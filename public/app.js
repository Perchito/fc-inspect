const $app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(`/api${path}`, body === undefined ? { method } : {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || r.statusText), { status: r.status });
  return data;
}
const post = (path, body = {}) => api(path, { method: 'POST', body });
const put = (path, body) => api(path, { method: 'PUT', body });
const del = (path) => api(path, { method: 'DELETE' });

const ROLE_LABEL = { admin: 'Admin', inspector: 'Inspector', cleaner: 'Cleaner', client: 'Client' };
let me = null;

// ── small UI helpers ────────────────────────────────────
function toast(msg, isError = false) {
  const t = document.createElement('div');
  t.className = `toast${isError ? ' error-bg' : ''}`;
  t.setAttribute('role', 'status');
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

// Native <dialog> form. fields: [{name, label, type, value, required, options:[{value,label}], hidden}]
// Resolves with the values, or null if cancelled. onSubmit may throw to keep the dialog open.
function formDialog({ title, fields, submitLabel = 'Save', onSubmit, onChange }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    const field = (f) => {
      const id = `f_${f.name}`;
      if (f.type === 'checks') {
        return `<fieldset class="checks" data-field="${f.name}"><legend>${esc(f.label)}</legend>
          ${f.options.length ? f.options.map((o) => `<label class="check"><input type="checkbox" name="${f.name}" value="${esc(o.value)}"
            ${(f.value || []).includes(o.value) ? 'checked' : ''}> ${esc(o.label)}</label>`).join('') : `<p class="muted small">${esc(f.empty || 'None yet')}</p>`}
        </fieldset>`;
      }
      const input = f.type === 'select'
        ? `<select id="${id}" name="${f.name}" ${f.required ? 'required' : ''}>${f.options.map((o) =>
            `<option value="${esc(o.value)}" ${o.value === f.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`
        : f.type === 'textarea'
          ? `<textarea id="${id}" name="${f.name}" rows="3">${esc(f.value)}</textarea>`
          : `<input id="${id}" name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value)}" ${f.required ? 'required' : ''}>`;
      return `<label for="${id}" data-field="${f.name}" ${f.hidden ? 'hidden' : ''}>${esc(f.label)}${input}</label>`;
    };
    d.innerHTML = `<form method="dialog" class="stack">
        <h2>${esc(title)}</h2>
        <p class="error" role="alert" hidden></p>
        ${fields.map(field).join('')}
        <div class="row end"><button type="button" class="btn" value="cancel">Cancel</button>
        <button class="btn primary">${esc(submitLabel)}</button></div>
      </form>`;
    document.body.append(d);
    const form = d.querySelector('form'), err = d.querySelector('.error');
    const values = () => Object.fromEntries(fields.map((f) => [f.name, f.type === 'checks'
      ? [...form.querySelectorAll(`input[name="${f.name}"]:checked`)].map((i) => i.value)
      : form.elements[f.name].value]));
    const close = (v) => { d.close(); d.remove(); resolve(v); };
    form.querySelector('[value=cancel]').onclick = () => close(null);
    d.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    if (onChange) { form.addEventListener('change', () => onChange(values(), form)); onChange(values(), form); }
    form.onsubmit = async (e) => {
      e.preventDefault();
      const v = values(), btn = form.querySelector('.btn.primary');
      btn.disabled = true;
      try { close(onSubmit ? await onSubmit(v) : v); }
      catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
    };
    d.showModal();
    form.querySelector('input:not([type=checkbox]), select, textarea')?.focus();
  });
}

async function confirmDialog(message, okLabel = 'Delete') {
  return !!(await formDialog({ title: message, fields: [], submitLabel: okLabel }));
}

function showPassword(user) {
  return formDialog({
    title: `Login for ${user.email}`, submitLabel: 'Done',
    fields: [{ name: 'password', label: 'Password — shown once, send it to them securely', value: user.password }],
  });
}

// ── login ───────────────────────────────────────────────
function showLogin(error = '') {
  $app.innerHTML = `
    <form class="card login" id="login">
      <img src="/img/fc-logo-black-icon.png" alt="" class="logo">
      <h1>FC Inspect</h1>
      <p class="muted">FC Cleaning Company quality inspections</p>
      ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
      <label>Email <input name="email" type="email" autocomplete="username" required></label>
      <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn primary">Log in</button>
    </form>`;
  const form = document.getElementById('login');
  form.email.focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    form.querySelector('button').disabled = true;
    try { await post('/login', { email: form.email.value, password: form.password.value }); start(); }
    catch (err) { showLogin(err.message); }
  };
}

