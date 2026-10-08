// Admin review: inbox, edit notes/photos, approve or send back. (No emails to clients for now.)
// Mounted at /api/admin behind requireUser('admin').
import { Router } from 'express';
import sharp from 'sharp';
import { BadRequest } from './admin.mjs';
import { loadInspection, inspectionDetail, itemUpdate, renameArea, LOW_SCORE, listActions, listInspections } from './inspections.mjs';
import { storage } from './storage.mjs';
import { notifyAssignments } from './actions.mjs';
import { reportPdf } from './pdf.mjs';


// full inspection with every photo's bytes, ready for the PDF
// every PDF is built from the full inspection; opts (the toggles) decide what is printed
// permanently remove deleted inspections (one by id, or all deleted more than 30 days ago) and their photos
export async function purgeDeleted(pool, { id = null } = {}) {
  if (id && !/^[0-9a-f-]{36}$/i.test(id)) return 0;
  const { rows } = await pool.query(
    `select i.id, coalesce(array_agg(p.storage_key) filter (where p.storage_key is not null), '{}') as keys
       from inspections i left join photos p on p.inspection_id = i.id
      where i.deleted_at is not null and ($1::uuid is null and i.deleted_at < now() - interval '30 days' or i.id = $1)
      group by i.id`, [id]);
  for (const r of rows) {
    await pool.query('delete from inspections where id = $1', [r.id]);
    await Promise.all(r.keys.map((k) => storage.del(k).catch((e) => console.warn('[photos] delete failed', e.message))));
  }
  if (rows.length) console.log(`[purge] removed ${rows.length} deleted inspection(s) for good`);
  return rows.length;
}

export async function pdfFor(pool, insp, opts) {
  const full = await inspectionDetail(pool, insp);
  await Promise.all(full.photos.map(async (p) => {
    const r = await storage.get(p.storage_key).catch(() => null);
    const raw = r?.ok ? Buffer.from(await r.arrayBuffer()) : null;
    // shrink for the PDF only (originals stay full size): ~1000px is sharp at the printed size and keeps reports small
    p.buffer = raw && await sharp(raw).rotate().resize(1000, 1000, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 72, mozjpeg: true }).toBuffer().catch(() => raw);
  }));
  return reportPdf(full, opts);
}

