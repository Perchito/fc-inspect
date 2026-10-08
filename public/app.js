// FC Inspect app shell: login, header + bottom tabs (desktop sidebar), router, More / Sync / About.
import { esc, icon, api, post, toast, avatar, row, errorState, skeleton, relDay } from './ui.js?v=__V__';
import { inspectViews, loadInspection, editable, sync, outbox, flush, clearSyncError, forgetCurrent } from './inspect.js?v=__V__';
import { reportViews } from './review.js?v=__V__';
import { listViews } from './lists.js?v=__V__';
import { adminViews } from './admin.js?v=__V__';

const VERSION = '__V__';
const $app = document.getElementById('app');
const ROLE_LABEL = { admin: 'Admin', inspector: 'Supervisor', cleaner: 'Cleaner' };
let me = null, realRole = null;
const isAdmin = () => me?.role === 'admin';
// "View as supervisor": an admin previews the supervisor app on this device (the server still treats them as admin)
const previewing = () => { try { return realRole === 'admin' && localStorage.getItem('fci-sup-view') === '1'; } catch { return false; } };
const setPreview = (on) => { try { on ? localStorage.setItem('fci-sup-view', '1') : localStorage.removeItem('fci-sup-view'); } catch {} location.reload(); };
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
document.documentElement.classList.toggle('standalone', !!standalone);

// ── sync pill (header) ──────────────────────────────────
function syncInfo(s = sync) {
  const n = s.pending.length;
  if (!navigator.onLine) return { tone: 'off', ic: 'offline', text: n ? `Offline · ${n}` : 'Offline' };
  if (s.error) return { tone: 'bad', ic: 'alert', text: 'Sync problem' };
  if (n && s.flushing) return { tone: 'busy', ic: 'sync', text: `Syncing ${n}` };
  if (n) return { tone: 'wait', ic: 'clock', text: `${n} waiting` };
  return { tone: 'ok', ic: 'check', text: 'Synced' };
}
const pillHtml = () => { const s = syncInfo(); return `<a class="sync-pill ${s.tone}" id="sync-pill" href="#/sync" aria-label="Sync status: ${s.text}">${icon(s.ic, s.tone === 'busy' ? 'spin' : '')}<span>${s.text}</span></a>`; };
outbox.onChange(() => { const el = document.getElementById('sync-pill'); if (el) el.outerHTML = pillHtml(); });

