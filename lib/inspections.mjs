// Inspections API (inspector side + shared read access). Mounted at /api.
import express, { Router } from 'express';
import { Readable } from 'node:stream';
import { storage } from './storage.mjs';
import { BadRequest, str } from './admin.mjs';
import { emailInspectionDone } from './notify.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EDITABLE = ['draft', 'returned'];
// whole string must be a PNG data URL: it is put straight into <img src> on review pages
export const SIG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export function gps(v) {
  if (v == null) return null;
  const lat = Number(v.lat), lng = Number(v.lng), accuracy = v.accuracy == null ? null : Number(v.accuracy);
  if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180) || (accuracy != null && !(accuracy >= 0))) return null;
  return { lat, lng, accuracy };
}
const when = (v) => { const d = v ? new Date(v) : null; return d && !isNaN(d) && Math.abs(d - Date.now()) < 7 * 86400_000 ? d : null; };

// Who may see an inspection. Admin: all. Inspector: their own. Cleaner: approved ones for
// their sites. Client: approved quality checks for their sites (before & after is internal).
// deleted (in Recently deleted) inspections are invisible everywhere except that admin page
export const ACCESS_SQL = `i.deleted_at is null and (
  $U_ROLE = 'admin'
  or $U_ROLE = 'inspector'  -- supervisors see (and can work on) every inspection
  or (i.status = 'approved' and $U_ROLE = 'cleaner' and exists (select 1 from site_cleaners sc where sc.site_id = i.site_id and sc.user_id = $U_ID))
  or (i.status = 'approved' and i.mode = 'check' and $U_ROLE = 'client' and s.client_id = $U_CLIENT)
)`;

// An inspection the user may see (null if missing or not theirs to see).
export async function loadInspection(pool, user, id) {
  if (!UUID.test(id)) return null;
  const sql = `select i.*, s.name as site_name, s.address as site_address, s.client_id, c.name as client_name, c.prospect as client_prospect,
                      c.email as client_email, c.contact_name as client_contact, u.name as inspector_name,
                      au.name as approved_by_name, cu.name as client_signed_by_name, sb.name as submitted_by_name,
                      (select coalesce(json_agg(cu2.name order by cu2.name), '[]') from users cu2 where cu2.id = any(i.contributors)) as contributor_names
                 from inspections i join sites s on s.id = i.site_id join clients c on c.id = s.client_id
                 join users u on u.id = i.inspector_id
                 left join users au on au.id = i.approved_by left join users cu on cu.id = i.client_signed_by left join users sb on sb.id = i.submitted_by
                where i.id = $1 and ${ACCESS_SQL.replaceAll('$U_ROLE', '$2').replaceAll('$U_ID', '$3').replaceAll('$U_CLIENT', '$4')}`;
  return (await pool.query(sql, [id, user.role, user.id, user.client_id])).rows[0] || null;
}

// items, photos and comments (one shared thread: everyone who can open the inspection sees it)
export async function inspectionDetail(pool, insp, role = 'admin') {
  const [items, photos, comments] = await Promise.all([
    pool.query(`select ii.item_key, ii.label, ii.hint, ii.area, ii.note, ii.added, ii.score, ii.action_what, ii.action_who,
                       to_char(ii.action_due, 'YYYY-MM-DD') as action_due, ii.action_done_at, u.name as action_done_by_name
                  from inspection_items ii left join users u on u.id = ii.action_done_by
                 where ii.inspection_id = $1 order by ii.position`, [insp.id]),
    pool.query('select id, item_key, storage_key, caption, taken_at, gps, phase, pair_id from photos where inspection_id = $1 order by coalesce(taken_at, created_at)', [insp.id]),
    pool.query(`select c.id, c.body, c.created_at, c.audience, u.name, u.role from comments c join users u on u.id = c.user_id
                 where c.inspection_id = $1 order by c.created_at`, [insp.id]),
  ]);
  // action plans are internal: clients see scores, not who is fixing what
  if (role === 'client') for (const it of items.rows) for (const k of Object.keys(it)) if (k.startsWith('action_')) delete it[k];
  return { ...insp, items: items.rows, photos: photos.rows, comments: comments.rows };
}

