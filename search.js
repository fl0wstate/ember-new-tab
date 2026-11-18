(() => {
  'use strict';

  // Search's own new tab is a native address field. An extension page gets no
  // access to it, so this file rebuilds what that field does, from the
  // browser's history, bookmarks and search APIs: the host completed as you
  // type, the rows under the field, Tab to search a site, Escape, and Return
  // through the default engine. Without those APIs (the manifest's
  // permissions refused, or the page opened outside the browser) it falls
  // back to a plain field.
  const form = document.getElementById('search');
  const input = document.getElementById('query');
  const list = document.getElementById('suggestions');
  const chip = document.getElementById('site-chip');
  const api = globalThis.chrome ?? globalThis.browser;
  const placeholder = input.placeholder;

  // Reassert the page title after restore/focus so Search needn't fall back
  // to the extension URL's generic "Extension page" label.
  const resetTitle = () => { document.title = 'New Tab'; };
  resetTitle();
  addEventListener('pageshow', resetTitle);
  input.addEventListener('focus', resetTitle);

  const MAX_ROWS = 3;
  const HALF_LIFE = 30 * 864e5; // A visit counts half as much a month later.
  const FALLBACK_SEARCH = 'https://www.google.com/search?q=%s';

  // Result pages of these engines are offered as past searches, not as pages.
  const ENGINES = [
    { name: 'Google', host: /(^|\.)google\.[a-z.]+$/, path: '/search', param: 'q' },
    { name: 'DuckDuckGo', host: /(^|\.)duckduckgo\.com$/, path: '/', param: 'q' },
    { name: 'Bing', host: /(^|\.)bing\.com$/, path: '/search', param: 'q' },
    { name: 'Ecosia', host: /(^|\.)ecosia\.org$/, path: '/search', param: 'q' },
    { name: 'Startpage', host: /(^|\.)startpage\.com$/, path: '/sp/search', param: 'query' },
    { name: 'Kagi', host: /(^|\.)kagi\.com$/, path: '/search', param: 'q' },
    { name: 'Brave', host: /^search\.brave\.com$/, path: '/search', param: 'q' },
    { name: 'Qwant', host: /(^|\.)qwant\.com$/, path: '/', param: 'q' },
  ];

  // The sites Search's field searches with Tab. Sites it learned from pages
  // you visited live in the browser's own file, out of an extension's reach.
  const SITES = [
    { name: 'YouTube', host: 'youtube.com', template: 'https://www.youtube.com/results?search_query=%s' },
    { name: 'GitHub', host: 'github.com', template: 'https://github.com/search?q=%s' },
    { name: 'Reddit', host: 'reddit.com', template: 'https://www.reddit.com/search/?q=%s' },
    { name: 'X', host: 'x.com', template: 'https://x.com/search?q=%s' },
    { name: 'ChatGPT', host: 'chatgpt.com', template: 'https://chatgpt.com/?q=%s' },
    { name: 'Claude', host: 'claude.ai', template: 'https://claude.ai/new?q=%s' },
    { name: 'Perplexity', host: 'perplexity.ai', template: 'https://www.perplexity.ai/search?q=%s' },
    { name: 'Wikipedia', host: 'wikipedia.org', template: 'https://en.wikipedia.org/w/index.php?search=%s' },
    { name: 'Stack Overflow', host: 'stackoverflow.com', template: 'https://stackoverflow.com/search?q=%s' },
    { name: 'MDN', host: 'developer.mozilla.org', template: 'https://developer.mozilla.org/search?q=%s' },
    { name: 'Google Maps', host: 'maps.google.com', template: 'https://www.google.com/maps/search/%s' },
    { name: 'IMDb', host: 'imdb.com', template: 'https://www.imdb.com/find/?q=%s' },
    { name: 'Spotify', host: 'open.spotify.com', template: 'https://open.spotify.com/search/%s' },
    { name: 'Figma Community', host: 'figma.com', template: 'https://www.figma.com/community/search?resource_type=mixed&sort_by=relevancy&query=%s' },
  ];

  // ---- What the browser knows: read once, a little after the page shows. ----

  let index = null;
  let loading = null;
  const attempt = async call => { try { return (await call()) ?? []; } catch { return []; } };
  const words = text => ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')}`;

  // "https://www.github.com/a?b" → origin, "github.com", "/a?b" ("" for the root).
  function parts(url) {
    const match = /^(https?:\/\/)([^/?#]+)([^#]*)/i.exec(url);
    if (!match) return null;
    const host = match[2].toLowerCase().replace(/^www\./, '');
    if (host.includes('@')) return null;
    const rest = match[3] === '/' ? '' : match[3];
    return { origin: match[1].toLowerCase() + match[2], host, rest, display: host + rest };
  }

  function pastSearch(page) {
    const mark = page.rest.indexOf('?');
    if (mark < 0) return null;
    const path = page.rest.slice(0, mark) || '/';
    const engine = ENGINES.find(e => e.path === path && e.host.test(page.host));
    if (!engine) return null;
    try {
      const query = new URLSearchParams(page.rest.slice(mark)).get(engine.param)?.trim();
      return query ? { engine, query } : null;
    } catch { return null; }
  }

  function build(history, bookmarkTree, tabs) {
    const now = Date.now();
    const pages = [];
    const hosts = new Map();
    const searches = new Map();
    let engine = null;
    let engineSeen = 0;
    for (const item of history) {
      const page = item.url && parts(item.url);
      if (!page) continue;
      const seen = item.lastVisitTime || 0;
      page.url = item.url;
      page.title = item.title || '';
      page.score = Math.max(1, item.visitCount || 1) * 0.5 ** (Math.max(0, now - seen) / HALF_LIFE);
      let host = hosts.get(page.host);
      if (!host) hosts.set(page.host, host = { host: page.host, labels: ` ${page.host.replaceAll('.', ' ')}`, origin: page.origin, score: 0, best: 0, title: '' });
      host.score += page.score;
      const searched = pastSearch(page);
      if (searched) {
        const key = searched.query.toLowerCase();
        const known = searches.get(key);
        if (!known || seen > known.seen) {
          searches.set(key, { query: searched.query, key, engine: searched.engine.name, seen, score: page.score + (known?.score ?? 0) });
        } else known.score += page.score;
        if (seen > engineSeen) { engineSeen = seen; engine = searched.engine.name; }
        continue;
      }
      page.hay = words(`${page.rest} ${page.title}`);
      pages.push(page);
      if (page.score > host.best) { host.best = page.score; host.origin = page.origin; }
      if (!page.rest) { host.title = page.title; host.origin = page.origin; host.best = Infinity; }
    }
    pages.sort((a, b) => b.score - a.score);
    const bookmarks = [];
    const walk = nodes => {
      for (const node of nodes || []) {
        const page = node.url && parts(node.url);
        if (page) bookmarks.push({ ...page, url: node.url, title: node.title || '', hay: words(node.title || '') });
        if (node.children) walk(node.children);
      }
    };
    walk(bookmarkTree);
    const icons = new Map();
    for (const tab of tabs) {
      const page = tab.favIconUrl?.startsWith('data:image/') && tab.url && parts(tab.url);
      if (page && !icons.has(page.host)) icons.set(page.host, tab.favIconUrl);
    }
    return { pages, hosts: [...hosts.values()].sort((a, b) => b.score - a.score), hostByName: hosts,
      searches: [...searches.values()].sort((a, b) => b.seen - a.seen), bookmarks, icons, engine };
  }

  function load() {
    loading ??= (async () => {
      if (!api?.history?.search) { index = build([], [], []); return; }
      const [history, bookmarkTree, tabs] = await Promise.all([
        attempt(() => api.history.search({ text: '', maxResults: 100000, startTime: 0 })),
        attempt(() => api.bookmarks.getTree()),
        attempt(() => api.tabs.query({})),
      ]);
      index = build(history, bookmarkTree, tabs);
    })();
    return loading;
  }

  // ---- Where Return goes. ----

  // What the field takes for an address, and the scheme it gets.
  function address(text) {
    if (!text || /\s/.test(text)) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
      try { return new URL(text).href; } catch { return null; }
    }
    if (text.includes('://')) return null;
    const typedHost = /^[^/?#]*/.exec(text)[0].toLowerCase();
    let url;
    try { url = new URL(`http://${text}`); } catch { return null; }
    if (!url.hostname || url.username || url.password) return null;
    const bare = typedHost.replace(/:\d+$/, '');
    const known = index?.hostByName.get(typedHost.replace(/^www\./, ''));
    if (known) return known.origin.replace(/\/\/.*/, '//') + text;
    const local = bare === 'localhost' || bare.endsWith('.localhost') || bare.endsWith('.local')
      || /^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.startsWith('[');
    if (local) return `http://${text}`;
    if (/^([a-z0-9¡-￿-]+\.)+[a-z¡-￿]{2,}$/i.test(bare)) return `https://${text}`;
    return null;
  }

  // A typed address replaces the new tab, as it does in Search's own: Back
  // doesn't return to an empty new tab.
  const visit = url => location.replace(url);

  function search(text) {
    const fallback = () => visit(FALLBACK_SEARCH.replace('%s', encodeURIComponent(text)));
    if (!api?.search?.query) { fallback(); return; }
    // The browser's default engine, whichever it is.
    try { Promise.resolve(api.search.query({ text, disposition: 'CURRENT_TAB' })).catch(fallback); }
    catch { fallback(); }
  }

  // ---- The rows under the field. ----

  function near(a, b) { // Within one typo: a letter wrong, missing, extra or swapped.
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    const tail = (x, y) => a.slice(i + x) === b.slice(i + y);
    return tail(1, 1) || tail(0, 1) || tail(1, 0)
      || (a[i] === b[i + 1] && a[i + 1] === b[i] && tail(2, 2));
  }

  const urlRow = (page, extra) => ({ kind: 'url', url: page.url ?? `${page.origin}/`, host: page.host,
    text: page.display ?? page.host, detail: page.title, ...extra });

  function matches(typed) {
    const q = typed.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
    const out = { rows: [], completion: null, q };
    if (!q || !index) return out;
    const tokens = q.split(/\s+/);
    const single = tokens.length === 1;
    const wordy = tokens.every(t => t.length >= 3 || !single) && q.length >= 3;
    const hasAll = hay => tokens.every(t => hay.includes(` ${t}`));
    const hostHit = h => h.host.startsWith(q) || (q.includes('.') ? h.host.includes(`.${q}`) : h.labels.includes(` ${q}`));

    const found = [];
    const taken = new Set();
    if (single) {
      for (const host of index.hosts) {
        if (!hostHit(host)) continue;
        taken.add(host.host);
        // Typed out in full and never visited at its root: its pages say more.
        if (host.host !== q || host.best === Infinity) found.push({ score: host.score, row: urlRow(host) });
      }
    }
    for (const page of index.pages) {
      if (!page.rest && taken.has(page.host)) continue; // Its site's row stands for it.
      const byAddress = single && (page.display.startsWith(q) || taken.has(page.host));
      if (byAddress) found.push({ score: page.score, row: urlRow(page) });
      else if (wordy && hasAll(page.hay)) found.push({ score: page.score * 0.7, row: urlRow(page) });
    }
    for (const past of index.searches) {
      if (past.key !== q && (past.key.startsWith(q) || (wordy && hasAll(` ${past.key}`)))) {
        found.push({ score: past.score, row: { kind: 'past', text: past.query, detail: past.engine } });
      }
    }
    if (!found.length && single && q.length >= 4) { // Forgive a typo in a site's name.
      const close = index.hosts.filter(h => h.labels.trim().split(' ').some(label =>
        near(q, label) || near(q, label.slice(0, q.length)) || near(q, label.slice(0, q.length + 1))));
      for (const host of close) { found.push({ score: host.score, row: urlRow(host) }); taken.add(host.host); }
      for (const page of index.pages) if (page.rest && taken.has(page.host)) found.push({ score: page.score, row: urlRow(page) });
    }
    found.sort((a, b) => b.score - a.score);

    const rows = [];
    if (q.length >= 2) {
      for (const mark of index.bookmarks) {
        if (rows.length === 2) break;
        const hit = single
          ? mark.display.startsWith(q) || ` ${mark.host.replaceAll('.', ' ')}`.includes(` ${q}`) || mark.hay.includes(` ${q}`)
          : hasAll(mark.hay);
        if (hit && !rows.some(r => r.url === mark.url)) rows.push(urlRow(mark, { bookmark: true }));
      }
    }
    for (const item of found) {
      if (rows.length === MAX_ROWS) break;
      rows.push(item.row);
    }
    out.rows = rows;

    // The site finished in the field itself; a whole host, then its best page.
    if (single && typed.toLowerCase() === q) {
      const site = index.hosts.find(h => h.host.startsWith(q) && h.host !== q);
      const page = !site && index.pages.find(p => p.rest && p.display.startsWith(q) && p.display !== q);
      if (site) out.completion = { rest: site.host.slice(q.length), url: `${site.origin}/` };
      else if (page) out.completion = { rest: page.display.slice(q.length), url: page.url };
    }
    return out;
  }

  const siteFor = q => q.length >= 2 && !/\s/.test(q)
    && SITES.find(s => s.host.startsWith(q) || s.name.toLowerCase().replaceAll(' ', '').startsWith(q));

  // ---- Drawing. ----

  // A new tab nothing was opened in: no page to go back or forward to.
  const unused = () => (globalThis.navigation
    ? !navigation.canGoBack && !navigation.canGoForward : history.length <= 1);

  const SVG = 'http://www.w3.org/2000/svg';
  function glyph(paths) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of paths) {
      const path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }
  const GLYPHS = {
    search: ['M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z', 'm10.4 10.4 3.1 3.1'],
    past: ['M2.5 8a5.5 5.5 0 1 0 1.7-4', 'M2.2 2.4v2.4h2.4', 'M8 5v3.2l2 1.3'],
    bookmark: ['M4.5 2.5h7v11L8 11l-3.5 2.5Z'],
  };

  function icon(host, fallback) {
    const box = document.createElement('span');
    box.className = 'icon';
    let data;
    for (let name = host; name && !data; name = name.includes('.') ? name.slice(name.indexOf('.') + 1) : '') {
      data = name.includes('.') || name === host ? index?.icons.get(name) : undefined;
    }
    if (data) {
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.src = data;
      box.append(img);
    } else if (fallback) {
      box.append(glyph(GLYPHS[fallback]));
    } else {
      box.classList.add('letter');
      box.textContent = (host || '?')[0].toUpperCase();
    }
    return box;
  }

  const span = (className, text) => {
    const node = document.createElement('span');
    node.className = className;
    node.textContent = text;
    return node;
  };

  let rows = [];        // What is listed now.
  let active = -1;      // The row the arrows are on; -1 is the field itself.
  let typed = '';       // What the keys put in, without what the field finished.
  let completion = null;
  let site = null;      // The site Tab chose to search.
  let revision = 0;

  function draw() {
    list.replaceChildren(...rows.map((row, at) => {
      const item = document.createElement('li');
      item.id = `suggestion-${at}`;
      item.className = 'row';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(at === active));
      item.dataset.at = at;
      const engineHost = row.kind === 'search' && ENGINES.find(e => e.name === row.detail);
      if (row.kind === 'url') item.append(icon(row.host));
      else if (row.kind === 'past') item.append(icon(null, 'past'));
      else if (row.kind === 'site' || row.kind === 'sitesearch') item.append(icon(row.site.host, 'search'));
      else item.append(icon(engineHost ? [...(index?.icons.keys() ?? [])].find(h => engineHost.host.test(h)) : null, 'search'));
      item.append(span('main', row.text));
      if (row.detail) item.append(span('detail', row.detail));
      if (row.kind === 'site') item.append(span('key', 'Tab'));
      if (row.bookmark) { const mark = span('mark', ''); mark.append(glyph(GLYPHS.bookmark)); item.append(mark); }
      return item;
    }));
    list.hidden = !rows.length;
    input.setAttribute('aria-expanded', String(!list.hidden));
    if (active >= 0) input.setAttribute('aria-activedescendant', `suggestion-${active}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function compute(text) {
    const trimmed = text.trim();
    if (site) return { rows: trimmed ? [{ kind: 'sitesearch', site, text: trimmed, detail: site.name }] : [], completion: null };
    if (!trimmed) return { rows: [], completion: null };
    const found = matches(text);
    const next = [];
    const hint = siteFor(found.q);
    if (hint) next.push({ kind: 'site', site: hint, text: `Search ${hint.name}` });
    next.push(...found.rows);
    // An address goes where it says; anything else can be searched for.
    if (!address(trimmed)) next.push({ kind: 'search', text: trimmed, detail: index?.engine || '' });
    return { rows: next, completion: found.completion };
  }

  // `finish`: the keys only added to the end, so the field may complete it.
  function refresh(finish) {
    typed = input.value;
    active = -1;
    const mine = ++revision;
    const apply = () => {
      if (mine !== revision) return;
      const result = compute(typed);
      rows = result.rows;
      completion = null;
      if (finish && result.completion && document.activeElement === input) {
        completion = { ...result.completion, full: typed + result.completion.rest };
        input.value = completion.full;
        input.setSelectionRange(typed.length, completion.full.length);
      }
      draw();
    };
    if (index) apply();
    else { rows = []; draw(); load().then(apply); }
  }

  function setSite(next) {
    site = next;
    chip.hidden = !site;
    chip.replaceChildren();
    if (site) {
      chip.append(icon(site.host, 'search'), span('name', site.name));
      input.placeholder = `Search ${site.name}`;
      input.style.paddingLeft = `${chip.offsetWidth + 24}px`;
    } else {
      input.placeholder = placeholder;
      input.style.paddingLeft = '';
    }
    input.value = '';
    refresh(false);
  }

  function go(row) {
    if (row.kind === 'url') visit(row.url);
    else if (row.kind === 'site') setSite(row.site);
    else if (row.kind === 'sitesearch') visit(row.site.template.replace('%s', encodeURIComponent(row.text)));
    else search(row.text);
  }

  function move(step) {
    if (!rows.length) return;
    const count = rows.length + 1; // The field itself is one of the stops.
    active = ((active + 1 + step + count) % count) - 1;
    completion = null;
    if (active < 0) {
      input.value = typed;
    } else {
      const row = rows[active];
      const fill = row.kind === 'site' ? typed : row.text;
      input.value = fill;
      const from = fill.toLowerCase().startsWith(typed.toLowerCase()) ? typed.length : fill.length;
      input.setSelectionRange(from, fill.length);
    }
    draw();
  }

  input.addEventListener('input', event => {
    const adding = !event.isComposing && (event.inputType || '').startsWith('insert')
      && input.selectionStart === input.value.length;
    refresh(adding);
  });

  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!rows.length) return;
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Tab' && !event.shiftKey && !site) {
      const hint = rows.find(row => row.kind === 'site');
      if (!hint) return;
      event.preventDefault();
      setSite(hint.site);
    } else if (event.key === 'Backspace' && site && !input.value) {
      event.preventDefault();
      setSite(null);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (input.value || site) {
        // First Escape empties the field.
        if (site) setSite(null);
        else { input.value = ''; refresh(false); }
      } else if (api?.tabs && unused()) {
        // A second one closes a new tab nothing was done with.
        window.close();
        try { Promise.resolve(api.tabs.getCurrent()).then(tab => tab && api.tabs.remove(tab.id)).catch(() => {}); } catch { /* Stays open. */ }
      }
    }
  });

  form.addEventListener('submit', event => {
    event.preventDefault();
    const text = input.value.trim();
    if (active >= 0 && rows[active]) { go(rows[active]); return; }
    if (!text) return;
    if (site) { go({ kind: 'sitesearch', site, text }); return; }
    if (completion && input.value === completion.full) { visit(completion.url); return; }
    const url = address(text);
    if (url) visit(url); else search(text);
  });

  // The field keeps the keys while a row is pressed.
  list.addEventListener('mousedown', event => event.preventDefault());
  list.addEventListener('click', event => {
    const item = event.target.closest('.row');
    if (item) go(rows[Number(item.dataset.at)]);
  });
  input.addEventListener('blur', () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); });
  input.addEventListener('focus', () => { if (rows.length) { list.hidden = false; input.setAttribute('aria-expanded', 'true'); } });

  // Read history once the page has shown, so the first key finds it ready;
  // keys that beat the scripts to the field are answered as soon as it is.
  if (input.value) refresh(false);
  else if (globalThis.requestIdleCallback) requestIdleCallback(load, { timeout: 300 });
  else setTimeout(load, 60);
})();