// ── shell ───────────────────────────────────────────────
// supervisors and cleaners get the same app (cleaners can do every type of inspection too)
const TABS = () => [['home', '#/home', 'home', 'Home'], ['inspections', '#/inspections', 'list', 'Inspections'], ['actions', '#/actions', 'actions', 'Actions'], ['alerts', '#/notifications', 'bell', 'Alerts'], ['more', '#/more', 'more', 'More']];
let unread = 0;
const refreshUnread = () => api('/notifications/unread').then((r) => {
  unread = r.count;
  document.querySelectorAll('[data-unread]').forEach((el) => { el.textContent = unread > 9 ? '9+' : unread; el.hidden = !unread; });
}).catch(() => {});
const SIDE = () => [
  ['home', '#/home', 'home', 'Home'], ['inspections', '#/inspections', 'list', 'Inspections'], ['actions', '#/actions', 'actions', 'Actions'],
  ['prospects', '#/prospects', 'sparkle', 'Prospects'],
  ['alerts', '#/notifications', 'bell', 'Notifications'],
  ...(isAdmin() ? [['clients', '#/clients', 'building', 'Clients'], ['templates', '#/templates', 'template', 'Templates'], ['users', '#/users', 'users', 'Team']] : []),
  ['sync', '#/sync', 'sync', 'Sync'], ['more', '#/more', 'more', 'More'],
];
let currentTab = 'home';
// renders the frame and returns the content element. focus = full-screen task (no tab bar on phones)
function shell({ title = '', subtitle = '', back = '', tab, focus = false, body = '', action = null }) {
  if (tab) currentTab = tab;
  const here = location.hash.split('?')[0];
  const sideOn = (k) => here.startsWith(`#/${k}`) || (k === currentTab && !SIDE().some(([s]) => here.startsWith(`#/${s}`)));
  $app.innerHTML = `
    <div class="app${focus ? ' focus' : ''}">
      <aside class="sidebar" aria-label="Main">
        <div class="brand"><img src="/img/fc-logo-white.png" alt="FC Cleaning Company Ltd"><span>FC Inspect</span></div>
        <a class="btn primary block" href="#/start">${icon('plus')} Start inspection</a>
        <nav>${SIDE().map(([k, href, ic, label]) => `<a href="${href}" ${sideOn(k) ? 'aria-current="page"' : ''}>${icon(ic)}<span>${label}</span></a>`).join('')}</nav>
        <a class="side-user" href="#/more">${avatar(me.name, 'light')}<span><strong>${esc(me.name)}</strong><small>${ROLE_LABEL[me.role] || me.role}</small></span></a>
      </aside>
      <div class="main">
        <header class="top">
          ${back ? `<a class="icon-btn back" href="${back}" aria-label="Back">${icon('back')}</a>` : ''}
          <div class="titles">${title ? `<h1>${esc(title)}</h1>` : ''}${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>
          ${pillHtml()}
          ${action ? (action.href ? `<a class="icon-btn accent" href="${action.href}" aria-label="${esc(action.label)}">${icon(action.icon)}</a>`
            : `<button class="icon-btn accent" id="${action.id}" aria-label="${esc(action.label)}">${icon(action.icon)}</button>`) : ''}
        </header>
        ${previewing() ? `<div class="preview-bar">${icon('users')}<span>You're viewing as a supervisor</span><button class="btn sm" id="end-preview">Back to admin</button></div>` : ''}
        <main id="view" class="view" tabindex="-1">${body}</main>
      </div>
      ${focus ? '' : `<nav class="tabbar tabs-${TABS().length}" aria-label="Main">${TABS().map(([k, href, ic, label]) =>
        `<a href="${href}" ${currentTab === k ? 'aria-current="page"' : ''}>${icon(ic)}<span>${label}</span>${k === 'alerts' ? `<span class="dot" data-unread ${unread ? '' : 'hidden'}>${unread > 9 ? '9+' : unread}</span>` : ''}</a>`).join('')}</nav>`}
    </div>`;
  document.getElementById('end-preview')?.addEventListener('click', () => setPreview(false));
  return document.getElementById('view');
}

// ── login ───────────────────────────────────────────────
function showLogin(error = '') {
  let lastEmail = '';
  try { lastEmail = localStorage.getItem('fci-email') || ''; } catch {}
  $app.innerHTML = `
    <div class="login-screen">
      <form class="login" id="login">
        <img src="/img/icon-192.png" alt="" class="login-logo">
        <h1>FC Inspect</h1>
        <p class="muted">Cleaning quality inspections<br>FC Cleaning Company</p>
        <p class="form-error" role="alert" ${error ? '' : 'hidden'}>${esc(error)}</p>
        <label class="field"><span>Email</span><input name="email" type="email" autocomplete="username" inputmode="email" value="${esc(lastEmail)}" required></label>
        <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn primary block lg">Log in</button>
      </form>
    </div>`;
  const form = document.getElementById('login'), $err = form.querySelector('.form-error'), btn = form.querySelector('button');
  if (!matchMedia('(pointer: coarse)').matches) (lastEmail ? form.password : form.email).focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    btn.disabled = true; btn.textContent = 'Logging in…'; $err.hidden = true;
    try {
      await post('/login', { email: form.email.value, password: form.password.value });
      try { localStorage.setItem('fci-email', form.email.value.trim()); } catch {}
      start();
    } catch (err) {
      // keep the email; just clear the password so they can try again
      $err.textContent = err.offline ? "You're offline — connect to log in." : err.message;
      $err.hidden = false;
      form.password.value = '';
      form.password.focus();
      btn.disabled = false; btn.textContent = 'Log in';
    }
  };
}
async function logout() {
  if (sync.pending.length && !confirm(`${sync.pending.length} change(s) haven't been sent yet. They stay on this phone and send after you log in again. Log out?`)) return;
  await post('/logout').catch(() => {});
  try { await caches.delete('fci-api'); await caches.delete('fci-photos'); } catch {}
  me = null; forgetCurrent(); history.replaceState(null, '', '/'); showLogin();
}

