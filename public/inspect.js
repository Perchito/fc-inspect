// Supervisor workflow: start an inspection, work through items one at a time (photos, score, notes,
// action plans, before & after), review, sign, submit. Every change goes through an IndexedDB outbox
// so a dropped signal never loses work — including starting an inspection with no signal at all.
import {
  esc, icon, api, del, toast, sheet, confirmSheet, viewer, skeleton, emptyState, errorState, statusBadge,
  scoreBadge, scoreWord, modeLabel, progressBar, LOW_SCORE, relDay, fmtDateTime, searchBar, itemNums, areaHead,
} from './ui.js?v=__V__';

// items added on site go at the end of their area (no area / a new area: the end of the list) — same rule as the server
function insertItem(items, it) {
  const last = it.area ? items.findLastIndex((x) => x.area === it.area) : -1;
  const at = last >= 0 ? last + 1 : items.length;
  items.splice(at, 0, it);
  return at;
}

// ── outbox ──────────────────────────────────────────────
// entries: {id, seq, inspectionId, method, url, body (Blob|string), contentType, kind, itemKey?, phase?, pairId?, local?}
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
function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
let seq = Date.now();
const listeners = new Set();
export const sync = { flushing: false, uploadingId: null, error: '', lastSynced: Number(safeGet('fci-last-synced')) || null, pending: [] };
export const outbox = {
  async put(entry) { await store('readwrite', (s) => s.put({ ...entry, seq: seq++ })); await notify(); flush(); },
  async remove(id) { await store('readwrite', (s) => s.delete(id)); await notify(); },
  async all() { return ((await store('readonly', (s) => s.getAll())) || []).sort((a, b) => a.seq - b.seq); },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};
async function notify() { sync.pending = await outbox.all(); listeners.forEach((fn) => fn(sync)); }
const KIND = { photo: 'photo', note: 'item update', delete: 'photo delete', submit: 'submission', additem: 'new item', delitem: 'removed item', start: 'new inspection' };

let retryTimer = null, retryDelay = 3000;
export async function flush() {
  if (sync.flushing) return;
  sync.flushing = true; clearTimeout(retryTimer); notify();
  try {
    for (const e of await outbox.all()) {
      sync.uploadingId = e.id; notify();
      let res;
      try {
        res = await fetch(e.url, { method: e.method, body: e.body, headers: e.contentType ? { 'content-type': e.contentType } : {} });
      } catch { return retryLater(); } // offline / dropped connection
      if (res.status === 401) { sync.error = 'Log in again to send your saved work.'; return; }
      if (res.status >= 500 || res.status === 429 || res.status === 408) return retryLater();
      if (!res.ok) { // refused for good (e.g. already submitted elsewhere): drop it, but say so
        const msg = (await res.json().catch(() => ({}))).error || res.statusText;
        console.warn('[outbox] dropped', e.kind, msg);
        sync.error = `A ${KIND[e.kind] || e.kind} couldn't be saved: ${msg}`;
      }
      await outbox.remove(e.id);
    }
    retryDelay = 3000;
    if (sync.error.startsWith('Log in')) sync.error = '';
    sync.lastSynced = Date.now();
    try { localStorage.setItem('fci-last-synced', String(sync.lastSynced)); } catch {}
  } finally { sync.flushing = false; sync.uploadingId = null; notify(); }
}
function retryLater() {
  retryTimer = setTimeout(flush, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 60_000);
}
export const clearSyncError = () => { sync.error = ''; notify(); };
addEventListener('online', () => { notify(); flush(); });
addEventListener('offline', () => notify());
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && flush());
navigator.storage?.persist?.(); // ask the browser not to evict unsent photos
notify().then(flush);

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
export function signaturePad(canvas) {
  const ratio = devicePixelRatio || 1, ctx = canvas.getContext('2d');
  const { width, height } = canvas.getBoundingClientRect();
  canvas.width = width * ratio; canvas.height = height * ratio;
  ctx.scale(ratio, ratio); ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#05101f';
  let drawing = false, inked = false, onInk = () => {};
  const at = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointerdown', (e) => { drawing = true; canvas.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...at(e)); ctx.lineTo(...at(e)); ctx.stroke(); });
  canvas.addEventListener('pointermove', (e) => { if (!drawing) return; ctx.lineTo(...at(e)); ctx.stroke(); if (!inked) { inked = true; onInk(true); } });
  addEventListener('pointerup', () => { drawing = false; });
  return {
    get inked() { return inked; },
    onInk(fn) { onInk = fn; },
    clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); inked = false; onInk(false); },
    dataUrl() { // exported on white so it reads well in reports
      const out = document.createElement('canvas'); out.width = canvas.width; out.height = canvas.height;
      const o = out.getContext('2d'); o.fillStyle = '#fff'; o.fillRect(0, 0, out.width, out.height); o.drawImage(canvas, 0, 0);
      return out.toDataURL('image/png');
    },
  };
}

