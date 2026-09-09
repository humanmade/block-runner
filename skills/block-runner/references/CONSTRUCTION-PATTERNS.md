# Fit the component to the project

Read this when integrating or changing a component in an existing WordPress project.
Use the examples to recognize source contracts, then follow the project's actual wiring.
They are inspection examples, not code to substitute for Block Runner's generator.

## Establish the contract

Record only properties that affect the requested change, with file/line references.

| Question | Properties to distinguish |
|---|---|
| What is being created or reused? | Custom type, pattern, style, variation, binding, editor/render extension |
| Who owns it? | Theme, plugin, MU plugin or shared package; implementation and presentation may have different owners |
| What persists? | Attributes, saved markup, children, conditional children, copied content or a shared reference |
| Who produces the output? | Save function, PHP, parent renderer, browser script or external provider; preview-only output is possible |
| How does it load? | PHP bootstrap, editor import, metadata/settings, source → build mapping, asset handles/modules and required copies |
| What must survive? | Nesting, context, locks, data/media identities, dependencies and historical saves |

These properties overlap. A package-owned block can save children and use a theme-styled PHP
wrapper. Unknown properties remain unknown; a new combination need not become a new category.

Start with package scripts and manifests, including Composer/npm locks when dependencies are
relevant. Trace both registrations to their callers. Read active save/render code and effective
settings, including filters. Follow a specific dependency into available package source when
needed; avoid broad scans of installed or generated files.

### Discovery tools supply leads

If a construction map is supplied, use it to locate candidate files. If the installed CLI's
`plugin --help` lists `orient`, invoke that same executable with these arguments for an
optional read-only starting map:

```text
plugin orient <project-directory> --json
```

Do not require this command or install another version for discovery. When unavailable, inspect
source directly. A map's “confirmed” label does not replace checking its evidence. Path-derived
ownership, guessed build outputs and metadata script references need verification. An empty map
can miss patterns, shared packages, handwritten definitions or build-only arrangements.

`plugin inspect <host> --json` serves a different purpose: assessing the existing supported host
profile. Neither command establishes deployed activation, persistence behavior or permission to write.

## Recognize persistence before editing

The following fragments omit imports and surrounding registration.

### Static markup can be interactive

```jsx
function save() {
  return <div {...useBlockProps.save()}>
    <button type="button" data-share>Share</button>
  </div>;
}
```

A view script may create a menu or read the current URL. That behavior is outside the saved
markup. Preserve its asset loading and interaction contract. A static container instead adds
`<InnerBlocks.Content />` inside its saved wrapper; the accepted wrapper shape still matters.

### Dynamic output can retain children

```jsx
// Attributes only: inspect the renderer and its data sources.
const save = () => null;

// Saved children: PHP may supply the surrounding shell.
const saveWithChildren = () => <InnerBlocks.Content />;

// Conditional saving: some instances retain success content.
function saveConditional({ attributes }) {
  if (!attributes.useAjax) return null;
  return <div {...useInnerBlocksProps.save()} />;
}
```

Conditional saving differs from conditional display: another form block may always save children,
then place them in a PHP-generated success template. Never replace either with `save: () => null`.
Attributes can hold a whole dataset, selected post IDs or provider HTML; preserve normalization,
query ordering, sanitization and provider policy rather than inferring them from appearance.

### A parent can own its children's rendering

```text
tabs: saves tab children; PHP renders their labels and descendants
  tab: saves its children; PHP deliberately returns no independent output
```

Render each descendant once. Check `parent`/`ancestor`, allowed children, provided/consumed
context and repeated-instance IDs. An editor's active-tab state may differ from frontend initial
state. A static parent/child family can use the same nesting constraints without parent-owned PHP.

### References and editor-only output are separate

```text
reference block: saved postID → resolve another post → render its blocks
editor block:   editing controls → preview output; normal frontend output is empty
```

A custom post reference is not automatically a synced pattern. Check missing targets and explicit
REST/preview branches. Empty output can be intentional; inserter visibility is not authorization.

### Old saves remain part of the definition

