# Native Navigation UI proof

Issue #166 was exercised on WordPress 7.1 / PHP 8.4.26 on 12 October 2026, using
`dev/fixtures/themes/valid-theme` in an isolated local theme named `nav-probe`.
The content-addressed receipt below retains the actual raw records and captures.
This is a bounded observed experiment, not an automated navigation acceptance test.

## Result and boundary

Editing the initial inline Navigation block created one `wp_navigation` post before
the Save button was pressed. Saving the header changed it from a theme file to a
database override containing `<!-- wp:navigation {"ref":11} /-->`. The menu's own
content held the edited links. The label, URL and added submenu item survived Save
and editor reopen. Desktop links and the mobile overlay worked.

M2 continues to compile caller-authored inline navigation. Its proof must report
this editor persistence honestly; it cannot claim that inline theme bytes survive
a native menu edit unchanged. M3 drift and pull must detect the referenced menu
dependency and refuse unsupported export. No automatic menu detachment, adoption,
creation or deletion is authorized by this observation.

## Reproduce in a disposable local environment

1. Verify OrbStack is the effective Docker endpoint, including `DOCKER_HOST` and
   `DOCKER_CONTEXT`. Use a fresh `wp-env` config with WordPress 7.1, PHP 8.4,
   `testsEnvironment: false` and unused explicit HTTP/MySQL ports. Copy the public
   valid theme into a private probe folder and activate it there. Preserve other
   stacks. Set explicit matching `WP_HOME`/`WP_SITEURL` for the browser URL.
2. Create only the five probe pages: Welcome, About, Team, Updates and Visit.
   Mark them as owned by the probe. Preserve the default page/post. Record a unique
   runtime marker, the theme header's raw content/source/`wp_id`, and all active
   `wp_navigation` records. The baseline must have no custom header or menu.
3. Log into that sandbox. Read the marker from authenticated WordPress settings
   before editing. Reuse `runAfterRuntimeVerification` from
   `scripts/proof-theme-playwright.mjs`; a mismatch must skip the edit/save action.
4. Open the header in the Site Editor. Use the Navigation UI to rename Home to
   Start. Capture a fresh menu/header inventory before saving. Use the actual Save
   button, with both Header and Navigation Menu selected in its confirmation.
5. Use the native link picker to change Start to the Welcome page's absolute URL.
   Use About's nested Add page control to add Updates beside Team. Save the menu
   with the actual Save button. Reopen the editor and confirm Start, About, Team
   and Updates persist and Save is disabled. Retain fresh raw records.
6. At 1440×900, open the About submenu and follow Updates and Start to their
   declared pages. At 390×844, open the menu, confirm its nested links, close it,
   reopen it and follow Updates. Capture both rendered states. Reset the temporary
   viewport afterwards.
7. Supply a deliberately wrong expected marker to the existing guard using a fresh
   authenticated marker observation. Record the skipped callback and unchanged raw
   before/after inventory. This negative control checks the guard; it does not
   claim that a second browser reached a different site.
8. Verify exact owned IDs and runtime identity before moving only the probe pages,
   menu and header override to recoverable WordPress Trash. Confirm the header
   returns to theme source, active menu count returns to zero, and default objects
   remain published. Stop only this probe config; retain its database volume.

## Evidence

`latest.json` points to a receipt written with the existing `ReceiptWriter` and
`EvidenceStore`. Evidence paths and SHA-256 addresses are relative to this folder.
Raw content includes sandbox URLs and numeric IDs; they describe this run only.
Chrome's exact version was not captured. Screenshots and browser interactions are
desktop Chrome with explicit viewport sizes, not physical mobile-device proof.
The source fixture inventory in the receipt identifies exact bytes; later code
changes do not turn this run into proof of a different compiler revision.