// ── More / Sync / About ─────────────────────────────────
function more() {
  const view = shell({ title: 'More', tab: 'more' });
  view.innerHTML = `
    <section class="card media profile">${avatar(me.name, 'navy lg')}
      <span class="grow"><strong>${esc(me.name)}</strong><small>${esc(me.email)}</small><span class="tags"><span class="badge ${isAdmin() ? 'blue' : 'neutral'}">${ROLE_LABEL[me.role]}</span></span></span></section>
    ${realRole === 'admin' ? `<div class="list-card">${previewing() ? row({ ic: 'back', title: 'Back to admin', sub: 'Leave the supervisor preview', id: 'preview-off' })
      : row({ ic: 'users', title: 'View as supervisor', sub: 'See the app the way supervisors see it', id: 'preview-on' })}</div>` : ''}
    ${isAdmin() ? `<h3 class="section-h">Management</h3><div class="list-card">
      ${row({ href: '#/deleted', ic: 'trash', title: 'Recently deleted', sub: 'Restore or remove for good — kept 30 days' })}
      ${row({ href: '#/clients', ic: 'building', title: 'Clients & sites', sub: 'Who you clean for and where' })}
      ${row({ href: '#/templates', ic: 'template', title: 'Templates', sub: 'Inspection checklists' })}
      ${row({ href: '#/users', ic: 'users', title: 'Team', sub: 'Admins and supervisors' })}</div>` : ''}
    <h3 class="section-h">Prospects</h3><div class="list-card">
      ${row({ href: '#/prospects', ic: 'sparkle', title: 'Prospects', sub: 'Potential clients from quick inspections' })}
      ${row({ href: '#/quick', ic: 'plus', title: 'Quick inspection', sub: 'No site needed — name the business now or later' })}</div>
    <h3 class="section-h">App</h3><div class="list-card">
      ${row({ href: '#/sync', ic: 'sync', title: 'Offline & sync', sub: syncInfo().text })}
      ${row({ href: '#/about', ic: 'info', title: 'About FC Inspect', sub: 'Version, notifications, help' })}</div>
    ${standalone ? '' : `<div class="note-box"><strong>${icon('sparkle', 'inline')} Install the app</strong>
      <p class="small">On iPhone: tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>. It opens full screen and works offline.</p></div>`}
    <div class="list-card">${row({ ic: 'logout', title: 'Log out', danger: true, id: 'logout' })}</div>`;
  view.querySelector('#preview-on')?.addEventListener('click', () => setPreview(true));
  view.querySelector('#preview-off')?.addEventListener('click', () => setPreview(false));
  view.querySelector('#logout').onclick = logout;
}

