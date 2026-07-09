import { TokenResolver } from '../types.js';

export function createNoopTokenResolver(): TokenResolver {
  return {
    kind: 'noop',
    async resolve() {
      return { colors: {}, fonts: {}, fontSizes: {}, spacing: {} };
    },
  };
}
