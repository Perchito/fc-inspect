// Home, Inspections and Actions — the three main tabs.
import {
  esc, icon, api, statusBadge, scoreBadge, modeLabel, progressBar, relDay, dueText, daysUntil, skeleton, emptyState,
  errorState, chips, searchBar, LOW_SCORE, fmtDateTime, viewer, put, post, toast, sheet, confirmSheet,
} from './ui.js?v=__V__';
import { fetchMine, sync, shrink } from './inspect.js?v=__V__';
import { itemPhotosHtml, bindActionToggles } from './review.js?v=__V__';

const title = (i) => (i.template_id ? i.template_name : modeLabel(i));
const open = (i) => ['draft', 'returned'].includes(i.status) && !i.sending;

// one inspection as a tappable card
export function inspectionCard(i, { admin = false, meId = null } = {}) {
  // open inspections are shared: anyone can continue them, even while someone else is working on it
  const mineToDo = open(i);
  const cta = i.sending ? '' : mineToDo ? 'Continue' : admin && i.status === 'submitted' ? 'Review' : open(i) ? 'View' : '';
  return `<a class="card tap insp-card" href="#/inspections/${i.id}">
    <div class="row-between">${statusBadge(i.status, { sending: i.sending })}${i.avg_score ? scoreBadge(+i.avg_score) : ''}</div>
    <strong class="card-title">${esc(title(i))}</strong>
    <span class="card-sub">${esc(i.site_name)} · ${esc(i.client_name)}</span>
    ${open(i) && i.item_count ? progressBar(i.done_count, i.item_count) : ''}
    ${i.status === 'returned' ? `<span class="card-flag">${icon('alert')} Sent back — changes needed</span>` : ''}
    ${i.open_actions ? `<span class="card-flag red">${icon('alert')} ${i.open_actions} urgent action${i.open_actions === 1 ? '' : 's'}</span>` : ''}
    <span class="card-meta"><span>${esc(relDay(i.finished_at || i.started_at))}${i.inspector_name && i.inspector_id !== meId ? ` · ${esc(i.inspector_name)}` : ''}${i.contributors?.length ? ` +${i.contributors.length}` : ''}${i.local ? ' · on this phone' : ''}</span>
      ${cta ? `<span class="card-cta">${cta} ${icon('chevron')}</span>` : ''}</span>
  </a>`;
}
export function actionCard(a) {
  const d = daysUntil(a.action_due), tone = a.action_done_at ? 'green' : d != null && d < 0 ? 'red' : d != null && d <= 1 ? 'amber' : 'neutral';
  return `<a class="card tap action-row" href="#/actions/${a.inspection_id}/${encodeURIComponent(a.item_key)}">
    <div class="row-between"><span class="badge ${tone}">${a.action_done_at ? `${icon('check')} Completed` : esc(dueText(a.action_due))}</span>${scoreBadge(a.score)}</div>
    <strong class="card-title">${esc(a.action_what)}</strong>
    <span class="card-sub">${a.area ? `${esc(a.area)} › ` : ''}${esc(a.label)} · ${esc(a.site_name)}</span>
    <span class="card-meta"><span>${icon('user', 'inline')} ${esc(a.action_who || 'Unassigned')}</span><span class="card-cta">${icon('chevron')}</span></span>
  </a>`;
}
// group cards by day: Today / Yesterday / This week / Earlier
function grouped(list, card) {
  const order = ['Today', 'Yesterday', 'This week', 'Earlier'], groups = {};
  for (const i of list) {
    const d = Math.round((new Date(new Date().toDateString()) - new Date(new Date(i.finished_at || i.started_at).toDateString())) / 86400000);
    (groups[d <= 0 ? 'Today' : d === 1 ? 'Yesterday' : d < 7 ? 'This week' : 'Earlier'] ||= []).push(i);
  }
  return order.filter((g) => groups[g]).map((g) => `<h3 class="section-h">${g}</h3><div class="card-grid">${groups[g].map(card).join('')}</div>`).join('');
}

