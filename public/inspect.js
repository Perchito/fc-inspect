// Inspector screens: start an inspection, walk the items (photos + notes), sign, submit.
// Photos, notes, deletes and the final submit go through an IndexedDB outbox, so a
// dropped signal never loses work: the outbox retries until the server has it.

// ── outbox ──────────────────────────────────────────────
// entries: {id, seq, inspectionId, method, url, body (Blob|string), contentType, kind, itemKey?}
const idb = new Promise((resolve, reject) => {
  const req = indexedDB.open('fc-inspect', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('outbox', { keyPath: 'id' });
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function store(mode, fn) {
  const db = await idb;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('outbox', mode);
    const result = fn(tx.objectStore('outbox'));
    tx.oncomplete = () => resolve(result?.result);
    tx.onerror = () => reject(tx.error);
  });
}
let seq = Date.now();
const listeners = new Set();
export const outbox = {
  async put(entry) { await store('readwrite', (s) => s.put({ ...entry, seq: seq++ })); notify(); flush(); },
  async remove(id) { await store('readwrite', (s) => s.delete(id)); notify(); },
  async all() { return ((await store('readonly', (s) => s.getAll())) || []).sort((a, b) => a.seq - b.seq); },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};
async function notify() { const all = await outbox.all(); listeners.forEach((fn) => fn(all)); }

let flushing = false, retryTimer = null, retryDelay = 3000;
export let outboxError = '';
export async function flush() {
  if (flushing) return;
  flushing = true; clearTimeout(retryTimer);
  try {
    for (const e of await outbox.all()) {
      let res;
      try {
        res = await fetch(e.url, { method: e.method, body: e.body, headers: e.contentType ? { 'content-type': e.contentType } : {} });
      } catch { return retryLater(); } // offline / dropped connection
      if (res.status === 401) { outboxError = 'Log in again to send your saved work.'; notify(); return; }
      if (res.status >= 500 || res.status === 429 || res.status === 408) return retryLater();
      if (!res.ok) { // the server refused it for good (e.g. inspection already approved): drop it, but say so
        const msg = (await res.json().catch(() => ({}))).error || res.statusText;
        console.warn('[outbox] dropped', e.kind, msg);
        outboxError = `Couldn't save a ${e.kind}: ${msg}`;
      }
      await outbox.remove(e.id);
    }
    retryDelay = 3000;
    if (outboxError.startsWith('Log in')) outboxError = '';
    notify();
  } finally { flushing = false; }
}
function retryLater() {
  retryTimer = setTimeout(flush, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 60_000);
}
addEventListener('online', flush);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && flush());
navigator.storage?.persist?.(); // ask the browser not to evict unsent photos
flush();

// ── location ────────────────────────────────────────────
let lastPos = null, watchId = null, gpsDenied = false;
const posOf = (p) => ({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) });
function watchGps() {
  if (watchId != null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition((p) => { lastPos = posOf(p); gpsDenied = false; },
    (err) => { if (err.code === err.PERMISSION_DENIED) gpsDenied = true; }, { enableHighAccuracy: true, maximumAge: 30_000 });
}
function currentGps(timeout = 8000) {
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => navigator.geolocation.getCurrentPosition(
    (p) => { lastPos = posOf(p); resolve(lastPos); },
    () => resolve(lastPos), { enableHighAccuracy: true, timeout, maximumAge: 30_000 }));
}

// ── photos ──────────────────────────────────────────────
const MAX_SIDE = 1600;
async function shrink(file) {
  try {
    const bmp = await createImageBitmap(file); // browsers apply the EXIF rotation here
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
    if (blob) return blob;
  } catch (e) { console.warn('shrink failed, sending original', e); }
  if (['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return file;
  throw new Error('That photo format is not supported — try taking it with the camera button.');
}

// ── signature pad ───────────────────────────────────────
function signaturePad(canvas) {
  const ratio = devicePixelRatio || 1, ctx = canvas.getContext('2d');
  const size = () => {
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = width * ratio; canvas.height = height * ratio;
    ctx.scale(ratio, ratio); ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#05101f';
  };
  size();
  let drawing = false, inked = false, onInk = () => {};
  const at = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointerdown', (e) => { drawing = true; canvas.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...at(e)); ctx.lineTo(...at(e)); ctx.stroke(); });
  canvas.addEventListener('pointermove', (e) => { if (!drawing) return; ctx.lineTo(...at(e)); ctx.stroke(); if (!inked) { inked = true; onInk(true); } });
  addEventListener('pointerup', () => { drawing = false; });
  return {
    get inked() { return inked; },
    onInk(fn) { onInk = fn; },
    clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); inked = false; onInk(false); },
    dataUrl() {
      // export on white so the PNG reads well in reports
      const out = document.createElement('canvas'); out.width = canvas.width; out.height = canvas.height;
      const o = out.getContext('2d'); o.fillStyle = '#fff'; o.fillRect(0, 0, out.width, out.height); o.drawImage(canvas, 0, 0);
      return out.toDataURL('image/png');
    },
  };
}

