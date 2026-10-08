// FC Inspect design system: tiny helpers + reusable UI pieces (no framework, no build step).

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ── icons (24px stroke icons, currentColor) ─────────────
const P = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h5v-6h4v6h5V9.5"/>',
  list: '<rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  actions: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.5 2.5L16 9.5"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  back: '<path d="M15 5 8 12l7 7"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.6-4.5M4 13a8 8 0 0 0 14.6 4.5"/><path d="M5 3v4h4M19 21v-4h-4"/>',
  offline: '<path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 12.5a10 10 0 0 1 4-2.4M19 12.5a10 10 0 0 0-2.6-1.8M2 8.8a15 15 0 0 1 4.6-2.9M22 8.8A15 15 0 0 0 12 5"/><circle cx="12" cy="20" r="1"/>',
  cloud: '<path d="M7 18a4.5 4.5 0 0 1-.5-9A6 6 0 0 1 18 8.5a4.8 4.8 0 0 1-1 9.5z"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17.5v.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
  building: '<path d="M4 21V5l8-2v18M12 8h8v13M8 8v.01M8 12v.01M8 16v.01M16 12v.01M16 16v.01M2 21h20"/>',
  template: '<rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="m8 9 1.5 1.5L12 8M8 15l1.5 1.5L12 14M14 9.5h3M14 15.5h3"/>',
  file: '<path d="M6 2h8l5 5v15H6z"/><path d="M14 2v5h5M9 13h6M9 17h6"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  pin: '<path d="M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>',
  send: '<path d="M21 3 10 14M21 3l-7 18-4-7-7-4z"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>',
};
export const icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;

// ── API ─────────────────────────────────────────────────
export class ApiError extends Error {}
export async function api(path, { method = 'GET', body } = {}) {
  let r;
  try {
    r = await fetch(`/api${path}`, body === undefined ? { method } : {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new ApiError("You're offline, or the connection dropped."), { offline: true });
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401) dispatchEvent(new Event('fci:logged-out'));
    throw Object.assign(new ApiError(data.error || 'Something went wrong. Please try again.'), { status: r.status });
  }
  return data;
}
export const post = (path, body = {}) => api(path, { method: 'POST', body });
export const put = (path, body) => api(path, { method: 'PUT', body });
export const del = (path) => api(path, { method: 'DELETE' });