// ── item rules (mirror the server's itemProblems / ITEM_DONE_SQL) ──
const planDone = (it) => !!(it.action_what?.trim() && it.action_who?.trim() && it.action_due);
// state of one item: 'todo' | 'score' | 'plan' | 'after' | 'done'
export function itemState(insp, it, photos) {
  const ps = photos.filter((p) => p.item_key === it.item_key);
  if (insp.mode === 'check') {
    if (!it.score) return ps.length || it.note?.trim() ? 'score' : 'todo';
    return it.score < LOW_SCORE && !planDone(it) ? 'plan' : 'done';
  }
  const befores = ps.filter((p) => p.phase !== 'after');
  if (!befores.length) return 'todo';
  if (befores.some((b) => !ps.some((a) => a.phase === 'after' && a.pair_id === b.id))) return 'after';
  return it.score && it.score < LOW_SCORE && !planDone(it) ? 'plan' : 'done'; // score optional here
}
const STATE_LABEL = { todo: 'Not started', score: 'Needs a score', plan: 'Action plan needed', after: 'After photo pending', done: 'Done' };
export const itemProblem = (it, mode) => !it.score ? (mode === 'check' ? 'Give this item a score before moving on.' : '')
  : it.score < LOW_SCORE && !planDone(it) ? 'Scores below 7 need an action plan: what, who and a deadline.' : '';
export const avgScore = (items) => { const s = items.map((i) => i.score).filter(Boolean); return s.length ? +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1) : null; };
const randomKey = () => [...crypto.getRandomValues(new Uint8Array(5))].map((b) => b.toString(16).padStart(2, '0')).join('');

// ── data: the user's own inspections, with anything still queued on this phone laid over ──
export async function fetchMine() {
  const [list, pending] = await Promise.all([api('/inspections/mine').catch((e) => { if (e.offline) return []; throw e; }), outbox.all()]);
  const submitting = new Set(pending.filter((e) => e.kind === 'submit').map((e) => e.inspectionId));
  for (const e of pending.filter((p) => p.kind === 'start' && !list.some((i) => i.id === p.inspectionId))) {
    const l = e.local;
    list.unshift({ id: e.inspectionId, status: 'draft', mode: l.mode, template_id: l.template_id, template_name: l.template_name,
      site_name: l.site_name, client_name: l.client_name, started_at: l.started_at, item_count: l.items.length, done_count: 0, local: true });
  }
  for (const i of list) if (submitting.has(i.id)) i.sending = true;
  return list;
}

let current = null; // inspection being worked on: server data + this phone's unsent changes
// Load an inspection, falling back to the queued start when it hasn't reached the server yet (offline start).
export async function loadInspection(id, { fresh = false } = {}) {
  if (!fresh && current?.id === id) return current;
  const pending = (await outbox.all()).filter((p) => p.inspectionId === id);
  let insp;
  try { insp = await api(`/inspections/${id}`); } catch (err) {
    const start = pending.find((e) => e.kind === 'start');
    if (!start || !(err.offline || err.status === 404)) throw err;
    const l = start.local;
    insp = { id, status: 'draft', mode: l.mode, template_id: l.template_id, template_name: l.template_name, site_name: l.site_name,
      site_address: l.site_address, client_name: l.client_name, started_at: l.started_at, inspector_name: l.inspector_name,
      inspector_id: l.inspector_id, items: l.items.map((it) => ({ ...it, note: '' })), photos: [], comments: [], local: true };
  }
  for (const e of pending) {
    if (e.kind === 'additem' && !insp.items.some((i) => i.item_key === e.itemKey)) {
      const { label, area = '' } = JSON.parse(e.body);
      insertItem(insp.items, { item_key: e.itemKey, label, hint: '', note: '', added: true, area });
    }
    if (e.kind === 'delitem') insp.items = insp.items.filter((i) => i.item_key !== e.itemKey);
    if (e.kind === 'note') Object.assign(insp.items.find((i) => i.item_key === e.itemKey) || {}, JSON.parse(e.body));
    if (e.kind === 'delete') insp.photos = insp.photos.filter((p) => p.id !== e.photoId);
  }
  insp.submitting = pending.some((e) => e.kind === 'submit');
  return (current = insp);
}
export const forgetCurrent = () => { current = null; };
// when a queued photo leaves the outbox it has been uploaded: keep showing it, now from the server
let uploading = new Map();
outbox.onChange(({ pending }) => {
  const now = new Map(pending.filter((e) => e.kind === 'photo').map((e) => [e.id, e]));
  for (const [pid, e] of uploading) {
    if (!now.has(pid) && current?.id === e.inspectionId && !current.photos.some((p) => p.id === pid)) {
      current.photos.push({ id: pid, item_key: e.itemKey, phase: e.phase, pair_id: e.pairId });
    }
  }
  uploading = now;
});
// every photo of an inspection, uploaded or still queued: {id, item_key, phase, pair_id, src, local}
const localUrls = new Map();
export async function allPhotos(insp) {
  const local = (await outbox.all()).filter((e) => e.kind === 'photo' && e.inspectionId === insp.id).map((e) => {
    if (!localUrls.has(e.id)) localUrls.set(e.id, URL.createObjectURL(e.body));
    return { id: e.id, item_key: e.itemKey, phase: e.phase, pair_id: e.pairId, src: localUrls.get(e.id), local: true };
  });
  return [...insp.photos.map((p) => ({ ...p, src: `/api/photos/${p.id}` })), ...local];
}
export const editable = (insp) => ['draft', 'returned'].includes(insp.status) && !insp.submitting;
const isFree = (insp) => insp.mode === 'before_after' && !insp.template_id;
const itemTitle = (insp) => (insp.template_id ? insp.template_name : modeLabel(insp));

