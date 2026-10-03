// Inspection report PDF (pdfkit, no browser needed). Photos come in as Buffers.
import PDFDocument from 'pdfkit';
import { readFileSync } from 'node:fs';

const RED = '#b42318', GREEN = '#05603a';
const NAVY = '#05101f', BLUE = '#4773a0', MUTED = '#4b5d73', LINE = '#c7d6e8', PALE = '#e6edf6';
const LOGO = readFileSync(new URL('../public/img/fc-logo-white-icon.png', import.meta.url));
const MODE = { check: 'Quality check', before_after: 'Before & after' };

const fmt = (d) => d ? new Date(d).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const gpsText = (g) => g ? `${g.lat.toFixed(5)}, ${g.lng.toFixed(5)}${g.accuracy != null ? ` (±${g.accuracy} m)` : ''}` : 'Not recorded';
// pdfkit reads JPEG and PNG only
const isImage = (b) => b && b.length > 4 && ((b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x89 && b[1] === 0x50));
const dataUrlBuffer = (u) => (typeof u === 'string' && u.startsWith('data:image/png;base64,') ? Buffer.from(u.split(',')[1], 'base64') : null);

/**
 * @param insp  inspection with items, photos (each with .buffer) and site/client fields
 * @param notes include the supervisor's notes (false = scores and photos only)
 * @returns Promise<Buffer>
 */
export function reportPdf(insp, { notes = true } = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: `Inspection report — ${insp.site_name}`, Author: 'FC Cleaning Company' } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 20; // keep room for the footer
  const ensure = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

  // header band
  doc.rect(0, 0, doc.page.width, 90).fill(NAVY);
  doc.image(LOGO, left, 22, { height: 46 });
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(20).text('Inspection report', left + 62, 28);
  doc.font('Helvetica').fontSize(10).fillColor('#9db6d3').text('FC Cleaning Company Ltd', left + 62, 54);
  doc.y = 110;

  // summary
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(16).text(insp.site_name, left, doc.y, { width });
  if (insp.site_address) doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(insp.site_address, { width });
  doc.moveDown(0.6);
  const rows = [
    ['Client', insp.client_name], ['Inspection', `${MODE[insp.mode] || 'Quality check'} — ${insp.template_name}`],
    ['Supervisor', insp.inspector_name], ['Started', fmt(insp.started_at)], ['Finished', fmt(insp.finished_at)],
    ['Location', gpsText(insp.start_gps)],
    ...(avgScore(insp) ? [['Overall score', `${avgScore(insp)} / 10`]] : []),
    ...(insp.approved_at ? [['Approved', `${fmt(insp.approved_at)}${insp.approved_by_name ? ` by ${insp.approved_by_name}` : ''}`]] : [['Status', 'Not yet approved']]),
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
  const photoCell = (p, x, y, label) => {
    if (p && isImage(p.buffer)) {
      doc.save().roundedRect(x, y, cellW, cellH, 4).clip();
      doc.rect(x, y, cellW, cellH).fill(PALE);
      doc.image(p.buffer, x, y, { fit: [cellW, cellH], align: 'center', valign: 'center' });
      doc.restore();
    } else {
      doc.roundedRect(x, y, cellW, cellH, 4).fill(PALE);
      doc.fillColor(MUTED).font('Helvetica').fontSize(10).text(p ? 'Photo unavailable' : label, x, y + cellH / 2 - 5, { width: cellW, align: 'center' });
    }
    if (p?.taken_at) doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(fmt(p.taken_at), x, y + cellH + 3, { width: cellW });
  };
  const ROW_H = cellH + 18;

  insp.items.forEach((it, n) => {
    const photos = insp.photos.filter((p) => p.item_key === it.item_key);
    ensure(40 + (photos.length ? ROW_H : 0));
    doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor(LINE).lineWidth(1).stroke();
    doc.moveDown(0.5);
    const titleY = doc.y, tagged = !!(it.added && insp.template_id); // no-checklist inspections: every item is added
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(13).text(`${n + 1}. ${it.label}`, left, titleY, { width: width - 90, continued: tagged });
    if (tagged) doc.font('Helvetica').fontSize(9).fillColor(MUTED).text('  (added on site)');
    if (it.score) {
      const after = doc.y;
      doc.fillColor(it.score < 7 ? RED : GREEN).font('Helvetica-Bold').fontSize(13).text(`${it.score} / 10`, left + width - 90, titleY, { width: 90, align: 'right' });
      doc.x = left; doc.y = after;
    }
    doc.x = left; doc.y = Math.max(doc.y, titleY + 17); // the smaller "(added on site)" text would otherwise pull the note up
    const note = notes && it.note?.trim();
    if (note) doc.font('Helvetica').fontSize(10).fillColor(NAVY).text(note, { width }).moveDown(0.3);
    else if (!photos.length) doc.font('Helvetica-Oblique').fontSize(10).fillColor(MUTED).text(notes ? 'No photos or notes.' : 'No photos.', { width });
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
      ensure(ROW_H);
      const y = doc.y;
      photoCell(a, left, y, 'No before photo');
      if (b || insp.mode === 'before_after') photoCell(b, left + cellW + gap, y, 'No after photo');
      doc.y = y + ROW_H;
    }
    doc.moveDown(0.5);
  });

  // signatures
  ensure(150);
  doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor(LINE).stroke().moveDown(0.8);
  const sigs = [['Supervisor', insp.inspector_name, insp.inspector_sig, insp.finished_at]];
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