// ── formatting ──────────────────────────────────────────
const TZ = { timeZone: 'Europe/London' };
export const fmtDateTime = (d) => d ? new Date(d).toLocaleString('en-GB', { ...TZ, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
export const fmtTime = (d) => new Date(d).toLocaleTimeString('en-GB', { ...TZ, hour: '2-digit', minute: '2-digit' });
export function relDay(d) {
  if (!d) return '—';
  const date = new Date(d), today = new Date();
  const key = (x) => x.toLocaleDateString('en-CA', TZ);
  const diff = Math.round((new Date(key(date)) - new Date(key(today))) / 86400000);
  if (diff === 0) return `Today · ${fmtTime(date)}`;
  if (diff === -1) return `Yesterday · ${fmtTime(date)}`;
  return date.toLocaleDateString('en-GB', { ...TZ, day: 'numeric', month: 'short', ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}
// action deadline (YYYY-MM-DD) as words
export function dueText(d) {
  if (!d) return 'No deadline';
  const today = new Date().toLocaleDateString('en-CA', TZ);
  const diff = Math.round((new Date(d) - new Date(today)) / 86400000);
  if (diff < -1) return `Overdue · ${-diff} days`;
  if (diff === -1) return 'Overdue · yesterday';
  if (diff === 0) return 'Due today';
  if (diff === 1) return 'Due tomorrow';
  if (diff < 7) return `Due in ${diff} days`;
  return `Due ${new Date(`${d}T12:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}
export const daysUntil = (d) => d ? Math.round((new Date(d) - new Date(new Date().toLocaleDateString('en-CA', TZ))) / 86400000) : null;
export const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

// ── status + score ──────────────────────────────────────
export const STATUS = {
  draft: ['In progress', 'blue'], returned: ['Returned', 'amber'], submitted: ['Submitted', 'neutral'], approved: ['Completed', 'green'],
};
export const statusBadge = (status, { sending = false } = {}) => {
  const [label, tone] = sending ? ['Sending…', 'neutral'] : STATUS[status] || [status, 'neutral'];
  return `<span class="badge ${tone}">${label}</span>`;
};
export const LOW_SCORE = 7;
export const scoreWord = (n) => !n ? '' : n <= 3 ? 'Poor' : n <= 6 ? 'Needs work' : n <= 8 ? 'Good' : 'Excellent';
export const scoreBadge = (n) => n ? `<span class="score ${n < LOW_SCORE ? 'low' : ''}">${Number(n) % 1 ? Number(n).toFixed(1) : n}<small>/10</small></span>` : '';
export const modeLabel = (insp) => insp.mode === 'check' ? (insp.template_id ? 'Quality Check' : 'Quality Check · no checklist') : insp.template_id ? 'Before & After' : 'Before & After · no checklist';

// ── progress ────────────────────────────────────────────
export const pct = (done, total) => (total ? Math.round((done / total) * 100) : 0);
export const progressBar = (done, total, label = true) => `
  <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}" aria-label="${done} of ${total} items done">
    <span style="width:${pct(done, total)}%"></span></div>
  ${label ? `<div class="progress-label"><span>${done} of ${total} items</span><strong>${pct(done, total)}%</strong></div>` : ''}`;

// ── states ──────────────────────────────────────────────
export const skeleton = (n = 3) => `<div class="stack" aria-busy="true" aria-label="Loading">${Array.from({ length: n }, () =>
  '<div class="card sk"><div class="sk-line w60"></div><div class="sk-line w40"></div><div class="sk-line w25"></div></div>').join('')}</div>`;
export const emptyState = ({ icon: ic = 'list', title, text = '', action = '' }) =>
  `<div class="empty"><div class="empty-ic">${icon(ic)}</div><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}${action}</div>`;
export const errorState = (err, retryId = 'retry') => `<div class="empty error-state" role="alert">
  <div class="empty-ic">${icon(err?.offline ? 'offline' : 'alert')}</div>
  <h3>${err?.offline ? "You're offline" : 'Something went wrong'}</h3>
  <p>${esc(err?.offline ? "This screen needs a connection the first time. Anything you've already done is safely stored on this phone." : err?.message || 'Please try again.')}</p>
  <button class="btn" id="${retryId}">${icon('sync')} Try again</button></div>`;

// ── toast ───────────────────────────────────────────────
export function toast(msg, { error = false } = {}) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = `toast${error ? ' error' : ''}`;
  t.setAttribute('role', error ? 'alert' : 'status');
  t.innerHTML = `${icon(error ? 'alert' : 'check')}<span>${esc(msg)}</span>`;
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, error ? 4500 : 2600);
}

// ── sheets / dialogs (native <dialog>, styled as a bottom sheet on phones) ──
// fields: [{name, label, type, value, required, options:[{value,label}], placeholder, hint}]
// Resolves with onSubmit's result (or the values), or null when cancelled. onSubmit may throw to stay open.
export function sheet({ title, text = '', fields = [], submitLabel = 'Save', danger = false, onSubmit, onChange }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'sheet';
    const field = (f) => {
      const id = `f_${f.name}`;
      if (f.type === 'checks') {
        return `<fieldset class="checks" data-field="${f.name}"><legend>${esc(f.label)}</legend>
          ${f.options.length ? f.options.map((o) => `<label class="check-row"><input type="checkbox" name="${f.name}" value="${esc(o.value)}"
            ${(f.value || []).includes(o.value) ? 'checked' : ''}><span>${esc(o.label)}</span></label>`).join('') : `<p class="muted small">${esc(f.empty || 'None yet')}</p>`}
        </fieldset>`;
      }
      if (f.type === 'choice') { // one-tap chips (radio buttons) instead of a dropdown
        return `<fieldset class="choice" data-field="${f.name}"><legend>${esc(f.label)}</legend>
          ${f.options.map((o) => `<label class="chip-radio"><input type="radio" name="${f.name}" value="${esc(o.value)}"
            ${o.value === f.value ? 'checked' : ''}><span>${esc(o.label)}</span></label>`).join('')}</fieldset>`;
      }
      const common = `id="${id}" name="${f.name}" ${f.required ? 'required' : ''} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}`;
      const input = f.type === 'select'
        ? `<select ${common}>${f.options.map((o) => `<option value="${esc(o.value)}" ${o.value === f.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`
        : f.type === 'textarea' ? `<textarea ${common} rows="${f.rows || 3}">${esc(f.value)}</textarea>`
          : `<input ${common} type="${f.type || 'text'}" value="${esc(f.value)}" ${f.min ? `min="${f.min}"` : ''} autocomplete="off">`;
      return `<label class="field" for="${id}" data-field="${f.name}"><span>${esc(f.label)}</span>${input}${f.hint ? `<small>${esc(f.hint)}</small>` : ''}</label>`;
    };
    d.innerHTML = `<form method="dialog" class="sheet-body">
        <div class="sheet-grip" aria-hidden="true"></div>
        <h2>${esc(title)}</h2>${text ? `<p class="muted">${esc(text)}</p>` : ''}
        <p class="form-error" role="alert" hidden></p>
        ${fields.map(field).join('')}
        <div class="sheet-actions"><button type="button" class="btn" value="cancel">Cancel</button>
          <button class="btn ${danger ? 'danger-solid' : 'primary'}">${esc(submitLabel)}</button></div>
      </form>`;
    document.body.append(d);
    const form = d.querySelector('form'), err = d.querySelector('.form-error');
    const values = () => Object.fromEntries(fields.map((f) => [f.name, f.type === 'checks'
      ? [...form.querySelectorAll(`input[name="${f.name}"]:checked`)].map((i) => i.value) : form.elements[f.name].value]));
    const close = (v) => { d.classList.add('closing'); setTimeout(() => { d.close(); d.remove(); }, 160); resolve(v); };
    form.querySelector('[value=cancel]').onclick = () => close(null);
    d.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    d.addEventListener('click', (e) => { if (e.target === d) close(null); }); // tap the backdrop
    if (onChange) { form.addEventListener('change', () => onChange(values(), form)); onChange(values(), form); }
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = form.querySelector('.sheet-actions .btn:last-child');
      btn.disabled = true;
      try { close(onSubmit ? await onSubmit(values()) : values()); }
      catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
    };
    // focus the dialog, not its first field: iOS won't open a dropdown that showModal() auto-focused
    d.autofocus = true;
    d.showModal();
    if (fields.length && !matchMedia('(pointer: coarse)').matches) form.querySelector('input:not([type=checkbox]), select, textarea')?.focus();
  });
}
export const confirmSheet = async (title, { text = '', okLabel = 'Delete', danger = true } = {}) =>
  !!(await sheet({ title, text, submitLabel: okLabel, danger }));

// ── full-screen photo viewer ────────────────────────────
// photos: [{src, label?}]; onDelete(i) optional → returns true to close
export function viewer(photos, start = 0, { onDelete } = {}) {
  let i = start;
  const d = document.createElement('dialog');
  d.className = 'viewer';
  const render = () => {
    const p = photos[i];
    d.innerHTML = `<div class="viewer-top">
        <button class="icon-btn light" data-act="close" aria-label="Close">${icon('x')}</button>
        <span>${p.label ? `${esc(p.label)} · ` : ''}${i + 1} / ${photos.length}</span>
        ${onDelete ? `<button class="icon-btn light" data-act="delete" aria-label="Delete photo">${icon('trash')}</button>` : '<span></span>'}
      </div>
      <img src="${p.src}" alt="${esc(p.label || 'Photo')}">
      ${photos.length > 1 ? `<button class="viewer-nav prev" data-act="prev" aria-label="Previous photo">${icon('back')}</button>
        <button class="viewer-nav next" data-act="next" aria-label="Next photo">${icon('chevron')}</button>` : ''}`;
  };
  render();
  document.body.append(d);
  const close = () => { d.close(); d.remove(); };
  d.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') close();
    if (act === 'prev') { i = (i - 1 + photos.length) % photos.length; render(); }
    if (act === 'next') { i = (i + 1) % photos.length; render(); }
    if (act === 'delete' && (await onDelete(i))) close();
  });
  let x0 = null;
  d.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  d.addEventListener('touchend', (e) => {
    if (x0 == null || photos.length < 2) return;
    const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (Math.abs(dx) > 50) { i = (i + (dx < 0 ? 1 : -1) + photos.length) % photos.length; render(); }
  });
  d.addEventListener('cancel', close);
  d.showModal();
}

// ── small pieces ────────────────────────────────────────
export const chips = (items, active, attr = 'data-filter') => `<div class="chips" role="tablist">${items.map(([value, label, count]) =>
  `<button class="chip" role="tab" ${attr}="${esc(value)}" aria-selected="${value === active}">${esc(label)}${count != null ? ` <span class="chip-count">${count}</span>` : ''}</button>`).join('')}</div>`;
export const searchBar = (placeholder, value = '') => `<label class="search">${icon('search')}
  <input type="search" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" value="${esc(value)}" autocomplete="off" enterkeyhint="search"></label>`;
export const avatar = (name, tone = '') => `<span class="avatar ${tone}" aria-hidden="true">${esc(initials(name))}</span>`;
export const row = ({ href, ic, title, sub = '', right = '', danger = false, id = '' }) =>
  `<${href ? `a href="${href}"` : `button type="button" ${id ? `id="${id}"` : ''}`} class="row-link${danger ? ' danger' : ''}">
    ${ic ? `<span class="row-ic">${icon(ic)}</span>` : ''}
    <span class="row-main"><strong>${esc(title)}</strong>${sub ? `<small>${esc(sub)}</small>` : ''}</span>
    ${right}${href ? icon('chevron', 'row-chev') : ''}</${href ? 'a' : 'button'}>`;

// ── save a PDF to the device ────────────────────────────
// iPhone home-screen apps can't download files from a link (it only opens a viewer), so on phones the PDF is
// fetched here and handed to the share sheet ("Save to Files", AirDrop, WhatsApp…). Elsewhere: normal download.
export async function savePdf(url, fallbackName = 'FC-Inspection.pdf') {
  toast('Preparing PDF…');
  let res;
  try { res = await fetch(url, { credentials: 'same-origin' }); } catch { return toast("Couldn't get the PDF — check your connection.", { error: true }); }
  if (!res.ok) return toast("Couldn't get the PDF. Please try again.", { error: true });
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || fallbackName;
  const file = new File([blob], name, { type: 'application/pdf' });
  if (navigator.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
    const share = () => navigator.share({ files: [file], title: name });
    try { await share(); return; } catch (e) { if (e.name === 'AbortError') return; }
    // the tap "expired" while a big PDF downloaded: one more tap opens the share sheet
    await sheet({
      title: 'PDF ready', submitLabel: 'Save PDF',
      text: `${name} · ${(blob.size / 1048576).toFixed(1)} MB. Tap Save PDF, then choose “Save to Files”.`,
      onSubmit: async () => { try { await share(); } catch (e) { if (e.name !== 'AbortError') throw new Error("Couldn't open the share sheet on this phone."); } },
    });
    return;
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

// ── areas: template items can be grouped under an area (1. Kitchen → 1.1 Kettle, 1.2 Fridge) ──
// numbers like "1", "1.1", "2.3"; an item with no area gets its own top-level number
export function itemNums(items) {
  let a = 0, s = 0, prev = '';
  return items.map((it) => {
    if (!it.area) { prev = ''; return String(++a); }
    if (it.area !== prev) { prev = it.area; a++; s = 0; }
    return `${a}.${++s}`;
  });
}
// heading shown before the first item of each area ('' otherwise)
// area heading; rename = show a pencil (data-rename-area) to rename the whole area
export const areaHead = (items, nums, i, { rename = false } = {}) => items[i].area && items[i].area !== items[i - 1]?.area
  ? `<h4 class="area-h">${nums[i].split('.')[0]}. ${esc(items[i].area)}${rename ? ` <button class="icon-btn sm-pen" data-rename-area="${esc(items[i].area)}" aria-label="Rename area">${icon('pen')}</button>` : ''}</h4>` : '';
// ask for a new name (item or area); resolves with the trimmed name or null
export const askName = async (title, value, label = 'Name') => (await sheet({ title, submitLabel: 'Rename', fields: [{ name: 'name', label, value, required: true }] }))?.name?.trim() || null;
