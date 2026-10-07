import { sendEmail, emailConfigured } from './mailer.mjs';
import { brandEmail, hi, p, facts, alert, esc } from './emails.mjs';

const ROLE = { admin: 'Admin', inspector: 'Supervisor' };
const fmt = (d) => d ? new Date(d).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtLong = (d) => d ? new Date(d).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const day = (d) => new Date(`${d}T12:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

// Email every active admin about an inspection (one email each, so it can greet them by name).
// title + body (HTML from emails.mjs helpers) make the branded version; text is the plain-text fallback.
// Fire-and-forget: never blocks or fails the caller.
export async function notifyAdmins(pool, req, insp, subject, text, { title = subject, body = p(esc(text)), attachments } = {}) {
  if (!emailConfigured()) return;
  const { rows } = await pool.query(`select email, name from users where role = 'admin' and active`);
  if (!rows.length) return;
  const url = `${req.protocol}://${req.get('host')}`, link = `${url}/#/inspections/${insp.id}`;
  const first = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';
  return Promise.all(rows.map((u) => sendEmail({
    to: u.email, subject, attachments,
    text: `Hi ${first(u.name)},\n\n${text}\n\nOpen it in FC Inspect: ${link}\n\nFC Cleaning Company`,
    html: brandEmail({ url, title, buttonUrl: link, body: hi(first(u.name)) + body }),
  })))
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
  // prospects (quick inspections): low scores come with a comment, not an urgent action plan
  const pro = !!insp.client_prospect;
  const lowLine = (it) => `${it.area ? `${it.area} › ` : ''}${it.label} — ${it.score}/10`;
  const subject = pro ? `Prospect inspection done: ${insp.client_name}` : `${low.length ? `URGENT: ${low.length} low score${low.length === 1 ? '' : 's'} — ` : ''}${type} done: ${insp.site_name} (${insp.client_name})`;
  const text = [
    `Client: ${insp.client_name}`,
    `Site: ${insp.site_name}${insp.site_address ? ` — ${insp.site_address}` : ''}`,
    `Inspection: ${type}${insp.template_id ? ` — ${insp.template_name}` : ''}`,
    `Done by: ${ROLE[by] || 'User'} ${insp.inspector_name}`,
    `Finished: ${fmt(insp.finished_at)}`,
    ...(avg ? [`Overall score: ${avg} / 10`] : []),
    ...(pro && low.length ? ['', `Low scores (${low.length}):`, ...low.map((it) => `• ${lowLine(it)}${it.note?.trim() ? `\n  Comment: ${it.note.trim()}` : ''}`)] : []),
    ...(!pro && low.length ? ['', `URGENT — ${low.length} item${low.length === 1 ? '' : 's'} below ${LOW_SCORE}/10:`,
      ...low.map((it) => `• ${it.area ? `${it.area} › ` : ''}${it.label} — ${it.score}/10\n  Action: ${it.action_what}\n  Who: ${it.action_who} · Deadline: ${it.action_due ? day(it.action_due) : '—'}`)] : []),
    '', 'The full report is attached as a PDF.',
  ].join('\n');
  const b = (x) => `<strong style="color:#05101f">${esc(x)}</strong>`;
  const body = p(`The ${esc(type.toLowerCase())} inspection for ${b(insp.client_name)} at ${b(insp.site_name)} has been completed.`)
    + facts([['Client', insp.client_name], ['Site', insp.site_name], ['Address', insp.site_address?.replace(/\s*\n\s*/g, ', ')],
      ['Inspection', `${type}${insp.template_id ? ` — ${insp.template_name}` : ''}`], ['Completed by', `${ROLE[by] || 'User'} ${insp.inspector_name}`],
      ['Finished', fmtLong(insp.finished_at)], ['Overall score', avg ? `${avg} / 10` : null]])
    + (pro && low.length ? facts([[`Low scores (${low.length})`, { html: low.map((it) => `${esc(lowLine(it))}${it.note?.trim() ? `<br><span style="font-weight:400">${esc(it.note.trim())}</span>` : ''}`).join('<br><br>') }]]) : '')
    + (!pro && low.length ? alert(`<strong>URGENT — ${low.length} item${low.length === 1 ? '' : 's'} below ${LOW_SCORE}/10</strong>${low.map((it) => `<div style="margin-top:12px">
        <strong>${esc(it.area ? `${it.area} › ` : '')}${esc(it.label)} — ${it.score}/10</strong><br>Action: ${esc(it.action_what)}<br>
        Who: ${esc(it.action_who)} · Deadline: ${it.action_due ? esc(day(it.action_due)) : '—'}</div>`).join('')}`) : '')
    + p('The full inspection report is attached as a PDF.');
  const pdf = await pdfFor(pool, insp);
  return notifyAdmins(pool, req, insp, subject, text, { title: `${type} inspection complete`, body,
    attachments: [{ filename: pdfFilename(insp), content: pdf, contentType: 'application/pdf' }] });
}
