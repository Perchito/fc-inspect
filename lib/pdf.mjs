// Inspection report PDF (pdfkit, no browser needed). Photos come in as Buffers.
import PDFDocument from 'pdfkit';
import { readFileSync } from 'node:fs';
import { itemNums } from '../public/ui.js';

const RED = '#b42318', GREEN = '#05603a';
const NAVY = '#05101f', BLUE = '#4773a0', MUTED = '#4b5d73', LINE = '#c7d6e8';
const LOGO = readFileSync(new URL('../public/img/fc-logo-white.png', import.meta.url)); // official full badge (white), see README
const MODE = { check: 'Quality Check', before_after: 'Before & After' };

const fmtDay = (d) => new Date(`${String(d).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const fmt = (d) => d ? new Date(d).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
// pdfkit reads JPEG and PNG only
const isImage = (b) => b && b.length > 4 && ((b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x89 && b[1] === 0x50));
const dataUrlBuffer = (u) => (typeof u === 'string' && u.startsWith('data:image/png;base64,') ? Buffer.from(u.split(',')[1], 'base64') : null);

/**
 * @param insp  inspection with items, photos (each with .buffer) and site/client fields
 * @param opts  which parts to print (all on by default): scores, notes, actions (urgent action plans), photos, comments
 * @returns Promise<Buffer>
 */
export const PDF_PARTS = ['scores', 'notes', 'actions', 'photos', 'comments'];
export function reportPdf(insp, opts = {}) {
  const show = Object.fromEntries(PDF_PARTS.map((k) => [k, opts[k] !== false]));
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: `Inspection report — ${insp.site_name}`, Author: 'FC Cleaning Company' } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 20; // keep room for the footer
  const ensure = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

  // header band
  doc.rect(0, 0, doc.page.width, 96).fill(NAVY);
  doc.image(LOGO, left, 12, { height: 72 });
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(22).text('Inspection report', left + 86, 36);
  doc.y = 116;

  // summary
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(16).text(insp.site_name, left, doc.y, { width });
  if (insp.site_address) doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(insp.site_address, { width });
  doc.moveDown(0.6);
  const rows = [
    ['Client', insp.client_name], ['Inspection', `${insp.template_name === 'Quick inspection' ? 'Quick inspection' : MODE[insp.mode] || 'Quality Check'}${insp.template_id ? ` — ${insp.template_name}` : ''}`], // no "No checklist" on the report
    [(insp.contributor_names || []).length ? 'Supervisors' : 'Supervisor', [insp.inspector_name, ...(insp.contributor_names || []).filter((n) => n !== insp.inspector_name)].join(', ')], ['Started', fmt(insp.started_at)], ['Finished', fmt(insp.finished_at)],
    ...(show.scores && avgScore(insp) ? [['Overall score', `${avgScore(insp)} / 10`]] : []),
    ...(insp.approved_at ? [['Approved', `${fmt(insp.approved_at)}${insp.approved_by_name ? ` by ${insp.approved_by_name}` : ''}`]] : []),
  ];
  for (const [k, v] of rows) {
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(MUTED).text(k, left, y, { width: 90 });
    doc.font('Helvetica').fillColor(NAVY).text(v || '—', left + 95, y, { width: width - 95 });
    doc.moveDown(0.25);
  }
  doc.moveDown(0.5);

  // items
  const gap = 10, cellW = (width - gap) / 2, cellH = cellW * 0.75;
  // a missing (or unreadable) photo leaves plain white space: no box, no text
  const photoCell = (p, x, y) => {
    if (!(p && isImage(p.buffer))) return;
    doc.save().roundedRect(x, y, cellW, cellH, 4).clip();
    doc.image(p.buffer, x, y, { fit: [cellW, cellH], align: 'center', valign: 'center' });
    doc.restore();
    if (p.taken_at) doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(fmt(p.taken_at), x, y + cellH + 3, { width: cellW });
    if (capOf(p)) doc.fillColor(NAVY).font('Helvetica').fontSize(10).text(capOf(p), x, y + cellH + 15, { width: cellW });
  };
  const ROW_H = cellH + 18;
  // the note on a photo (quick inspections) prints under it
  const capOf = (p) => (show.notes && p?.caption?.trim()) || '';
  const capH = (p) => (capOf(p) ? doc.font('Helvetica').fontSize(10).heightOfString(capOf(p), { width: cellW }) + 4 : 0);

  const nums = itemNums(insp.items);
  insp.items.forEach((it, n) => {
    const photos = show.photos ? insp.photos.filter((p) => p.item_key === it.item_key) : [];
    const head = it.area && it.area !== insp.items[n - 1]?.area;
    ensure(40 + (head ? 30 : 0) + (photos.length ? ROW_H : 0));
    if (head) {
      doc.moveDown(0.4).fillColor(BLUE).font('Helvetica-Bold').fontSize(15).text(`${nums[n].split('.')[0]}. ${it.area}`, left, doc.y, { width });
      doc.moveDown(0.3);
    }
    doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor(LINE).lineWidth(1).stroke();
    doc.moveDown(0.5);
    const titleY = doc.y, tagged = !!(it.added && insp.template_id); // no-checklist inspections: every item is added
    // an item with a blank name prints no heading: its photos read as one area
    if (it.label?.trim()) {
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(13).text(`${nums[n]}${it.area ? '' : '.'} ${it.label}`, left, titleY, { width: width - 90, continued: tagged });
      if (tagged) doc.font('Helvetica').fontSize(9).fillColor(MUTED).text('  (added on site)');
    }
    if (show.scores && it.score) {
      const after = doc.y;
      doc.fillColor(it.score < 7 ? RED : GREEN).font('Helvetica-Bold').fontSize(13).text(`${it.score} / 10`, left + width - 90, titleY, { width: 90, align: 'right' });
      doc.x = left; doc.y = after;
    }
    doc.x = left; doc.y = it.label?.trim() || (show.scores && it.score) ? Math.max(doc.y, titleY + 17) : titleY; // the smaller "(added on site)" text would otherwise pull the note up
    const note = show.notes && it.note?.trim();
    if (note) doc.font('Helvetica').fontSize(10).fillColor(NAVY).text(note, { width }).moveDown(0.3);
    // urgent action plan for a low score
    const action = show.actions && it.action_what?.trim();
    if (action) {
      const pad = 8, inner = width - pad * 2;
      const head = `Urgent action${it.action_who ? ` · ${it.action_who}` : ''}${it.action_due ? ` · due ${fmtDay(it.action_due)}` : ''}`;
      const done = it.action_done_at ? `Done ${fmt(it.action_done_at)}${it.action_done_by_name ? ` by ${it.action_done_by_name}` : ''}` : '';
      doc.font('Helvetica').fontSize(10);
      const h = pad * 2 + 14 + doc.heightOfString(action, { width: inner }) + (done ? 14 : 0);
      ensure(h + 6);
      const y = doc.y;
      doc.save().roundedRect(left, y, width, h, 4).fill(done ? '#dcfae6' : '#fee4e2').restore();
      doc.font('Helvetica-Bold').fontSize(9).fillColor(done ? GREEN : RED).text(head.toUpperCase(), left + pad, y + pad, { width: inner });
      doc.font('Helvetica').fontSize(10).fillColor(NAVY).text(action, left + pad, y + pad + 14, { width: inner });
      if (done) doc.font('Helvetica-Bold').fontSize(9).fillColor(GREEN).text(done, left + pad, doc.y + 2, { width: inner });
      doc.x = left; doc.y = y + h + 6;
    }
    doc.moveDown(0.3);

    let pairs;
    if (insp.mode === 'before_after') {
      const befores = photos.filter((p) => p.phase !== 'after');
      pairs = befores.map((b) => [b, photos.find((a) => a.phase === 'after' && a.pair_id === b.id)]);
      for (const a of photos.filter((p) => p.phase === 'after' && !befores.some((b) => b.id === p.pair_id))) pairs.push([null, a]);
      if (pairs.length) {
        ensure(14 + ROW_H);
        const y = doc.y;
        doc.font('Helvetica-Bold').fontSize(9).fillColor(BLUE).text('BEFORE', left, y).text('AFTER', left + cellW + gap, y);
        doc.y = y + 14;
      }
    } else {
      pairs = [];
      for (let i = 0; i < photos.length; i += 2) pairs.push([photos[i], photos[i + 1]]);
    }
    for (const [a, b] of pairs) {
      const h = ROW_H + Math.max(capH(a), capH(b));
      ensure(h);
      const y = doc.y;
      photoCell(a, left, y);
      photoCell(b, left + cellW + gap, y);
      doc.x = left; doc.y = y + h;
    }
    doc.moveDown(0.5);
  });

  // comments, oldest first
  const msgs = show.comments ? (insp.comments || []).filter((c) => c.body?.trim()) : [];
  if (msgs.length) {
    ensure(60);
    doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor(LINE).lineWidth(1).stroke().moveDown(0.6);
    doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(15).text('Comments', left, doc.y, { width }).moveDown(0.3);
    for (const c of msgs) {
      doc.font('Helvetica').fontSize(10);
      ensure(30 + doc.heightOfString(c.body, { width }));
      doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED)
        .text(`${c.name || 'User'} · ${fmt(c.created_at)}`.toUpperCase(), left, doc.y, { width });
      doc.font('Helvetica').fontSize(10).fillColor(NAVY).text(c.body.trim(), { width }).moveDown(0.6);
    }
    doc.moveDown(0.4);
  }

  // signatures
  ensure(150);
  doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor(LINE).stroke().moveDown(0.8);
  const sigs = [['Supervisor', insp.submitted_by_name || insp.inspector_name, insp.inspector_sig, insp.finished_at]];
  if (insp.client_sig) sigs.push(['Client sign-off', insp.client_signed_by_name, insp.client_sig, insp.client_signed_at]);
  const y0 = doc.y;
  sigs.forEach(([title, name, sig, at], i) => {
    const x = left + i * (cellW + gap);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(MUTED).text(title, x, y0, { width: cellW });
    const img = dataUrlBuffer(sig);
    if (img) doc.image(img, x, y0 + 16, { fit: [200, 70] });
    doc.font('Helvetica').fontSize(10).fillColor(NAVY).text(`${name || ''} — ${fmt(at)}`, x, y0 + 92, { width: cellW });
  });

  // footer on every page
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(i);
    const keep = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // writing below the margin would otherwise start a new page
    const y = doc.page.height - keep - 4;
    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
      .text(`FC Cleaning Company Ltd · ${insp.site_name} · ${fmt(insp.started_at)}`, left, y, { width: width - 60, lineBreak: false })
      .text(`Page ${i + 1} of ${pages.count}`, left + width - 60, y, { width: 60, align: 'right', lineBreak: false });
    doc.page.margins.bottom = keep;
  }
  doc.end();
  return done;
}

// average item score to one decimal, or null when nothing is scored
export function avgScore(insp) {
  const scores = insp.items.map((i) => i.score).filter(Boolean);
  return scores.length ? (Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10).toFixed(1) : null;
}

export const pdfFilename = (insp) =>
  `FC-Inspection-${String(insp.site_name).replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '')}-${new Date(insp.started_at).toISOString().slice(0, 10)}.pdf`;
