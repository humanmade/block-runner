import { MediaResolver } from '../types.js';

export function createNoopResolver(): MediaResolver {
  return {
    kind: 'noop',
    async resolve(input) {
      return {
        url: input.urlOrPath,
        id: null,
        resolved: false,
        reason: 'noop resolver does not resolve media IDs',
      };
    },
  };
}