function syncScreen() {
  const view = shell({ title: 'Offline & sync', back: '#/more', tab: 'more' });
  const render = () => {
    if (!document.body.contains(view)) return off();
    const s = syncInfo(), byKind = (k) => sync.pending.filter((e) => e.kind === k).length;
    view.innerHTML = `
      <section class="card sync-hero ${s.tone}"><span class="card-ic xl">${icon(s.ic, s.tone === 'busy' ? 'spin' : '')}</span>
        <h2>${navigator.onLine ? (sync.pending.length ? (sync.flushing ? 'Syncing…' : 'Waiting to sync') : 'All synced') : "You're offline"}</h2>
        <p class="muted">${navigator.onLine ? (sync.pending.length ? 'Your changes are being sent to the office.' : 'Everything on this phone has reached the office.')
          : 'Keep working. Changes are stored on this phone and sync automatically when the connection returns.'}</p></section>
      ${sync.error ? `<section class="card warn-card" role="alert"><h3>${icon('alert')} Sync problem</h3><p>${esc(sync.error)}</p>
        <button class="btn sm" id="dismiss">Dismiss</button></section>` : ''}
      <div class="stats">
        <div class="stat"><span>Connection</span><strong>${navigator.onLine ? 'Online' : 'Offline'}</strong></div>
        <div class="stat"><span>Last synced</span><strong>${sync.lastSynced ? esc(relDay(sync.lastSynced).replace('Today · ', '')) : '—'}</strong></div>
        <div class="stat ${byKind('photo') ? 'warn' : ''}"><span>Photos waiting</span><strong>${byKind('photo')}</strong></div>
        <div class="stat"><span>Other changes</span><strong>${sync.pending.length - byKind('photo')}</strong></div>
        <div class="stat"><span>Inspections affected</span><strong>${new Set(sync.pending.map((e) => e.inspectionId)).size}</strong></div>
        <div class="stat"><span>Submissions waiting</span><strong>${byKind('submit')}</strong></div>
      </div>
      <button class="btn primary block lg" id="now" ${navigator.onLine && sync.pending.length && !sync.flushing ? '' : 'disabled'}>${icon('sync')} Sync now</button>
      <p class="muted small center-text">Photos, notes, scores and submissions stay safely on this phone until the office has them — nothing is lost if the signal drops.</p>`;
    view.querySelector('#now').onclick = () => { flush(); toast('Syncing…'); };
    view.querySelector('#dismiss')?.addEventListener('click', clearSyncError);
  };
  const off = outbox.onChange(render);
  render();
}

function about() {
  shell({ title: 'About', back: '#/more', tab: 'more', body: `
    <section class="card center-text about"><img src="/img/icon-192.png" alt="" class="login-logo"><h2>FC Inspect</h2>
      <p class="muted">Cleaning quality inspections for FC Cleaning Company</p><p class="small muted">Version ${esc(VERSION)}</p></section>
    <h3 class="section-h">How it works</h3>
    <div class="card stack small">
      <p><strong>Quality Checks</strong> score each item 1–10. Anything below 7 needs an urgent action with an owner and a deadline.</p>
      <p><strong>Before &amp; After</strong> inspections pair a before photo with an after photo of the same spot. They are internal.</p>
      <p><strong>Notifications:</strong> every submitted inspection is emailed to the admins with the PDF attached — marked URGENT when something scored low.</p>
      <p><strong>Offline:</strong> you can start and complete inspections with no signal. Everything syncs when you reconnect.</p>
    </div>` });
}

// ── routing ─────────────────────────────────────────────
let leaveGuard = null;
const setLeaveGuard = (fn) => { leaveGuard = fn; };
let insp, report, lists, admin;

async function inspectionRoute(id, sub, n) {
  const view = shell({ title: 'Inspection', back: '#/inspections', focus: true, body: skeleton(3) });
  try {
    if (sub === 'item') return await insp.item(id, n);
    if (sub === 'review') return await insp.review(id);
    if (sub === 'sign') return await insp.sign(id);
    if (sub === 'done') return await insp.done(id);
    const data = await loadInspection(id, { fresh: true });
    if (editable(data)) return await insp.detail(data); // open inspections are shared by every supervisor
    return await report.report(data, () => inspectionRoute(id));
  } catch (e) {
    if (e.status === 401) return;
    view.innerHTML = e.status === 404 ? '<div class="empty"><h3>Inspection not found</h3><p>It may have been discarded.</p><a class="btn" href="#/inspections">Back to inspections</a></div>' : errorState(e);
    view.querySelector('#retry')?.addEventListener('click', () => inspectionRoute(id, sub, n));
  }
}

