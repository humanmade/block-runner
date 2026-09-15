# Custom conversion rules

Block Runner can add a narrow HTML-to-block conversion without changing its built-in rules. A custom rule has an `id`, a `match` function, and an async `emit` function that returns a native block, blocks, or `null`.

[`examples/custom-rule.mjs`](../examples/custom-rule.mjs) maps only `p[data-notice]` to a `core/paragraph` with the `notice` class. It keeps the paragraph's inner HTML as the block content:

```js
export default {
  rules: {
    custom: [{
      id: 'notice-paragraph',
      match: (node) => node.matches('p[data-notice]'),
      emit: async (node, { wp }) => wp.createBlock('core/paragraph', {
        content: node.innerHTML,
        className: 'notice',
      }),
    }],
  },
};
```

From a checkout, build the CLI and run the example with a literal input:

```sh
npm ci
npm run build
npx --no-install block-runner convert '<p data-notice>Service update</p>' --config examples/custom-rule.mjs
```

The command writes native paragraph markup. The relevant output is:

```html
<!-- wp:paragraph {"className":"notice"} -->
<p class="notice">Service update</p>
<!-- /wp:paragraph -->
```

`match` receives each HTML element and decides whether the rule owns it. `emit` receives that element and the conversion context. Use `context.wp.createBlock()` to create Gutenberg blocks. This example supports a simple paragraph and does not sanitise or define a rich-text conversion policy for arbitrary HTML.

Custom rules are tried before built-in rules. Before rule matching, the walker preserves foreign elements as Custom HTML. When asset preservation is enabled, it also preserves unsupported asset forms. It then uses the first matching custom or built-in rule. A matching rule that returns `null` drops that node; Block Runner does not continue to later rules. If `match` or `emit` throws, Block Runner records a warning and emits the source node as a Custom HTML fallback.

After `emit`, the shared style mapper applies the source element's own supported styles. The resulting tree then enters the shared finalizer, which resolves media, repairs configured tokens, serializes the blocks, and validates the output. The custom rule does not bypass those steps.

`rules.order` changes the order of built-in rules, and `rules.disabledDefaults` disables named built-ins. Neither option supplies arbitrary block definitions. A conversion rule is separate from registering a custom WordPress block. Register that block in both the target site and Block Runner's headless environment when your rule emits one. Block Runner does not load arbitrary third-party block definitions.

`className: 'notice'` adds a class to the paragraph. It does not create CSS or update `theme.json`; provide the matching styles in the WordPress site.

The npm package includes this [runnable example](https://github.com/humanmade/block-runner/blob/main/examples/custom-rule.mjs). See the repository's [`Rule` type](https://github.com/humanmade/block-runner/blob/main/src/types.ts) for the full hook contract.
