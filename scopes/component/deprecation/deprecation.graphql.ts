import type { Component } from '@teambit/component';
import type { Schema } from '@teambit/graphql';
import { gql } from 'graphql-tag';

import type { DeprecationMain } from './deprecation.main.runtime';

export function deprecationSchema(deprecation: DeprecationMain): Schema {
  return {
    typeDefs: gql`
      extend type Component {
        deprecation: DeprecationInfo
      }

      type DeprecationInfo {
        isDeprecate: Boolean
        newId: String
      }

      type DeprecationResult {
        bitIds: [String]
        missingComponents: [String]
      }

      type Mutation {
        # deprecate components
        deprecate(bitIds: [String!]!): DeprecationResult

        # undo deprecate to components
        undeprecate(bitIds: [String!]!): DeprecationResult
      }
    `,
    resolvers: {
      // Mutation: {
      //   deprecate: (req: any, { bitIds }: { bitIds: string[] }, context: { verb: string }) => {
      //     if (context.verb !== 'write') throw new Error('You are not authorized');
      //     return deprecation.deprecate(bitIds);
      //   },

      //   undeprecate: (req: any, { bitIds }: { bitIds: string[] }, context: { verb: string }) => {
      //     if (context.verb !== 'write') throw new Error('You are not authorized');
      //     return deprecation.unDeprecate(bitIds);
      //   },
      // },
      Component: {
        deprecation: (component: Component) => {
          return deprecation.getDeprecationInfo(component);
        },
      },
    },
  };
}