export const LOW_SCORE = 7;
const STATUSES = ['draft', 'submitted', 'returned', 'approved'];

// An item is done when: quality check -> scored (and planned if low); before & after -> has a before
// photo and every before photo has its after. Mirrors itemDone() on the phone. Needs aliases i + ii.
// prospects (quick inspections) get a comment per item instead of urgent action plans
const PROSPECT_SQL = '(select c.prospect from sites s join clients c on c.id = s.client_id where s.id = i.site_id)';
const ITEM_DONE_SQL = `case when i.mode = 'check'
    then ii.score is not null and (ii.score >= ${LOW_SCORE} or (coalesce(ii.action_what, '') <> '' and coalesce(ii.action_who, '') <> '' and ii.action_due is not null) or ${PROSPECT_SQL})
    else exists (select 1 from photos b where b.inspection_id = i.id and b.item_key = ii.item_key and b.phase = 'before')
     and not exists (select 1 from photos b where b.inspection_id = i.id and b.item_key = ii.item_key and b.phase = 'before'
                       and not exists (select 1 from photos a where a.pair_id = b.id))
     and (ii.score is null or ii.score >= ${LOW_SCORE} or (coalesce(ii.action_what, '') <> '' and coalesce(ii.action_who, '') <> '' and ii.action_due is not null) or ${PROSPECT_SQL}) end`;
// progress columns for inspection lists (alias i)
export const PROGRESS_SQL = `
  (select count(*)::int from inspection_items ii where ii.inspection_id = i.id) as item_count,
  (select count(*)::int from inspection_items ii where ii.inspection_id = i.id and ${ITEM_DONE_SQL}) as done_count,
  (select round(avg(ii.score), 1) from inspection_items ii where ii.inspection_id = i.id) as avg_score,
  (select count(*)::int from inspection_items ii where ii.inspection_id = i.id and ii.score < ${LOW_SCORE}) as low_count`;

// inspection lists (admin inbox, everyone's Inspections tab)
export async function listInspections(pool, status) {
  status = STATUSES.includes(status) ? status : null;
  return (await pool.query(
      `select i.id, i.status, i.mode, i.template_id, i.inspector_id, i.started_at, i.finished_at, i.approved_at, i.emailed_at, i.client_signed_at,
              i.template_name, i.contributors, s.name as site_name, c.name as client_name, u.name as inspector_name,
              (select count(*)::int from photos p where p.inspection_id = i.id) as photo_count,
              ${PROGRESS_SQL},
              (select count(*)::int from inspection_items ii where ii.inspection_id = i.id and ii.score < ${LOW_SCORE} and ii.action_what is not null and ii.action_done_at is null) as open_actions
         from inspections i join sites s on s.id = i.site_id join clients c on c.id = s.client_id
         join users u on u.id = i.inspector_id
        where i.deleted_at is null and ($1::text is null or i.status = $1)
        order by coalesce(i.finished_at, i.started_at) desc limit 300`, [status])).rows;
}