// ── shell ───────────────────────────────────────────────
const ADMIN_NAV = [['#/clients', 'Clients & sites'], ['#/templates', 'Templates'], ['#/users', 'Users'], ['#/inspect', 'Inspect']];

function shell(content) {
  const nav = me.role === 'admin'
    ? `<nav class="tabs">${ADMIN_NAV.map(([href, label]) =>
        `<a href="${href}" ${location.hash.startsWith(href) ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav>` : '';
  $app.innerHTML = `
    <header class="top">
      <img src="/img/fc-logo-white-icon.png" alt="" class="logo-sm">
      <strong>FC Inspect</strong>
      <span class="spacer"></span>
      <span class="who">${esc(me.name)} · ${ROLE_LABEL[me.role]}</span>
      <span id="sync" class="sync" role="status" hidden></span>
      <button class="btn ghost" id="logout">Log out</button>
    </header>
    ${nav}
    <div id="view">${content}</div>`;
  document.getElementById('logout').onclick = async () => { await post('/logout'); me = null; showLogin(); };
  return document.getElementById('view');
}

// ── admin: clients ──────────────────────────────────────
const clientFields = (c = {}) => [
  { name: 'name', label: 'Business name', value: c.name, required: true },
  { name: 'contact_name', label: 'Contact name', value: c.contact_name },
  { name: 'email', label: 'Email', type: 'email', value: c.email },
  { name: 'phone', label: 'Phone', type: 'tel', value: c.phone },
];

async function viewClients() {
  const clients = await api('/admin/clients');
  const view = shell(`
    <div class="row between"><h1>Clients</h1><button class="btn primary" id="add">Add client</button></div>
    ${clients.length ? `<ul class="list">${clients.map((c) => `
      <li><a href="#/clients/${c.id}" class="list-link">
        <strong>${esc(c.name)}</strong>
        <span class="muted">${esc([c.contact_name, c.email].filter(Boolean).join(' · '))}</span>
        <span class="pill">${c.site_count} site${c.site_count === 1 ? '' : 's'}</span>
      </a></li>`).join('')}</ul>`
      : '<p class="empty">No clients yet. Add your first client, then their sites.</p>'}`);
  view.querySelector('#add').onclick = async () => {
    const c = await formDialog({ title: 'Add client', fields: clientFields(), onSubmit: (v) => post('/admin/clients', v) });
    if (c) location.hash = `#/clients/${c.id}`;
  };
}

