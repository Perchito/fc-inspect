// Assigned actions + in-app notifications. An urgent action plan can name a person (their FC Inspect login):
// they are notified when the inspection is submitted, reminded when it is overdue, and can mark it done
// (with an optional note and photo) from "My actions" — cleaners, supervisors and admins alike.
import express, { Router } from 'express';
import { BadRequest } from './admin.mjs';
import { storage } from './storage.mjs';
import { sendEmail, emailConfigured } from './mailer.mjs';
import { brandEmail, hi, p, facts, esc } from './emails.mjs';
import { wanted, pushTo, pushRoutes } from './push.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOW = 7;
const day = (d) => d ? new Date(`${String(d).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '—';
const appUrl = (req) => `${req.protocol}://${req.get('host')}`;

// in-app notification + a phone pop-up for those who want this category (actions | reminders | updates)
export async function notify(pool, userIds, { title, body = '', link = null, category = 'updates' }) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return;
  await pool.query('insert into notifications (user_id, title, body, link) select unnest($1::uuid[]), $2, $3, $4', [ids, title, body, link]);
  wanted(pool, ids, category).then((w) => pushTo(pool, w.push, { title, body, link })).catch((e) => console.error('[push]', e.message));
}

// open actions on a submitted/approved inspection whose person hasn't been told yet: notify + email them
export async function notifyAssignments(pool, req, inspectionId) {
  const { rows } = await pool.query(
    `update inspection_items ii set action_notified = true
       from inspections i where i.id = ii.inspection_id and ii.inspection_id = $1 and i.status in ('submitted', 'approved') and i.deleted_at is null
        and ii.score < ${LOW} and ii.action_user_id is not null and ii.action_done_at is null and not ii.action_notified
      returning ii.item_key, ii.label, ii.area, ii.action_what, to_char(ii.action_due, 'YYYY-MM-DD') as action_due, ii.action_user_id`, [inspectionId]);
  if (!rows.length) return;
  const { rows: [insp] } = await pool.query('select s.name as site_name from inspections i join sites s on s.id = i.site_id where i.id = $1', [inspectionId]);
  for (const a of rows) {
    const link = `#/my-actions/${inspectionId}/${encodeURIComponent(a.item_key)}`;
    await notify(pool, [a.action_user_id], { title: `New action at ${insp.site_name}`, body: `${a.action_what} — due ${day(a.action_due)}`, link, category: 'actions' });
    const { rows: [u] } = await pool.query('select email, name, active from users where id = $1', [a.action_user_id]);
    if (!u?.active || !emailConfigured() || !(await wanted(pool, [a.action_user_id], 'actions')).email.length) continue; // they switched these emails off
    const first = String(u.name || '').split(/\s+/)[0] || 'there';
    sendEmail({
      to: u.email, subject: `Urgent action at ${insp.site_name} — due ${day(a.action_due)}`,
      text: `Hi ${first},\n\nYou've been given an urgent action at ${insp.site_name}:\n\n${a.action_what}\nItem: ${a.area ? `${a.area} › ` : ''}${a.label}\nDeadline: ${day(a.action_due)}\n\nOpen FC Inspect to see the photos and mark it done: ${appUrl(req)}/${link}\n\nFC Cleaning Company`,
      html: brandEmail({ url: appUrl(req), title: 'You have an urgent action', buttonUrl: `${appUrl(req)}/${link}`, button: 'Open in FC Inspect',
        body: hi(first) + p(`You've been given an urgent action at <strong style="color:#05101f">${esc(insp.site_name)}</strong>.`)
          + facts([['What to do', a.action_what], ['Item', `${a.area ? `${a.area} › ` : ''}${a.label}`], ['Deadline', day(a.action_due)]])
          + p('Open FC Inspect to see the photos and mark it done.') }),
    }).catch((e) => console.error('[actions] email failed', e.message));
  }
}

// once a day per action: remind the person (and the admins) about actions past their deadline
export async function remindOverdue(pool) {
  const { rows } = await pool.query(
    `update inspection_items ii set action_reminded_at = now()
       from inspections i join sites s on s.id = i.site_id
      where i.id = ii.inspection_id and i.status in ('submitted', 'approved') and i.deleted_at is null
        and ii.score < ${LOW} and ii.action_done_at is null and ii.action_due < current_date
        and (ii.action_reminded_at is null or ii.action_reminded_at < now() - interval '23 hours')
      returning ii.inspection_id, ii.item_key, ii.action_what, ii.action_who, ii.action_user_id, to_char(ii.action_due, 'YYYY-MM-DD') as action_due, s.name as site_name`);
  if (!rows.length) return 0;
  const admins = (await pool.query(`select id from users where role = 'admin' and active`)).rows.map((u) => u.id);
  for (const a of rows) {
    const link = `#/my-actions/${a.inspection_id}/${encodeURIComponent(a.item_key)}`;
    if (a.action_user_id) await notify(pool, [a.action_user_id], { title: `Overdue action at ${a.site_name}`, body: `${a.action_what} — was due ${day(a.action_due)}`, link, category: 'reminders' });
    await notify(pool, admins.filter((id) => id !== a.action_user_id), { title: `Overdue: ${a.site_name}`, body: `${a.action_what} (${a.action_who || 'unassigned'}) — was due ${day(a.action_due)}`, link: `#/actions/${a.inspection_id}/${encodeURIComponent(a.item_key)}`, category: 'reminders' });
  }
  return rows.length;
}