// urgent action plans (items scored below LOW_SCORE) on submitted/approved inspections;
// inspectorId limits them to one supervisor's own inspections
export async function listActions(pool, { done = false, inspectorId = null } = {}) {
  return (await pool.query(
    `select ii.inspection_id, ii.item_key, ii.label, ii.area, ii.score, ii.note, ii.action_what, ii.action_who,
            to_char(ii.action_due, 'YYYY-MM-DD') as action_due, ii.action_due < current_date as overdue,
            ii.action_done_at, du.name as action_done_by_name,
            i.status, i.mode, i.template_name, i.finished_at, s.name as site_name, c.name as client_name, u.name as inspector_name
       from inspection_items ii join inspections i on i.id = ii.inspection_id
       join sites s on s.id = i.site_id join clients c on c.id = s.client_id join users u on u.id = i.inspector_id
       left join users du on du.id = ii.action_done_by
      where ii.score < ${LOW_SCORE} and i.status in ('submitted', 'approved') and not c.prospect and i.deleted_at is null
        and (ii.action_done_at is not null) = $1 and ($2::uuid is null or i.inspector_id = $2)
      order by ${done ? 'ii.action_done_at desc' : 'ii.action_due nulls last, i.finished_at'} limit 300`, [done, inspectorId])).rows;
}
// what still stops a quality check being submitted (empty = ready)
// Quality checks must score every item; before & after scores are optional. Any low score needs a plan.
export function itemProblems(items, mode, prospect = false) {
  const out = [];
  for (const it of items) {
    if (!it.score) { if (mode === 'check') out.push(`${it.label}: needs a score`); }
    else if (!prospect && it.score < LOW_SCORE && !(it.action_what?.trim() && it.action_who?.trim() && it.action_due)) {
      out.push(`${it.label}: scored ${it.score}, needs an urgent action plan (what, who, deadline)`);
    }
  }
  return out;
}

