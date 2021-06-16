import { GraphQLNonNull } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';

import { Unauthorized } from '../../errors';
import { Individual } from '../object/Individual';

const userMutations = {
  setChangelogViewDate: {
    type: new GraphQLNonNull(Individual),
    description: 'Update the time which the user viewed the changelog updates',
    args: {
      changelogViewDate: {
        type: new GraphQLNonNull(GraphQLDateTime),
      },
    },
    resolve: async (_, { changelogViewDate }, { remoteUser }) => {
      if (!remoteUser) {
        throw new Unauthorized();
      }
      const user = await remoteUser.update({ changelogViewDate: changelogViewDate });
      return user.getCollective();
    },
  },
};

export default userMutations;