// ── screens ─────────────────────────────────────────────
export function inspectViews({ shell, me }) {
  const base = (id) => `#/inspections/${id}`;

  // add an item found on site (this inspection only, never the template)
  // an item added on site goes in an area: an existing one (the current item's by default) or a new one
  async function addItem(insp, { first = false, area = '' } = {}) {
    const NEW = '+new', areas = [...new Set(insp.items.map((i) => i.area).filter(Boolean))];
    const v = await sheet({
      title: first ? 'Add the first item' : 'Add an item', submitLabel: 'Add item',
      text: isFree(insp) ? 'Name what you are photographing.' : 'Something you found that is not on the checklist.',
      fields: [
        { name: 'area', label: 'Area', type: 'choice', value: area || (areas.length ? areas.at(-1) : ''),
          options: [...(areas.length ? areas.map((a) => ({ value: a, label: a })) : [{ value: '', label: 'No area' }]), { value: NEW, label: '+ New area' }] },
        { name: 'newarea', label: 'New area name', placeholder: 'e.g. Laundry room' },
        { name: 'label', label: 'Item name', placeholder: 'e.g. Oven, fire exit door, stained carpet', required: true },
      ],
      onChange: (v, form) => { form.querySelector('[data-field=newarea]').hidden = v.area !== NEW; },
      onSubmit: (v) => { if (v.area === NEW && !v.newarea.trim()) throw new Error('Give the new area a name'); return v; },
    });
    const label = v?.label?.trim().slice(0, 200);
    if (!label) return;
    const key = randomKey(), itemArea = (v.area === NEW ? v.newarea : v.area).trim().slice(0, 200);
    const at = insertItem(insp.items, { item_key: key, label, hint: '', note: '', added: true, area: itemArea });
    await outbox.put({ id: `additem:${insp.id}:${key}`, inspectionId: insp.id, itemKey: key, kind: 'additem', method: 'POST',
      url: `/api/inspections/${insp.id}/items`, body: JSON.stringify({ key, label, area: itemArea }), contentType: 'application/json' });
    location.hash = `${base(insp.id)}/item/${at + 1}`;
  }

  // ── start flow: site → inspection → confirm ──
  let sitesCache = null;
  async function start(siteId, choice) {
    const stepNo = siteId ? (choice ? 3 : 2) : 1;
    const view = shell({ title: 'New inspection', subtitle: `Step ${stepNo} of 3`,
      back: siteId ? (choice ? `#/start/${siteId}` : '#/start') : '#/home', focus: true, body: skeleton(4) });
    try { sitesCache = await api('/inspect/sites'); } catch (e) {
      if (!sitesCache) { view.innerHTML = errorState(e); view.querySelector('#retry').onclick = () => start(siteId, choice); return; }
    }
    watchGps();
    const steps = `<ol class="steps" aria-hidden="true">${[1, 2, 3].map((i) => `<li class="${i <= stepNo ? 'on' : ''}"></li>`).join('')}</ol>`;
    if (!siteId) {
      view.innerHTML = `${steps}<h2 class="screen-h">Which site?</h2>${searchBar('Search sites or clients')}<div class="stack" id="sites"></div>`;
      const $q = view.querySelector('input'), $list = view.querySelector('#sites');
      const render = () => {
        const q = $q.value.trim().toLowerCase();
        const hits = sitesCache.filter((s) => `${s.name} ${s.client_name} ${s.address || ''}`.toLowerCase().includes(q));
        $list.innerHTML = hits.map((s) => `<a class="card tap media" href="#/start/${s.id}">
            <span class="card-ic">${icon('building')}</span>
            <span class="grow"><strong>${esc(s.name)}</strong><small>${esc(s.client_name)}${s.address ? ` · ${esc(s.address)}` : ''}</small></span>
            ${icon('chevron', 'chev')}</a>`).join('')
          || emptyState({ icon: 'search', title: sitesCache.length ? 'No matching sites' : 'No sites yet', text: sitesCache.length ? 'Try another name.' : 'Ask the office to add your sites.' });
      };
      render(); $q.oninput = render;
      return;
    }
    const site = sitesCache.find((s) => s.id === siteId);
    if (!site) { location.replace('#/start'); return; }
    // every way to inspect this site: each checklist as a quality check or before & after, plus no checklist
    const options = [
      ...site.templates.map((t) => ({ key: `check.${t.id}`, mode: 'check', template: t, title: t.name, kind: 'Quality check', ic: 'actions', text: `${t.item_count} items · score each 1–10` })),
      ...site.templates.map((t) => ({ key: `ba.${t.id}`, mode: 'before_after', template: t, title: t.name, kind: 'Before & after', ic: 'image', text: `${t.item_count} items · photos before and after the clean` })),
      { key: 'free', mode: 'before_after', template: null, title: 'No checklist', kind: 'Before & after', ic: 'plus', text: 'Start empty and add each item as you go' },
    ];
    if (!choice) {
      const group = (kind) => options.filter((o) => o.kind === kind).map((o) => `<a class="card tap media" href="#/start/${siteId}/${o.key}">
          <span class="card-ic ${o.mode === 'check' ? 'blue' : 'teal'}">${icon(o.ic)}</span>
          <span class="grow"><strong>${esc(o.title)}</strong><small>${esc(o.text)}</small></span>${icon('chevron', 'chev')}</a>`).join('');
      view.innerHTML = `${steps}<h2 class="screen-h">${esc(site.name)}</h2><p class="muted">${esc(site.client_name)}</p>
        <h3 class="section-h">Quality check <span class="muted small">· shared with the client</span></h3>
        ${site.templates.length ? `<div class="stack">${group('Quality check')}</div>` : '<p class="note-box">No checklist set up for this site yet — ask the office.</p>'}
        <h3 class="section-h">Before &amp; after <span class="muted small">· internal</span></h3><div class="stack">${group('Before & after')}</div>`;
      return;
    }
    const o = options.find((x) => x.key === choice);
    if (!o) { location.replace(`#/start/${siteId}`); return; }
    view.innerHTML = `${steps}
      <div class="card confirm-card">
        <span class="card-ic xl ${o.mode === 'check' ? 'blue' : 'teal'}">${icon(o.ic)}</span>
        <p class="eyebrow">${esc(o.kind)}</p><h2>${esc(o.title)}</h2>
        <p>${esc(site.name)} · ${esc(site.client_name)}</p>
        <p class="small muted">${esc(o.text)}</p>
      </div>
      <p class="muted small center-text">${icon('pin', 'inline')} Your location is recorded when you start and finish.</p>
      <div class="bottom-bar"><button class="btn primary block lg" id="go">Start inspection</button></div>`;
    view.querySelector('#go').onclick = async (e) => {
      e.currentTarget.disabled = true; e.currentTarget.textContent = 'Starting…';
      const id = crypto.randomUUID(), started_at = new Date().toISOString();
      const start_gps = await currentGps(6000);
      const items = (o.template?.items || []).map((it) => ({ item_key: it.key, label: it.label, hint: it.hint || '', area: it.area || '' }));
      // queued like everything else, so starting works with no signal too
      await outbox.put({ id: `start:${id}`, inspectionId: id, kind: 'start', method: 'POST', url: '/api/inspections', contentType: 'application/json',
        body: JSON.stringify({ id, site_id: site.id, template_id: o.template?.id ?? null, mode: o.mode, start_gps, started_at }),
        local: { mode: o.mode, template_id: o.template?.id ?? null, template_name: o.template?.name ?? 'No checklist', site_name: site.name,
          site_address: site.address, client_name: site.client_name, started_at, inspector_name: me().name, inspector_id: me().id, items } });
      current = null;
      location.hash = items.length ? `${base(id)}/item/1` : base(id);
    };
  }

  // ── inspection overview (its owner, while it can still be changed) ──
  async function detail(insp) {
    const id = insp.id;
    const photos = await allPhotos(insp);
    const states = insp.items.map((it) => itemState(insp, it, photos));
    const done = states.filter((s) => s === 'done').length, total = insp.items.length;
    const nextTodo = states.findIndex((s) => s !== 'done');
    const free = isFree(insp), nums = itemNums(insp.items);
    const view = shell({ title: itemTitle(insp), subtitle: insp.site_name, back: '#/inspections', focus: true, body: `
      <section class="card summary-card">
        <div class="row-between">${statusBadge(insp.status)}<span class="muted small">${esc(modeLabel(insp))}</span></div>
        <h2>${esc(insp.site_name)}</h2>
        <p class="muted">${esc(insp.client_name)} · started ${esc(relDay(insp.started_at))}</p>
        ${total ? progressBar(done, total) : ''}
      </section>
      ${insp.comments?.length ? `<section class="card warn-card"><h3>${icon('alert')} Sent back by the office</h3>${insp.comments.map((c) =>
        `<p><strong>${esc(c.name)}:</strong> ${esc(c.body)}</p>`).join('')}</section>` : ''}
      ${insp.mode === 'before_after' && total ? '<p class="note-box">Take the before photos now. Leave this inspection open during the clean, then come back and add an after photo next to each one.</p>' : ''}
      ${total ? `<h3 class="section-h">Items</h3><div class="stack">${insp.items.map((it, n) => {
        const count = photos.filter((p) => p.item_key === it.item_key).length;
        return `${areaHead(insp.items, nums, n)}<a class="card tap media item-card" href="${base(id)}/item/${n + 1}">
          <span class="item-num state-${states[n]}">${states[n] === 'done' ? icon('check') : nums[n]}</span>
          <span class="grow"><strong>${esc(it.label)}</strong>
            <small>${STATE_LABEL[states[n]]}${count ? ` · ${count} photo${count === 1 ? '' : 's'}` : ''}${it.note?.trim() ? ' · note' : ''}</small></span>
          ${scoreBadge(it.score)}${icon('chevron', 'chev')}</a>`;
      }).join('')}</div>` : emptyState({ icon: 'camera', title: 'No items yet', text: 'Add the first thing you\'re photographing, e.g. "Oven" or "Bathroom tiles".' })}
      <button class="btn ${free ? 'primary block lg' : 'dashed block'}" id="add-item">${icon('plus')} ${free ? (total ? 'Add next item' : 'Add first item') : 'Add an item not on the checklist'}</button>
      ${insp.status === 'draft' ? `<button class="btn ghost-danger block" id="discard">${icon('trash')} Discard inspection</button>` : ''}
      ${total ? `<div class="bottom-bar">${nextTodo >= 0
        ? `<a class="btn primary block lg" href="${base(id)}/item/${nextTodo + 1}">${done ? 'Continue' : 'Start'} · item ${nextTodo + 1} of ${total} ${icon('chevron')}</a>`
        : `<a class="btn primary block lg" href="${base(id)}/review">Review &amp; submit ${icon('chevron')}</a>`}</div>` : ''}` });
    view.querySelector('#add-item').onclick = () => addItem(insp, { first: !total });
    view.querySelector('#discard')?.addEventListener('click', async () => {
      if (!(await confirmSheet('Discard this inspection?', { text: 'All its photos and notes are deleted. This cannot be undone.', okLabel: 'Discard' }))) return;
      const pending = (await outbox.all()).filter((e) => e.inspectionId === id);
      try { if (!pending.some((e) => e.kind === 'start')) await del(`/inspections/${id}`); }
      catch (e) { return toast(e.offline ? 'Discarding needs a connection.' : e.message, { error: true }); }
      for (const e of pending) await outbox.remove(e.id);
      current = null; toast('Inspection discarded'); location.hash = '#/home';
    });
  }

  // ── one item at a time ──
  async function item(id, n) {
    const insp = await loadInspection(id);
    if (!editable(insp) || !insp.items.length) { location.replace(base(id)); return; }
    n = Math.min(Math.max(1, +n), insp.items.length);
    const it = insp.items[n - 1], last = n === insp.items.length, ba = insp.mode === 'before_after', free = isFree(insp);
    const total = insp.items.length;
    watchGps();
    const view = shell({ title: `Item ${n} of ${total}`, subtitle: insp.site_name, back: base(id), focus: true, body: `
      <div class="progress thin" aria-hidden="true"><span style="width:${(n / total) * 100}%"></span></div>
      <header class="item-head">
        <p class="eyebrow">${esc(it.area || itemTitle(insp))}</p>
        <h1>${it.area ? `<span class="muted">${itemNums(insp.items)[n - 1]}</span> ` : ''}${esc(it.label)}</h1>
        ${it.hint ? `<p class="muted">${esc(it.hint)}</p>` : ''}
        ${it.added ? `<p class="small">${free ? '' : '<span class="badge neutral">Added on site</span> '}<button class="link danger" id="remove-item">Remove this item</button></p>` : ''}
      </header>
      <section class="block-section"><div class="row-between"><h3>${ba ? 'Before &amp; after' : 'Photos'}</h3><span class="muted small" id="photo-count"></span></div>
        <div id="photos"></div>
        <div class="photo-actions">
          <label class="btn primary lg grow">${icon('camera')} ${ba ? 'Before photo' : 'Take photo'}<input type="file" accept="image/*" capture="environment" hidden data-add></label>
          <label class="btn lg">${icon('image')} Gallery<input type="file" accept="image/*" multiple hidden data-add></label>
        </div></section>
      ${`<section class="block-section"><h3>Score${ba ? ' <span class="muted small">(optional)</span>' : ''}</h3>
        <div class="score-grid" role="radiogroup" aria-label="Score from 1 to 10">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) =>
          `<button type="button" role="radio" data-score="${v}" class="${v < LOW_SCORE ? 'low' : ''}" aria-checked="${it.score === v}">${v}</button>`).join('')}</div>
        <p class="score-word" id="score-word" aria-live="polite"></p>
        <div id="plan"></div></section>`}
      <section class="block-section" id="note-wrap"></section>
      <p class="form-error" id="missing" role="alert" hidden></p>
      <button class="btn ${free ? 'primary block lg' : 'dashed block'}" id="add-item">${icon('plus')} ${free ? 'Add next item' : 'Add an item not on the checklist'}</button>
      ${gpsDenied ? '<p class="note-box small">Location is off — the report will show no GPS. Allow location for this site in Settings.</p>' : ''}
      <div class="bottom-bar two">
        ${n > 1 ? `<a class="btn lg" href="${base(id)}/item/${n - 1}">${icon('back')} Previous</a>` : `<a class="btn lg" href="${base(id)}">${icon('list')} All items</a>`}
        <a class="btn primary lg" id="next" href="${last ? `${base(id)}/review` : `${base(id)}/item/${n + 1}`}">${last ? 'Review' : 'Next'} ${icon('chevron')}</a>
      </div>` });

    // photos
    const $photos = view.querySelector('#photos');
    const upState = (p) => !p.local ? '' : `<span class="up-state">${sync.uploadingId === p.id ? `${icon('sync', 'spin')} Uploading…`
      : navigator.onLine ? `${icon('clock')} Queued` : `${icon('offline')} Waiting for signal`}</span>`;
    const fig = (p, label) => `<figure class="ph${p.local ? ' pending' : ''}"><button class="ph-open" data-view="${p.id}" aria-label="View ${label.toLowerCase()}">
      <img src="${p.src}" alt="${label}" loading="lazy" decoding="async"></button>${upState(p)}</figure>`;
    let shown = [];
    const render = async () => {
      const all = (await allPhotos(insp)).filter((p) => p.item_key === it.item_key);
      view.querySelector('#photo-count').textContent = all.length ? `${all.length} photo${all.length === 1 ? '' : 's'}` : '';
      if (!ba) {
        shown = all.map((p) => ({ ...p, label: 'Photo' }));
        $photos.innerHTML = all.length ? `<div class="ph-grid">${all.map((p) => fig(p, 'Photo')).join('')}</div>`
          : `<div class="ph-empty">${icon('camera')}<span>No photos yet</span></div>`;
        return;
      }
      const befores = all.filter((p) => p.phase !== 'after');
      const afterOf = (b) => all.find((p) => p.phase === 'after' && p.pair_id === b.id);
      const orphans = all.filter((p) => p.phase === 'after' && !befores.some((b) => b.id === p.pair_id));
      shown = [...befores.flatMap((b) => [{ ...b, label: 'Before' }, ...(afterOf(b) ? [{ ...afterOf(b), label: 'After' }] : [])]), ...orphans.map((p) => ({ ...p, label: 'After' }))];
      const head = '<div class="pair-label"><span>Before</span><span>After</span></div>';
      $photos.innerHTML = befores.length || orphans.length ? `<div class="pairs">${befores.map((b) => {
        const a = afterOf(b);
        return `<div class="pair">${head}${fig(b, 'Before photo')}${a ? fig(a, 'After photo') : `<label class="after-slot">${icon('camera')}<span>Take after photo</span>
            <input type="file" accept="image/*" hidden data-pair="${b.id}"></label>`}</div>`;
      }).join('')}${orphans.map((a) => `<div class="pair">${head}<div class="ph-blank" aria-hidden="true"></div>${fig(a, 'After photo')}</div>`).join('')}</div>`
        : `<div class="ph-empty">${icon('camera')}<span>Take the before photos now. After the clean, come back and add an after photo next to each one.</span></div>`;
    };
    render();
    const off = outbox.onChange(() => (document.body.contains($photos) ? render() : off()));

    async function addFiles(files, phase = ba ? 'before' : null, pairId = null) {
      let added = 0;
      for (const file of files) {
        try {
          const blob = await shrink(file);
          const pid = crypto.randomUUID(), pos = lastPos;
          const q = new URLSearchParams({
            item_key: it.item_key, taken_at: new Date().toISOString(),
            ...(phase ? { phase } : {}), ...(pairId ? { pair_id: pairId } : {}),
            ...(pos ? { lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy } : {}),
          });
          await outbox.put({ id: pid, inspectionId: id, itemKey: it.item_key, kind: 'photo', phase, pairId, method: 'PUT',
            url: `/api/inspections/${id}/photos/${pid}?${q}`, body: blob, contentType: blob.type });
          added++;
        } catch (e) { toast(e.message, { error: true }); }
      }
      if (added) toast(added > 1 ? `${added} photos added` : phase === 'after' ? 'After photo added' : 'Photo added');
    }
    view.addEventListener('change', (e) => {
      const input = e.target;
      if (input.type !== 'file' || !input.files.length) return;
      if (input.dataset.pair) addFiles([input.files[0]], 'after', input.dataset.pair);
      else if ('add' in input.dataset) addFiles([...input.files]);
      input.value = '';
    });
    async function deletePhoto(p) {
      const linked = p.phase !== 'after' ? shown.filter((x) => x.phase === 'after' && x.pair_id === p.id) : [];
      if (!(await confirmSheet(linked.length ? 'Delete this before photo and its after photo?' : 'Delete this photo?', { okLabel: 'Delete' }))) return false;
      for (const x of [p, ...linked]) {
        if (x.local) { uploading.delete(x.id); await outbox.remove(x.id); continue; }
        insp.photos = insp.photos.filter((y) => y.id !== x.id);
        // the server deletes a before photo's pair itself, so only queue the one delete
        if (x.id === p.id) await outbox.put({ id: `delete:${p.id}`, inspectionId: id, kind: 'delete', photoId: p.id, method: 'DELETE', url: `/api/inspections/${id}/photos/${p.id}` });
      }
      render(); toast('Photo deleted');
      return true;
    }
    $photos.addEventListener('click', (e) => {
      const b = e.target.closest('[data-view]'); if (!b) return;
      viewer(shown, Math.max(0, shown.findIndex((p) => p.id === b.dataset.view)), { onDelete: (k) => deletePhoto(shown[k]) });
    });

    // note, score and action plan are saved together as one queued update per item
    let saveTimer, dirty = false;
    const fields = () => ({ note: it.note, score: it.score ?? null, action_what: it.action_what ?? '', action_who: it.action_who ?? '', action_due: it.action_due || null });
    const saveItem = () => {
      clearTimeout(saveTimer);
      if (!dirty) return;
      dirty = false;
      outbox.put({ id: `note:${id}:${it.item_key}`, inspectionId: id, itemKey: it.item_key, kind: 'note', method: 'PUT',
        url: `/api/inspections/${id}/items/${encodeURIComponent(it.item_key)}`, body: JSON.stringify(fields()), contentType: 'application/json' });
    };
    const changed = (now = false) => { dirty = true; view.querySelector('#missing').hidden = true; clearTimeout(saveTimer); now ? saveItem() : (saveTimer = setTimeout(saveItem, 700)); };
    view.addEventListener('focusout', saveItem);
    addEventListener('hashchange', saveItem, { once: true });

    // notes stay folded away until needed
    const $note = view.querySelector('#note-wrap');
    const renderNote = (open) => {
      $note.innerHTML = open || it.note?.trim()
        ? `<label class="field"><span>Notes</span><textarea id="note" rows="3" placeholder="Anything the office should know, e.g. grease behind the fryer">${esc(it.note)}</textarea></label>`
        : `<button class="add-note" id="open-note">${icon('pen')} Add a note</button>`;
      $note.querySelector('#open-note')?.addEventListener('click', () => { renderNote(true); $note.querySelector('textarea').focus(); });
      $note.querySelector('textarea')?.addEventListener('input', (e) => { it.note = e.target.value; changed(); });
    };
    renderNote(false);

    // score + urgent action plan (optional on before & after, required on quality checks)
    {
      const $word = view.querySelector('#score-word'), $plan = view.querySelector('#plan');
      const renderScore = () => {
        $word.innerHTML = it.score ? `<strong>${it.score}</strong> · ${scoreWord(it.score)}${ba ? ' <span class="muted small">(tap again to clear)</span>' : ''}` : 'Tap a score';
        $word.className = `score-word${it.score && it.score < LOW_SCORE ? ' low' : ''}`;
        if (!(it.score && it.score < LOW_SCORE)) { $plan.innerHTML = ''; return; }
        $plan.innerHTML = planDone(it)
          ? `<div class="action-card"><div class="row-between"><strong>${icon('alert')} Urgent action</strong><button class="link" id="edit-plan">Edit</button></div>
              <p>${esc(it.action_what)}</p><p class="small muted">${esc(it.action_who)} · by ${esc(new Date(`${it.action_due}T12:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }))}</p></div>`
          : `<div class="action-card needed"><strong>${icon('alert')} Action required</strong>
              <p class="small">Scores below ${LOW_SCORE} need an action plan. The office is alerted when you submit.</p>
              <button class="btn danger-solid block" id="edit-plan">${icon('plus')} Create action</button></div>`;
        $plan.querySelector('#edit-plan').onclick = async () => {
          const v = await sheet({
            title: 'Urgent action', text: `${it.label} scored ${it.score}/10. How will it be put right?`, submitLabel: 'Save action',
            fields: [
              { name: 'action_what', label: 'What needs doing', type: 'textarea', value: it.action_what, required: true, placeholder: 'e.g. Re-clean behind the fryers and degrease the drain' },
              { name: 'action_who', label: 'Assigned to', value: it.action_who, required: true, placeholder: 'Name' },
              { name: 'action_due', label: 'Deadline', type: 'date', value: it.action_due || new Date(Date.now() + 86400000).toISOString().slice(0, 10), min: new Date().toISOString().slice(0, 10), required: true },
            ],
          });
          if (!v) return;
          Object.assign(it, { action_what: v.action_what.trim(), action_who: v.action_who.trim(), action_due: v.action_due });
          changed(true); renderScore(); toast('Action saved');
        };
      };
      renderScore();
      view.querySelectorAll('[data-score]').forEach((b) => b.addEventListener('click', () => {
        it.score = ba && it.score === +b.dataset.score ? null : +b.dataset.score; // optional score: tap again to clear
        view.querySelectorAll('[data-score]').forEach((x) => x.setAttribute('aria-checked', String(+x.dataset.score === it.score)));
        changed(true); renderScore();
        navigator.vibrate?.(8);
      }));
    }

    view.querySelector('#add-item').onclick = () => { saveItem(); addItem(insp, { area: it.area }); };
    view.querySelector('#remove-item')?.addEventListener('click', async () => {
      if (!(await confirmSheet(`Remove "${it.label}"?`, { text: 'Its photos and notes are removed from this inspection.', okLabel: 'Remove' }))) return;
      clearTimeout(saveTimer); dirty = false;
      const pending = (await outbox.all()).filter((e) => e.inspectionId === id && e.itemKey === it.item_key);
      for (const e of pending) { uploading.delete(e.id); await outbox.remove(e.id); }
      if (!pending.some((e) => e.kind === 'additem')) { // never reached the server? dropping the queued add is enough
        await outbox.put({ id: `delitem:${id}:${it.item_key}`, inspectionId: id, itemKey: it.item_key, kind: 'delitem', method: 'DELETE',
          url: `/api/inspections/${id}/items/${encodeURIComponent(it.item_key)}` });
      }
      insp.items = insp.items.filter((x) => x !== it);
      insp.photos = insp.photos.filter((p) => p.item_key !== it.item_key);
      location.hash = base(id);
    });
    // can't move on until the item is scored (and planned if low)
    view.querySelector('#next').addEventListener('click', (e) => {
      const problem = itemProblem(it, insp.mode);
      if (!problem) return;
      e.preventDefault();
      const m = view.querySelector('#missing'); m.textContent = problem; m.hidden = false;
      const target = view.querySelector('.action-card.needed') || view.querySelector('.score-grid');
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target?.classList.remove('shake'); void target?.offsetWidth; target?.classList.add('shake');
    });
  }

  // ── review ──
  async function review(id) {
    const insp = await loadInspection(id);
    if (!editable(insp) || !insp.items.length) { location.replace(base(id)); return; }
    const photos = await allPhotos(insp);
    const states = insp.items.map((it) => itemState(insp, it, photos));
    const problems = insp.items.map((it, i) => [i, itemProblem(it, insp.mode)]).filter(([, p]) => p);
    const done = states.filter((s) => s === 'done').length, total = insp.items.length;
    const avg = avgScore(insp.items), low = insp.items.filter((it) => it.score && it.score < LOW_SCORE);
    const afterPending = insp.mode === 'before_after' ? states.filter((s) => s === 'after').length : 0;
    const notes = insp.items.filter((it) => it.note?.trim()).length, nums = itemNums(insp.items);
    const stat = (label, value, tone = '') => `<div class="stat ${tone}"><span>${label}</span><strong>${value}</strong></div>`;
    const view = shell({ title: 'Review', subtitle: insp.site_name, back: `${base(id)}/item/${total}`, focus: true, body: `
      <section class="card">
        <div class="row-between"><h2>Completion</h2>${done === total ? `<span class="badge green">${icon('check')} Complete</span>` : `<span class="badge amber">${total - done} to go</span>`}</div>
        ${progressBar(done, total)}
      </section>
      <div class="stats">
        ${avg ? stat('Overall score', `${avg}<small>/10</small>`, avg < LOW_SCORE ? 'bad' : 'good') : stat('Inspection', esc(modeLabel(insp)))}
        ${insp.mode === 'check' ? stat('Issues', low.length, low.length ? 'bad' : '') : stat('After photos due', afterPending, afterPending ? 'warn' : '')}
        ${stat('Photos', photos.length)}${stat('Notes', notes)}
        ${insp.mode === 'check' || low.length ? stat('Actions', low.filter(planDone).length, low.length ? 'warn' : '') : ''}
      </div>
      ${problems.length ? `<section class="card warn-card"><h3>${icon('alert')} Before you can submit</h3><ul class="plain">${problems.map(([i, p]) =>
        `<li><a href="${base(id)}/item/${i + 1}"><strong>${esc(insp.items[i].label)}</strong> — ${esc(p)}</a></li>`).join('')}</ul></section>` : ''}
      ${afterPending ? `<p class="note-box">${afterPending} item${afterPending === 1 ? ' still needs' : 's still need'} after photos. You can still submit.</p>` : ''}
      <h3 class="section-h">Items</h3>
      <div class="list-card">${insp.items.map((it, i) => `<a class="row-link" href="${base(id)}/item/${i + 1}">
        <span class="item-num sm state-${states[i]}">${states[i] === 'done' ? icon('check') : nums[i]}</span>
        <span class="row-main"><strong>${esc(it.label)}</strong><small>${STATE_LABEL[states[i]]}</small></span>${scoreBadge(it.score)}${icon('chevron', 'row-chev')}</a>`).join('')}</div>
      <div class="bottom-bar"><a class="btn primary block lg${problems.length ? ' disabled' : ''}" ${problems.length ? 'aria-disabled="true" href="#"' : `href="${base(id)}/sign"`}>
        Continue to sign-off ${icon('chevron')}</a></div>` });
    view.querySelector('.bottom-bar .disabled')?.addEventListener('click', (e) => { e.preventDefault(); toast('Finish the items listed above first', { error: true }); });
  }

  // ── sign-off + submit ──
  async function sign(id) {
    const insp = await loadInspection(id);
    if (!editable(insp) || !insp.items.length || insp.items.some((it) => itemProblem(it, insp.mode))) { location.replace(`${base(id)}/review`); return; }
    const view = shell({ title: 'Sign-off', subtitle: insp.site_name, back: `${base(id)}/review`, focus: true, body: `
      <section class="card">
        <dl class="facts"><dt>Site</dt><dd>${esc(insp.site_name)}</dd><dt>Inspection</dt><dd>${esc(itemTitle(insp))}</dd>
          <dt>Supervisor</dt><dd>${esc(me().name)}</dd><dt>Date</dt><dd>${esc(fmtDateTime(new Date()))}</dd></dl>
      </section>
      <section class="card sign-card">
        <div class="row-between"><h3>Your signature</h3><button class="btn sm" id="clear">Clear</button></div>
        <canvas id="sig" class="sig" aria-label="Sign here with your finger"></canvas>
        <p class="muted small">By signing you confirm this inspection was carried out on site.</p>
      </section>
      <div class="bottom-bar"><button class="btn primary block lg" id="submit" disabled>${icon('send')} Submit inspection</button></div>` });
    const pad = signaturePad(view.querySelector('#sig'));
    const $submit = view.querySelector('#submit');
    pad.onInk((inked) => { $submit.disabled = !inked; });
    view.querySelector('#clear').onclick = () => pad.clear();
    $submit.onclick = async () => {
      $submit.disabled = true; $submit.textContent = 'Submitting…';
      const end_gps = await currentGps(5000);
      await outbox.put({ id: `submit:${id}`, inspectionId: id, kind: 'submit', method: 'POST', url: `/api/inspections/${id}/submit`,
        body: JSON.stringify({ inspector_sig: pad.dataUrl(), end_gps, finished_at: new Date().toISOString() }), contentType: 'application/json' });
      insp.submitting = true;
      location.hash = `${base(id)}/done`;
    };
  }

  // ── submitted ──
  async function done(id) {
    const insp = await loadInspection(id);
    const avg = avgScore(insp.items);
    const waiting = !navigator.onLine && (await outbox.all()).some((e) => e.inspectionId === id);
    shell({ title: '', back: '#/home', focus: true, body: `
      <div class="success">
        <div class="success-ic">${icon(waiting ? 'cloud' : 'check')}</div>
        <h1>${waiting ? 'Saved on this phone' : 'Inspection submitted'}</h1>
        <p class="muted">${waiting ? 'It will be sent automatically as soon as you have signal.' : 'The office has been notified by email.'}</p>
        <section class="card">
          <dl class="facts"><dt>Site</dt><dd>${esc(insp.site_name)}</dd><dt>Inspection</dt><dd>${esc(itemTitle(insp))}</dd>
            ${avg ? `<dt>Score</dt><dd>${scoreBadge(avg)}</dd>` : ''}<dt>Submitted</dt><dd>Just now</dd></dl>
        </section>
      </div>
      <div class="bottom-bar two"><a class="btn lg" href="${base(id)}">View inspection</a><a class="btn primary lg" href="#/home">Back to Home</a></div>` });
    current = null;
  }

  return { start, detail, item, review, sign, done, addItem };
}
