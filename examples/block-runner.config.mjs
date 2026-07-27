export default {
  strict: false,
  // How much off-theme CSS to keep: 'strict' (theme presets only), 'relaxed' (default —
  // exact values on the block), or 'open' (also emit CSS no block can express as a
  // stylesheet, which needs --css-out or --json to receive it).
  styling: 'relaxed',
  media: {
    resolver: 'map',
    mapFile: './media-map.json',
  },
  tokens: {
    colors: {
      dark: 'contrast',
      light: 'base',
      accent: 'accent',
    },
    fonts: {
      heading: 'display',
      body: 'body',
    },
    spacing: ['20', '30', '40', '50', '60'],
  },
};
