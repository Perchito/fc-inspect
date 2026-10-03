import { sendEmail, emailConfigured } from './mailer.mjs';

const ROLE = { admin: 'Admin', inspector: 'Supervisor' };
const fmt = (d) => d ? new Date(d).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const day = (d) => new Date(`${d}T12:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

// Email every active admin about an inspection. Fire-and-forget: never blocks or fails the caller.
export async function notifyAdmins(pool, req, insp, subject, text, attachments) {
  if (!emailConfigured()) return;
  const { rows } = await pool.query(`select email from users where role = 'admin' and active`);
  if (!rows.length) return;
  const link = `${req.protocol}://${req.get('host')}/#/inspections/${insp.id}`;
  return sendEmail({ to: rows.map((u) => u.email).join(', '), subject, text: `${text}\n\nOpen it in FC Inspect: ${link}`, attachments })
    .then(() => console.log(`[notify] emailed ${rows.length} admin(s): ${subject}`))
    .catch((e) => console.error('[notify] email failed', e.message));
}

// "Inspection done" email to the admins with the full PDF (notes included — admins only).
// Marked URGENT when any item scored below LOW_SCORE.
export async function emailInspectionDone(pool, req, id) {
  // imported lazily: these modules import each other
  const { loadInspection, inspectionDetail, LOW_SCORE } = await import('./inspections.mjs');
  const { pdfFor } = await import('./review.mjs');
  const { pdfFilename, avgScore } = await import('./pdf.mjs');
  const insp = await loadInspection(pool, { role: 'admin' }, id);
  if (!insp) return;
  const full = await inspectionDetail(pool, insp);
  const by = (await pool.query('select role from users where id = $1', [insp.inspector_id])).rows[0]?.role;
  const type = insp.mode === 'check' ? 'Quality check' : insp.template_id ? 'Before & after' : 'Before & after (no checklist)';
  const low = full.items.filter((it) => it.score && it.score < LOW_SCORE);
  const avg = avgScore(full);
  const subject = `${low.length ? `URGENT: ${low.length} low score${low.length === 1 ? '' : 's'} — ` : ''}${type} done: ${insp.site_name} (${insp.client_name})`;
  const text = [
    `Client: ${insp.client_name}`,
    `Site: ${insp.site_name}${insp.site_address ? ` — ${insp.site_address}` : ''}`,
    `Inspection: ${type}${insp.template_id ? ` — ${insp.template_name}` : ''}`,
    `Done by: ${ROLE[by] || 'User'} ${insp.inspector_name}`,
    `Finished: ${fmt(insp.finished_at)}`,
    ...(avg ? [`Overall score: ${avg} / 10`] : []),
    ...(low.length ? ['', `URGENT — ${low.length} item${low.length === 1 ? '' : 's'} below ${LOW_SCORE}/10:`,
      ...low.map((it) => `• ${it.label} — ${it.score}/10\n  Action: ${it.action_what}\n  Who: ${it.action_who} · Deadline: ${it.action_due ? day(it.action_due) : '—'}`)] : []),
    '', 'The full report is attached as a PDF.',
  ].join('\n');
  const pdf = await pdfFor(pool, insp);
  return notifyAdmins(pool, req, insp, subject, text, [{ filename: pdfFilename(insp), content: pdf, contentType: 'application/pdf' }]);
}
