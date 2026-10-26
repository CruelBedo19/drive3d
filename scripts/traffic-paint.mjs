// Measures each traffic model's paint as rendered (scripts/traffic-paint.html, through the dev server) and writes it
// into src/config/trafficModels.json (`paint`: the colour of its low-poly stand-in in the distance).
// Usage: node scripts/traffic-paint.mjs http://localhost:<port>/ [chromium executable]
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const [base, exe] = process.argv.slice(2);
if (!base) throw new Error('usage: node scripts/traffic-paint.mjs http://localhost:<port>/ [chromium executable]');
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=gl-egl', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error(e.message));
await page.goto(new URL('scripts/traffic-paint.html', base).href);
const paints = await page.waitForFunction(() => window.__paints, null, { timeout: 300000, polling: 200 }).then((h) => h.jsonValue());
await browser.close();
// Liveries a single colour cannot pick from a render: the white bus with green stripes.
const OVERRIDE = { citybus: 0xe6e8e6 };
Object.assign(paints, OVERRIDE);
const file = new URL('../src/config/trafficModels.json', import.meta.url);
const models = JSON.parse(readFileSync(file, 'utf8'));
for (const [id, paint] of Object.entries(paints)) {
  if (!models[id]) continue;
  console.log(id.padEnd(18), `#${models[id].paint.toString(16).padStart(6, '0')} → #${paint.toString(16).padStart(6, '0')}`);
  models[id].paint = paint;
}
writeFileSync(file, `${JSON.stringify(models, null, 2)}\n`);