const MY_ACTIONS_SQL = `
  select ii.inspection_id, ii.item_key, ii.label, ii.area, ii.score, ii.note, ii.action_what, ii.action_who,
         to_char(ii.action_due, 'YYYY-MM-DD') as action_due, ii.action_done_at, ii.action_done_note, du.name as action_done_by_name,
         s.name as site_name, s.address as site_address, c.name as client_name, i.finished_at,
         coalesce((select json_agg(json_build_object('id', ph.id, 'action', ph.action, 'phase', ph.phase) order by ph.action, coalesce(ph.taken_at, ph.created_at))
                     from photos ph where ph.inspection_id = ii.inspection_id and ph.item_key = ii.item_key), '[]') as photos
    from inspection_items ii join inspections i on i.id = ii.inspection_id join sites s on s.id = i.site_id join clients c on c.id = s.client_id
    left join users du on du.id = ii.action_done_by
   where ii.action_user_id = $1 and ii.score < ${LOW} and i.status in ('submitted', 'approved') and i.deleted_at is null`;

export function actionRoutes(pool, requireUser) {
  const r = Router();
  const anyone = requireUser('admin', 'inspector', 'cleaner');
  pushRoutes(r, pool, anyone); // phone pop-ups + my notification settings

  // ── notifications ──
  r.get('/notifications', anyone, async (req, res) => {
    res.json((await pool.query('select id, title, body, link, created_at, read_at from notifications where user_id = $1 order by created_at desc limit 100', [req.user.id])).rows);
  });
  r.get('/notifications/unread', anyone, async (req, res) => {
    res.json({ count: (await pool.query('select count(*)::int as n from notifications where user_id = $1 and read_at is null', [req.user.id])).rows[0].n });
  });
  r.post('/notifications/read', anyone, async (req, res) => {
    await pool.query('update notifications set read_at = now() where user_id = $1 and read_at is null', [req.user.id]);
    res.json({ ok: true });
  });

  // ── my actions ──
  r.get('/me/actions', anyone, async (req, res) => {
    res.json((await pool.query(`${MY_ACTIONS_SQL} order by ii.action_done_at desc nulls first, ii.action_due nulls last limit 200`, [req.user.id])).rows);
  });
  const mine = async (req) => {
    if (!UUID.test(req.params.id)) return null;
    return (await pool.query(`${MY_ACTIONS_SQL} and ii.inspection_id = $2 and ii.item_key = $3`, [req.user.id, req.params.id, req.params.key])).rows[0] || null;
  };
  r.get('/me/actions/:id/:key', anyone, async (req, res) => {
    const a = await mine(req);
    a ? res.json(a) : res.status(404).json({ error: 'Action not found' });
  });
  r.post('/me/actions/:id/:key/done', anyone, async (req, res) => {
    const a = await mine(req); if (!a) return res.status(404).json({ error: 'Action not found' });
    if (a.action_done_at) return res.json({ ok: true });
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 2000) || null : null;
    await pool.query('update inspection_items set action_done_at = now(), action_done_by = $3, action_done_note = $4 where inspection_id = $1 and item_key = $2',
      [req.params.id, req.params.key, req.user.id, note]);
    const { rows } = await pool.query(`select id from users where active and (role = 'admin' or id = (select inspector_id from inspections where id = $1))`, [req.params.id]);
    await notify(pool, rows.map((u) => u.id).filter((id) => id !== req.user.id), {
      title: `Action done: ${a.site_name}`, body: `${req.user.name} — ${a.action_what}${note ? ` (“${note}”)` : ''}`,
      link: `#/actions/${req.params.id}/${encodeURIComponent(req.params.key)}` });
    res.json({ ok: true });
  });
  // a photo of the fix (before or after marking it done); the phone picks the id so retries are safe
  r.put('/me/actions/:id/:key/photos/:pid', anyone, express.raw({ type: ['image/jpeg', 'image/webp', 'image/png'], limit: 10 * 1024 * 1024 }), async (req, res) => {
    if (!UUID.test(req.params.pid)) throw new BadRequest('Bad photo id');
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new BadRequest('No image received');
    const a = await mine(req); if (!a) return res.status(404).json({ error: 'Action not found' });
    if ((await pool.query('select 1 from photos where id = $1', [req.params.pid])).rowCount) return res.json({ ok: true });
    const ext = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' }[req.get('content-type').split(';')[0]];
    const key = `inspections/${req.params.id}/${req.params.pid}.${ext}`;
    await storage.put(key, req.body, req.get('content-type'));
    await pool.query(`insert into photos (id, inspection_id, item_key, storage_key, taken_at, action) values ($1, $2, $3, $4, now(), true) on conflict (id) do nothing`,
      [req.params.pid, req.params.id, req.params.key, key]);
    res.json({ ok: true });
  });
  return r;
}

// may this user see this photo because it belongs to an action assigned to them?
export async function assigneeMaySee(pool, userId, photo) {
  return (await pool.query(`select 1 from inspection_items ii join inspections i on i.id = ii.inspection_id
    where ii.inspection_id = $1 and ii.item_key = $2 and ii.action_user_id = $3 and i.deleted_at is null`, [photo.inspection_id, photo.item_key, userId])).rowCount > 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.assert(day('2026-10-10') === 'Sat 10 Oct', day('2026-10-10'));
  console.log('actions ok');
}