export function listViews({ shell, me }) {
  const isAdmin = () => me().role === 'admin';
  const allInspections = async () => {
    const [all, mine] = await Promise.all([api('/inspections/all'), fetchMine()]);
    const local = mine.filter((m) => m.local || m.sending), ids = new Set(all.map((i) => i.id));
    return [...local.filter((m) => !ids.has(m.id)), ...all.map((i) => ({ ...i, sending: local.some((m) => m.id === i.id && m.sending) }))];
  };

  // ── Home ──
  async function home() {
    const hour = new Date().getHours();
    const greeting = `${hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}, ${me().name.split(' ')[0]}`;
    const view = shell({ title: 'Home', subtitle: greeting, tab: 'home', body: skeleton(3) });
    let mine, actions = [], review = [];
    try {
      [mine, actions, review] = await Promise.all([
        fetchMine(),
        api('/actions').catch(() => []),
        isAdmin() ? api('/admin/inspections?status=submitted').catch(() => []) : [],
      ]);
    } catch (e) { view.innerHTML = errorState(e); view.querySelector('#retry').onclick = home; return; }
    const cont = mine.filter(open).sort((a, b) => (b.status === 'returned') - (a.status === 'returned') || new Date(b.started_at) - new Date(a.started_at));
    const recent = (isAdmin() ? [...review] : mine.filter((i) => !open(i))).slice(0, 4);
    const urgent = actions.slice(0, 3);
    view.innerHTML = `
      <a class="hero-cta" href="#/start">
        <span class="hero-ic">${icon('plus')}</span>
        <span><strong>Start inspection</strong><small>Quality Check or Before &amp; After</small></span>
        ${icon('chevron', 'chev')}
      </a>
      ${cont.length ? `<h3 class="section-h">Continue where you left off</h3>
        <div class="card-grid">${cont.slice(0, 2).map((i) => inspectionCard(i, { meId: me().id })).join('')}</div>
        ${cont.length > 2 ? `<a class="more-link" href="#/inspections">${cont.length - 2} more in progress ${icon('chevron')}</a>` : ''}` : ''}
      ${isAdmin() && review.length ? `<a class="card tap media attention" href="#/inspections?f=submitted">
          <span class="card-ic blue">${icon('list')}</span>
          <span class="grow"><strong>${review.length} inspection${review.length === 1 ? '' : 's'} to review</strong><small>Submitted by supervisors</small></span>${icon('chevron', 'chev')}</a>` : ''}
      <div class="row-between section-h"><h3>Actions</h3>${actions.length ? `<a class="link" href="#/actions">View all</a>` : ''}</div>
      ${actions.length ? `<div class="card attention-card">
          <p class="attention-title">${icon('alert')} ${actions.length} action${actions.length === 1 ? ' needs' : 's need'} attention</p>
          <ul class="plain">${urgent.map((a) => `<li><a href="#/actions/${a.inspection_id}/${encodeURIComponent(a.item_key)}">
            <span>${esc(a.action_what)}</span><small class="${daysUntil(a.action_due) < 0 ? 'bad' : ''}">${esc(dueText(a.action_due))}</small></a></li>`).join('')}</ul>
        </div>` : `<div class="card quiet">${icon('check')} No open actions — everything is up to date.</div>`}
      <div class="row-between section-h"><h3>${isAdmin() ? 'Waiting for review' : 'Recent inspections'}</h3>${recent.length ? '<a class="link" href="#/inspections">See all</a>' : ''}</div>
      ${recent.length ? `<div class="card-grid">${recent.map((i) => inspectionCard(i, { admin: isAdmin(), meId: me().id })).join('')}</div>`
        : emptyState({ icon: 'list', title: isAdmin() ? 'Nothing to review' : 'No inspections yet', text: isAdmin() ? 'Submitted inspections appear here.' : 'Start your first inspection to see it here.' })}`;
  }

  // ── Inspections ──
  const FILTERS = [['all', 'All'], ['draft', 'In progress'], ['returned', 'Returned'], ['submitted', 'Submitted'], ['approved', 'Completed']];
  let state = { f: 'all', type: 'all', q: '' };
  async function inspections(query = {}) {
    if (query.f) state.f = query.f;
    const view = shell({ title: 'Inspections', subtitle: isAdmin() ? 'All supervisors' : 'Your inspections', tab: 'inspections', body: skeleton(4),
      action: { href: '#/start', icon: 'plus', label: 'Start inspection' } });
    let list;
    try { list = await allInspections(); } catch (e) { view.innerHTML = errorState(e); view.querySelector('#retry').onclick = () => inspections(); return; }
    view.innerHTML = `${searchBar('Search site, client or supervisor', state.q)}
      <div id="chips"></div><div id="types"></div><div id="results"></div>`;
    const render = () => {
      const q = state.q.toLowerCase();
      const typed = list.filter((i) => state.type === 'all' || (state.type === 'check' ? i.mode === 'check' : i.mode === 'before_after'))
        .filter((i) => !q || `${i.site_name} ${i.client_name} ${i.inspector_name || ''} ${title(i)}`.toLowerCase().includes(q));
      const count = (f) => (f === 'all' ? typed.length : typed.filter((i) => i.status === f).length);
      view.querySelector('#chips').innerHTML = chips(FILTERS.map(([v, l]) => [v, l, count(v)]), state.f);
      view.querySelector('#types').innerHTML = chips([['all', 'All types'], ['check', 'Quality Check'], ['ba', 'Before & After']], state.type, 'data-type');
      const hits = typed.filter((i) => state.f === 'all' || i.status === state.f);
      view.querySelector('#results').innerHTML = hits.length ? grouped(hits, (i) => inspectionCard(i, { admin: isAdmin(), meId: me().id }))
        : list.length ? emptyState({ icon: 'search', title: 'Nothing here', text: 'Try another filter or search.' })
          : emptyState({ icon: 'list', title: 'No inspections yet', text: 'Start your first inspection to see it here.', action: `<a class="btn primary" href="#/start">${icon('plus')} Start inspection</a>` });
    };
    render();
    view.querySelector('.search input').oninput = (e) => { state.q = e.target.value; render(); };
    view.addEventListener('click', (e) => {
      const f = e.target.closest('[data-filter]'), t = e.target.closest('[data-type]');
      if (f) { state.f = f.dataset.filter; render(); }
      if (t) { state.type = t.dataset.type; render(); }
    });
  }

  // ── Actions ──
  let actionTab = 'open';
  async function actions() {
    const view = shell({ title: 'Actions', subtitle: 'Urgent fixes from low scores', tab: 'actions', body: skeleton(3) });
    let openList, doneList;
    try { [openList, doneList] = await Promise.all([api('/actions'), api('/actions?done=1')]); }
    catch (e) { view.innerHTML = errorState(e); view.querySelector('#retry').onclick = actions; return; }
    const soon = openList.filter((a) => daysUntil(a.action_due) != null && daysUntil(a.action_due) <= 2);
    const mineOpen = openList.filter((a) => a.action_user_id === me().id);
    const lists = { open: openList, mine: mineOpen, soon, done: doneList };
    const render = () => {
      const list = lists[actionTab];
      view.innerHTML = `${chips([['open', 'Open', openList.length], ['mine', 'Mine', mineOpen.length], ['soon', 'Due soon', soon.length], ['done', 'Completed', doneList.length]], actionTab)}
        ${list.length ? `<div class="card-grid">${list.map(actionCard).join('')}</div>`
          : actionTab === 'done' ? emptyState({ icon: 'actions', title: 'Nothing completed yet', text: 'Completed actions are listed here.' })
            : emptyState({ icon: 'check', title: 'No open actions', text: 'Everything is up to date.' })}
        <p class="muted small center-text">Actions are created when an item scores below ${LOW_SCORE}/10.</p>`;
    };
    render();
    view.addEventListener('click', (e) => { const f = e.target.closest('[data-filter]'); if (f) { actionTab = f.dataset.filter; render(); } });
  }

  async function action(inspectionId, itemKey) {
    const view = shell({ title: 'Action', back: '#/actions', focus: true, body: skeleton(2) });
    let insp;
    try { insp = await api(`/inspections/${inspectionId}`); } catch (e) { view.innerHTML = errorState(e); view.querySelector('#retry').onclick = () => action(inspectionId, itemKey); return; }
    const it = insp.items.find((x) => x.item_key === itemKey);
    if (!it || !it.action_what) { view.innerHTML = emptyState({ icon: 'alert', title: 'Action not found' }); return; }
    const reload = () => action(inspectionId, itemKey);
    view.innerHTML = `
      <section class="card">
        <span class="badge ${it.action_done_at ? 'green' : daysUntil(it.action_due) < 0 ? 'red' : 'amber'}">${it.action_done_at ? `${icon('check')} Completed` : 'Open'}</span>
        <h2 class="action-title">${esc(it.action_what)}</h2>
        <p class="muted">${esc(insp.site_name)} · ${esc(insp.client_name)}</p>
        <dl class="facts">
          <dt>Item</dt><dd>${it.area ? `${esc(it.area)} › ` : ''}${esc(it.label)} ${scoreBadge(it.score)}</dd>
          <dt>Assigned to</dt><dd>${esc(it.action_who)}</dd>
          <dt>Deadline</dt><dd>${esc(dueText(it.action_due))}</dd>
          ${it.action_done_at ? `<dt>Completed</dt><dd>${esc(fmtDateTime(it.action_done_at))}${it.action_done_by_name ? ` by ${esc(it.action_done_by_name)}` : ''}</dd>` : ''}
          ${it.action_done_note ? `<dt>Their note</dt><dd>${esc(it.action_done_note)}</dd>` : ''}
        </dl>
      </section>
      ${it.note ? `<section class="card"><h3>What was found</h3><p class="note">${esc(it.note)}</p></section>` : ''}
      <section class="card"><h3>Photos</h3><div id="ph">${itemPhotosHtml(insp, it)}</div></section>
      ${(insp.action_photos || []).some((p) => p.item_key === itemKey) ? `<section class="card"><h3>Photo of the fix</h3><div class="ph-grid">${insp.action_photos.filter((p) => p.item_key === itemKey).map((p) => `<figure class="ph"><a class="ph-open" href="/api/photos/${p.id}" target="_blank" rel="noopener"><img src="/api/photos/${p.id}" alt="Photo of the fix" loading="lazy"></a></figure>`).join('')}</div></section>` : ''}
      <a class="card tap media" href="#/inspections/${insp.id}">
        <span class="card-ic">${icon('file')}</span>
        <span class="grow"><small>Created from</small><strong>${esc(insp.template_id ? insp.template_name : modeLabel(insp))}</strong><small>${esc(insp.inspector_name)} · ${esc(relDay(insp.finished_at || insp.started_at))}</small></span>${icon('chevron', 'chev')}</a>
      ${isAdmin() ? `<div class="bottom-bar"><button class="btn ${it.action_done_at ? '' : 'primary'} block lg" data-done="${esc(it.item_key)}" data-insp="${insp.id}"
          data-state="${it.action_done_at ? '1' : '0'}">${it.action_done_at ? 'Reopen action' : `${icon('check')} Mark as complete`}</button></div>`
        : '<p class="muted small center-text">The office marks actions as complete.</p>'}`;
    bindActionToggles(view, reload);
    view.querySelector('#ph').addEventListener('click', (e) => {
      const b = e.target.closest('[data-view]'); if (!b) return;
      const list = insp.photos.filter((p) => p.item_key === itemKey).map((p) => ({ ...p, src: `/api/photos/${p.id}` }));
      viewer(list, Math.max(0, list.findIndex((p) => p.id === b.dataset.view)));
    });
  }

  // ── prospects: businesses inspected with a quick inspection, before they are clients ──
  async function prospects() {
    const view = shell({ title: 'Prospects', subtitle: 'Potential clients from quick inspections', back: '#/more', tab: 'more', body: skeleton(3) });
    let list;
    try { list = await api('/prospects'); } catch (e) { view.innerHTML = errorState(e); view.querySelector('#retry').onclick = prospects; return; }
    const admin = me().role === 'admin';
    view.innerHTML = list.length ? `<div class="stack">${list.map((p) => `<section class="card">
        <div class="row-between"><h3>${esc(p.name)}</h3><button class="btn sm" data-edit="${p.id}">${icon('pen')} ${p.name === 'New prospect' ? 'Add name' : 'Edit'}</button></div>
        <p class="small muted">${[p.contact_name, p.phone, p.email, p.address].filter(Boolean).map(esc).join(' · ') || 'No details yet'}</p>
        <div class="list-card">${p.inspections.map((i) => `<a class="row-link" href="#/inspections/${i.id}">
          <span class="row-main"><strong>${esc(title(i))}</strong><small>${esc(relDay(i.started_at))} · ${esc(i.inspector_name)}</small></span>${statusBadge(i.status)}${icon('chevron', 'row-chev')}</a>`).join('')}</div>
        ${admin ? `<button class="btn sm block" data-convert="${p.id}" style="margin-top:10px">${icon('building')} Make a client</button>` : ''}
      </section>`).join('')}</div>`
      : emptyState({ icon: 'sparkle', title: 'No prospects yet', text: 'Start a quick inspection to inspect a business that is not a client yet.',
          action: '<a class="btn primary" href="#/quick">Quick inspection</a>' });
    view.addEventListener('click', async (e) => {
      const edit = e.target.closest('[data-edit]'), conv = e.target.closest('[data-convert]');
      if (edit) {
        const p = list.find((x) => x.id === edit.dataset.edit);
        const ok = await sheet({ title: 'Prospect details', submitLabel: 'Save', fields: [
          { name: 'name', label: 'Business name', value: p.name === 'New prospect' ? '' : p.name, required: true },
          { name: 'contact_name', label: 'Contact name', value: p.contact_name }, { name: 'phone', label: 'Phone', type: 'tel', value: p.phone },
          { name: 'email', label: 'Email', type: 'email', value: p.email }, { name: 'address', label: 'Address', type: 'textarea', value: p.address },
        ], onSubmit: (v) => put(`/prospects/${p.id}`, v) });
        if (ok) { toast('Saved'); prospects(); }
      } else if (conv) {
        const p = list.find((x) => x.id === conv.dataset.convert);
        if (!(await confirmSheet(`Make ${p.name} a client?`, { text: 'It moves to Clients & sites, where you can add checklists for its site.', okLabel: 'Make a client', danger: false }))) return;
        try { await post(`/prospects/${p.id}/convert`); toast('Now a client'); location.hash = `#/clients/${p.id}`; } catch (err) { toast(err.message, { error: true }); }
      }
    });
  }

  // ── notifications (everyone) ──
  async function notifications(refreshUnread) {
    const view = shell({ title: 'Notifications', tab: 'alerts', body: skeleton(3) });
    let list;
    try { list = await api('/notifications'); } catch (e) { view.innerHTML = errorState(e); view.querySelector('#retry').onclick = () => notifications(refreshUnread); return; }
    view.innerHTML = list.length ? `<div class="list-card">${list.map((n) => `<a class="notif ${n.read_at ? '' : 'unread'}" href="${esc(n.link || '#/notifications')}">
        <span class="grow"><strong>${esc(n.title)}</strong>${n.body ? `<p>${esc(n.body)}</p>` : ''}<small>${esc(relDay(n.created_at))}</small></span></a>`).join('')}</div>`
      : emptyState({ icon: 'bell', title: 'No notifications yet', text: 'New actions assigned to you, reminders and updates show here.' });
    if (list.some((n) => !n.read_at)) await post('/notifications/read').then(refreshUnread).catch(() => {});
  }

  // ── my actions: urgent actions assigned to me ──
  async function myActions() {
    const view = shell({ title: 'My actions', subtitle: 'Urgent fixes assigned to you', tab: 'actions', body: skeleton(3) });
    let list;
    try { list = await api('/me/actions'); } catch (e) { view.innerHTML = errorState(e); view.querySelector('#retry').onclick = myActions; return; }
    const open = list.filter((a) => !a.action_done_at), done = list.filter((a) => a.action_done_at);
    const card = (a) => { const d = daysUntil(a.action_due); return `<a class="card tap" href="#/my-actions/${a.inspection_id}/${encodeURIComponent(a.item_key)}">
        <div class="row-between"><strong>${esc(a.site_name)}</strong>${a.action_done_at ? `<span class="badge green">${icon('check')} Done</span>`
          : `<span class="badge ${d != null && d < 0 ? 'red' : d != null && d <= 1 ? 'amber' : 'neutral'}">${esc(dueText(a.action_due))}</span>`}</div>
        <p>${esc(a.action_what)}</p><small class="muted">${esc(a.area ? `${a.area} › ` : '')}${esc(a.label)}</small></a>`; };
    view.innerHTML = list.length ? `${open.length ? `<h3 class="section-h">To do · ${open.length}</h3><div class="card-grid">${open.map(card).join('')}</div>` : '<section class="card"><p>Nothing to do — all your actions are done. 🎉</p></section>'}
      ${done.length ? `<h3 class="section-h">Done</h3><div class="card-grid">${done.slice(0, 20).map(card).join('')}</div>` : ''}`
      : emptyState({ icon: 'check', title: 'No actions for you', text: 'When an urgent action is assigned to you, it shows here.' });
  }

  async function myAction(inspectionId, itemKey) {
    const view = shell({ title: 'Action', back: '#/my-actions', focus: true, body: skeleton(2) });
    let a;
    try { a = await api(`/me/actions/${inspectionId}/${encodeURIComponent(itemKey)}`); }
    catch (e) { view.innerHTML = e.status === 404 ? emptyState({ icon: 'alert', title: 'Action not found', text: 'It may have been reassigned or removed.' }) : errorState(e); return; }
    const reload = () => myAction(inspectionId, itemKey);
    const shots = (list, label) => list.length ? `<div class="ph-grid">${list.map((p) => `<figure class="ph"><button class="ph-open" data-view="${p.id}" aria-label="View ${label}"><img src="/api/photos/${p.id}" alt="${label}" loading="lazy"></button></figure>`).join('')}</div>` : '';
    const found = a.photos.filter((p) => !p.action), fixed = a.photos.filter((p) => p.action);
    view.innerHTML = `
      <section class="card">
        <span class="badge ${a.action_done_at ? 'green' : daysUntil(a.action_due) < 0 ? 'red' : 'amber'}">${a.action_done_at ? `${icon('check')} Done` : esc(dueText(a.action_due))}</span>
        <h2 class="action-title">${esc(a.action_what)}</h2>
        <p class="muted">${esc(a.site_name)}${a.site_address ? ` · ${esc(a.site_address)}` : ''}</p>
        <dl class="facts"><dt>Item</dt><dd>${esc(a.area ? `${a.area} › ` : '')}${esc(a.label)} ${scoreBadge(a.score)}</dd><dt>Deadline</dt><dd>${esc(dueText(a.action_due))}</dd>
          ${a.action_done_at ? `<dt>Done</dt><dd>${esc(fmtDateTime(a.action_done_at))}${a.action_done_by_name ? ` by ${esc(a.action_done_by_name)}` : ''}</dd>` : ''}
          ${a.action_done_note ? `<dt>Note</dt><dd>${esc(a.action_done_note)}</dd>` : ''}</dl>
      </section>
      ${a.note ? `<section class="card"><h3>What was found</h3><p class="note">${esc(a.note)}</p></section>` : ''}
      ${found.length ? `<section class="card"><h3>Photos from the inspection</h3><div id="ph-found">${shots(found, 'photo')}</div></section>` : ''}
      <section class="card"><div class="row-between"><h3>Photo of the fix</h3><label class="btn sm">${icon('camera')} Add photo<input type="file" accept="image/*" capture="environment" hidden id="fix-photo"></label></div>
        <div id="ph-fixed">${shots(fixed, 'photo of the fix') || '<p class="muted small">Optional — show it\'s been put right.</p>'}</div></section>
      ${a.action_done_at ? '' : `<div class="bottom-bar"><button class="btn primary block lg" id="done">${icon('check')} Mark as done</button></div>`}`;
    view.querySelector('#fix-photo').addEventListener('change', async (e) => {
      const file = e.target.files[0]; if (!file) return;
      try {
        const blob = await shrink(file);
        const res = await fetch(`/api/me/actions/${inspectionId}/${encodeURIComponent(itemKey)}/photos/${crypto.randomUUID()}`, { method: 'PUT', body: blob, headers: { 'content-type': blob.type }, credentials: 'same-origin' });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed — try again with signal');
        toast('Photo added'); reload();
      } catch (err) { toast(err.message, { error: true }); }
    });
    view.querySelector('#done')?.addEventListener('click', async () => {
      const v = await sheet({ title: 'Mark as done?', text: 'The office is told straight away.', submitLabel: 'Mark as done',
        fields: [{ name: 'note', label: 'Note (optional)', type: 'textarea', placeholder: 'e.g. Re-cleaned and degreased, all good now' }] });
      if (!v) return;
      try { await post(`/me/actions/${inspectionId}/${encodeURIComponent(itemKey)}/done`, { note: v.note }); toast('Marked as done — thank you'); reload(); }
      catch (err) { toast(err.message, { error: true }); }
    });
    view.addEventListener('click', (e) => {
      const b = e.target.closest('[data-view]'); if (!b) return;
      const all = a.photos.map((p) => ({ ...p, src: `/api/photos/${p.id}`, label: p.action ? 'Fix' : 'Photo' }));
      viewer(all, Math.max(0, all.findIndex((p) => p.id === b.dataset.view)));
    });
  }

  return { home, inspections, actions, action, prospects, notifications, myActions, myAction, syncState: () => sync };
}
