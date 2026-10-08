// Phone pop-up notifications (Web Push) + each person's notification settings.
// Same module in FC Staff Hub (~/fc-staff/lib/push.mjs) — keep the two in step.
// Every in-app notification is still stored; settings only decide pop-ups and emails.
import webpush from 'web-push';

const { VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT = 'mailto:mateo@fccleaningcompany.com' } = process.env;
if (VAPID_PUBLIC && VAPID_PRIVATE) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
export const pushKey = () => VAPID_PUBLIC || null;
// only the real push services (Apple, Google, Mozilla, Microsoft) — so nobody can make the server call an address of their choosing
const PUSH_HOSTS = ['web.push.apple.com', 'fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com'];
export const pushHostOk = (endpoint) => {
  try { const u = new URL(endpoint), h = u.hostname.toLowerCase().replace(/\.$/, ''); return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some((d) => h === d || h.endsWith(`.${d}`)); }
  catch { return false; }
};


// people who want this category: { push: [user ids], email: [user ids] } (always: categories that can't be muted)
export async function wanted(pool, userIds, category, { always = false } = {}) {
  if (!userIds.length) return { push: [], email: [] };
  const { rows } = await pool.query(
    `select u, coalesce(p.muted, '{}') as muted, coalesce(p.email, true) as email
       from unnest($1::uuid[]) u left join notification_prefs p on p.user_id = u`, [userIds]);
  const on = rows.filter((r) => always || !r.muted.includes(category));
  return { push: on.map((r) => r.u), email: on.filter((r) => r.email).map((r) => r.u) };
}

// send a pop-up to every phone these people turned notifications on for; dead subscriptions are removed
export async function pushTo(pool, userIds, { title, body = '', link = null, tag = null }) {
  if (!VAPID_PUBLIC || !userIds.length) return 0;
  const { rows } = await pool.query('select endpoint, p256dh, auth from push_subscriptions where user_id = any($1::uuid[])', [userIds]);
  const payload = JSON.stringify({ title, body: body || '', link: link || '/', tag });
  let sent = 0;
  await Promise.all(rows.filter((s) => pushHostOk(s.endpoint)).map(async (s) => {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 24 * 3600 }); sent++; }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await pool.query('delete from push_subscriptions where endpoint = $1', [s.endpoint]);
      else console.warn('[push]', e.statusCode || '', e.message);
    }
  }));
  return sent;
}

// routes: the public key, subscribe/unsubscribe this phone, read/save my settings
// guard: optional login check per route (Staff Hub already checks logins for every /api route)
export function pushRoutes(router, pool, guard = (req, res, next) => next(), me = (req) => req.user.id) {
  router.get('/push/key', guard, (req, res) => res.json({ key: pushKey() }));
  router.post('/push/subscribe', guard, async (req, res) => {
    const s = req.body || {};
    if (typeof s.endpoint !== 'string' || !pushHostOk(s.endpoint) || s.endpoint.length > 1000 || typeof s.keys?.p256dh !== 'string' || typeof s.keys?.auth !== 'string') {
      return res.status(400).json({ error: 'That phone could not be set up for notifications' });
    }
    await pool.query(
      `insert into push_subscriptions (endpoint, user_id, p256dh, auth, user_agent) values ($1, $2, $3, $4, $5)
       on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      [s.endpoint, me(req), s.keys.p256dh.slice(0, 200), s.keys.auth.slice(0, 100), String(req.get('user-agent') || '').slice(0, 300)]);
    res.json({ ok: true });
  });
  router.post('/push/unsubscribe', guard, async (req, res) => {
    await pool.query('delete from push_subscriptions where endpoint = $1 and user_id = $2', [String(req.body?.endpoint || ''), me(req)]);
    res.json({ ok: true });
  });
  router.get('/me/notification-settings', guard, async (req, res) => {
    const { rows: [p] } = await pool.query('select muted, email from notification_prefs where user_id = $1', [me(req)]);
    const { rows: [n] } = await pool.query('select count(*)::int as phones from push_subscriptions where user_id = $1', [me(req)]);
    res.json({ muted: p?.muted || [], email: p?.email ?? true, phones: n.phones });
  });
  router.put('/me/notification-settings', guard, async (req, res) => {
    const muted = Array.isArray(req.body?.muted) ? req.body.muted.filter((x) => typeof x === 'string' && /^[a-z_]{1,30}$/.test(x)).slice(0, 30) : [];
    await pool.query(`insert into notification_prefs (user_id, muted, email) values ($1, $2, $3)
      on conflict (user_id) do update set muted = excluded.muted, email = excluded.email`, [me(req), muted, req.body?.email !== false]);
    res.json({ ok: true });
  });
  router.post('/push/test', guard, async (req, res) => {
    const n = await pushTo(pool, [me(req)], { title: 'Notifications are on ✅', body: 'This is how alerts will look on this phone.', tag: 'test' });
    res.json({ sent: n });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (await import('node:assert')).strict;
  for (const ok of ['https://web.push.apple.com/QGuQ', 'https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-db5p.notify.windows.com/w/?token=x']) assert.ok(pushHostOk(ok), ok);
  for (const bad of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://fcm.googleapis.com.evil.com/x', 'https://evilfcm.googleapis.com.attacker.net/x', 'https://fcm.googleapis.com:8443/x', 'https://localhost/x', 'nonsense']) assert.ok(!pushHostOk(bad), bad);
  console.log('push ok');
}