```js
registerBlockType('example/section', {
  edit: Edit,
  save: currentSave,
  deprecated: [{ attributes: oldAttributes, save: oldSave, migrate }]
});
```

Inspect those implementations before changing wrappers, attributes or media identities. Current
validity does not prove old content survives. Block API version and package version do not describe
all accepted historical forms.

## Reuse the right WordPress mechanism

| Mechanism | Small example | Preserve |
|---|---|---|
| Unsynced pattern | Group → Query → Post Template → Title + Excerpt | Insertion copies blocks; query results remain runtime data |
| Synced pattern | Shared composition referenced by instances | Shared identity and any explicit per-instance overrides |
| Style | `registerBlockStyle('core/group', { name: 'outlined', label: 'Outlined' })` | The CSS/behavior that implements the choice |
| Variation | `registerBlockVariation('core/query', { name: 'example/resources', attributes: { namespace: 'example/resources' } })` | Defaults, children and any accompanying curation controls |
| Binding | `metadata.bindings.text.source = 'example/primary-term'` | Registered source, context and resolution; not the currently rendered text |
| Editor/render extension | Query attributes added by a filter; icons added during PHP rendering | Effective schema and output beyond the stock Core definition |

A pattern file declares neither a lock nor a synced lifecycle merely by existing. Styles,
variations, bindings and filters can coexist. Similar-looking custom markup may lose their behavior.
A type in a site snapshot does not load its implementation into Block Runner's headless registry.

## Follow integration all the way through

### Metadata registration and editor discovery can differ

```php
foreach ( glob( $root . '/blocks/*/block.json' ) as $file ) {
    register_block_type_from_metadata( $file );
}
```

```js
// Separate editor entry: a new directory still needs its import.
import './blocks/hero';
```

Check the actual traversal depth on each side. A `RecursiveDirectoryIterator` alone does not
prove recursive descent. PHP may instead register names explicitly:

```php
register_block_type( 'example/section' );
register_block_type( 'example/feed', [ 'render_callback' => 'render_feed' ] );
```

A nearby `render.php` is inactive unless metadata or registration connects it. JavaScript settings
and PHP overrides may extend or replace metadata; preserve the existing arrangement.

### Build output must match registration

```text
blocks/src/card → build command → blocks/build/card
PHP registers blocks/build/card
metadata references ./index.js, ./style-index.css and ./render.php
```

Verify the output mapping and required copies, including PHP when the build uses
`--webpack-copy-php`. Shared Webpack entries, project-root output, manual style imports and custom
MU-plugin URLs require their actual host wiring. Finding only a theme bundle is a useful partial
result, not evidence of block registration.

Distinguish `file:` asset paths, registered script/style handles and script-module IDs. Inspect
manifest dependencies, shared bundles, and editor content versus inspector/chrome styles as relevant.
Build configuration does not prove emitted files exist or are deployed.

### Dependencies can split ownership

```text
consumer composer.json + lock → exact form plugin source
plugin → registration, PHP renderer, provider script
theme  → form styling
```

Inspect the available locked implementation before proposing a duplicate local block. Dependency
presence does not prove activation; theme styles do not make the theme the implementation owner.
Provider configuration, script delivery and submission behavior remain separate runtime questions.

## Turn findings into a useful recommendation

Use the smallest mechanism that preserves the requested behavior. For example:

> “The existing resource pattern already supplies the query and layout. Reuse that composition;
> a new registered type would add no needed behavior.”

> “This theme registers built blocks, but its editor imports them explicitly. The supported static
> source can be delivered here with a handoff naming the editor import and build step. Site
> registration and save/reopen remain untested.”

> “The shared package owns this form; the theme styles it. The requested submission change belongs
> in the package's behavior, which the static generator does not produce.”

Follow GUIDE.md §0 for unresolved choices and §2 for supported generation, confirmation and delivery.
Understanding PHP, providers or a custom build does not add compiler support. For an unfamiliar
combination, trace the connections; for missing evidence, name the specific gap. Keep source facts,
interpretation and runtime proof separate.
