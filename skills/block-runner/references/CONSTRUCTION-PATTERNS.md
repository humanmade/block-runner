# Fit the component to the project

Read this when integrating or changing a component in an existing WordPress project.
Choose an implementation route, then inspect its contracts and project wiring. Code fragments
are inspection examples, not substitutes for Block Runner's generator.

## Choose the implementation route

Reuse available local or dependency implementations before defining another. Classify the
component or extension being changed, not the entire project.

```text
Compose existing blocks → content, pattern, template or shared composition
Extend an existing type/editor → style, variation, binding or editor/render extension
Define or maintain a custom block
├─ Framework supplies the field editor → field-framework block
└─ Project owns the native editor/definition
   ├─ Saved markup supplies the component → saved-markup block
   ├─ Server produces output from settings/data → data-rendered block
   └─ Meaningful saved content and server behavior both matter → combined save/render block
```

These are navigation routes, not compiler modes or an exhaustive taxonomy. A composition can
contain data-rendered blocks; a saved-markup block can contain interactive or dynamic children.
Extensions and combined save/render blocks need a specific mechanism before a file plan.

## Establish the contract

Record only properties that affect the requested change, with file/line references.

| Question | Properties to distinguish |
|---|---|
| What changes? | Reuse, configure, extend, modify or create; identify the owned type, composition or extension |
| Who owns it? | Theme, plugin, MU plugin or shared package; implementation and presentation may have different owners |
| What persists? | Attributes, saved markup, children, conditional children, copied content or a shared reference |
| Who produces the output? | Save function, PHP, parent renderer, browser script or external provider; preview-only output is possible |
| How does it load? | PHP bootstrap, editor import, metadata/settings, source → build mapping, asset handles/modules and required copies |
| What may editors change? | Starter template, allowed children, parent/ancestor constraints, insertion/movement/removal locks, content-only or field controls |
| What must survive? | Nesting, context, data/media identities, dependencies and historical saves |

Ownership, wiring and editing policy qualify the route; theme/plugin placement or locking alone
cannot select a save/render implementation. Unknown properties remain unknown. Editor locks are
not authorization boundaries.

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

Saved content can also be a fallback, a parallel representation, or input to a renderer/filter.
Preserve authored fallback content even when normal PHP output ignores it, and the selectors
and conditions used to transform or replace markup. Browser enhancement alone does not make a
block combined save/render.

A data-rendered block may save a legacy placeholder instead of `null`; preserve that accepted
form. Without effective save and render definitions, leave the persistence route unresolved.

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

### Field frameworks own a different editing contract

For an ACF-style block, trace framework registration, field identities and storage, template or
controller mapping, and asset hooks. Follow those conventions rather than replacing the field
editor with a native edit/save pair. If the block retains native children, preserve their save
and render contract too. A `get_field()` call alone establishes neither framework ownership of
the editor nor where its values persist.

## Reuse the right WordPress mechanism

| Mechanism | Small example | Preserve |
|---|---|---|
| Unsynced pattern | Group → Query → Post Template → Title + Excerpt | Insertion copies blocks; query results remain runtime data |
| Theme template/part | A block tree placed through theme template resolution | Placement and any database override of the source template |
| Synced pattern | Shared composition referenced by instances | Shared identity and any explicit per-instance overrides |
| Style | `registerBlockStyle('core/group', { name: 'outlined', label: 'Outlined' })` | The CSS/behavior that implements the choice |
| Variation | `registerBlockVariation('core/query', { name: 'example/resources', attributes: { namespace: 'example/resources' } })` | Defaults, children and any accompanying curation controls |
| Binding | `metadata.bindings.text.source = 'example/primary-term'` | Registered source, context and resolution; not the currently rendered text |
| Editor/render extension | Query attributes added by a filter; icons added during PHP rendering | Effective schema and output beyond the stock Core definition |

Changing an unsynced pattern does not update prior insertions. A pattern file declares neither
a lock nor a synced lifecycle merely by existing. No new block type does not mean nothing is
registered: patterns, styles and binding sources have their own wiring. Select the extension
mechanism explicitly; styles, variations, bindings and filters can coexist but are not interchangeable.
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

Recommend the smallest mechanism that preserves the requested behavior. Name the construction
recipe, owner/destination, registration/build wiring, editing policy and specific evidence gaps.
Infer these from source; ask users only about unresolved choices, not taxonomy labels.

> “The existing resource pattern already supplies the query and layout. Reuse that composition;
> a new registered type would add no needed behavior.”

> “Use a saved-markup block in the existing plugin, with fixed structure and editable text/images.
> Its shared build needs an explicit editor import and PHP registration. Deliver supported static
> source with that integration handoff; site registration and save/reopen remain untested.”

> “The shared package owns this form; the theme styles it. The requested submission change belongs
> in the package's behavior, which the static generator does not produce.”

State whether the next step is reuse, supported generation or a developer handoff. Recognition
does not establish generation support: the static generator does not author new PHP renderers,
field-framework implementations, arbitrary interactions, style/variation/binding implementations
or pattern registration packages.
Never substitute a static block for required behavior. Follow [GUIDE.md](GUIDE.md) §0 for
capability gaps and [AUTHORING.md](AUTHORING.md) for supported generation, confirmation and
delivery. Keep source facts, interpretation and runtime proof separate.
