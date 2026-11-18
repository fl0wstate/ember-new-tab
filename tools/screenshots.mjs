// Regenerates docs/screenshots. Run: npm run screenshots
// Every picture is drawn from stand-in history and bookmarks defined below,
// never from a real browser profile.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs', 'screenshots');
const served = new Set(['newtab.html', 'background.css', 'background.js', 'search.js', 'wallpaper.js']);
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
const server = http.createServer((request, response) => {
  const name = new URL(request.url, 'http://local').pathname.slice(1) || 'newtab.html';
  if (!served.has(name)) { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', types[path.extname(name)]);
  response.end(fs.readFileSync(path.join(root, name)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

// A dusk landscape, so the image mode has something to weave.
const landscape = { name: 'dusk.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="2560" height="1600">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1b2a55"/><stop offset=".45" stop-color="#7a4a86"/>
      <stop offset=".7" stop-color="#f08a4b"/><stop offset="1" stop-color="#ffd89a"/>
    </linearGradient>
    <radialGradient id="sun" cx=".68" cy=".66" r=".3">
      <stop offset="0" stop-color="#fff3c4"/><stop offset=".25" stop-color="#ffc56b" stop-opacity=".9"/>
      <stop offset="1" stop-color="#ffc56b" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="2560" height="1600" fill="url(#sky)"/>
  <rect width="2560" height="1600" fill="url(#sun)"/>
  <path d="M0 1080 L420 760 L760 1010 L1180 640 L1620 1000 L1980 800 L2560 1090 V1600 H0Z" fill="#3a2f5e"/>
  <path d="M0 1240 L360 1040 L820 1230 L1320 980 L1800 1220 L2200 1100 L2560 1260 V1600 H0Z" fill="#231c3f"/>
  <path d="M0 1400 L520 1260 L1100 1420 L1700 1290 L2560 1440 V1600 H0Z" fill="#120f24"/>
</svg>`) };

function standIn() {
  const day = 864e5, now = Date.now();
  const visit = (url, title, visitCount, age = 0) => ({ url, title, visitCount, typedCount: 0, lastVisitTime: now - age * day });
  window.chrome = {
    history: { search: async () => [
      visit('https://github.com/', 'GitHub', 18),
      visit('https://github.com/notifications', 'Notifications · GitHub', 9),
      visit('https://github.com/explore', 'Explore · GitHub', 4),
      visit('https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API', 'WebGL: 2D and 3D graphics for the web | MDN', 6),
      visit('https://www.wikipedia.org/', 'Wikipedia', 7),
      visit('https://www.google.com/search?q=dithering%20algorithms%20compared', 'dithering algorithms compared - Google Search', 3),
      visit('https://www.google.com/search?q=dithering%20bayer%20matrix', 'dithering bayer matrix - Google Search', 2, 2),
      visit('http://localhost:3000/dashboard', 'Dashboard', 5),
    ] },
    bookmarks: { getTree: async () => [{ children: [{ title: 'YouTube', url: 'https://www.youtube.com/' }] }] },
    tabs: { query: async () => [], getCurrent: async () => ({ id: 1 }), remove: async () => {} },
    search: { query: async () => {} },
  };
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
async function shot(name, { scheme = 'dark', image = false, steps = async () => {} } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: scheme });
  await page.addInitScript(standIn);
  await page.goto(url);
  await page.waitForSelector('canvas.drawn');
  if (image) {
    await page.locator('#background-file').setInputFiles(landscape);
    await page.waitForFunction(() => document.documentElement.dataset.background === 'image' && !document.querySelector('#upload-background').disabled);
  }
  await page.locator('#query').focus();
  await steps(page);
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  await page.close();
  console.log(name);
}
const type = text => async page => { await page.keyboard.type(text, { delay: 30 }); await page.waitForSelector('#suggestions .row'); };

// Every state in both appearances.
const states = [
  ['new-tab', {}],
  ['suggestions', { steps: type('gi') }],
  ['past-search', { steps: async page => { await type('dith')(page); await page.keyboard.press('ArrowDown'); } }],
  ['site-search', { steps: async page => { await type('yo')(page); await page.keyboard.press('Tab'); await page.keyboard.type('lofi mix', { delay: 30 }); } }],
  ['image', { image: true }],
  ['image-suggestions', { image: true, steps: type('gi') }],
  ['menu', { steps: async page => { await page.locator('#background-options').click(); } }],
];
for (const [name, options] of states) {
  for (const scheme of ['dark', 'light']) await shot(`${name}-${scheme}`, { ...options, scheme });
}

await browser.close();
server.close();
