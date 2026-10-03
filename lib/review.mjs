// Admin review: inbox, edit notes/photos, approve or send back, email the report.
// Mounted at /api/admin behind requireUser('admin').
import { Router } from 'express';
import { BadRequest } from './admin.mjs';
import { loadInspection, inspectionDetail, itemUpdate, LOW_SCORE } from './inspections.mjs';
import { storage } from './storage.mjs';
import { reportPdf, pdfFilename } from './pdf.mjs';
import { sendEmail, emailConfigured } from './mailer.mjs';

const STATUSES = ['draft', 'submitted', 'returned', 'approved'];
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

// full inspection with every photo's bytes, ready for the PDF
export async function pdfFor(pool, insp) {
  const full = await inspectionDetail(pool, insp);
  await Promise.all(full.photos.map(async (p) => {
    const r = await storage.get(p.storage_key).catch(() => null);
    p.buffer = r?.ok ? Buffer.from(await r.arrayBuffer()) : null;
  }));
  return reportPdf(full);
}

export function parseRecipients(v) {
  const list = String(v || '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new BadRequest('Add at least one email address');
  if (list.length > 5) throw new BadRequest('Five recipients at most');
  const bad = list.find((e) => !EMAIL.test(e));
  if (bad) throw new BadRequest(`"${bad}" doesn't look like an email address`);
  return list;
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

  r.get('/email-status', (req, res) => res.json({ configured: emailConfigured() }));

  r.get('/inspections', async (req, res) => {
    const status = STATUSES.includes(req.query.status) ? req.query.status : null;
    res.json((await pool.query(
      `select i.id, i.status, i.mode, i.started_at, i.finished_at, i.approved_at, i.emailed_at, i.client_signed_at,
              i.template_name, s.name as site_name, c.name as client_name, u.name as inspector_name,
              (select count(*)::int from photos p where p.inspection_id = i.id) as photo_count,
              (select round(avg(score), 1) from inspection_items ii where ii.inspection_id = i.id) as avg_score,
              (select count(*)::int from inspection_items ii where ii.inspection_id = i.id and ii.score < ${LOW_SCORE}) as low_count,
              (select count(*)::int from inspection_items ii where ii.inspection_id = i.id and ii.score < ${LOW_SCORE} and ii.action_done_at is null) as open_actions
         from inspections i join sites s on s.id = i.site_id join clients c on c.id = s.client_id
         join users u on u.id = i.inspector_id
        where ($1::text is null or i.status = $1)
        order by coalesce(i.finished_at, i.started_at) desc limit 300`, [status])).rows);
  });

  // admin tidy-ups before approving
  r.put('/inspections/:id/items/:key', async (req, res) => {
    const insp = await loadIn(req, res, ['submitted']); if (!insp) return;
    const set = itemUpdate(req.body || {}, insp.mode), keys = Object.keys(set);
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

  // manual "Email to client" with the PDF attached — nothing is ever sent automatically
  r.post('/inspections/:id/email', async (req, res) => {
    const to = parseRecipients(req.body?.to);
    const subject = String(req.body?.subject || '').trim().slice(0, 200);
    const text = String(req.body?.message || '').slice(0, 5000);
    if (!subject) throw new BadRequest('Add a subject');
    const insp = await loadIn(req, res, ['approved']); if (!insp) return;
    if (insp.mode !== 'check') throw new BadRequest('Before & after inspections are internal and are not sent to clients');
    const pdf = await pdfFor(pool, insp);
    try {
      await sendEmail({ to: to.join(', '), subject, text, attachments: [{ filename: pdfFilename(insp), content: pdf, contentType: 'application/pdf' }] });
    } catch (e) {
      console.error('[email] send failed', e.message);
      return res.status(502).json({ error: `Email not sent: ${e.message}` });
    }
    const row = await one(`update inspections set emailed_at = now(), emailed_to = $2 where id = $1 returning emailed_at, emailed_to`, [insp.id, to.join(', ')]);
    res.json({ ok: true, ...row });
  });

  // urgent action plans (items scored below 7) across all submitted/approved inspections
  r.get('/actions', async (req, res) => {
    const done = req.query.done === '1';
    res.json((await pool.query(
      `select ii.inspection_id, ii.item_key, ii.label, ii.score, ii.action_what, ii.action_who,
              to_char(ii.action_due, 'YYYY-MM-DD') as action_due, ii.action_due < current_date as overdue,
              ii.action_done_at, du.name as action_done_by_name,
              i.status, i.finished_at, s.name as site_name, c.name as client_name, u.name as inspector_name
         from inspection_items ii join inspections i on i.id = ii.inspection_id
         join sites s on s.id = i.site_id join clients c on c.id = s.client_id join users u on u.id = i.inspector_id
         left join users du on du.id = ii.action_done_by
        where ii.score < ${LOW_SCORE} and i.status in ('submitted', 'approved')
          and (ii.action_done_at is not null) = $1
        order by ${done ? 'ii.action_done_at desc' : 'ii.action_due nulls last, i.finished_at'} limit 300`, [done])).rows);
  });
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

if (import.meta.url === `file://${process.argv[1]}`) {
  console.assert(parseRecipients('a@b.co, c@d.org').length === 2, 'two recipients');
  for (const bad of ['', 'nope', 'a@b.co,x', Array(6).fill('a@b.co').join(',')]) {
    let threw = false; try { parseRecipients(bad); } catch { threw = true; }
    console.assert(threw, `rejects ${bad}`);
  }
  console.log('review ok');
}
