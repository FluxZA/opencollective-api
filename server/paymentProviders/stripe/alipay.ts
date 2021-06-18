/* eslint-disable camelcase */
import querystring from 'querystring';

import config from 'config';
import debugLib from 'debug';
import { NextFunction, Request, Response } from 'express';

import OrderStatus from '../../constants/order_status';
import { TransactionTypes } from '../../constants/transactions';
import { idDecode, IDENTIFIER_TYPES } from '../../graphql/v2/identifiers';
import logger from '../../lib/logger';
import { createRefundTransaction, getHostFee, getPlatformFee } from '../../lib/payments';
import stripe, { convertFromStripeAmount, convertToStripeAmount, extractFees } from '../../lib/stripe';
import models from '../../models';

import { refundTransaction } from './common';

const debug = debugLib('alipay');

const compatibleCurrencies = ['cny', 'aud', 'cad', 'eur', 'gbp', 'hkd', 'jpy', 'myr', 'nzd', 'sgd', 'usd'];

const processOrder = async (order: typeof models.Order): Promise<void> => {
  const hostStripeAccount = await order.collective.getHostStripeAccount();
  if (!hostStripeAccount) {
    throw new Error('Host is not connected to Stripe');
  }
  if (!compatibleCurrencies.includes(order.currency.toLowerCase())) {
    throw new Error(`We can not pay with Alipay in ${order.currency} currency`);
  }

  let intent;
  if (!order.data?.paymentIntent) {
    debug(`creating intent for order ${order.id}`);
    intent = await stripe.paymentIntents.create(
      {
        payment_method_types: ['alipay'],
        amount: convertToStripeAmount(order.currency, order.totalAmount),
        currency: order.currency,
      },
      {
        stripeAccount: hostStripeAccount.username,
      },
    );
    await order.update({ data: { ...order.data, paymentIntent: { id: intent.id, status: intent.status } } });
  } else {
    debug(`intent for order ${order.id} already exists, fetching it from stripe`);
    intent = await stripe.paymentIntents.retrieve(order.data.paymentIntent.id, {
      stripeAccount: hostStripeAccount.username,
    });
  }

  const paymentIntentError = new Error('Payment Intent require action');
  paymentIntentError['stripeAccount'] = hostStripeAccount.username;
  paymentIntentError['stripeResponse'] = { paymentIntent: intent };
  throw paymentIntentError;
};

