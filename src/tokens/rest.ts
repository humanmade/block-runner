import { BlockRunnerConfig, ResolvedTokens, TokenResolver } from '../types.js';
import { emptyTokens, parseThemeJsonSettings } from './resolver.js';

const REQUEST_TIMEOUT_MS = 10_000;

const cache = new Map<string, ResolvedTokens>();

export function createRestTokenResolver(config: BlockRunnerConfig): TokenResolver {
  return {
    kind: 'rest',
    async resolve() {
      const wpUrl = config.media?.wpUrl;
      if (!wpUrl) {
        return emptyTokens();
      }

      const cached = cache.get(wpUrl);
      if (cached) {
        return cached;
      }

      const base = wpUrl.replace(/\/$/, '');
      const auth = authorization(config);
      const context = auth ? 'edit' : 'view';

      try {
        const themes = (await getJson(`${base}/wp-json/wp/v2/themes?status=active`, auth)) as Array<{
          stylesheet?: string;
        }>;
        const stylesheet = themes[0]?.stylesheet;
        if (!stylesheet) {
          return emptyTokens();
        }

        const globalStyles = (await getJson(
          `${base}/wp-json/wp/v2/global-styles/themes/${encodeURIComponent(stylesheet)}?context=${context}`,
          auth,
        )) as { settings?: Parameters<typeof parseThemeJsonSettings>[0] };

        const tokens = parseThemeJsonSettings(globalStyles.settings);
        cache.set(wpUrl, tokens);
        return tokens;
      } catch {
        return emptyTokens();
      }
    },
  };
}

async function getJson(url: string, auth: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: auth ? { Authorization: auth } : {},
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`request failed: ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function authorization(config: BlockRunnerConfig): string {
  const user = config.media?.wpUser;
  const password = config.media?.wpAppPassword;
  return user && password ? `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` : '';
}