// ── screens ─────────────────────────────────────────────
const STATUS = {
  draft: ['In progress', 'pill'], returned: ['Sent back — needs changes', 'pill warn'],
  submitted: ['Waiting for review', 'pill'], approved: ['Approved', 'pill ok'],
};
const fmt = (d) => new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function inspectViews({ api, post, del, esc, toast, shell, confirmDialog }) {
  let current = null; // the inspection being walked: server data + local pending changes

  // syncing badge in the header
  const syncText = (all) => {
    const el = document.getElementById('sync'); if (!el) return;
    const n = all.length;
    el.hidden = !n && !outboxError;
    el.className = `sync${outboxError ? ' bad' : ''}`;
    el.textContent = outboxError || (n ? `${n} waiting to upload${navigator.onLine ? '…' : ' (offline)'}` : '');
  };
  outbox.onChange(syncText);
  // when a queued photo leaves the outbox it has been uploaded: show it as a server photo
  let uploading = new Map();
  outbox.onChange((all) => {
    const now = new Map(all.filter((e) => e.kind === 'photo').map((e) => [e.id, e]));
    for (const [pid, e] of uploading) {
      if (!now.has(pid) && current?.id === e.inspectionId) current.photos.push({ id: pid, item_key: e.itemKey });
    }
    uploading = now;
  });
  const page = (html) => { const v = shell(html); notify(); return v; };

  async function home() {
    const [list, pending] = await Promise.all([api('/inspections/mine'), outbox.all()]);
    const submitting = new Set(pending.filter((e) => e.kind === 'submit').map((e) => e.inspectionId));
    const open = list.filter((i) => ['draft', 'returned'].includes(i.status) && !submitting.has(i.id));
    const done = list.filter((i) => !open.includes(i));
    const row = (i) => {
      const [label, cls] = submitting.has(i.id) ? ['Sending…', 'pill'] : STATUS[i.status];
      return `<li><a class="list-link" href="#/inspect/${i.id}">
        <span class="grow"><strong>${esc(i.site_name)}</strong><br><span class="muted small">${esc(i.client_name)} · ${esc(i.template_name)} · ${fmt(i.started_at)}</span></span>
        <span class="${cls}">${label}</span></a></li>`;
    };
    page(`
      <a class="btn primary big" href="#/inspect/new">Start an inspection</a>
      ${open.length ? `<h2>To finish</h2><ul class="list">${open.map(row).join('')}</ul>` : ''}
      <h2>Recent</h2>
      ${done.length ? `<ul class="list">${done.map(row).join('')}</ul>` : '<p class="empty">Nothing submitted yet.</p>'}`);
  }

  async function start() {
    const sites = await api('/inspect/sites');
    watchGps();
    const view = page(`
      <p><a href="#/inspect">← Back</a></p>
      <h1>Which site?</h1>
      <input id="q" type="search" placeholder="Search sites or clients" aria-label="Search sites" autocomplete="off">
      <ul class="list" id="sites"></ul>
      <p class="muted small">Only sites with a template are listed. Ask the office if a site is missing.</p>`);
    const $list = view.querySelector('#sites'), $q = view.querySelector('#q');
    const render = () => {
      const q = $q.value.trim().toLowerCase();
      const hits = sites.filter((s) => `${s.name} ${s.client_name} ${s.address || ''}`.toLowerCase().includes(q));
      $list.innerHTML = hits.map((s) => `<li><button class="list-link as-button" data-site="${s.id}">
        <span class="grow"><strong>${esc(s.name)}</strong><br><span class="muted small">${esc(s.client_name)}${s.address ? ` · ${esc(s.address)}` : ''}</span></span></button></li>`).join('')
        || '<li class="list-row muted">No matching sites</li>';
    };
    render(); $q.oninput = render;
    $list.onclick = async (e) => {
      const b = e.target.closest('[data-site]'); if (!b) return;
      const site = sites.find((s) => s.id === b.dataset.site);
      if (site.templates.length === 1) return begin(site, site.templates[0]);
      $list.innerHTML = `<li class="list-row"><strong>${esc(site.name)}</strong> — which checklist?</li>` + site.templates.map((t) =>
        `<li><button class="list-link as-button" data-template="${t.id}"><span class="grow">${esc(t.name)}</span><span class="muted small">${t.item_count} items</span></button></li>`).join('');
      $list.onclick = (ev) => { const tb = ev.target.closest('[data-template]'); if (tb) begin(site, site.templates.find((t) => t.id === tb.dataset.template)); };
    };
  }

  async function begin(site, template) {
    page(`<p class="center">Starting inspection at <strong>${esc(site.name)}</strong>…<br><span class="muted small">Getting your location</span></p>`);
    const id = crypto.randomUUID(), started_at = new Date().toISOString();
    const start_gps = await currentGps();
    for (;;) {
      try {
        await post('/inspections', { id, site_id: site.id, template_id: template.id, start_gps, started_at });
        location.hash = `#/inspect/${id}/1`;
        return;
      } catch (err) {
        if (err.status && err.status < 500) { toast(err.message, true); location.hash = '#/inspect'; return; }
        const view = page(`<section class="card stack center-text"><h2>No connection</h2>
          <p class="muted">Couldn't start the inspection. Check your signal and try again.</p>
          <button class="btn primary" id="retry">Try again</button></section>`);
        await new Promise((r) => { view.querySelector('#retry').onclick = r; });
      }
    }
  }

  // fetch the inspection and lay unsent local changes (notes, photos, deletes) over it
  async function load(id) {
    if (current?.id === id) return current;
    const [insp, pending] = await Promise.all([api(`/inspections/${id}`), outbox.all()]);
    for (const e of pending.filter((p) => p.inspectionId === id)) {
      if (e.kind === 'note') insp.items.find((i) => i.item_key === e.itemKey).note = JSON.parse(e.body).note;
      if (e.kind === 'delete') insp.photos = insp.photos.filter((p) => p.id !== e.photoId);
    }
    insp.submitting = pending.some((e) => e.inspectionId === id && e.kind === 'submit');
    return (current = insp);
  }
  const editable = (insp) => ['draft', 'returned'].includes(insp.status) && !insp.submitting;
  const pendingPhotos = async (id, key) => (await outbox.all()).filter((e) => e.kind === 'photo' && e.inspectionId === id && e.itemKey === key);

  // overview: every item with its photos/notes; read-only once submitted
  async function overview(id) {
    current = null;
    const insp = await load(id);
    const pending = (await outbox.all()).filter((e) => e.kind === 'photo' && e.inspectionId === id);
    const can = editable(insp);
    const [label, cls] = insp.submitting ? ['Sending…', 'pill'] : STATUS[insp.status];
    const view = page(`
      <p><a href="#/inspect">← My inspections</a></p>
      <section class="card">
        <div class="row between"><h1>${esc(insp.site_name)}</h1><span class="${cls}">${label}</span></div>
        <p class="muted">${esc(insp.client_name)} · ${esc(insp.template_name)} · started ${fmt(insp.started_at)}</p>
        ${insp.comments.length ? `<div class="comments">${insp.comments.map((c) => `<p><strong>${esc(c.name)}:</strong> ${esc(c.body)}</p>`).join('')}</div>` : ''}
      </section>
      <ol class="walk-list">${insp.items.map((it, n) => {
        const photos = insp.photos.filter((p) => p.item_key === it.item_key);
        const local = pending.filter((p) => p.itemKey === it.item_key);
        return `<li class="card">
          <div class="row between"><strong>${n + 1}. ${esc(it.label)}</strong>
            ${can ? `<a class="btn" href="#/inspect/${id}/${n + 1}">Edit</a>` : ''}</div>
          ${photos.length + local.length ? `<div class="thumbs">${photos.map((p) => `<img src="/api/photos/${p.id}" alt="" loading="lazy">`).join('')}
            ${local.map(() => '<span class="thumb-pending">Uploading</span>').join('')}</div>` : '<p class="muted small">No photos</p>'}
          ${it.note ? `<p class="note">${esc(it.note)}</p>` : ''}
        </li>`;
      }).join('')}</ol>
      ${can ? `<div class="row between sticky-bar">
          ${insp.status === 'draft' ? '<button class="btn danger" id="discard">Discard</button>' : '<span></span>'}
          <a class="btn primary" href="#/inspect/${id}/finish">Review &amp; sign</a></div>` : ''}`);
    view.querySelector('#discard')?.addEventListener('click', async () => {
      if (!(await confirmDialog('Discard this inspection and all its photos?', 'Discard'))) return;
      try {
        await del(`/inspections/${id}`);
        for (const e of await outbox.all()) if (e.inspectionId === id) await outbox.remove(e.id);
        current = null; location.hash = '#/inspect';
      } catch (e) { toast(e.message, true); }
    });
  }

  // one item: photos + note
  async function item(id, n) {
    const insp = await load(id);
    if (!editable(insp)) { location.replace(`#/inspect/${id}`); return; }
    n = Math.min(Math.max(1, +n), insp.items.length);
    const it = insp.items[n - 1], last = n === insp.items.length;
    watchGps();
    const view = page(`
      <div class="walk-top"><a href="#/inspect/${id}">← ${esc(insp.site_name)}</a><span class="muted small">Item ${n} of ${insp.items.length}</span></div>
      <div class="progress" aria-hidden="true"><span style="width:${(n / insp.items.length) * 100}%"></span></div>
      <h1>${esc(it.label)}</h1>
      ${it.hint ? `<p class="muted">${esc(it.hint)}</p>` : ''}
      <div class="thumbs big" id="thumbs"></div>
      <div class="row photo-btns">
        <label class="btn primary grow center-text">Take photo<input type="file" accept="image/*" capture="environment" hidden id="cam"></label>
        <label class="btn grow center-text">From gallery<input type="file" accept="image/*" multiple hidden id="gallery"></label>
      </div>
      <label>Notes<textarea id="note" rows="4" placeholder="What did you find? e.g. bins not emptied, streaks on glass">${esc(it.note)}</textarea></label>
      ${gpsDenied ? '<p class="small warn-text">Location is off — the report will show no GPS. Allow location for this site in your browser settings.</p>' : ''}
      <div class="row between sticky-bar">
        ${n > 1 ? `<a class="btn" href="#/inspect/${id}/${n - 1}">← Previous</a>` : '<span></span>'}
        <a class="btn primary" href="${last ? `#/inspect/${id}/finish` : `#/inspect/${id}/${n + 1}`}">${last ? 'Review &amp; sign →' : 'Next →'}</a>
      </div>`);

    const $thumbs = view.querySelector('#thumbs');
    const urls = [];
    const renderThumbs = async () => {
      urls.splice(0).forEach(URL.revokeObjectURL);
      const local = await pendingPhotos(id, it.item_key);
      const server = insp.photos.filter((p) => p.item_key === it.item_key);
      $thumbs.innerHTML = server.map((p) => `<figure><img src="/api/photos/${p.id}" alt="Photo"><button class="thumb-del" data-del="${p.id}" aria-label="Delete photo">✕</button></figure>`).join('')
        + local.map((e) => { const u = URL.createObjectURL(e.body); urls.push(u); return `<figure class="pending"><img src="${u}" alt="Photo waiting to upload"><button class="thumb-del" data-del-local="${e.id}" aria-label="Delete photo">✕</button><span>Uploading</span></figure>`; }).join('')
        || '<p class="muted small">No photos yet.</p>';
    };
    renderThumbs();
    const off = outbox.onChange(() => document.body.contains($thumbs) ? renderThumbs() : off());

    const addFiles = async (files) => {
      for (const file of files) {
        try {
          const blob = await shrink(file);
          const pid = crypto.randomUUID(), pos = lastPos;
          const q = new URLSearchParams({ item_key: it.item_key, taken_at: new Date().toISOString(), ...(pos ? { lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy } : {}) });
          await outbox.put({ id: pid, inspectionId: id, itemKey: it.item_key, kind: 'photo', method: 'PUT',
            url: `/api/inspections/${id}/photos/${pid}?${q}`, body: blob, contentType: blob.type });
        } catch (e) { toast(e.message, true); }
      }
      renderThumbs();
    };
    for (const input of view.querySelectorAll('input[type=file]')) input.onchange = () => { addFiles([...input.files]); input.value = ''; };

    $thumbs.onclick = async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (!(await confirmDialog('Delete this photo?'))) return;
      if (b.dataset.delLocal) {
        uploading.delete(b.dataset.delLocal);
        await outbox.remove(b.dataset.delLocal);
      } else {
        const pid = b.dataset.del;
        insp.photos = insp.photos.filter((p) => p.id !== pid);
        await outbox.put({ id: `delete:${pid}`, inspectionId: id, kind: 'delete', photoId: pid, method: 'DELETE', url: `/api/inspections/${id}/photos/${pid}` });
      }
      renderThumbs();
    };

    let noteTimer;
    const saveNote = () => {
      clearTimeout(noteTimer);
      if (it.note === view.querySelector('#note').value) return;
      it.note = view.querySelector('#note').value;
      outbox.put({ id: `note:${id}:${it.item_key}`, inspectionId: id, itemKey: it.item_key, kind: 'note', method: 'PUT',
        url: `/api/inspections/${id}/items/${encodeURIComponent(it.item_key)}`, body: JSON.stringify({ note: it.note }), contentType: 'application/json' });
    };
    view.querySelector('#note').addEventListener('input', () => { clearTimeout(noteTimer); noteTimer = setTimeout(saveNote, 800); });
    view.querySelector('#note').addEventListener('blur', saveNote);
    addEventListener('hashchange', saveNote, { once: true });
  }

  // review + signature + submit
  async function finish(id) {
    const insp = await load(id);
    if (!editable(insp)) { location.replace(`#/inspect/${id}`); return; }
    const pending = (await outbox.all()).filter((e) => e.kind === 'photo' && e.inspectionId === id);
    const counts = insp.items.map((it) => insp.photos.filter((p) => p.item_key === it.item_key).length
      + pending.filter((p) => p.itemKey === it.item_key).length);
    const empty = insp.items.filter((it, i) => !counts[i] && !it.note.trim());
    const view = page(`
      <p><a href="#/inspect/${id}/${insp.items.length}">← Back to items</a></p>
      <h1>Review &amp; sign</h1>
      <ul class="list">${insp.items.map((it, i) => `<li><a class="list-link" href="#/inspect/${id}/${i + 1}">
        <span class="grow">${i + 1}. ${esc(it.label)}</span>
        <span class="muted small">${counts[i]} photo${counts[i] === 1 ? '' : 's'}${it.note.trim() ? ' · note' : ''}</span></a></li>`).join('')}</ul>
      ${empty.length ? `<p class="warn-text small">${empty.length} item${empty.length === 1 ? ' has' : 's have'} no photo or note: ${empty.map((i) => esc(i.label)).join(', ')}.</p>` : ''}
      <section class="card stack">
        <div class="row between"><strong>Your signature</strong><button class="btn" id="clear">Clear</button></div>
        <canvas id="sig" class="sig" aria-label="Sign here with your finger"></canvas>
        <p class="muted small">By signing you confirm this inspection was carried out on site.</p>
        <button class="btn primary big" id="submit" disabled>Submit inspection</button>
      </section>`);
    const pad = signaturePad(view.querySelector('#sig'));
    const $submit = view.querySelector('#submit');
    pad.onInk((inked) => { $submit.disabled = !inked; });
    view.querySelector('#clear').onclick = () => pad.clear();
    $submit.onclick = async () => {
      $submit.disabled = true;
      const end_gps = await currentGps(5000);
      await outbox.put({ id: `submit:${id}`, inspectionId: id, kind: 'submit', method: 'POST', url: `/api/inspections/${id}/submit`,
        body: JSON.stringify({ inspector_sig: pad.dataUrl(), end_gps, finished_at: new Date().toISOString() }), contentType: 'application/json' });
      current = null;
      toast(navigator.onLine ? 'Inspection submitted' : 'Saved — it will send when you have signal');
      location.hash = '#/inspect';
    };
  }

  return { home, start, overview, item, finish };
}