async function viewClient(id) {
  const [clients, sites, templates, users] = await Promise.all([
    api('/admin/clients'), api(`/admin/sites?client_id=${id}`), api('/admin/templates'), api('/admin/users')]);
  const client = clients.find((c) => c.id === id);
  if (!client) { location.hash = '#/clients'; return; }
  const tName = Object.fromEntries(templates.map((t) => [t.id, t.name]));
  const cleaners = users.filter((u) => u.role === 'cleaner' && u.active);
  const uName = Object.fromEntries(users.map((u) => [u.id, u.name]));
  const logins = users.filter((u) => u.client_id === id);

  const view = shell(`
    <p><a href="#/clients">← All clients</a></p>
    <section class="card">
      <div class="row between"><h1>${esc(client.name)}</h1>
        <div class="row"><button class="btn" id="edit">Edit</button><button class="btn danger" id="delete">Delete</button></div></div>
      <p class="muted">${esc([client.contact_name, client.email, client.phone].filter(Boolean).join(' · ') || 'No contact details')}</p>
    </section>
    <div class="row between"><h2>Sites</h2><button class="btn primary" id="add-site">Add site</button></div>
    ${sites.length ? sites.map((s) => `
      <section class="card site">
        <div class="row between"><div><strong>${esc(s.name)}</strong><div class="muted">${esc(s.address || '')}</div></div>
          <div class="row"><button class="btn" data-edit-site="${s.id}">Edit</button><button class="btn danger" data-del-site="${s.id}">Delete</button></div></div>
        <p class="small"><span class="label">Templates</span> ${s.template_ids.map((t) => `<span class="pill">${esc(tName[t])}</span>`).join('') || '<span class="muted">none — inspectors can\'t inspect this site yet</span>'}</p>
        <p class="small"><span class="label">Cleaners</span> ${s.cleaner_ids.map((u) => `<span class="pill">${esc(uName[u])}</span>`).join('') || '<span class="muted">none</span>'}</p>
      </section>`).join('') : '<p class="empty">No sites yet.</p>'}
    <div class="row between"><h2>Client logins</h2><button class="btn" id="add-login">Add client login</button></div>
    ${logins.length ? `<ul class="list">${logins.map((u) => `<li class="list-row"><strong>${esc(u.name)}</strong><span class="muted">${esc(u.email)}</span>
      ${u.active ? '' : '<span class="pill">inactive</span>'}</li>`).join('')}</ul>`
      : '<p class="empty">Nobody from this client can log in yet. Manage logins on the Users tab.</p>'}`);

  const siteFields = (s = {}) => [
    { name: 'name', label: 'Site name', value: s.name, required: true },
    { name: 'address', label: 'Address', type: 'textarea', value: s.address },
    { name: 'template_ids', label: 'Templates used at this site', type: 'checks', value: s.template_ids,
      options: templates.map((t) => ({ value: t.id, label: t.name })), empty: 'No templates yet — create one on the Templates tab.' },
    { name: 'cleaner_ids', label: 'Cleaners assigned', type: 'checks', value: s.cleaner_ids,
      options: cleaners.map((u) => ({ value: u.id, label: u.name })), empty: 'No cleaner accounts yet — add them on the Users tab.' },
  ];
  const reload = () => viewClient(id);
  view.querySelector('#edit').onclick = async () => {
    if (await formDialog({ title: 'Edit client', fields: clientFields(client), onSubmit: (v) => put(`/admin/clients/${id}`, v) })) reload();
  };
  view.querySelector('#delete').onclick = async () => {
    if (!(await confirmDialog(`Delete ${client.name}, its sites and client logins?`))) return;
    try { await del(`/admin/clients/${id}`); location.hash = '#/clients'; } catch (e) { toast(e.message, true); }
  };
  view.querySelector('#add-site').onclick = async () => {
    if (await formDialog({ title: 'Add site', fields: siteFields(), onSubmit: (v) => post('/admin/sites', { ...v, client_id: id }) })) reload();
  };
  view.querySelectorAll('[data-edit-site]').forEach((b) => b.onclick = async () => {
    const s = sites.find((x) => x.id === b.dataset.editSite);
    if (await formDialog({ title: 'Edit site', fields: siteFields(s), onSubmit: (v) => put(`/admin/sites/${s.id}`, v) })) reload();
  });
  view.querySelectorAll('[data-del-site]').forEach((b) => b.onclick = async () => {
    const s = sites.find((x) => x.id === b.dataset.delSite);
    if (!(await confirmDialog(`Delete site ${s.name}?`))) return;
    try { await del(`/admin/sites/${s.id}`); reload(); } catch (e) { toast(e.message, true); }
  });
  view.querySelector('#add-login').onclick = async () => {
    const u = await formDialog({
      title: `Add login for ${client.name}`,
      fields: [{ name: 'name', label: 'Name', value: client.contact_name, required: true },
        { name: 'email', label: 'Email', type: 'email', value: client.email, required: true }],
      onSubmit: (v) => post('/admin/users', { ...v, role: 'client', client_id: id }),
    });
    if (u) { await showPassword(u); reload(); }
  };
}

// ── admin: templates ────────────────────────────────────
async function viewTemplates() {
  const templates = await api('/admin/templates');
  const view = shell(`
    <div class="row between"><h1>Templates</h1><button class="btn primary" id="add">New template</button></div>
    <p class="muted">A template is the checklist an inspector walks through: one photo-and-notes step per item.</p>
    ${templates.length ? `<ul class="list">${templates.map((t) => `
      <li><a href="#/templates/${t.id}" class="list-link"><strong>${esc(t.name)}</strong>
        <span class="muted">${t.items.length} item${t.items.length === 1 ? '' : 's'}</span>
        <span class="pill">${t.site_count} site${t.site_count === 1 ? '' : 's'}</span></a></li>`).join('')}</ul>`
      : '<p class="empty">No templates yet.</p>'}`);
  view.querySelector('#add').onclick = async () => {
    const t = await formDialog({ title: 'New template', fields: [{ name: 'name', label: 'Template name', required: true }],
      submitLabel: 'Create', onSubmit: (v) => post('/admin/templates', { name: v.name, items: [] }) });
    if (t) location.hash = `#/templates/${t.id}`;
  };
}