// item fields an inspector may send; only the ones present in the body are changed
export function itemUpdate(body) {
  const set = {};
  if (typeof body?.note === 'string') set.note = body.note.slice(0, 5000);
  {
    if ('score' in body) {
      const n = body.score == null || body.score === '' ? null : Number(body.score);
      if (n !== null && !(Number.isInteger(n) && n >= 1 && n <= 10)) throw new BadRequest('Score must be 1 to 10');
      set.score = n;
    }
    for (const k of ['action_what', 'action_who']) if (k in body) set[k] = String(body[k] ?? '').slice(0, 2000).trim() || null;
    if ('action_due' in body) {
      const d = body.action_due || null;
      if (d !== null && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new BadRequest('Deadline must be a date');
      set.action_due = d;
    }
  }
  return set;
}

export function inspectionRoutes(pool, requireUser) {
  const r = Router();
  const inspecting = requireUser('admin', 'inspector');
  const load = (req, id) => loadInspection(pool, req.user, id);
  // load for editing: any admin or supervisor may work on an open inspection (shared, several phones at once);
  // whoever changes someone else's inspection is recorded as a contributor
  async function loadEditable(req, res) {
    const insp = await load(req, req.params.id);
    if (!insp) { res.status(404).json({ error: 'Inspection not found' }); return null; }
    if (!EDITABLE.includes(insp.status)) { res.status(409).json({ error: 'This inspection has been submitted and can no longer be changed' }); return null; }
    if (insp.inspector_id !== req.user.id && !(insp.contributors || []).includes(req.user.id)) {
      await pool.query('update inspections set contributors = array_append(contributors, $2) where id = $1 and not ($2 = any(contributors))', [insp.id, req.user.id]);
    }
    return insp;
  }

  // every site, with its usable templates (a site without any can still have a no-checklist before & after)
  r.get('/inspect/sites', inspecting, async (req, res) => {
    res.json((await pool.query(
      `select s.id, s.name, s.address, c.name as client_name,
              coalesce(json_agg(json_build_object('id', t.id, 'name', t.name, 'item_count', jsonb_array_length(t.items), 'items', t.items)
                       order by lower(t.name)) filter (where t.id is not null), '[]') as templates
         from sites s join clients c on c.id = s.client_id and not c.prospect
         left join site_templates st on st.site_id = s.id
         left join templates t on t.id = st.template_id and jsonb_array_length(t.items) > 0
        group by s.id, c.name order by lower(c.name), lower(s.name)`)).rows);
  });

  // start: the phone picks the id, so a retried request can't create a duplicate.
  // A quick inspection ({ quick: { name } }, no site) creates a prospect client + site to hang it on.
  r.post('/inspections', inspecting, async (req, res) => {
    const { id, template_id } = req.body || {}, quick = req.body?.quick;
    let site_id = req.body?.site_id;
    const mode = req.body?.mode === 'before_after' ? 'before_after' : 'check';
    // no template = no checklist: items are added on site (before & after, or any quick inspection)
    const free = template_id == null && (mode === 'before_after' || !!quick);
    if (!UUID.test(id) || !(quick || UUID.test(site_id)) || !(free || UUID.test(template_id))) throw new BadRequest('id, site and template are required');
    const db = await pool.connect();
    try {
      await db.query('begin');
      if (quick) {
        const had = (await db.query('select site_id from inspections where id = $1', [id])).rows[0];
        if (had) site_id = had.site_id;
        else {
          const name = str(quick.name, 'Name', { max: 200 }) || 'New prospect';
          const c = (await db.query('insert into clients (name, prospect) values ($1, true) returning id', [name])).rows[0];
          site_id = (await db.query('insert into sites (client_id, name) values ($1, $2) returning id', [c.id, name])).rows[0].id;
        }
      }
      const t = free
        ? (await db.query('select null::uuid as id, $1::text as name, $2::jsonb as items from sites where id = $3',
            ['No checklist', '[]', site_id])).rows[0]
        : (await db.query(
            `select t.* from templates t join site_templates st on st.template_id = t.id
              where t.id = $1 and st.site_id = $2`, [template_id, site_id])).rows[0];
      if (!t) { await db.query('rollback'); throw new BadRequest(free ? 'Unknown site' : 'That template is not used at this site'); }
      const ins = await db.query(
        `insert into inspections (id, site_id, template_id, template_name, inspector_id, start_gps, started_at, mode)
         values ($1, $2, $3, $4, $5, $6, coalesce($7, now()), $8) on conflict (id) do nothing`,
        [id, site_id, t.id, t.name, req.user.id, gps(req.body.start_gps), when(req.body.started_at), mode]);
      if (ins.rowCount) {
        await db.query(
          `insert into inspection_items (inspection_id, item_key, position, label, hint, area)
           select $1, it->>'key', ord::int, it->>'label', coalesce(it->>'hint', ''), coalesce(it->>'area', '') from jsonb_array_elements($2::jsonb) with ordinality as x(it, ord)`,
          [id, JSON.stringify(t.items)]);
      }
      await db.query('commit');
    } catch (e) { await db.query('rollback').catch(() => {}); throw e; } finally { db.release(); }
    const insp = await load(req, id);
    insp ? res.json(insp) : res.status(409).json({ error: 'Inspection id clash' });
  });

  // ── prospects (clients made by quick inspections); admins and supervisors see them all ──
  r.get('/prospects', inspecting, async (req, res) => {
    res.json((await pool.query(
      `select c.id, c.name, c.contact_name, c.email, c.phone, c.created_at, s.address,
              coalesce((select json_agg(json_build_object('id', i.id, 'status', i.status, 'mode', i.mode, 'template_id', i.template_id,
                         'started_at', i.started_at, 'inspector_name', u.name) order by i.started_at desc)
                 from inspections i join sites s3 on s3.id = i.site_id join users u on u.id = i.inspector_id where s3.client_id = c.id and i.deleted_at is null), '[]') as inspections
         from clients c left join lateral (select address from sites where client_id = c.id order by created_at limit 1) s on true
        where c.prospect order by c.created_at desc`)).rows);
  });
  r.put('/prospects/:id', inspecting, async (req, res) => {
    if (!UUID.test(req.params.id)) throw new BadRequest('Unknown prospect');
    const b = req.body || {};
    const name = str(b.name, 'Business name', { required: true, max: 200 });
    const vals = [str(b.contact_name, 'Contact name', { max: 200 }), str(b.email, 'Email', { max: 200 }), str(b.phone, 'Phone', { max: 50 })];
    const { rows: [c] } = await pool.query(
      `update clients c set name = $2, contact_name = $3, email = $4, phone = $5 where c.id = $1 and c.prospect returning c.id`,
      [req.params.id, name, ...vals]);
    if (!c) return res.status(404).json({ error: 'Prospect not found' });
    // a prospect has the one site its quick inspection made: it follows the business name
    await pool.query('update sites set name = $2, address = $3 where client_id = $1', [c.id, name, str(b.address, 'Address', { max: 500 })]);
    res.json({ ok: true });
  });
  // admins turn a prospect into a normal client (it then shows under Clients & sites)
  r.post('/prospects/:id/convert', requireUser('admin'), async (req, res) => {
    if (!UUID.test(req.params.id)) throw new BadRequest('Unknown prospect');
    const { rowCount } = await pool.query('update clients set prospect = false where id = $1 and prospect', [req.params.id]);
    rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Prospect not found' });
  });

  // every inspection (Inspections tab) — admins and supervisors alike
  r.get('/inspections/all', inspecting, async (req, res) => res.json(await listInspections(pool, req.query.status)));

  r.get('/inspections/mine', inspecting, async (req, res) => {
    res.json((await pool.query(
      `select i.id, i.status, i.mode, i.template_id, i.inspector_id, i.started_at, i.finished_at, i.template_name,
              s.name as site_name, s.address as site_address, c.name as client_name, u.name as inspector_name,
              (select count(*)::int from photos p where p.inspection_id = i.id) as photo_count, ${PROGRESS_SQL}
         from inspections i join sites s on s.id = i.site_id join clients c on c.id = s.client_id join users u on u.id = i.inspector_id
        where i.deleted_at is null and (i.inspector_id = $1 or $1 = any(i.contributors) or i.status in ('draft', 'returned'))
        order by i.started_at desc limit 100`, [req.user.id])).rows);
  });

  // action plans: everyone sees all (marking done stays admin-only)
  r.get('/actions', inspecting, async (req, res) => {
    res.json(await listActions(pool, { done: req.query.done === '1' }));
  });

  r.get('/inspections/:id', requireUser(), async (req, res) => {
    const insp = await load(req, req.params.id);
    if (!insp) return res.status(404).json({ error: 'Inspection not found' });
    const full = await inspectionDetail(pool, insp, req.user.role);
    full.photos.forEach((p) => delete p.storage_key);
    res.json(full);
  });

  r.put('/inspections/:id/items/:key', inspecting, async (req, res) => {
    const insp = await loadEditable(req, res); if (!insp) return;
    const set = itemUpdate(req.body || {}), keys = Object.keys(set);
    if (!keys.length) return res.json({ ok: true });
    const { rowCount } = await pool.query(
      `update inspection_items set ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')} where inspection_id = $1 and item_key = $2`,
      [req.params.id, req.params.key, ...keys.map((k) => set[k])]);
    rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'No such item' });
  });

  // add an item on site (this inspection only, never the template). The phone picks the key so retries are safe.
  r.post('/inspections/:id/items', inspecting, async (req, res) => {
    const insp = await loadEditable(req, res); if (!insp) return;
    const key = req.body?.key, label = typeof req.body?.label === 'string' ? req.body.label.trim().slice(0, 200) : '';
    if (typeof key !== 'string' || !/^[a-z0-9]{1,16}$/.test(key)) throw new BadRequest('Bad item key');
    if (!label) throw new BadRequest('Give the item a name');
    const area = typeof req.body?.area === 'string' ? req.body.area.trim().slice(0, 200) : '';
    // goes at the end of its area (no area / a new area: the end of the list), later items shift down one;
    // a retried add (key already there) changes nothing
    await pool.query(
      `with ex as (select 1 from inspection_items where inspection_id = $1 and item_key = $2),
            p as (select coalesce(max(position) filter (where $4 <> '' and area = $4), max(position), 0) as pos
                    from inspection_items where inspection_id = $1),
            sh as (update inspection_items set position = position + 1
                    where inspection_id = $1 and position > (select pos from p) and not exists (select 1 from ex))
       insert into inspection_items (inspection_id, item_key, position, label, added, area)
       select $1, $2, pos + 1, $3, true, $4 from p where not exists (select 1 from ex)`, [insp.id, key, label, area]);
    res.json({ ok: true });
  });
  // remove an item added on site (template items stay)
  r.delete('/inspections/:id/items/:key', inspecting, async (req, res) => {
    const insp = await loadEditable(req, res); if (!insp) return;
    const { rows } = await pool.query('select added from inspection_items where inspection_id = $1 and item_key = $2', [insp.id, req.params.key]);
    if (!rows[0]) return res.json({ ok: true }); // already gone (retried delete)
    if (!rows[0].added) throw new BadRequest('Only items added on site can be removed');
    const photos = await pool.query('delete from photos where inspection_id = $1 and item_key = $2 returning storage_key', [insp.id, req.params.key]);
    await pool.query('delete from inspection_items where inspection_id = $1 and item_key = $2', [insp.id, req.params.key]);
    await Promise.all(photos.rows.map((p) => storage.del(p.storage_key).catch(() => {})));
    res.json({ ok: true });
  });

  // photo upload: raw image body, metadata in the query string; the phone picks the id so retries are safe
  r.put('/inspections/:id/photos/:pid', inspecting,
    express.raw({ type: ['image/jpeg', 'image/webp', 'image/png'], limit: MAX_PHOTO_BYTES }), async (req, res) => {
      if (!UUID.test(req.params.pid)) throw new BadRequest('Bad photo id');
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw new BadRequest('No image received');
      const insp = await loadEditable(req, res); if (!insp) return;
      const { item_key, taken_at, lat, lng, accuracy } = req.query;
      const item = await pool.query('select 1 from inspection_items where inspection_id = $1 and item_key = $2', [insp.id, item_key]);
      if (!item.rowCount) throw new BadRequest('No such item');
      // before & after: phase is required; an after photo may name the before photo it matches
      let phase = null, pairId = null;
      if (insp.mode === 'before_after') {
        phase = req.query.phase === 'after' ? 'after' : 'before';
        if (phase === 'after' && req.query.pair_id) {
          const pair = await pool.query(`select 1 from photos where id = $1 and inspection_id = $2 and item_key = $3 and phase = 'before'`,
            [UUID.test(req.query.pair_id) ? req.query.pair_id : null, insp.id, item_key]);
          if (!pair.rowCount) throw new BadRequest('The before photo for this after photo is missing');
          pairId = req.query.pair_id;
        }
      }
      const existing = await pool.query('select inspection_id from photos where id = $1', [req.params.pid]);
      if (existing.rowCount) {
        return existing.rows[0].inspection_id === insp.id ? res.json({ ok: true }) : res.status(409).json({ error: 'Photo id clash' });
      }
      const ext = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' }[req.get('content-type').split(';')[0]];
      const key = `inspections/${insp.id}/${req.params.pid}.${ext}`;
      await storage.put(key, req.body, req.get('content-type'));
      await pool.query(
        `insert into photos (id, inspection_id, item_key, storage_key, taken_at, gps, phase, pair_id) values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (id) do nothing`,
        [req.params.pid, insp.id, item_key, key, when(taken_at), gps(lat == null ? null : { lat, lng, accuracy }), phase, pairId]);
      res.json({ ok: true });
    });

  r.delete('/inspections/:id/photos/:pid', inspecting, async (req, res) => {
    const insp = await loadEditable(req, res); if (!insp) return;
    // deleting a before photo takes its matching after photo with it
    if (!UUID.test(req.params.pid)) throw new BadRequest('Bad photo id');
    const { rows } = await pool.query('delete from photos where (id = $1 or pair_id = $1) and inspection_id = $2 returning storage_key', [req.params.pid, insp.id]);
    await Promise.all(rows.map((p) => storage.del(p.storage_key).catch((e) => console.warn('[photos] delete failed', e.message))));
    res.json({ ok: true });
  });

  r.get('/photos/:pid', requireUser(), async (req, res) => {
    if (!UUID.test(req.params.pid)) return res.status(404).end();
    const p = (await pool.query('select inspection_id, storage_key from photos where id = $1', [req.params.pid])).rows[0];
    if (!p || !(await load(req, p.inspection_id))) return res.status(404).end();
    const file = await storage.get(p.storage_key);
    if (!file.ok) return res.status(404).end();
    res.set({ 'content-type': file.headers.get('content-type'), 'cache-control': 'private, max-age=31536000, immutable' });
    Readable.fromWeb(file.body).pipe(res);
  });

  r.post('/inspections/:id/submit', inspecting, async (req, res) => {
    const insp = await loadEditable(req, res); if (!insp) return;
    const sig = req.body?.inspector_sig;
    if (typeof sig !== 'string' || !SIG_DATA_URL.test(sig) || sig.length > 1_000_000) throw new BadRequest('Please sign before submitting');
    const { rows: items } = await pool.query('select label, score, action_what, action_who, action_due from inspection_items where inspection_id = $1 order by position', [insp.id]);
    const problems = items.length ? itemProblems(items, insp.mode, insp.client_prospect) : ['add at least one item'];
    if (problems.length) throw new BadRequest(`Not ready to submit — ${problems.join('; ')}`);
    await pool.query(
      `update inspections set status = 'submitted', submitted_by = $5, inspector_sig = $2, end_gps = coalesce($3, end_gps), finished_at = coalesce($4, now())
        where id = $1`, [insp.id, sig, gps(req.body.end_gps), when(req.body.finished_at), req.user.id]);
    // tell both admins (PDF attached; URGENT if anything scored low) — doesn't hold up the phone
    emailInspectionDone(pool, req, insp.id).catch((e) => console.error('[notify] inspection email failed', e.message));
    res.json({ ok: true });
  });

  // discard a draft that was never submitted
  r.delete('/inspections/:id', inspecting, async (req, res) => {
    const insp = await loadEditable(req, res); if (!insp) return;
    if (insp.status !== 'draft') throw new BadRequest('Only drafts can be discarded');
    if (insp.inspector_id !== req.user.id && req.user.role !== 'admin') throw new BadRequest('Only whoever started it (or an admin) can discard it');
    const { rows } = await pool.query('select storage_key from photos where inspection_id = $1', [insp.id]);
    await pool.query('delete from inspections where id = $1', [insp.id]);
    await Promise.all(rows.map((p) => storage.del(p.storage_key).catch(() => {})));
    res.json({ ok: true });
  });

  return r;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.assert(gps({ lat: '53.48', lng: '-2.24', accuracy: 12 }).lat === 53.48, 'gps parses');
  console.assert(gps({ lat: 91, lng: 0 }) === null && gps({ lat: 'x', lng: 0 }) === null && gps(null) === null, 'gps rejects');
  console.assert(gps({ lat: 0, lng: 0, accuracy: -1 }) === null, 'gps accuracy');
  console.assert(when(new Date().toISOString()) && !when('2001-01-01') && !when('nope'), 'when');
  console.assert(SIG_DATA_URL.test('data:image/png;base64,iVBORw0KGgo=') && !SIG_DATA_URL.test('data:image/png;base64,x"><script>'), 'signature check');
  const items = [{ label: 'A', score: 8 }, { label: 'B', score: 6, action_what: 'redo', action_who: 'Ana', action_due: '2026-10-10' }];
  console.assert(itemProblems(items, 'check').length === 0, 'complete check passes');
  console.assert(itemProblems([{ label: 'A' }], 'check')[0].includes('needs a score'), 'missing score');
  console.assert(itemProblems([{ label: 'B', score: 6, action_what: 'redo' }], 'check')[0].includes('action plan'), 'low needs full plan');
  console.assert(itemProblems([{ label: 'A' }], 'before_after').length === 0, 'b&a score is optional');
  console.assert(itemProblems([{ label: 'B', score: 4 }], 'before_after')[0].includes('action plan'), 'b&a low score needs a plan');
  console.assert(itemProblems([{ label: 'B', score: 3 }], 'check', true).length === 0, 'prospects: no action plans');
  console.assert(itemUpdate({ score: 7 }).score === 7, 'score saved for every mode');
  for (const bad of [{ score: 0 }, { score: 11 }, { score: 6.5 }, { action_due: 'tomorrow' }]) {
    let threw = false; try { itemUpdate(bad); } catch { threw = true; } console.assert(threw, `rejects ${JSON.stringify(bad)}`);
  }
  console.log('inspections ok');
}
