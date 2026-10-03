// Client portal + cleaner view: approved reports, client sign-off and replies.
// Admin replies to the client go through the same comments endpoint.
import { Router } from 'express';
import { BadRequest } from './admin.mjs';
import { loadInspection, SIG_DATA_URL } from './inspections.mjs';
import { sendEmail, emailConfigured } from './mailer.mjs';

export function portalRoutes(pool, requireUser) {
  const r = Router();
  const portal = requireUser('client', 'cleaner');

  // tell every active admin; never blocks or fails the client's action
  async function notifyAdmins(req, insp, subject, text) {
    if (!emailConfigured()) return;
    const { rows } = await pool.query(`select email from users where role = 'admin' and active`);
    if (!rows.length) return;
    const link = `${req.protocol}://${req.get('host')}/#/inspections/${insp.id}`;
    sendEmail({ to: rows.map((u) => u.email).join(', '), subject, text: `${text}\n\nOpen the report: ${link}` })
      .catch((e) => console.error('[notify] email failed', e.message));
  }

  r.get('/portal/inspections', portal, async (req, res) => {
    const mine = req.user.role === 'client'
      ? 's.client_id = $1'
      : 'exists (select 1 from site_cleaners sc where sc.site_id = i.site_id and sc.user_id = $1)';
    res.json((await pool.query(
      `select i.id, i.mode, i.started_at, i.approved_at, i.client_signed_at, i.template_name,
              s.name as site_name, s.address as site_address,
              (select count(*)::int from comments c where c.inspection_id = i.id and c.audience = 'client') as comment_count
         from inspections i join sites s on s.id = i.site_id
        where i.status = 'approved' and ${mine}
        order by i.started_at desc limit 300`, [req.user.role === 'client' ? req.user.client_id : req.user.id])).rows);
  });

  r.post('/portal/inspections/:id/sign', requireUser('client'), async (req, res) => {
    const sig = req.body?.signature;
    if (typeof sig !== 'string' || !SIG_DATA_URL.test(sig) || sig.length > 1_000_000) throw new BadRequest('Please sign first');
    const insp = await loadInspection(pool, req.user, req.params.id);
    if (!insp) return res.status(404).json({ error: 'Report not found' });
    const { rowCount } = await pool.query(
      `update inspections set client_sig = $2, client_signed_by = $3, client_signed_at = now()
        where id = $1 and status = 'approved' and client_signed_at is null`, [insp.id, sig, req.user.id]);
    if (!rowCount) return res.status(409).json({ error: 'This report has already been signed off' });
    notifyAdmins(req, insp, `Signed off: ${insp.site_name}`,
      `${req.user.name} (${insp.client_name}) signed off the inspection report for ${insp.site_name}.`);
    res.json({ ok: true });
  });

  // client <-> admin thread on an approved report
  r.post('/inspections/:id/comments', requireUser('client', 'admin'), async (req, res) => {
    const body = typeof req.body?.body === 'string' ? req.body.body.trim().slice(0, 2000) : '';
    if (!body) throw new BadRequest('Write a message first');
    const insp = await loadInspection(pool, req.user, req.params.id);
    if (!insp) return res.status(404).json({ error: 'Report not found' });
    if (insp.status !== 'approved') throw new BadRequest('Messages to the client are only possible on approved reports');
    const { rows } = await pool.query(
      `insert into comments (inspection_id, user_id, body, audience) values ($1, $2, $3, 'client') returning id, created_at`,
      [insp.id, req.user.id, body]);
    if (req.user.role === 'client') {
      notifyAdmins(req, insp, `Client reply: ${insp.site_name}`,
        `${req.user.name} (${insp.client_name}) replied about the inspection report for ${insp.site_name}:\n\n${body}`);
    }
    res.json({ ok: true, ...rows[0] });
  });

  return r;
}