async function viewTemplate(id) {
  const t = (await api('/admin/templates')).find((x) => x.id === id);
  if (!t) { location.hash = '#/templates'; return; }
  const items = t.items.map((i) => ({ ...i }));
  let dirty = false;
  const view = shell(`
    <p><a href="#/templates">← All templates</a></p>
    <section class="card stack">
      <label>Template name <input id="tname" value="${esc(t.name)}"></label>
      <p class="muted small">Used at ${t.site_count} site${t.site_count === 1 ? '' : 's'}. Edits apply to new inspections only — finished reports keep the items they had.</p>
      <ol id="items" class="items"></ol>
      <button class="btn" id="add-item">+ Add item</button>
      <div class="row between"><button class="btn danger" id="delete">Delete template</button>
        <button class="btn primary" id="save">Save</button></div>
    </section>`);
  const $items = view.querySelector('#items');
  const render = () => {
    $items.innerHTML = items.map((it, i) => `
      <li class="item">
        <div class="stack grow">
          <input data-i="${i}" data-k="label" value="${esc(it.label)}" placeholder="e.g. Kitchen surfaces" aria-label="Item ${i + 1} name">
          <input data-i="${i}" data-k="hint" value="${esc(it.hint)}" placeholder="Hint for the inspector (optional)" aria-label="Item ${i + 1} hint" class="small">
        </div>
        <div class="item-tools">
          <button class="btn icon" data-move="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
          <button class="btn icon" data-move="${i}" data-dir="1" ${i === items.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
          <button class="btn icon danger" data-remove="${i}" aria-label="Remove item">✕</button>
        </div>
      </li>`).join('') || '<li class="empty">No items yet — add the areas to check, e.g. Reception, Kitchen, Toilets.</li>';
  };
  render();
  $items.addEventListener('input', (e) => { const { i, k } = e.target.dataset; if (k) { items[i][k] = e.target.value; dirty = true; } });
  $items.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.remove) items.splice(+b.dataset.remove, 1);
    if (b.dataset.move) { const i = +b.dataset.move, j = i + +b.dataset.dir; [items[i], items[j]] = [items[j], items[i]]; }
    dirty = true; render();
  });
  view.querySelector('#tname').oninput = () => { dirty = true; };
  view.querySelector('#add-item').onclick = () => {
    items.push({ label: '', hint: '' }); dirty = true; render();
    $items.querySelector(`[data-i="${items.length - 1}"][data-k=label]`).focus();
  };
  view.querySelector('#save').onclick = async () => {
    try {
      const saved = await put(`/admin/templates/${id}`, { name: view.querySelector('#tname').value, items: items.filter((i) => i.label.trim()) });
      items.splice(0, items.length, ...saved.items); dirty = false; render(); toast('Template saved');
    } catch (e) { toast(e.message, true); }
  };
  view.querySelector('#delete').onclick = async () => {
    if (!(await confirmDialog(`Delete template ${t.name}? Sites using it will lose it.`))) return;
    try { await del(`/admin/templates/${id}`); dirty = false; location.hash = '#/templates'; } catch (e) { toast(e.message, true); }
  };
  leaveGuard = () => !dirty || confirm('You have unsaved changes to this template. Leave anyway?');
}

