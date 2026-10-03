// Inspections API (inspector side + shared read access). Mounted at /api.
import express, { Router } from 'express';
import { Readable } from 'node:stream';
import { storage } from './storage.mjs';
import { BadRequest } from './admin.mjs';

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

// Who may see an inspection. Admin: all. Inspector: their own. Cleaner/client: approved
// ones for their sites only.
export const ACCESS_SQL = `(
  $U_ROLE = 'admin'
  or ($U_ROLE = 'inspector' and i.inspector_id = $U_ID)
  or (i.status = 'approved' and $U_ROLE = 'cleaner' and exists (select 1 from site_cleaners sc where sc.site_id = i.site_id and sc.user_id = $U_ID))
  or (i.status = 'approved' and $U_ROLE = 'client' and s.client_id = $U_CLIENT)
)`;

// An inspection the user may see (null if missing or not theirs to see).
export async function loadInspection(pool, user, id) {
  if (!UUID.test(id)) return null;
  const sql = `select i.*, s.name as site_name, s.address as site_address, s.client_id, c.name as client_name,
                      c.email as client_email, c.contact_name as client_contact, u.name as inspector_name,
                      au.name as approved_by_name, cu.name as client_signed_by_name
                 from inspections i join sites s on s.id = i.site_id join clients c on c.id = s.client_id
                 join users u on u.id = i.inspector_id
                 left join users au on au.id = i.approved_by left join users cu on cu.id = i.client_signed_by
                where i.id = $1 and ${ACCESS_SQL.replaceAll('$U_ROLE', '$2').replaceAll('$U_ID', '$3').replaceAll('$U_CLIENT', '$4')}`;
  return (await pool.query(sql, [id, user.role, user.id, user.client_id])).rows[0] || null;
}

// items, photos and comments of a loaded inspection
export async function inspectionDetail(pool, insp) {
  const [items, photos, comments] = await Promise.all([
    pool.query('select item_key, label, hint, note from inspection_items where inspection_id = $1 order by position', [insp.id]),
    pool.query('select id, item_key, storage_key, caption, taken_at, gps, phase, pair_id from photos where inspection_id = $1 order by coalesce(taken_at, created_at)', [insp.id]),
    pool.query(`select c.id, c.body, c.created_at, u.name, u.role from comments c join users u on u.id = c.user_id
                 where c.inspection_id = $1 order by c.created_at`, [insp.id]),
  ]);
  return { ...insp, items: items.rows, photos: photos.rows, comments: comments.rows };
}

export function inspectionRoutes(pool, requireUser) {
  const r = Router();
  const inspecting = requireUser('admin', 'inspector');
  const load = (req, id) => loadInspection(pool, req.user, id);
  // load for editing: must be the inspector who owns it, and still editable
  async function loadEditable(req, res) {
    const insp = await load(req, req.params.id);
    if (!insp || insp.inspector_id !== req.user.id) { res.status(404).json({ error: 'Inspection not found' }); return null; }
    if (!EDITABLE.includes(insp.status)) { res.status(409).json({ error: 'This inspection has been submitted and can no longer be changed' }); return null; }
    return insp;
  }

  // sites an inspector can start an inspection at (only ones with templates)
  r.get('/inspect/sites', inspecting, async (req, res) => {
    res.json((await pool.query(
      `select s.id, s.name, s.address, c.name as client_name,
              json_agg(json_build_object('id', t.id, 'name', t.name, 'item_count', jsonb_array_length(t.items)) order by lower(t.name)) as templates
         from sites s join clients c on c.id = s.client_id
         join site_templates st on st.site_id = s.id join templates t on t.id = st.template_id
        where jsonb_array_length(t.items) > 0
        group by s.id, c.name order by lower(c.name), lower(s.name)`)).rows);
  });

  // start: the phone picks the id, so a retried request can't create a duplicate
  r.post('/inspections', inspecting, async (req, res) => {
    const { id, site_id, template_id } = req.body || {};
    if (![id, site_id, template_id].every((x) => UUID.test(x))) throw new BadRequest('id, site and template are required');
    const db = await pool.connect();
    try {
      await db.query('begin');
      const t = (await db.query(
        `select t.* from templates t join site_templates st on st.template_id = t.id
          where t.id = $1 and st.site_id = $2`, [template_id, site_id])).rows[0];
      if (!t) { await db.query('rollback'); throw new BadRequest('That template is not used at this site'); }
      const ins = await db.query(
        `insert into inspections (id, site_id, template_id, template_name, inspector_id, start_gps, started_at, mode)
         values ($1, $2, $3, $4, $5, $6, coalesce($7, now()), $8) on conflict (id) do nothing`,
        [id, site_id, t.id, t.name, req.user.id, gps(req.body.start_gps), when(req.body.started_at),
         req.body.mode === 'before_after' ? 'before_after' : 'check']);
      if (ins.rowCount) {
        await db.query(
          `insert into inspection_items (inspection_id, item_key, position, label, hint)
           select $1, it->>'key', ord::int, it->>'label', coalesce(it->>'hint', '') from jsonb_array_elements($2::jsonb) with ordinality as x(it, ord)`,
          [id, JSON.stringify(t.items)]);
      }
      await db.query('commit');
    } catch (e) { await db.query('rollback').catch(() => {}); throw e; } finally { db.release(); }
    const insp = await load(req, id);
    insp ? res.json(insp) : res.status(409).json({ error: 'Inspection id clash' });
  });

  r.get('/inspections/mine', inspecting, async (req, res) => {
    res.json((await pool.query(
      `select i.id, i.status, i.mode, i.started_at, i.finished_at, i.template_name, s.name as site_name, c.name as client_name,
              (select count(*)::int from photos p where p.inspection_id = i.id) as photo_count
         from inspections i join sites s on s.id = i.site_id join clients c on c.id = s.client_id
        where i.inspector_id = $1 order by i.started_at desc limit 100`, [req.user.id])).rows);
  });

  r.get('/inspections/:id', requireUser(), async (req, res) => {
    const insp = await load(req, req.params.id);
    if (!insp) return res.status(404).json({ error: 'Inspection not found' });
    const full = await inspectionDetail(pool, insp);
    full.photos.forEach((p) => delete p.storage_key);
    res.json(full);
  });

  r.put('/inspections/:id/items/:key', inspecting, async (req, res) => {
    if (!(await loadEditable(req, res))) return;
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 5000) : '';
    const { rowCount } = await pool.query('update inspection_items set note = $3 where inspection_id = $1 and item_key = $2',
      [req.params.id, req.params.key, note]);
    rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'No such item' });
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
    await pool.query(
      `update inspections set status = 'submitted', inspector_sig = $2, end_gps = coalesce($3, end_gps), finished_at = coalesce($4, now())
        where id = $1`, [insp.id, sig, gps(req.body.end_gps), when(req.body.finished_at)]);
    res.json({ ok: true });
  });

  // discard a draft that was never submitted
  r.delete('/inspections/:id', inspecting, async (req, res) => {
    const insp = await loadEditable(req, res); if (!insp) return;
    if (insp.status !== 'draft') throw new BadRequest('Only drafts can be discarded');
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
  console.log('inspections ok');
}
