// Run from the repository root: npm test  (needs Playwright and an installed Google Chrome).
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
const files = new Set(['newtab.html', 'background.css', 'background.js', 'search.js', 'wallpaper.js']);
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://local').pathname.slice(1) || 'newtab.html';
  if (!files.has(name)) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
  res.setHeader('Content-Security-Policy', manifest.content_security_policy.extension_pages);
  res.end(fs.readFileSync(path.join(root, name)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1250, height: 1119 }, colorScheme: 'dark' });
  const errors = [];
  const external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'warning' && message.text().includes('Animated background unavailable')) errors.push(message.text());
  });
  page.on('request', request => {
    if (!request.url().startsWith(url) && !request.url().startsWith('blob:')) external.push(request.url());
  });
  await page.addInitScript(() => {
    window.probe = { draws: 0, pixel: [], image: false, textureSize: null };
    const draw = WebGL2RenderingContext.prototype.drawArrays;
    WebGL2RenderingContext.prototype.drawArrays = function (...args) {
      const result = draw.apply(this, args);
      const program = this.getParameter(this.CURRENT_PROGRAM);
      // Two passes a frame: the embers, then the glass over them.
      const has = this.getUniformLocation(program, 'hasImage');
      if (has) window.probe.image = !!this.getUniform(program, has);
      const count = this.getUniformLocation(program, 'lensCount');
      if (count) {
        window.probe.lenses = this.getUniform(program, count);
        window.probe.lens = [...this.getUniform(program, this.getUniformLocation(program, 'lens[0]'))];
        window.probe.light = this.getUniform(program, this.getUniformLocation(program, 'light'));
      }
      const pixel = new Uint8Array(4);
      this.readPixels(Math.floor(this.canvas.width * 0.75), Math.floor(this.canvas.height * 0.25), 1, 1, this.RGBA, this.UNSIGNED_BYTE, pixel);
      window.probe.pixel = [...pixel];
      window.probe.error = this.getError();
      window.probe.draws++;
      return result;
    };
    const upload = WebGL2RenderingContext.prototype.texImage2D;
    WebGL2RenderingContext.prototype.texImage2D = function (...args) {
      if (args.length === 6 && (args[5] instanceof ImageBitmap || args[5] instanceof HTMLImageElement)) {
        window.probe.textureSize = [args[5].width, args[5].height];
      }
      return upload.apply(this, args);
    };
  });
  await page.goto(url);
  await page.waitForFunction(() => window.probe.draws > 0);
  const query = page.locator('#query');
  await query.focus();
  const field = await query.evaluate(input => {
    const s = getComputedStyle(input), r = input.getBoundingClientRect();
    return { width: r.width, height: r.height, center: r.y + r.height / 2,
      blur: s.backdropFilter, shadow: s.boxShadow, background: s.backgroundColor, color: s.color,
      glass: document.documentElement.dataset.glass,
      foreground: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === input };
  });
  assert.equal(field.width, 560);
  assert.equal(field.height, 50);
  assert(Math.abs(field.center - 1119 * 0.47) < 1);
  assert(field.foreground);
  // Liquid glass: the shader draws the field as a lens over itself, exactly
  // where the field is, and the field's own frosted pane steps aside.
  assert.equal(field.glass, 'on');
  assert.equal(field.blur, 'none');
  assert.notEqual(field.shadow, 'none');
  const lens = await page.evaluate(() => ({ ...window.probe, canvas: [document.querySelector('canvas').width, document.querySelector('canvas').height] }));
  assert.equal(lens.lenses, 1);
  assert.deepEqual(lens.lens.map(Math.round), [625, Math.round(1119 - 1119 * 0.47), 280, 25]);
  assert.deepEqual(lens.canvas, [1250, 1119]);
  // The shader and the page follow the browser's appearance as it changes.
  assert.equal(lens.light, 0);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => window.probe.light === 1);
  const day = await query.evaluate(input => [getComputedStyle(input).color, [...window.probe.pixel]]);
  assert.equal(day[0], 'rgb(31, 27, 23)');
  assert(day[1][0] > 150 && day[1][1] > 100 && day[1][0] < 235, 'By day the embers are drawn on paper, dimmed: ' + day[1]);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => window.probe.light === 0);
  assert.equal(await query.evaluate(input => getComputedStyle(input).color), 'rgb(245, 242, 238)');
  assert((await page.evaluate(() => window.probe.pixel))[1] < 100, 'By night the same place is dark');
  assert.equal(await page.title(), 'New Tab');
  assert.equal((await page.evaluate(() => window.probe)).image, false);

  // A wide image whose center is green: cover-fit must crop red/blue edges.
  // At 4000px wide it also exercises the texture size cap.
  const image = { name: 'shader-source.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="1000"><rect width="4000" height="1000" fill="#ff0000"/><rect x="1400" width="1200" height="1000" fill="#00ff00"/><rect x="2600" width="1400" height="1000" fill="#0000ff"/></svg>') };
  await page.locator('#background-file').setInputFiles(image);
  await page.waitForFunction(() => window.probe.image && !document.querySelector('#upload-background').disabled);
  const uploaded = await page.evaluate(() => window.probe);
  assert.deepEqual(uploaded.textureSize, [1280, 320]);
  assert.equal(uploaded.error, 0);
  // The picture is kept as a JPEG, so a pure colour may be off by a step or two.
  assert(uploaded.pixel[0] <= 4, 'The red edge must be cropped away');
  assert(uploaded.pixel[2] <= 4, 'The blue edge must be cropped away');
  assert(uploaded.pixel[1] > 0, 'The shader must sample green image pixels, not the orange palette');
  const first = await page.locator('canvas#background').screenshot();
  await page.waitForTimeout(1600);
  const second = await page.locator('canvas#background').screenshot();
  assert.notDeepEqual(first, second, 'Uploaded image must remain animated');
  assert((await page.evaluate(() => window.probe.draws)) > uploaded.draws);
  assert(await page.locator('#background-status').isHidden());

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(100);
  let draws = await page.evaluate(() => window.probe.draws);
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => window.probe.draws), draws);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForFunction(n => window.probe.draws > n, draws);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  draws = await page.evaluate(() => window.probe.draws);
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => window.probe.draws), draws);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(n => window.probe.draws > n, draws);

  await page.reload();
  await page.waitForFunction(() => window.probe.image);
  assert.equal(await page.title(), 'New Tab');
  assert((await page.evaluate(() => window.probe)).pixel[0] <= 4);
  await page.locator('#background-file').setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
  await page.waitForFunction(() => !document.querySelector('#upload-background').disabled);
  assert(await page.locator('#background-status').isVisible());
  assert.equal((await page.evaluate(() => window.probe)).image, true);

  await page.locator('#background-options').click();
  await page.locator('#reset-background').click();
  await page.waitForFunction(() => !window.probe.image && !document.querySelector('#reset-background').disabled);
  await page.reload();
  await page.waitForFunction(() => window.probe.draws > 0);
  assert.equal((await page.evaluate(() => window.probe)).image, false);
  await page.setViewportSize({ width: 390, height: 844 });
  const box = await query.boundingBox();
  assert(box.x >= 0 && box.x + box.width <= 390);

  await page.locator('#background-options').click();
  assert(await page.locator('#background-menu').isVisible());
  await page.keyboard.press('Escape');
  assert(await page.locator('#background-menu').isHidden());
  await query.fill('hello & shader');
  assert.equal(await page.title(), 'New Tab');
  await page.route('https://www.google.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Search test</title>' }));
  await Promise.all([page.waitForURL('https://www.google.com/search?q=hello%20%26%20shader'), query.press('Enter')]);
  assert.deepEqual(external, ['https://www.google.com/search?q=hello%20%26%20shader']);
  assert.deepEqual(errors, []);
  // Only what the field needs to act like the browser's own; no site access.
  assert.deepEqual(manifest.permissions, ['history', 'bookmarks', 'search', 'tabs']);
  assert(!manifest.host_permissions);

  // The field with the browser's APIs behind it, as it runs in Search.
  const tab = await browser.newPage({ viewport: { width: 1250, height: 900 }, colorScheme: 'dark' });
  const fieldErrors = [];
  tab.on('pageerror', error => fieldErrors.push(error.message));
  await tab.addInitScript(() => {
    const day = 864e5, now = Date.now();
    const visit = (url, title, visitCount, age = 0) => ({ url, title, visitCount, typedCount: 0, lastVisitTime: now - age * day });
    window.calls = [];
    window.chrome = {
      history: { search: async () => [
        visit('https://github.com/', 'GitHub', 18),
        visit('https://github.com/sessions/two-factor/mobile', 'Two-factor authentication · GitHub', 9),
        visit('https://www.google.com/', 'Google', 10),
        visit('https://accounts.google.com/gsi/transform', 'Sign In - Google Accounts', 3),
        visit('https://gemini.google.com/app', 'Gemini', 40, 300),
        visit('https://www.google.com/search?q=nothing%20new%20under%20the%20sun', 'nothing new under the sun - Google Search', 3),
        visit('http://localhost:3000/dashboard', 'Dashboard', 4),
        visit('https://openrouter.ai/settings/credits', 'Credits | OpenRouter', 2, 100),
      ] },
      bookmarks: { getTree: async () => [{ children: [{ title: 'YouTube', url: 'https://youtube.com/' }] }] },
      tabs: { query: async () => [], getCurrent: async () => ({ id: 1 }), remove: async id => { window.calls.push(['remove', id]); } },
      search: { query: async options => { window.calls.push(['search', options]); } },
    };
    window.close = () => { window.calls.push(['close']); };
  });
  await tab.route('**/visited/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Visited</title>' }));
  await tab.goto(url);
  const address = tab.locator('#query');
  const state = () => tab.evaluate(() => {
    const input = document.querySelector('#query');
    return { value: input.value, selected: input.value.slice(input.selectionStart, input.selectionEnd),
      rows: [...document.querySelectorAll('#suggestions:not([hidden]) .row')].map(row =>
        [...row.querySelectorAll('.main, .detail, .key')].map(part => part.textContent).join(' | ')),
      active: [...document.querySelectorAll('#suggestions .row')].findIndex(row => row.getAttribute('aria-selected') === 'true') };
  });
  await address.focus();
  await tab.keyboard.type('g');
  await tab.waitForFunction(() => document.querySelectorAll('#suggestions .row').length > 0);
  // The site most used lately is finished in the field and leads the rows;
  // one visited long ago stays out; the search comes last, with its engine.
  assert.deepEqual(await state(), { value: 'github.com', selected: 'ithub.com', active: -1,
    rows: ['github.com | GitHub', 'google.com | Google', 'github.com/sessions/two-factor/mobile | Two-factor authentication · GitHub', 'g | Google'] });
  await tab.keyboard.type('i');
  let seen = await state();
  assert.equal(seen.value, 'github.com');
  assert.equal(seen.selected, 'thub.com');
  assert.equal(seen.rows[0], 'Search GitHub | Tab');
  assert.equal(seen.rows.at(-1), 'gi | Google');
  // Deleting takes the finished part away and offers none again.
  await tab.keyboard.press('Backspace');
  assert.equal((await state()).value, 'gi');
  await tab.keyboard.press('Backspace');
  assert.equal((await state()).value, 'g');
  // Tab searches the site; Escape empties the field, site and all.
  await tab.keyboard.type('i');
  await tab.keyboard.press('Tab');
  assert.equal(await address.getAttribute('placeholder'), 'Search GitHub');
  assert(await tab.locator('#site-chip').isVisible());
  await tab.keyboard.type('foo');
  assert.deepEqual((await state()).rows, ['foo | GitHub']);
  await tab.keyboard.press('Escape');
  assert.equal((await state()).value, '');
  assert(await tab.locator('#site-chip').isHidden());
  assert.equal(await address.getAttribute('placeholder'), 'Enter a web address');
  assert.deepEqual(await tab.evaluate(() => window.calls), []);
  // A search made before is offered again; the arrows fill the field with it.
  await tab.keyboard.type('nothing');
  assert.deepEqual((await state()).rows, ['nothing new under the sun | Google', 'nothing | Google']);
  await tab.keyboard.press('ArrowDown');
  seen = await state();
  assert.deepEqual([seen.value, seen.selected, seen.active], ['nothing new under the sun', ' new under the sun', 0]);
  await tab.keyboard.press('ArrowDown');
  await tab.keyboard.press('ArrowDown');
  seen = await state();
  assert.deepEqual([seen.value, seen.active], ['nothing', -1]);
  // Words go to the browser's default engine, not to a fixed one.
  await tab.keyboard.press('Enter');
  assert.deepEqual(await tab.evaluate(() => window.calls), [['search', { text: 'nothing', disposition: 'CURRENT_TAB' }]]);
  // A typo in a site's name still finds it, words find pages by title or
  // path, a bookmark is marked, and an address offers no search.
  const type = async text => { await address.fill(''); await tab.keyboard.type(text); return state(); };
  assert.equal((await type('githb')).rows[0], 'github.com | GitHub');
  assert.equal((await type('settings')).rows[0], 'openrouter.ai/settings/credits | Credits | OpenRouter');
  assert.deepEqual((await type('hello world')).rows, ['hello world | Google']);
  assert.equal(await tab.locator('#suggestions .row:has(.mark)').count(), 0);
  assert.equal((await type('yo')).rows[1], 'youtube.com | YouTube');
  assert.equal(await tab.locator('#suggestions .row:has(.mark)').count(), 1);
  seen = await type('localhost:3000');
  assert.deepEqual([seen.value, seen.selected, seen.rows], ['localhost:3000/dashboard', '/dashboard', ['localhost:3000/dashboard | Dashboard']]);
  // Escape on an empty, unused new tab closes it.
  await address.fill('');
  await tab.evaluate(() => { window.calls.length = 0; });
  await tab.keyboard.press('Escape');
  assert.deepEqual((await tab.evaluate(() => window.calls))[0], ['close']);
  // Return on a finished address goes there, in place of the new tab.
  await tab.route('https://github.com/', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Visited</title>' }));
  await tab.keyboard.type('gith');
  await Promise.all([tab.waitForURL('https://github.com/'), tab.keyboard.press('Enter')]);
  assert.deepEqual(fieldErrors, []);

  // Static fallback keeps the upload and search usable without WebGL.
  const fallback = await browser.newPage();
  await fallback.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...args) { return kind === 'webgl2' ? null : original.call(this, kind, ...args); };
  });
  await fallback.goto(url);
  // Without the shader there is no lens: the field keeps its frosted pane.
  assert((await fallback.locator('#query').evaluate(input => getComputedStyle(input).backdropFilter)).includes('blur(22px)'));
  assert.equal(await fallback.evaluate(() => document.documentElement.dataset.glass), undefined);
  await fallback.locator('#background-file').setInputFiles(image);
  await fallback.waitForFunction(() => document.documentElement.dataset.background === 'image' && !document.querySelector('#upload-background').disabled);
  assert(await fallback.locator('#custom-background').isVisible());
  await fallback.locator('#query').fill('still usable');
  assert.equal(await fallback.locator('#query').inputValue(), 'still usable');

  console.log('PASS: live image-texture shader, image colors/cover crop, texture size cap, animated pixels, reduced motion, hidden-tab pause/resume, local persistence/reset, invalid-image recovery, glass input/placement/hit test, New Tab title, narrow layout, search, no-WebGL fallback, no background requests, liquid-glass lens placement, light/dark appearance, and the address field: completion, rows, arrows, Tab site search, Escape, typo, bookmarks, default-engine search. Search navigation intercepted.');
} finally {
  if (browser) await browser.close();
  server.close();
}