// ── admin: users ────────────────────────────────────────
async function viewUsers() {
  const [users, clients] = await Promise.all([api('/admin/users'), api('/admin/clients')]);
  const view = shell(`
    <div class="row between"><h1>Users</h1><button class="btn primary" id="add">Add user</button></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead>
      <tbody>${users.map((u) => `
        <tr class="${u.active ? '' : 'inactive'}">
          <td>${esc(u.name)}${u.id === me.id ? ' <span class="muted">(you)</span>' : ''}</td>
          <td>${esc(u.email)}</td>
          <td>${ROLE_LABEL[u.role]}${u.client_name ? ` · ${esc(u.client_name)}` : ''}${u.active ? '' : ' <span class="pill">inactive</span>'}</td>
          <td class="actions"><button class="btn" data-edit="${u.id}">Edit</button>
            <button class="btn" data-reset="${u.id}">Reset password</button></td>
        </tr>`).join('')}</tbody>
    </table></div>`);
  const roleOptions = Object.entries(ROLE_LABEL).map(([value, label]) => ({ value, label }));
  const clientOptions = [{ value: '', label: '— pick client —' }, ...clients.map((c) => ({ value: c.id, label: c.name }))];
  const userFields = (u = {}) => [
    { name: 'name', label: 'Name', value: u.name, required: true },
    { name: 'email', label: 'Email', type: 'email', value: u.email, required: true },
    { name: 'role', label: 'Role', type: 'select', value: u.role || 'inspector', options: roleOptions },
    { name: 'client_id', label: 'Client', type: 'select', value: u.client_id || '', options: clientOptions },
    ...(u.id ? [{ name: 'active', label: 'Status', type: 'select', value: u.active ? 'yes' : 'no',
      options: [{ value: 'yes', label: 'Active — can log in' }, { value: 'no', label: 'Inactive — blocked' }] }] : []),
  ];
  const showClientPick = (v, form) => { form.querySelector('[data-field=client_id]').hidden = v.role !== 'client'; };
  view.querySelector('#add').onclick = async () => {
    const u = await formDialog({ title: 'Add user', fields: userFields(), submitLabel: 'Create', onChange: showClientPick,
      onSubmit: (v) => post('/admin/users', v) });
    if (u) { await showPassword(u); viewUsers(); }
  };
  view.querySelectorAll('[data-edit]').forEach((b) => b.onclick = async () => {
    const u = users.find((x) => x.id === b.dataset.edit);
    if (await formDialog({ title: `Edit ${u.name}`, fields: userFields(u), onChange: showClientPick,
      onSubmit: (v) => put(`/admin/users/${u.id}`, { ...v, active: v.active === 'yes' }) })) viewUsers();
  });
  view.querySelectorAll('[data-reset]').forEach((b) => b.onclick = async () => {
    const u = users.find((x) => x.id === b.dataset.reset);
    if (!(await confirmDialog(`Give ${u.name} a new password? Their current one stops working.`, 'Reset'))) return;
    try {
      await showPassword(await post(`/admin/users/${u.id}/reset-password`));
      if (u.id === me.id) { me = null; showLogin('Your password was reset — log in with the new one.'); }
    } catch (e) { toast(e.message, true); }
  });
}

// ── non-admin placeholder (inspector/cleaner/client screens come in later steps) ──
function viewHome() {
  shell(`<section class="card"><h2>Welcome, ${esc(me.name.split(' ')[0])}</h2>
    <p class="muted">You're logged in as ${ROLE_LABEL[me.role].toLowerCase()}. Your screens are on the way.</p></section>`);
}

// ── router ──────────────────────────────────────────────
// inspect.js imported with this file's ?v= so Cloudflare's 4h cache never serves a stale copy
const { inspectViews, flush } = await import(`./inspect.js${new URL(import.meta.url).search}`);
const insp = inspectViews({ api, post, del, esc, toast, shell, confirmDialog });
const INSPECT_ROUTES = [
  [/^#\/inspect$/, insp.home], [/^#\/inspect\/new$/, insp.start],
  [/^#\/inspect\/([\w-]{36})$/, insp.overview], [/^#\/inspect\/([\w-]{36})\/finish$/, insp.finish],
  [/^#\/inspect\/([\w-]{36})\/(\d+)$/, insp.item],
];
let leaveGuard = null;
const ROUTES = [...INSPECT_ROUTES,
  [/^#\/clients\/([\w-]+)$/, viewClient], [/^#\/clients$/, viewClients],
  [/^#\/templates\/([\w-]+)$/, viewTemplate], [/^#\/templates$/, viewTemplates],
  [/^#\/users$/, viewUsers],
];
let lastHash = location.hash;
async function route() {
  if (leaveGuard && !leaveGuard()) { history.replaceState(null, '', lastHash); return; }
  leaveGuard = null; lastHash = location.hash;
  const routes = { admin: ROUTES, inspector: INSPECT_ROUTES }[me.role];
  if (!routes) return viewHome();
  const hit = routes.find(([re]) => re.test(location.hash));
  if (!hit) { location.replace(me.role === 'admin' ? '#/clients' : '#/inspect'); return; }
  try { await hit[1](...location.hash.match(hit[0]).slice(1)); }
  catch (err) { err.status === 401 ? showLogin('Your session ended — log in again.') : shell(`<p class="error">${esc(err.message)}</p>`); }
}
addEventListener('hashchange', () => me && route());

async function start() {
  try { me = await api('/me'); route(); flush(); }
  catch (err) { err.status === 401 ? showLogin() : ($app.innerHTML = `<p class="error center">${esc(err.message)}</p>`); }
}
start();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('sw', e));
