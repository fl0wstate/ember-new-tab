# How Ember is built

This is the long version of the README: what each file does, why it does it that way, and how the numbers were taken. Read the README first.

- [The page](#the-page)
- [Start-up order](#start-up-order)
- [search.js — the address field](#searchjs--the-address-field)
- [background.js — the shader](#backgroundjs--the-shader)
- [wallpaper.js — the image](#wallpaperjs--the-image)
- [How the scripts talk](#how-the-scripts-talk)
- [Fallbacks](#fallbacks)
- [How the native field was matched](#how-the-native-field-was-matched)
- [Measurements](#measurements)
- [Things that look odd and are deliberate](#things-that-look-odd-and-are-deliberate)

## The page

`newtab.html` is one canvas, one form and a menu:

```
<canvas id="background">         the shader and the glass, behind everything
<img id="custom-background">     the image as a plain picture; only without WebGL
<form id="search">
  <span id="site-chip">          the site Tab chose, at the head of the field
  <input id="query">             the field
  <ul id="suggestions">          the rows
<button id="background-options"> opens the menu (a popover)
<div id="background-menu">       Upload / Reset
<input type="file">, <p role="status">
```

The content security policy in `manifest.json` allows scripts and styles from the extension only, images from the extension plus `blob:` and `data:` (the stored image and tab icons), and no connections at all (`connect-src 'none'`). There are no inline scripts or styles; the scripts set styles through the CSSOM, which the policy allows.

## Start-up order

The three scripts are `defer`red and run in this order, and the order is the design:

1. **`search.js`** attaches the field's listeners. From here the field answers keys. Reading history is put off to an idle callback (300 ms at most) so it does not sit in front of the first paint; a key that arrives before the index does is answered the moment the index is ready.
2. **`background.js`** only registers a listener and schedules its real start for *after the first frame* (`requestAnimationFrame` then `setTimeout 0`). Creating the WebGL context and compiling two shader programs happens with the field already on screen.
3. **`wallpaper.js`** sets `data-background` on `<html>` from `localStorage` synchronously — so the page knows before anything is read from disk whether an image is coming — then opens IndexedDB and reads the image.

Shader compilation does not block either: with `KHR_parallel_shader_compile` the script polls `COMPLETION_STATUS_KHR` on a timer and asks for the link status only once the driver is done. Asking earlier would stall the page until the compile finished.

No orange flash: if an image is stored, the canvas stays transparent (opacity 0) over a dark page until the image's first frame is ready, then fades in over 140 ms. Only if no image arrives within 1.5 s do the embers show instead. The ember-coloured CSS gradient that stands in for the shader applies only under `data-background="shader"`.

## search.js — the address field

### The index

Built once per new tab by `build()` from three calls made together:

| Call | Used for |
|---|---|
| `chrome.history.search({ text: '', maxResults: 100000, startTime: 0 })` | sites, pages, past searches |
| `chrome.bookmarks.getTree()` | bookmarks |
| `chrome.tabs.query({})` | `favIconUrl` of open tabs, when it is a `data:` image |

Each history entry is split by one regular expression (not `new URL`, which is several times slower over thousands of entries) into origin, host without `www.`, and the rest. Its weight is

```
score = max(1, visitCount) × 0.5 ^ (age of last visit / 30 days)
```

Then:

- If the entry is a result page of a known search engine (`ENGINES`: host pattern, path, query parameter), it becomes a **past search** keyed by its words, and is not listed as a page. Its weight still counts towards its site.
- Otherwise it is a **page**, with a precomputed lowercase "haystack" of its path and title in which every word is preceded by a space — so "does any word begin with `x`" is one `includes(' x')`.
- Every entry adds its weight to its **host**. A host remembers the origin of its front page if that was visited, else of its heaviest page, and the front page's title.

The engine named on the search row is the engine of the most recent past search.

### Matching

`matches(typed)` runs on every key over the in-memory index. In order:

1. Hosts whose name, or any dot-separated part of it, begins with the query. A host typed out in full that was never visited at its root is left out — its pages say more.
2. Pages whose address begins with the query, or that belong to a matched host; and, for queries of three letters or more, pages where every query word begins a word of the haystack (weighted ×0.7).
3. Past searches that begin with the query or contain all its words.
4. If nothing was found and the query is one word of four letters or more: hosts with a part within one edit (`near()`: substitution, insertion, deletion, transposition), and their pages.

Everything found is sorted by weight; bookmarks (two at most) go first, then results up to three rows in all. The completion is the heaviest host beginning with the query, or — once a host is typed in full — its heaviest page.

`compute()` wraps that with the site hint row in front and the search row behind, or returns the single row of a site search.

### State

Five variables: `rows`, `active` (the row the arrows are on, −1 for the field), `typed` (the text without the completed part), `completion`, `site`. `revision` discards the result of a refresh that a later key overtook while the index was still loading.

Completion uses the input's own selection: the value becomes typed-plus-rest with the rest selected, so the next key replaces it and Backspace removes it, with no extra bookkeeping. It is offered only when the key added text at the end and no IME composition is under way.

### Going somewhere

- `visit(url)` is `location.replace`, so the new tab does not stay in the tab's history.
- `search(text)` is `chrome.search.query({ text, disposition: 'CURRENT_TAB' })`; if that API is missing or fails it falls back to a Google address, which is also what runs when the page is opened outside a browser extension.
- Escape on an empty field closes the tab only when the tab has nowhere to go back or forward to (`navigation.canGoBack/​canGoForward`, else `history.length`), using `window.close()` and `chrome.tabs.remove` as a second try.

## background.js — the shader

Two programs, two passes per frame, one WebGL 2 context.

### Pass 1 — the scene

Drawn into a framebuffer texture at about one third of the window (never more than 960×600): one full-screen triangle and `fragmentSource`.

- `field()` is three octaves of 2D simplex noise.
- The embers: a warp of two fields, a cloud through the warp, an exponential plume at the lower right, a ribbon; summed to a brightness, quantised to seven steps through an 8×8 Bayer threshold computed from the pixel's bits, coloured by `palette()` (night) or `dayPalette()` (day), and thinned by a second, binary threshold that gives the fabric look.
- With an image (`hasImage`): the texture is cover-fitted, nudged by the warp, its luminance dithered the same way while its chroma is kept. By night the weave lets black through; by day it lets `paper` through and the whole is lifted slightly.
- The centre is shaded (night) or lightened (day) so the field sits on a quiet patch.
- `light` is 0 or 1 from `matchMedia('(prefers-color-scheme: light)')`; a change redraws at once.

### Pass 2 — the glass

Drawn to the canvas, which is the window's size in CSS pixels. `glassSource`:

- Outside any lens: `texelFetch` of the scene — nearest-neighbour, so each shader pixel stays a crisp square. This replaces CSS `image-rendering: pixelated`.
- Inside a lens (up to two: the field and the rows): the distance to a rounded box gives an edge factor; the sampling point is pushed along the corner-aware normal by `edge × REFRACTION + edge¹⁰ × BEVEL_DEPTH`; sixteen samples on a random disc of the pane's `frost` radius are averaged; the result is tinted (smoked or milky by `light`), given two drifting highlights, and a rim that is brighter where it faces up.

The lens rectangles are measured from the DOM (`getBoundingClientRect` of `#query` and `#suggestions`, and their `border-radius`) by `measure()`. A `ResizeObserver` on both calls `relens()`, which measures and draws immediately — rows appear and vanish as fast as keys, and waiting for the next animation frame would leave the glass a frame behind the text.

When the glass is running the script sets `data-glass="on"` on `<html>`, and the stylesheet makes the field and rows transparent and drops their `backdrop-filter`. Without it they keep an ordinary frosted pane.

### The loop

A `setTimeout` loop at 50 ms, not `requestAnimationFrame`. In Search the frame callback fires 30 times a second; a 20 fps target on top of it could only land on every second callback, i.e. 15 fps. `sync()` restarts the loop on visibility change, reduced-motion change, resize, a new image and context loss; it draws one frame and schedules nothing when the page is hidden or motion is reduced.

## wallpaper.js — the image

- **Choosing**: the file is decoded through an `<img>` (which handles SVG and animated formats), drawn onto a canvas scaled so its long side is at most 1280 px, over black, and saved as JPEG at quality 0.9 under the key `texture` in the IndexedDB database `ember-background`, store `settings`.
- **Loading**, in every new tab: the blob is read and decoded with `createImageBitmap(blob, { imageOrientation: 'flipY' })` — off the main thread, and already the way up a texture wants, because `UNPACK_FLIP_Y_WEBGL` does not apply to bitmaps. The bitmap is handed to the shader, uploaded once with mipmaps, and closed.
- **Upgrading**: versions before 0.4 stored the original file under `image`. It is converted to a texture the first time it is met and then deleted.
- `localStorage['ember.background']` (`image` or `shader`) exists only so the first frame knows what is coming.
- A counter (`revision`) drops the result of a slow read or decode if the user has chosen or reset in the meantime.

## How the scripts talk

Through two DOM events on `document` and two attributes on `<html>`; no script calls another.

| Signal | From → to | Meaning |
|---|---|---|
| `backgroundchange`, `detail: { source, width, height, flipped }` or `null` | wallpaper → background | Use this picture; `null` means the embers |
| `backgrounderror`, `detail: { reason: 'unavailable' \| 'failed' }` | background → wallpaper | The shader can't take it; show it as a plain picture (and say so if it `failed`) |
| `data-background="shader" \| "image"` | wallpaper → CSS, background | Which background is, or is about to be, shown |
| `data-glass="on"` | background → CSS | The lens is being drawn; step the CSS panes aside |

`background.js` keeps the last `backgroundchange` it could not yet act on in `pending`, since the image can be ready before the shader is.

## Fallbacks

| Missing | Result |
|---|---|
| WebGL 2, or a shader that will not link | Still gradient (shader mode) or the image in `<img id="custom-background">`; field and rows use CSS frosted panes |
| WebGL context lost | Canvas hidden, glass attribute removed, CSS panes return |
| `createImageBitmap` | Image decoded through `<img>` and flipped on upload |
| `chrome.history` etc. (permissions refused, or not an extension) | Field works as a plain box: addresses open, words go to the fallback engine, no rows |
| IndexedDB | Image applies to the open tab only; a note says so |
| `localStorage` | First frame may be the wrong colour; nothing else |

## How the native field was matched

Search's field is native UI, so its rules were read off its behaviour: with the extension off, the same queries were typed into the real field and the rows, their order, the completed text and the selection were recorded; then the same with the extension on. The differences found in the first version were: no completion, no rows, Escape ignored, a hard-coded search engine, and a field that could lose focus and swallow typing.

The ranking was fitted the same way. Candidate formulas were computed over the real history and compared with the native rows for a set of queries (single letters, prefixes, words in titles, a typo, an address with a port). Summed visits with a 30-day half-life reproduced the native order of sites for all of them; raw visit counts did not.

What could not be read off, or is out of an extension's reach, is listed under *Known differences* in the README.

## Measurements

Taken in Search 1.0.14 on an Apple M2 (8 cores), 2880×1864 display, window 1427×1124 pt, one image set, a history of about 2,000 entries, 45 open tabs.

- **Load and key timings** come from the page itself (`performance` navigation and paint entries, a `MutationObserver` on the canvas, timed API calls, timed synthetic `input` events) reported through `document.title`, over six fresh new tabs. That code was temporary and is not in the repository.
- **CPU and memory** are `top` at 1 s intervals for the browser's main process, its GPU process and the page's WebContent process. **GPU utilisation** is `Device Utilization %` from `ioreg -c IOAccelerator` — a whole-system figure.
- Each configuration was sampled by alternating the Ember tab and a static page (the browser's Settings) in the same window, 6 s each, five or six times, discarding any sample during which focus changed.

| Configuration | GPU utilisation | GPU process | Page process |
|---|---|---|---|
| Static page | 0–2% | 1.4% | 0% |
| Glass at 2×, 30 fps | 19.5–24% | 6.9–8.6% | 6–8% |
| Glass at 1×, 30 fps | 12.8–16% | 6.3–6.6% | 6.2–7.0% |
| Glass at 1×, 20 fps (current) | 9.7–10% | 4.9–5.4% | 5.4–6.7% |

Caveats, all of which apply:

- The machine was in use during the runs. The first row of 2× figures came from an earlier, less controlled protocol than the two below it.
- The page process hosted several Ember tabs, so its figure is not one tab's.
- A stack sample of the page process showed its main thread about 91% idle; the rest was split between WebKit's idle-time garbage collection and presenting the canvas (mostly waiting on the GPU process). Ember's own drawing code did not appear in the sample, which is why that row barely moves with frame rate.
- The native blank new tab was not sampled separately; a static page stands in for it.

## Things that look odd and are deliberate

- **`?v=` on every file in `newtab.html`.** Search caches extension files by address; without a changed query a reloaded extension can keep running old scripts.
- **The canvas is not Retina-sharp.** At 2× the glass pass filled four times the pixels for an edge slightly crisper, and cost about half again as much GPU.
- **The rows are opaque without WebGL and glass with it, never `backdrop-filter` over the canvas.** A blurred CSS pane over a canvas that changes every frame is recomposited every frame.
- **JPEG for the stored image.** The shader multiplies colour by alpha anyway, so flattening onto black loses nothing it would have shown, and the file is a tenth the size of a PNG.
- **Past searches are recognised by address pattern.** An extension cannot ask the browser which engine is the default, only send a search to it.
- **`location.replace` for addresses.** The native new tab leaves nothing behind it in Back; a page that used `assign` would.
