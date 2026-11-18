(() => {
  'use strict';

  const image = document.getElementById('custom-background');
  const fileInput = document.getElementById('background-file');
  const menu = document.getElementById('background-menu');
  const upload = document.getElementById('upload-background');
  const reset = document.getElementById('reset-background');
  const status = document.getElementById('background-status');
  const root = document.documentElement;
  // The shader draws about a third of the window's pixels, so a picture
  // larger than this is only more to read, decode and upload in every tab.
  const TEXTURE_EDGE = 1280;
  const MODE_KEY = 'ember.background';
  let current = null;    // The picture as it is kept: a small JPEG.
  let fallbackURL = null;
  let revision = 0;
  let busy = false;

  // Known before anything is read, so a tab with a picture never opens on
  // the embers and then changes.
  const remembered = (() => { try { return localStorage.getItem(MODE_KEY); } catch { return null; } })();
  root.dataset.background = remembered === 'image' ? 'image' : 'shader';
  const remember = mode => { try { localStorage.setItem(MODE_KEY, mode); } catch { /* Only the first frame's colour. */ } };

  const database = new Promise((resolve, reject) => {
    const request = indexedDB.open('ember-background', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('settings');
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Local image storage is busy.'));
  });
  // Handle restricted storage even when the user never opens the picker.
  database.catch(() => {});

  // `texture` is the picture ready for the shader. `image` is what versions
  // before 0.4 kept: the file as chosen, turned into a texture when first met.
  async function stored(operation, key, value) {
    const db = await database;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('settings', operation === 'read' ? 'readonly' : 'readwrite');
      const store = transaction.objectStore('settings');
      const request = operation === 'read' ? store.get(key)
        : operation === 'write' ? store.put(value, key) : store.delete(key);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Image storage interrupted.'));
    });
  }

  function notify(text = '') {
    status.textContent = text;
    status.hidden = !text;
  }

  function setMode(mode, detail = null) {
    root.dataset.background = mode;
    remember(mode);
    document.dispatchEvent(new CustomEvent('backgroundchange', { detail }));
  }

  function hideFallback() {
    image.hidden = true;
    image.removeAttribute('src');
    if (fallbackURL) URL.revokeObjectURL(fallbackURL);
    fallbackURL = null;
  }

  // Without the shader the picture is shown as it is.
  document.addEventListener('backgrounderror', event => {
    if (!current) return;
    hideFallback();
    fallbackURL = URL.createObjectURL(current);
    image.src = fallbackURL;
    image.hidden = false;
    if (event.detail?.reason !== 'unavailable') {
      notify('The shader could not process this image. Showing the original image as a fallback.');
    }
  });

  async function decoded(blob) {
    const url = URL.createObjectURL(blob);
    try {
      const picture = new Image();
      picture.src = url;
      await picture.decode();
      return picture;
    } finally {
      // Once decoded the picture no longer needs its address.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }

  // Any file the browser can show, as a JPEG no larger than the shader needs.
  // Clear parts become black, which is what the shader made of them anyway.
  async function textureFrom(file) {
    let picture;
    try { picture = await decoded(file); }
    catch { throw new Error('This image could not be opened. Try PNG, JPEG, WebP, AVIF, SVG, or GIF.'); }
    const scale = Math.min(1, TEXTURE_EDGE / Math.max(picture.naturalWidth, picture.naturalHeight));
    const staging = document.createElement('canvas');
    staging.width = Math.max(1, Math.round(picture.naturalWidth * scale));
    staging.height = Math.max(1, Math.round(picture.naturalHeight * scale));
    const context = staging.getContext('2d', { alpha: false });
    context.fillStyle = '#000';
    context.fillRect(0, 0, staging.width, staging.height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(picture, 0, 0, staging.width, staging.height);
    const blob = await new Promise(resolve => staging.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) throw new Error('This image could not be prepared for the shader.');
    return blob;
  }

  // Decoded off the page's thread, and already turned the way a texture lies.
  async function show(blob, expectedRevision) {
    let detail;
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'flipY' });
      detail = { source: bitmap, width: bitmap.width, height: bitmap.height, flipped: true };
    } catch {
      const picture = await decoded(blob);
      detail = { source: picture, width: picture.naturalWidth, height: picture.naturalHeight, flipped: false };
    }
    if (expectedRevision !== revision) { detail.source.close?.(); return false; }
    current = blob;
    hideFallback();
    setMode('image', detail);
    return true;
  }

  function showShader() {
    current = null;
    hideFallback();
    setMode('shader');
  }

  function setBusy(value) {
    busy = value;
    upload.disabled = value;
    reset.disabled = value;
  }

  upload.addEventListener('click', () => {
    if (busy) return;
    menu.hidePopover();
    notify();
    fileInput.click();
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = ''; // Picking the same file again should still work.
    if (!file || busy) return;
    const selectedRevision = ++revision;
    notify();
    if (file.size > 50 * 1024 * 1024) { notify('Choose an image smaller than 50 MB.'); return; }
    if (file.type && !file.type.startsWith('image/')) { notify('Choose an image file.'); return; }
    setBusy(true);
    try {
      const texture = await textureFrom(file);
      if (await show(texture, selectedRevision)) {
        try { await stored('write', 'texture', texture); await stored('delete', 'image'); }
        catch { notify('Image applied to this tab, but local storage could not save it for new tabs.'); }
      }
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy(false);
    }
  });

  reset.addEventListener('click', async () => {
    if (busy) return;
    ++revision;
    menu.hidePopover();
    notify();
    showShader();
    setBusy(true);
    try { await stored('delete', 'texture'); await stored('delete', 'image'); }
    catch { notify('Animation restored here, but the saved image could not be cleared for new tabs.'); }
    finally { setBusy(false); }
  });

  const initialRevision = revision;
  (async () => {
    let texture = await stored('read', 'texture');
    if (!(texture instanceof Blob)) {
      const original = await stored('read', 'image');
      if (!(original instanceof Blob)) return false;
      texture = await textureFrom(original);
      stored('write', 'texture', texture).then(() => stored('delete', 'image')).catch(() => {});
    }
    return revision === initialRevision && show(texture, initialRevision);
  })().then(shown => {
    // Remembered a picture that is no longer there: the embers, now.
    if (!shown && revision === initialRevision && root.dataset.background === 'image') showShader();
  }).catch(() => {
    // A damaged/missing saved image never blocks the shader or search.
    if (revision === initialRevision && root.dataset.background === 'image') showShader();
  });
})();
