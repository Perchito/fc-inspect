// Management (admins): clients & sites, templates, users.
import {
  esc, icon, api, post, put, del, toast, sheet, confirmSheet, skeleton, emptyState, errorState, searchBar, avatar,
  statusBadge, scoreBadge, modeLabel, relDay,
} from './ui.js?v=__V__';

const ROLE_LABEL = { admin: 'Admin', inspector: 'Supervisor', cleaner: 'Cleaner', client: 'Client' };
// for now only admins and supervisors log in (no client/cleaner portal); reports go to clients as PDFs
const ACTIVE_ROLES = ['admin', 'inspector'];

export function adminViews({ shell, me, setLeaveGuard }) {
  const fail = (view, e, again) => { view.innerHTML = errorState(e); view.querySelector('#retry').onclick = again; };

  // ── clients ──
  const clientFields = (c = {}) => [
    { name: 'name', label: 'Business name', value: c.name, required: true },
    { name: 'contact_name', label: 'Contact name', value: c.contact_name },
    { name: 'email', label: 'Email', type: 'email', value: c.email },
    { name: 'phone', label: 'Phone', type: 'tel', value: c.phone },
  ];
  async function clients() {
    const view = shell({ title: 'Clients', subtitle: 'Clients and their sites', back: '#/more', tab: 'more', body: skeleton(3),
      action: { id: 'add', icon: 'plus', label: 'Add client' } });
    const add = async () => {
      const c = await sheet({ title: 'Add client', fields: clientFields(), submitLabel: 'Add client', onSubmit: (v) => post('/admin/clients', v) });
      if (c) { toast('Client added'); location.hash = `#/clients/${c.id}`; }
    };
    document.getElementById('add')?.addEventListener('click', add);
    let list;
    try { list = await api('/admin/clients'); } catch (e) { return fail(view, e, clients); }
    view.innerHTML = `${list.length > 5 ? searchBar('Search clients') : ''}<div class="card-grid" id="list"></div>`;
    const render = (q = '') => {
      const hits = list.filter((c) => `${c.name} ${c.contact_name || ''}`.toLowerCase().includes(q.toLowerCase()));
      view.querySelector('#list').innerHTML = hits.map((c) => `<a class="card tap media" href="#/clients/${c.id}">
          <span class="card-ic">${icon('building')}</span>
          <span class="grow"><strong>${esc(c.name)}</strong>
            <small>${c.site_count} site${c.site_count === 1 ? '' : 's'} · ${c.inspection_count} inspection${c.inspection_count === 1 ? '' : 's'}</small>
            ${c.open_actions ? `<small class="bad">${c.open_actions} open action${c.open_actions === 1 ? '' : 's'}</small>` : ''}</span>${icon('chevron', 'chev')}</a>`).join('')
        || emptyState({ icon: 'building', title: list.length ? 'No matching clients' : 'No clients yet', text: list.length ? '' : 'Add your first client, then their sites.',
          action: list.length ? '' : `<button class="btn primary" id="add-empty">${icon('plus')} Add client</button>` });
      view.querySelector('#add-empty')?.addEventListener('click', add);
    };
    render();
    view.querySelector('.search input')?.addEventListener('input', (e) => render(e.target.value));
  }

  async function client(id) {
    const view = shell({ title: 'Client', back: '#/clients', tab: 'more', body: skeleton(3) });
    let cl, sites, templates, insps;
    try {
      [cl, sites, templates, insps] = await Promise.all([api('/admin/clients'), api(`/admin/sites?client_id=${id}`), api('/admin/templates'), api('/admin/inspections')]);
    } catch (e) { return fail(view, e, () => client(id)); }
    const c = cl.find((x) => x.id === id);
    if (!c) { location.replace('#/clients'); return; }
    const tName = Object.fromEntries(templates.map((t) => [t.id, t.name]));
    const history = insps.filter((i) => i.client_name === c.name).slice(0, 6);
    const reload = () => client(id);
    view.innerHTML = `
      <section class="card">
        <div class="row-between"><h2>${esc(c.name)}</h2><button class="btn sm" id="edit">${icon('pen')} Edit</button></div>
        <dl class="facts">${c.contact_name ? `<dt>Contact</dt><dd>${esc(c.contact_name)}</dd>` : ''}
          ${c.email ? `<dt>Email</dt><dd><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></dd>` : ''}
          ${c.phone ? `<dt>Phone</dt><dd><a href="tel:${esc(c.phone)}">${esc(c.phone)}</a></dd>` : ''}
          <dt>Inspections</dt><dd>${c.inspection_count}${c.open_actions ? ` · <span class="bad">${c.open_actions} open action${c.open_actions === 1 ? '' : 's'}</span>` : ''}</dd></dl>
      </section>
      <div class="row-between section-h"><h3>Sites</h3><button class="btn sm primary" id="add-site">${icon('plus')} Add site</button></div>
      ${sites.length ? `<div class="stack">${sites.map((s) => `<section class="card site-card">
          <div class="row-between"><div><strong>${esc(s.name)}</strong>${s.address ? `<p class="muted small">${esc(s.address)}</p>` : ''}</div>
            <div class="btn-row"><button class="icon-btn" data-edit-site="${s.id}" aria-label="Edit ${esc(s.name)}">${icon('pen')}</button>
              <button class="icon-btn danger" data-del-site="${s.id}" aria-label="Delete ${esc(s.name)}">${icon('trash')}</button></div></div>
          <div class="tags">${s.template_ids.map((t) => `<span class="badge neutral">${esc(tName[t])}</span>`).join('') || '<span class="muted small">No checklist — only before &amp; after without a checklist</span>'}</div>
        </section>`).join('')}</div>` : emptyState({ icon: 'building', title: 'No sites yet', text: 'Add the places you inspect for this client.' })}
      ${history.length ? `<h3 class="section-h">Recent inspections</h3><div class="list-card">${history.map((i) => `<a class="row-link" href="#/inspections/${i.id}">
          <span class="row-main"><strong>${esc(i.site_name)} · ${esc(i.template_id ? i.template_name : modeLabel(i))}</strong><small>${esc(relDay(i.finished_at || i.started_at))} · ${esc(i.inspector_name)}</small></span>
          ${scoreBadge(i.avg_score && +i.avg_score)}${statusBadge(i.status)}</a>`).join('')}</div>` : ''}
      <button class="btn ghost-danger block" id="delete">${icon('trash')} Delete client</button>`;
    const siteFields = (s = {}) => [
      { name: 'name', label: 'Site name', value: s.name, required: true },
      { name: 'address', label: 'Address', type: 'textarea', rows: 2, value: s.address },
      { name: 'template_ids', label: 'Checklists used at this site', type: 'checks', value: s.template_ids,
        options: templates.map((t) => ({ value: t.id, label: t.name })), empty: 'No templates yet — create one under Templates.' },
    ];
    view.querySelector('#edit').onclick = async () => {
      if (await sheet({ title: 'Edit client', fields: clientFields(c), onSubmit: (v) => put(`/admin/clients/${id}`, v) })) { toast('Client saved'); reload(); }
    };
    view.querySelector('#add-site').onclick = async () => {
      if (await sheet({ title: 'Add site', fields: siteFields(), submitLabel: 'Add site', onSubmit: (v) => post('/admin/sites', { ...v, client_id: id }) })) { toast('Site added'); reload(); }
    };
    view.querySelectorAll('[data-edit-site]').forEach((b) => b.onclick = async () => {
      const s = sites.find((x) => x.id === b.dataset.editSite);
      if (await sheet({ title: 'Edit site', fields: siteFields(s), onSubmit: (v) => put(`/admin/sites/${s.id}`, v) })) { toast('Site saved'); reload(); }
    });
    view.querySelectorAll('[data-del-site]').forEach((b) => b.onclick = async () => {
      const s = sites.find((x) => x.id === b.dataset.delSite);
      if (!(await confirmSheet(`Delete ${s.name}?`))) return;
      try { await del(`/admin/sites/${s.id}`); toast('Site deleted'); reload(); } catch (e) { toast(e.message, { error: true }); }
    });
    view.querySelector('#delete').onclick = async () => {
      if (!(await confirmSheet(`Delete ${c.name} and its sites?`))) return;
      try { await del(`/admin/clients/${id}`); toast('Client deleted'); location.hash = '#/clients'; } catch (e) { toast(e.message, { error: true }); }
    };
  }

  // ── templates ──
  async function templates() {
    const view = shell({ title: 'Templates', subtitle: 'Checklists supervisors walk through', back: '#/more', tab: 'more', body: skeleton(3),
      action: { id: 'add', icon: 'plus', label: 'New template' } });
    const add = async () => {
      const t = await sheet({ title: 'New template', fields: [{ name: 'name', label: 'Template name', required: true, placeholder: 'e.g. Restaurant quality check' }],
        submitLabel: 'Create', onSubmit: (v) => post('/admin/templates', { name: v.name, items: [] }) });
      if (t) location.hash = `#/templates/${t.id}`;
    };
    document.getElementById('add')?.addEventListener('click', add);
    let list;
    try { list = await api('/admin/templates'); } catch (e) { return fail(view, e, templates); }
    view.innerHTML = list.length ? `<div class="card-grid">${list.map((t) => `<div class="card template-card">
        <a class="tap-area" href="#/templates/${t.id}"><span class="card-ic">${icon('template')}</span>
          <span class="grow"><strong>${esc(t.name)}</strong><small>${t.items.length} item${t.items.length === 1 ? '' : 's'} · ${t.site_count} site${t.site_count === 1 ? '' : 's'} · used ${t.use_count} time${t.use_count === 1 ? '' : 's'}</small></span>
          ${icon('chevron', 'chev')}</a>
        <button class="icon-btn" data-dup="${t.id}" aria-label="Duplicate ${esc(t.name)}">${icon('copy')}</button></div>`).join('')}</div>`
      : emptyState({ icon: 'template', title: 'No templates yet', text: 'A template is the checklist a supervisor walks through.', action: `<button class="btn primary" id="add-empty">${icon('plus')} New template</button>` });
    view.querySelector('#add-empty')?.addEventListener('click', add);
    view.querySelectorAll('[data-dup]').forEach((b) => b.onclick = async () => {
      const t = list.find((x) => x.id === b.dataset.dup);
      const copy = await sheet({ title: 'Duplicate template', fields: [{ name: 'name', label: 'Name of the copy', value: `${t.name} (copy)`, required: true }],
        submitLabel: 'Duplicate', onSubmit: (v) => post('/admin/templates', { name: v.name, items: t.items.map(({ label, hint }) => ({ label, hint })) }) });
      if (copy) { toast('Template duplicated'); location.hash = `#/templates/${copy.id}`; }
    });
  }

  async function template(id) {
    const view = shell({ title: 'Template', back: '#/templates', tab: 'more', body: skeleton(2) });
    let t;
    try { t = (await api('/admin/templates')).find((x) => x.id === id); } catch (e) { return fail(view, e, () => template(id)); }
    if (!t) { location.replace('#/templates'); return; }
    const items = t.items.map((i) => ({ ...i }));
    let dirty = false;
    view.innerHTML = `
      <section class="card stack">
        <label class="field"><span>Template name</span><input id="tname" value="${esc(t.name)}"></label>
        <p class="muted small">Used at ${t.site_count} site${t.site_count === 1 ? '' : 's'}. Changes apply to new inspections only — finished reports keep the items they had.</p>
      </section>
      <h3 class="section-h">Items</h3>
      <ol class="stack plain" id="items"></ol>
      <button class="btn dashed block" id="add-item">${icon('plus')} Add item</button>
      <button class="btn ghost-danger block" id="delete">${icon('trash')} Delete template</button>
      <div class="bottom-bar"><button class="btn primary block lg" id="save">Save template</button></div>`;
    const $items = view.querySelector('#items');
    const render = () => {
      $items.innerHTML = items.map((it, i) => `<li class="card edit-item">
        <span class="item-num sm">${i + 1}</span>
        <div class="grow stack tight">
          <input data-i="${i}" data-k="label" value="${esc(it.label)}" placeholder="e.g. Kitchen floor" aria-label="Item ${i + 1} name">
          <input data-i="${i}" data-k="hint" value="${esc(it.hint)}" placeholder="Hint for the supervisor (optional)" aria-label="Item ${i + 1} hint" class="hint-input">
        </div>
        <div class="edit-tools">
          <button class="icon-btn" data-move="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">${icon('up')}</button>
          <button class="icon-btn" data-move="${i}" data-dir="1" ${i === items.length - 1 ? 'disabled' : ''} aria-label="Move down">${icon('down')}</button>
          <button class="icon-btn danger" data-remove="${i}" aria-label="Remove item">${icon('x')}</button>
        </div></li>`).join('') || `<li>${emptyState({ icon: 'template', title: 'No items yet', text: 'Add the areas to check, e.g. Reception, Kitchen, Toilets.' })}</li>`;
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
      } catch (e) { toast(e.message, { error: true }); }
    };
    view.querySelector('#delete').onclick = async () => {
      if (!(await confirmSheet(`Delete ${t.name}?`, { text: 'Sites using it lose this checklist. Past reports are kept.' }))) return;
      try { await del(`/admin/templates/${id}`); dirty = false; location.hash = '#/templates'; } catch (e) { toast(e.message, { error: true }); }
    };
    setLeaveGuard(() => !dirty || confirm('You have unsaved changes to this template. Leave anyway?'));
  }

  // ── users ──
  async function users() {
    const view = shell({ title: 'Team', subtitle: 'Who can log in', back: '#/more', tab: 'more', body: skeleton(3),
      action: { id: 'add', icon: 'plus', label: 'Add person' } });
    const roleOptions = (role) => [...new Set([...ACTIVE_ROLES, role].filter(Boolean))].map((value) => ({ value, label: ROLE_LABEL[value] }));
    const userFields = (u = {}) => [
      { name: 'name', label: 'Name', value: u.name, required: true },
      { name: 'email', label: 'Email', type: 'email', value: u.email, required: true },
      { name: 'role', label: 'Role', type: 'select', value: u.role || 'inspector', options: roleOptions(u.role),
        hint: 'Supervisors do inspections. Admins also review, manage clients, templates and the team.' },
      ...(u.id ? [{ name: 'active', label: 'Status', type: 'select', value: u.active ? 'yes' : 'no',
        options: [{ value: 'yes', label: 'Active — can log in' }, { value: 'no', label: 'Inactive — blocked' }] }] : []),
    ];
    const showPassword = (u) => sheet({ title: `Login for ${u.name || u.email}`, submitLabel: 'Done',
      text: 'Shown once — send it to them securely. They log in with their email and this password.',
      fields: [{ name: 'password', label: 'Password', value: u.password }] });
    document.getElementById('add')?.addEventListener('click', async () => {
      const u = await sheet({ title: 'Add person', fields: userFields(), submitLabel: 'Create login', onSubmit: (v) => post('/admin/users', v) });
      if (u) { await showPassword(u); users(); }
    });
    let list;
    try { list = await api('/admin/users'); } catch (e) { return fail(view, e, users); }
    view.innerHTML = `<div class="card-grid">${list.map((u) => `<div class="card media user-card${u.active ? '' : ' inactive'}">
        ${avatar(u.name, u.role === 'admin' ? 'navy' : '')}
        <span class="grow"><strong>${esc(u.name)}${u.id === me().id ? ' <span class="muted small">(you)</span>' : ''}</strong>
          <small>${esc(u.email)}</small>
          <span class="tags"><span class="badge ${u.role === 'admin' ? 'blue' : 'neutral'}">${ROLE_LABEL[u.role]}</span>${u.active ? '' : '<span class="badge red">Inactive</span>'}</span></span>
        <div class="stack tight"><button class="btn sm" data-edit="${u.id}">Edit</button><button class="btn sm" data-reset="${u.id}">Reset password</button></div>
      </div>`).join('')}</div>`;
    view.querySelectorAll('[data-edit]').forEach((b) => b.onclick = async () => {
      const u = list.find((x) => x.id === b.dataset.edit);
      if (await sheet({ title: `Edit ${u.name}`, fields: userFields(u), onSubmit: (v) => put(`/admin/users/${u.id}`, { ...v, active: v.active === 'yes' }) })) { toast('Saved'); users(); }
    });
    view.querySelectorAll('[data-reset]').forEach((b) => b.onclick = async () => {
      const u = list.find((x) => x.id === b.dataset.reset);
      if (!(await confirmSheet(`Give ${u.name} a new password?`, { text: 'Their current password stops working.', okLabel: 'Reset password', danger: false }))) return;
      try {
        await showPassword({ ...(await post(`/admin/users/${u.id}/reset-password`)), name: u.name });
        if (u.id === me().id) location.reload();
      } catch (e) { toast(e.message, { error: true }); }
    });
  }

  return { clients, client, templates, template, users };
}
