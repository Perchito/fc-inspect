import { sendEmail, emailConfigured } from './mailer.mjs';

// Email every active admin about an inspection. Fire-and-forget: never blocks or fails the caller.
export async function notifyAdmins(pool, req, insp, subject, text) {
  if (!emailConfigured()) return;
  const { rows } = await pool.query(`select email from users where role = 'admin' and active`);
  if (!rows.length) return;
  const link = `${req.protocol}://${req.get('host')}/#/inspections/${insp.id}`;
  sendEmail({ to: rows.map((u) => u.email).join(', '), subject, text: `${text}\n\nOpen the report: ${link}` })
    .catch((e) => console.error('[notify] email failed', e.message));
}