export function reviewRoutes(pool) {
  const r = Router();
  const one = async (sql, args) => (await pool.query(sql, args)).rows[0];

  // load as admin and check the status allows the action
  async function loadIn(req, res, statuses) {
    const insp = await loadInspection(pool, req.user, req.params.id);
    if (!insp) { res.status(404).json({ error: 'Inspection not found' }); return null; }
    if (!statuses.includes(insp.status)) {
      res.status(409).json({ error: `Not possible while the inspection is ${insp.status}` });
      return null;
    }
    return insp;
  }

  r.get('/inspections', async (req, res) => res.json(await listInspections(pool, req.query.status)));

  // admin tidy-ups before approving
  r.put('/inspections/:id/items/:key', async (req, res) => {
    const insp = await loadIn(req, res, ['submitted']); if (!insp) return;
    const set = itemUpdate(req.body || {});
    const { rows: [cur] } = await pool.query('select action_user_id from inspection_items where inspection_id = $1 and item_key = $2', [req.params.id, req.params.key]);
    if ('action_user_id' in set && cur && (cur.action_user_id || null) !== set.action_user_id) set.action_notified = false;
    const keys = Object.keys(set);
    if (!keys.length) return res.json({ ok: true });
    const { rowCount } = await pool.query(
      `update inspection_items set ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')} where inspection_id = $1 and item_key = $2`,
      [req.params.id, req.params.key, ...keys.map((k) => set[k])]);
    if (rowCount && set.action_notified === false) await notifyAssignments(pool, req, insp.id);
    rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'No such item' });
  });
  r.delete('/inspections/:id/photos/:pid', async (req, res) => {
    const insp = await loadIn(req, res, ['submitted']); if (!insp) return;
    const { rows } = await pool.query('delete from photos where (id = $1 or pair_id = $1) and inspection_id = $2 returning storage_key',
      [req.params.pid, insp.id]);
    await Promise.all(rows.map((p) => storage.del(p.storage_key).catch((e) => console.warn('[photos] delete failed', e.message))));
    res.json({ ok: true, deleted: rows.length });
  });

  r.post('/inspections/:id/approve', async (req, res) => {
    if (!(await loadIn(req, res, ['submitted']))) return;
    await pool.query(`update inspections set status = 'approved', approved_by = $2, approved_at = now() where id = $1`, [req.params.id, req.user.id]);
    res.json({ ok: true });
  });

  // back to the inspector with a reason; they fix it on their phone and resubmit
  r.post('/inspections/:id/return', async (req, res) => {
    const body = typeof req.body?.comment === 'string' ? req.body.comment.trim().slice(0, 2000) : '';
    if (!body) throw new BadRequest('Say what needs changing');
    if (!(await loadIn(req, res, ['submitted']))) return;
    await pool.query(`update inspections set status = 'returned' where id = $1`, [req.params.id]);
    await pool.query('insert into comments (inspection_id, user_id, body) values ($1, $2, $3)', [req.params.id, req.user.id, body]);
    res.json({ ok: true });
  });

  // undo an approval (e.g. approved by mistake); not once the client has signed it off
  // delete = move to Recently deleted (kept 30 days, then purged by purgeDeleted)
  r.delete('/inspections/:id', async (req, res) => {
    const insp = await loadInspection(pool, req.user, req.params.id);
    if (!insp) return res.status(404).json({ error: 'Inspection not found' });
    await pool.query('update inspections set deleted_at = now(), deleted_by = $2 where id = $1', [insp.id, req.user.id]);
    console.log(`[admin] ${req.user.email} deleted inspection ${insp.id} (${insp.site_name}, ${insp.status})`);
    res.json({ ok: true });
  });
  r.get('/deleted', async (req, res) => {
    res.json((await pool.query(
      `select i.id, i.status, i.mode, i.template_id, i.template_name, i.started_at, i.deleted_at, s.name as site_name, c.name as client_name,
              u.name as inspector_name, du.name as deleted_by_name, (select count(*)::int from photos p where p.inspection_id = i.id) as photo_count
         from inspections i join sites s on s.id = i.site_id join clients c on c.id = s.client_id join users u on u.id = i.inspector_id
         left join users du on du.id = i.deleted_by
        where i.deleted_at is not null order by i.deleted_at desc`)).rows);
  });
  r.post('/deleted/:id/restore', async (req, res) => {
    const { rowCount } = await pool.query('update inspections set deleted_at = null, deleted_by = null where id = $1 and deleted_at is not null', [req.params.id]);
    rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Not in Recently deleted' });
  });
  r.delete('/deleted/:id', async (req, res) => {
    const n = await purgeDeleted(pool, { id: req.params.id });
    n ? res.json({ ok: true }) : res.status(404).json({ error: 'Not in Recently deleted' });
  });

  // admin tidy-up: rename an area while reviewing
  r.post('/inspections/:id/areas', async (req, res) => {
    const insp = await loadIn(req, res, ['submitted']); if (!insp) return;
    res.json(await renameArea(pool, insp.id, req.body));
  });

  r.post('/inspections/:id/unapprove', async (req, res) => {
    const insp = await loadIn(req, res, ['approved']); if (!insp) return;
    if (insp.client_signed_at) throw new BadRequest('The client has already signed this off');
    await pool.query(`update inspections set status = 'submitted', approved_by = null, approved_at = null where id = $1`, [insp.id]);
    res.json({ ok: true });
  });


  // urgent action plans (items scored below 7) across all submitted/approved inspections
  r.get('/actions', async (req, res) => res.json(await listActions(pool, { done: req.query.done === '1' })));
  r.post('/inspections/:id/items/:key/action-done', async (req, res) => {
    const done = req.body?.done !== false;
    const { rowCount } = await pool.query(
      `update inspection_items set action_done_at = ${done ? 'now()' : 'null'}, action_done_by = ${done ? '$3' : 'null'}
        where inspection_id = $1 and item_key = $2 and score < ${LOW_SCORE}`,
      done ? [req.params.id, req.params.key, req.user.id] : [req.params.id, req.params.key]);
    rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'No action plan on that item' });
  });

  return r;
}