const UUID = '([0-9a-f-]{36})';
const ROUTES = () => [
  [/^#\/home$/, () => lists.home()],
  [/^#\/my-actions$/, () => lists.myActions()], [new RegExp(`^#/my-actions/${UUID}/([^/]+)$`), (i, k) => lists.myAction(i, decodeURIComponent(k))],
  [/^#\/notifications$/, () => lists.notifications(refreshUnread)],
  [/^#\/quick$/, () => insp.quick()],
  [/^#\/prospects$/, () => lists.prospects()],
  [/^#\/start(?:\/([0-9a-f-]{36}))?(?:\/([\w.-]+))?$/, (site, choice) => insp.start(site, choice)],
  [new RegExp(`^#/inspections/${UUID}(?:/(item|review|sign|done)(?:/(\\d+))?)?$`), inspectionRoute],
  [/^#\/inspections$/, (q) => lists.inspections(q)],
  [new RegExp(`^#/actions/${UUID}/([^/]+)$`), (i, k) => lists.action(i, decodeURIComponent(k))],
  [/^#\/actions$/, () => lists.actions()],
  [/^#\/more$/, more], [/^#\/sync$/, syncScreen], [/^#\/about$/, about],
  ...(isAdmin() ? [
    [/^#\/clients$/, () => admin.clients()], [/^#\/clients\/([\w-]+)$/, (id) => admin.client(id)],
    [/^#\/templates$/, () => admin.templates()], [/^#\/templates\/([\w-]+)$/, (id) => admin.template(id)],
    [/^#\/users$/, () => admin.users()], [/^#\/deleted$/, () => admin.deleted()],
  ] : []),
];
// links from before the redesign (bookmarks, old emails) keep working
const LEGACY = [
  [/^#\/inspect$/, () => '#/home'], [/^#\/inspect\/new$/, () => '#/start'],
  [new RegExp(`^#/inspect/${UUID}$`), (id) => `#/inspections/${id}`],
  [new RegExp(`^#/inspect/${UUID}/finish$`), (id) => `#/inspections/${id}/review`],
  [new RegExp(`^#/inspect/${UUID}/(\\d+)$`), (id, n) => `#/inspections/${id}/item/${n}`],
  [/^#\/inspections\/f\/(\w+)$/, (f) => `#/inspections?f=${f}`],
  [/^#\/actions\/done$/, () => '#/actions'],
];

let lastHash = location.hash;
async function route() {
  if (leaveGuard && !leaveGuard()) { history.replaceState(null, '', lastHash); return; }
  leaveGuard = null; lastHash = location.hash;
  const legacy = LEGACY.find(([re]) => re.test(location.hash));
  if (legacy) { location.replace(legacy[1](...location.hash.match(legacy[0]).slice(1))); return; }
  const [path, qs] = location.hash.split('?');
  const hit = ROUTES().find(([re]) => re.test(path));
  if (!hit) { location.replace('#/home'); return; }
  refreshUnread();
  const args = path.match(hit[0]).slice(1);
  if (qs) args.push(Object.fromEntries(new URLSearchParams(qs)));
  scrollTo(0, 0);
  try { await hit[1](...args); } catch (err) {
    if (err.status === 401) return;
    console.error(err);
    const view = shell({ title: 'FC Inspect', body: errorState(err) });
    view.querySelector('#retry').onclick = route;
  }
}
addEventListener('hashchange', () => me && route());
addEventListener('fci:logged-out', () => { if (me) { me = null; showLogin('Your session ended — please log in again.'); } });

async function start() {
  try { me = await api('/me'); realRole = me.role; if (previewing()) me = { ...me, role: 'inspector' }; } catch (err) {
    if (err.status === 401) return showLogin();
    $app.innerHTML = `<div class="login-screen">${errorState(err)}</div>`;
    document.getElementById('retry').onclick = start;
    return;
  }
  const ctx = { shell, me: () => me, setLeaveGuard };
  insp = inspectViews(ctx); report = reportViews(ctx); lists = listViews(ctx); admin = adminViews(ctx);
  setInterval(() => { if (me && !document.hidden) refreshUnread(); }, 60_000);
  if (!location.hash || location.hash === '#/') location.replace('#/home');
  else route();
  flush();
}
start();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('sw', e));
