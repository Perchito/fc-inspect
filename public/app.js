const $app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function api(path, body) {
  const r = await fetch(`/api${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || r.statusText), { status: r.status });
  return data;
}

const ROLE_LABEL = { admin: 'Admin', inspector: 'Inspector', cleaner: 'Cleaner', client: 'Client' };

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
    try {
      await api('/login', { email: form.email.value, password: form.password.value });
      start();
    } catch (err) { showLogin(err.message); }
  };
}

function showHome(me) {
  $app.innerHTML = `
    <header class="top">
      <img src="/img/fc-logo-white-icon.png" alt="" class="logo-sm">
      <strong>FC Inspect</strong>
      <span class="spacer"></span>
      <span class="muted">${esc(me.name)} · ${ROLE_LABEL[me.role]}</span>
      <button class="btn ghost" id="logout">Log out</button>
    </header>
    <section class="card">
      <h2>Welcome, ${esc(me.name.split(' ')[0])}</h2>
      <p class="muted">You're logged in as ${ROLE_LABEL[me.role].toLowerCase()}. More screens are on the way.</p>
    </section>`;
  document.getElementById('logout').onclick = async () => { await api('/logout', {}); showLogin(); };
}

async function start() {
  try { showHome(await api('/me')); }
  catch (err) { err.status === 401 ? showLogin() : ($app.innerHTML = `<p class="error center">${esc(err.message)}</p>`); }
}
start();
