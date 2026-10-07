// Admin review: inbox, edit notes/photos, approve or send back. (No emails to clients for now.)
// Mounted at /api/admin behind requireUser('admin').
import { Router } from 'express';
import sharp from 'sharp';
import { BadRequest } from './admin.mjs';
import { loadInspection, inspectionDetail, itemUpdate, LOW_SCORE, PROGRESS_SQL, listActions } from './inspections.mjs';
import { storage } from './storage.mjs';
import { reportPdf } from './pdf.mjs';

const STATUSES = ['draft', 'submitted', 'returned', 'approved'];

// full inspection with every photo's bytes, ready for the PDF
// role decides what the PDF may show: clients get no action plans or internal messages
export async function pdfFor(pool, insp, opts, role = 'admin') {
  const full = await inspectionDetail(pool, insp, role);
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

  r.get('/inspections', async (req, res) => {
    const status = STATUSES.includes(req.query.status) ? req.query.status : null;
    res.json((await pool.query(
      `select i.id, i.status, i.mode, i.template_id, i.inspector_id, i.started_at, i.finished_at, i.approved_at, i.emailed_at, i.client_signed_at,
              i.template_name, s.name as site_name, c.name as client_name, u.name as inspector_name,
              (select count(*)::int from photos p where p.inspection_id = i.id) as photo_count,
              ${PROGRESS_SQL},
              (select count(*)::int from inspection_items ii where ii.inspection_id = i.id and ii.score < ${LOW_SCORE} and ii.action_done_at is null) as open_actions
         from inspections i join sites s on s.id = i.site_id join clients c on c.id = s.client_id
         join users u on u.id = i.inspector_id
        where ($1::text is null or i.status = $1)
        order by coalesce(i.finished_at, i.started_at) desc limit 300`, [status])).rows);
  });

  // admin tidy-ups before approving
  r.put('/inspections/:id/items/:key', async (req, res) => {
    const insp = await loadIn(req, res, ['submitted']); if (!insp) return;
    const set = itemUpdate(req.body || {}), keys = Object.keys(set);
    if (!keys.length) return res.json({ ok: true });
    const { rowCount } = await pool.query(
      `update inspection_items set ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')} where inspection_id = $1 and item_key = $2`,
      [req.params.id, req.params.key, ...keys.map((k) => set[k])]);
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
