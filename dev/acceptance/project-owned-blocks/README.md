# Project-owned custom-block acceptance proof

This neutral, test-owned consumer plugin is the #84 execution input. It is
ordinary project source, not a Block Runner generator or a package API.

`example/dynamic-hero` is a fully custom dynamic block: its editor exposes
media, focal point, rich text, heading level and button controls; PHP renders
the selected attachment with WordPress-generated responsive candidates. Block
Runner contributes no retained output to this example.

`example/resource-list` combines a project-owned category/limit query with a
native introduction. `src/resource-list/introduction.intent.json` is passed to
`realize()` by the source-contract test; the exact returned markup is retained
in `introduction.js` and parsed into `InnerBlocks` by the editor. Its saved
children remain on the page while PHP queries current published results.

## Build and install

From this checkout (or an isolated copy), install the consumer dependency and
build it. The exact installed Block Runner version and source revision belong
in the result receipt.

```sh
cd dev/acceptance/project-owned-blocks
npm install
npm run build
php -l project-owned-blocks.php
php -l src/dynamic-hero/render.php
php -l src/resource-list/render.php
```

Copy the built directory into the test-owned WordPress plugin directory,
activate `project-owned-blocks`, and use the existing pinned WordPress 7.1 / PHP
8.3 environment. The proof harness must seed its category, posts and image at
runtime; no database IDs are kept in this source.

## Runtime acceptance

Use actual editor controls to create two instances of each block. Change only
the second instance, save, reopen and record that both parent attributes and
the list's native children remain independent, valid and clean. For the hero,
change image, focal point, heading level and new-tab link setting; verify its
attachment-derived `srcset`, focal placement, heading and safe link output.

For the list, edit the introduction, category and limit; save/reopen; then
change a matching post title or add a published match without saving the
containing page. The introduction must remain while results update. Also prove
empty results retain the introduction, drafts never render, invalid limits and
malformed category/focal data do not produce notices or unsafe output, and a
missing image shows the documented helper text.

After the first successful build, change a renderer string and an editor label,
then run `npm run build` again. Those normal source edits must survive and be
visible after reinstall/reload. Record commands, source/build hashes, WordPress
and skill identities, editor observations and screenshots in `evidence/`.

The checked-in local proof receipt is
`evidence/RUNTIME-RESULT.md`. Re-run its browser control from this directory
after seeding a category and passing its ID:

```sh
WP_USERNAME=admin WP_PASSWORD=... node evidence/proof-browser.mjs --category 3 --empty-category 4 --out evidence/browser-result.json
```

The source contract, PHP lint and build are preliminary. Only the serialized
WordPress browser run proves editor persistence and dynamic frontend behaviour.