const confirmOrder = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  debug('confirm order', req.query);
  try {
    const { OrderId, payment_intent, redirect_status } = req.query;
    if (redirect_status === 'succeeded') {
      const order = await models.Order.findByPk(idDecode(OrderId, IDENTIFIER_TYPES.ORDER), {
        include: [
          { model: models.Collective, as: 'collective' },
          { model: models.Collective, as: 'fromCollective' },
          { model: models.PaymentMethod, as: 'paymentMethod' },
          { model: models.Subscription, as: 'Subscription' },
          { association: 'createdByUser' },
        ],
      });
      if (order.status !== OrderStatus.REQUIRE_CLIENT_CONFIRMATION) {
        logger.warn(
          `Trying to confirm Alipay order but order status is not waiting for client confirmation: #${order.id}`,
        );
        res.sendStatus(200);
        return;
      }
      debug(`confirming order ${order.id}`);
      const host = await order.collective.getHostCollective();
      const hostStripeAccount = await order.collective.getHostStripeAccount();
      const hostPlan = await host.getPlan();
      const hostFeeSharePercent = hostPlan?.hostFeeSharePercent;
      const isSharedRevenue = !!hostFeeSharePercent;

      // Read or compute Platform Fee
      const platformFee = await getPlatformFee(order.totalAmount, order, host, { hostPlan, hostFeeSharePercent });
      const platformTip = order.data?.platformFee;
      const intent = await stripe.paymentIntents.retrieve(payment_intent, {
        stripeAccount: hostStripeAccount.username,
      });

      const charge = intent.charges.data[0];

      const balanceTransaction = await stripe.balanceTransactions.retrieve(charge.balance_transaction, {
        stripeAccount: hostStripeAccount.username,
      });

      // Create a Transaction
      const fees = extractFees(balanceTransaction, balanceTransaction.currency);
      const amountInHostCurrency = convertFromStripeAmount(balanceTransaction.currency, balanceTransaction.amount);
      const hostFeeInHostCurrency = await getHostFee(amountInHostCurrency, order);
      const data = {
        charge,
        balanceTransaction,
        isFeesOnTop: order.data?.isFeesOnTop,
        isSharedRevenue,
        platformFee: platformFee,
        platformTip,
        hostFeeSharePercent,
      };
      const hostCurrencyFxRate = amountInHostCurrency / order.totalAmount;
      const platformFeeInHostCurrency = isSharedRevenue ? platformTip * hostCurrencyFxRate || 0 : fees.applicationFee;

      const transactionPayload = {
        CreatedByUserId: order.CreatedByUserId,
        FromCollectiveId: order.FromCollectiveId,
        CollectiveId: order.CollectiveId,
        PaymentMethodId: order.PaymentMethodId,
        type: TransactionTypes.CREDIT,
        OrderId: order.id,
        amount: order.totalAmount,
        currency: order.currency,
        hostCurrency: balanceTransaction.currency.toUpperCase(),
        amountInHostCurrency,
        hostCurrencyFxRate,
        paymentProcessorFeeInHostCurrency: fees.stripeFee,
        taxAmount: order.taxAmount,
        description: order.description,
        hostFeeInHostCurrency,
        platformFeeInHostCurrency,
        data,
      };

      await models.Transaction.createFromContributionPayload(transactionPayload, {
        isPlatformTipDirectlyCollected: true,
      });
      await order.update({ status: 'PAID' });

      res.redirect(`${config.host.website}/${order.collective.slug}/donate/success?OrderId=${OrderId}`);
    } else if (redirect_status === 'failed') {
      const id = idDecode(OrderId, IDENTIFIER_TYPES.ORDER);
      debug(`payment for order ${id} failed, deleting order`);
      const order = await models.Order.findByPk(id, {
        include: [{ model: models.Collective, as: 'collective' }],
      });
      if (order) {
        await order.destroy();
        res.redirect(
          `${config.host.website}/${order.collective.slug}/donate?${querystring.stringify({
            error: "Couldn't approve Alipay payment, please try again.",
          })}`,
        );
      } else {
        next(new Error('Could not find the requested orded.'));
      }
    }
  } catch (e) {
    logger.error(e);
    next(e);
  }
};

const webhook = async (_, event) => {
  if (event.type === 'charge.refund.updated') {
    const refund = event.object.data;
    if (refund.status === 'succeeded') {
      const transaction = await models.Transaction.findOne({
        where: { type: 'CREDIT', isRefund: false, data: { charge: { id: refund.charge } } },
        include: [
          { model: models.Collective, as: 'collective' },
          { model: models.PaymentMethod, as: 'paymentMethod' },
        ],
      });
      if (!transaction) {
        logger.warn(`Could not find transaction for charge.refund.updated event`, event);
        return;
      } else if (transaction.RefundTransactionId) {
        logger.warn(`Transaction was already refunded, charge.refund.updated ignoring event`, event);
        return;
      } else if (transaction.paymentMethod.type !== 'alipay') {
        return;
      }

      const hostStripeAccount = await transaction.collective.getHostStripeAccount();
      const refundBalance = await stripe.balanceTransactions.retrieve(refund.balance_transaction, {
        stripeAccount: hostStripeAccount.username,
      });
      const charge = transaction.data.charge;
      const fees = extractFees(refundBalance, refundBalance.currency);

      await transaction.update({ data: { ...transaction.data, refund } });

      /* Create negative transactions for the received transaction */
      return await createRefundTransaction(
        transaction,
        fees.stripeFee,
        { ...transaction.data, charge, refund, balanceTransaction: refundBalance },
        undefined,
      );
    }
  }
  return 'OK';
};

export default {
  features: {
    recurring: false,
    waitToCharge: false,
  },
  webhook,
  processOrder,
  confirmOrder,
  refundTransaction: (transaction, user) => {
    return refundTransaction(transaction, user, { checkRefundStatus: true });
  },
};
