import { writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { getWp } from '../src/headless/wp.js';

// Test-only probe: scrambled comments distinguish schema order from input order.
const attrs = {
  style: { spacing: { padding: { top: '1rem' } } },
  backgroundColor: 'base',
  layout: { type: 'constrained' },
};
const html = '<div class="wp-block-group has-base-background-color has-background" style="padding-top:1rem"></div>';
const inputs = [attrs, { layout: attrs.layout, backgroundColor: attrs.backgroundColor, style: attrs.style }]
  .map((attributes) => `<!-- wp:group ${JSON.stringify(attributes)} -->\n${html}\n<!-- /wp:group -->`);
const wp = await getWp();
const pinned = {
  attributes: Object.keys((wp.getBlockType('core/group') as { attributes: Record<string, unknown> }).attributes),
  outputs: inputs.map((input) => wp.serialize(wp.parse(input))),
};
const baseUrl = process.argv[2] ?? 'http://localhost:8888';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`${baseUrl}/wp-login.php`);
  await page.locator('#user_login').fill('admin');
  await page.locator('#user_pass').fill('password');
  await Promise.all([page.waitForURL('**/wp-admin/**'), page.locator('#wp-submit').click()]);
  await page.goto(`${baseUrl}/wp-admin/post-new.php`);
  await page.waitForFunction(() => Boolean((window as any).wp?.blocks?.getBlockType('core/group')));
  const editor = await page.evaluate((inputs) => {
    const wp = (window as any).wp;
    return {
      attributes: Object.keys(wp.blocks.getBlockType('core/group').attributes),
      outputs: inputs.map((input) => wp.blocks.serialize(wp.blocks.parse(input))),
      registry: wp.blocks.getBlockTypes().map((type: any) => ({ name: type.name, attributes: Object.keys(type.attributes) })),
    };
  }, inputs);
  const result = { inputs, pinned, editor, equal: pinned.outputs.every((output, i) => output === editor.outputs[i]) };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (process.argv[3]) await writeFile(process.argv[3], json);
  console.log(JSON.stringify({ pinned: pinned.outputs, editor: editor.outputs, equal: result.equal }, null, 2));
} finally {
  await browser.close();
}
