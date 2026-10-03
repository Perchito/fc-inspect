// Inspection report screen. Admins review it (tidy notes/photos, approve or send back, PDF, mark
// actions done); supervisors see the same report read-only once it has been submitted.
import {
  esc, icon, post, put, del, toast, sheet, confirmSheet, viewer, statusBadge, scoreBadge, modeLabel, fmtDateTime,
  relDay, dueText, LOW_SCORE,
} from './ui.js?v=__V__';

const withNotes = () => { try { return localStorage.getItem('fci-pdf-notes') !== '0'; } catch { return true; } };
const avg = (items) => { const s = items.map((i) => i.score).filter(Boolean); return s.length ? +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1) : null; };

// photos of one item: a grid, or before/after pairs (server photos only)
export function itemPhotosHtml(insp, it) {
  const ps = insp.photos.filter((p) => p.item_key === it.item_key);
  if (!ps.length) return '<p class="muted small">No photos</p>';
  const fig = (p, label) => p ? `<figure class="ph"><button class="ph-open" data-view="${p.id}" aria-label="View ${label}">
    <img src="/api/photos/${p.id}" alt="${label}" loading="lazy" decoding="async"></button></figure>` : '<div class="after-slot muted">—</div>';
  if (insp.mode !== 'before_after') return `<div class="ph-grid">${ps.map((p) => fig(p, 'photo')).join('')}</div>`;
  const befores = ps.filter((p) => p.phase !== 'after');
  const orphans = ps.filter((p) => p.phase === 'after' && !befores.some((b) => b.id === p.pair_id));
  const head = '<div class="pair-label"><span>Before</span><span>After</span></div>';
  return `<div class="pairs">${befores.map((b) => `<div class="pair">${head}${fig(b, 'before photo')}${fig(ps.find((a) => a.phase === 'after' && a.pair_id === b.id), 'after photo')}</div>`).join('')}
    ${orphans.map((a) => `<div class="pair">${head}${fig(null)}${fig(a, 'after photo')}</div>`).join('')}</div>`;
}
// viewer order for an item: grid order, or before/after pairs
function viewList(insp, it) {
  const ps = insp.photos.filter((p) => p.item_key === it.item_key);
  if (insp.mode !== 'before_after') return ps.map((p) => ({ ...p, src: `/api/photos/${p.id}`, label: 'Photo' }));
  const befores = ps.filter((p) => p.phase !== 'after');
  return [...befores.flatMap((b) => [b, ...ps.filter((a) => a.pair_id === b.id)]), ...ps.filter((a) => a.phase === 'after' && !befores.some((b) => b.id === a.pair_id))]
    .map((p) => ({ ...p, src: `/api/photos/${p.id}`, label: p.phase === 'after' ? 'After' : 'Before' }));
}

export function actionPlanHtml(it, { canToggle = false, inspectionId = '' } = {}) {
  if (!(it.score && it.score < LOW_SCORE && it.action_what)) return '';
  const overdue = !it.action_done_at && it.action_due && it.action_due < new Date().toISOString().slice(0, 10);
  return `<div class="action-card ${it.action_done_at ? 'done' : overdue ? 'overdue' : ''}">
    <div class="row-between"><strong>${icon(it.action_done_at ? 'check' : 'alert')} ${it.action_done_at ? 'Action completed' : 'Urgent action'}</strong>
      <span class="badge ${it.action_done_at ? 'green' : overdue ? 'red' : 'amber'}">${it.action_done_at ? 'Done' : esc(dueText(it.action_due))}</span></div>
    <p>${esc(it.action_what)}</p>
    <p class="small muted">Assigned to ${esc(it.action_who)}${it.action_done_at ? ` · completed ${esc(fmtDateTime(it.action_done_at))}${it.action_done_by_name ? ` by ${esc(it.action_done_by_name)}` : ''}` : ''}</p>
    ${canToggle ? `<button class="btn ${it.action_done_at ? '' : 'primary'} block" data-done="${esc(it.item_key)}" data-insp="${inspectionId}" data-state="${it.action_done_at ? '1' : '0'}">
      ${it.action_done_at ? 'Reopen action' : `${icon('check')} Mark as complete`}</button>` : ''}
  </div>`;
}
export function bindActionToggles(view, reload) {
  view.querySelectorAll('[data-done]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await post(`/admin/inspections/${b.dataset.insp}/items/${encodeURIComponent(b.dataset.done)}/action-done`, { done: b.dataset.state === '0' });
      toast(b.dataset.state === '0' ? 'Action completed' : 'Action reopened'); reload();
    } catch (e) { toast(e.message, { error: true }); b.disabled = false; }
  }));
}

export function reportViews({ shell, me }) {
  async function report(insp, reload) {
    const admin = me().role === 'admin';
    const id = insp.id, editing = admin && insp.status === 'submitted', ba = insp.mode === 'before_after';
    const internal = insp.comments.filter((c) => c.audience !== 'client');
    const score = avg(insp.items), low = insp.items.filter((it) => it.score && it.score < LOW_SCORE).length;
    const maps = (g) => g ? `<a href="https://www.google.com/maps?q=${g.lat},${g.lng}" target="_blank" rel="noopener">${icon('pin', 'inline')} Map</a> <span class="muted small">±${g.accuracy ?? '?'} m</span>` : '<span class="muted">not recorded</span>';
    const view = shell({ title: insp.template_id ? insp.template_name : modeLabel(insp), subtitle: insp.site_name, back: '#/inspections', focus: !admin, body: `
      <section class="card summary-card">
        <div class="row-between">${statusBadge(insp.status)}${score ? scoreBadge(score) : ''}</div>
        <h2>${esc(insp.site_name)}</h2>
        <p class="muted">${esc(insp.client_name)}${insp.site_address ? ` · ${esc(insp.site_address)}` : ''}</p>
        <dl class="facts">
          <dt>Inspection</dt><dd>${esc(modeLabel(insp))}${insp.template_id ? ` · ${esc(insp.template_name)}` : ''}</dd>
          <dt>Supervisor</dt><dd>${esc(insp.inspector_name)}</dd>
          <dt>Started</dt><dd>${esc(fmtDateTime(insp.started_at))} · ${maps(insp.start_gps)}</dd>
          <dt>Finished</dt><dd>${esc(fmtDateTime(insp.finished_at))} · ${maps(insp.end_gps)}</dd>
          ${low ? `<dt>Issues</dt><dd><span class="badge red">${low} below ${LOW_SCORE}/10</span></dd>` : ''}
          ${insp.approved_at ? `<dt>Approved</dt><dd>${esc(fmtDateTime(insp.approved_at))} by ${esc(insp.approved_by_name)}</dd>` : ''}
          ${ba ? '<dt>Visibility</dt><dd>Internal</dd>' : ''}
        </dl>
      </section>
      ${internal.length ? `<section class="card warn-card"><h3>Notes to the supervisor</h3>${internal.map((c) =>
        `<p><strong>${esc(c.name)}</strong> <span class="muted small">${esc(relDay(c.created_at))}</span><br>${esc(c.body)}</p>`).join('')}</section>` : ''}
      ${editing ? '<p class="note-box">You can tidy up notes and delete photos before approving.</p>' : ''}
      ${insp.items.map((it, n) => `
        <section class="card report-item">
          <div class="row-between"><h3><span class="muted">${n + 1}.</span> ${esc(it.label)}${it.added && insp.template_id ? ' <span class="badge neutral">Added on site</span>' : ''}</h3>${scoreBadge(it.score)}</div>
          ${actionPlanHtml(it, { canToggle: admin && insp.status !== 'draft', inspectionId: id })}
          ${editing ? `<label class="field"><span>Notes</span><textarea data-note="${esc(it.item_key)}" rows="2" placeholder="No notes">${esc(it.note)}</textarea></label>`
            : it.note ? `<p class="note">${esc(it.note)}</p>` : ''}
          <div data-photos="${esc(it.item_key)}">${itemPhotosHtml(insp, it)}</div>
        </section>`).join('')}
      ${insp.inspector_sig ? `<section class="card"><h3>Supervisor signature</h3><img class="sig-img" src="${esc(insp.inspector_sig)}" alt="Signature of ${esc(insp.inspector_name)}">
        <p class="small muted">${esc(insp.inspector_name)} · ${esc(fmtDateTime(insp.finished_at))}</p></section>` : ''}
      <section class="card">
        <div class="row-between"><h3>PDF report</h3>
          <label class="switch"><input type="checkbox" id="with-notes" ${withNotes() ? 'checked' : ''}><span>Include notes</span></label></div>
        <div class="btn-row">
          <a class="btn" data-pdf href="/api/inspections/${id}/pdf" target="_blank" rel="noopener">${icon('file')} View PDF</a>
          <a class="btn" data-pdf data-download href="/api/inspections/${id}/pdf?download=1">${icon('down')} Download</a>
        </div>
      </section>
      ${admin && insp.status === 'approved' && !insp.client_signed_at ? '<button class="btn ghost-danger block" id="unapprove">Move back to “To review”</button>' : ''}
      ${editing ? `<div class="bottom-bar two"><button class="btn lg" id="return">Send back</button>
        <button class="btn primary lg" id="approve">${icon('check')} Approve</button></div>` : ''}` });

    // PDF links follow the notes switch; remembered on this device
    const $notes = view.querySelector('#with-notes');
    const pdfLinks = () => view.querySelectorAll('[data-pdf]').forEach((a) => {
      const q = new URLSearchParams({ ...('download' in a.dataset ? { download: 1 } : {}), ...($notes.checked ? {} : { notes: 0 }) });
      a.href = `/api/inspections/${id}/pdf${q.size ? `?${q}` : ''}`;
    });
    $notes.addEventListener('change', () => { try { localStorage.setItem('fci-pdf-notes', $notes.checked ? '1' : '0'); } catch {} pdfLinks(); });
    pdfLinks();

    view.querySelectorAll('[data-photos]').forEach((box) => box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-view]'); if (!b) return;
      const it = insp.items.find((x) => x.item_key === box.dataset.photos), list = viewList(insp, it);
      viewer(list, Math.max(0, list.findIndex((p) => p.id === b.dataset.view)), editing ? {
        onDelete: async (k) => {
          const p = list[k], paired = p.phase !== 'after' && insp.photos.some((a) => a.pair_id === p.id);
          if (!(await confirmSheet(paired ? 'Delete this before photo and its after photo?' : 'Delete this photo?'))) return false;
          try { await del(`/admin/inspections/${id}/photos/${p.id}`); toast('Photo deleted'); reload(); return true; }
          catch (err) { toast(err.message, { error: true }); return false; }
        },
      } : {});
    }));
    view.querySelectorAll('[data-note]').forEach((ta) => ta.addEventListener('change', async () => {
      try { await put(`/admin/inspections/${id}/items/${encodeURIComponent(ta.dataset.note)}`, { note: ta.value }); toast('Note saved'); }
      catch (e) { toast(e.message, { error: true }); }
    }));
    bindActionToggles(view, reload);
    view.querySelector('#approve')?.addEventListener('click', async () => {
      if (!(await confirmSheet('Approve this inspection?', { text: 'It moves to Completed and its PDF is ready to send to the client.', okLabel: 'Approve', danger: false }))) return;
      try { await post(`/admin/inspections/${id}/approve`); toast('Inspection approved'); reload(); } catch (e) { toast(e.message, { error: true }); }
    });
    view.querySelector('#return')?.addEventListener('click', async () => {
      const ok = await sheet({
        title: 'Send back to the supervisor', submitLabel: 'Send back', text: 'They will see your note and can fix it on their phone.',
        fields: [{ name: 'comment', label: 'What needs changing?', type: 'textarea', required: true, placeholder: 'e.g. Retake the oven photo, it is blurred' }],
        onSubmit: (v) => post(`/admin/inspections/${id}/return`, v),
      });
      if (ok) { toast('Sent back'); location.hash = '#/inspections'; }
    });
    view.querySelector('#unapprove')?.addEventListener('click', async () => {
      if (!(await confirmSheet('Move back to “To review”?', { okLabel: 'Move back', danger: false }))) return;
      try { await post(`/admin/inspections/${id}/unapprove`); reload(); } catch (e) { toast(e.message, { error: true }); }
    });
  }
  return { report };
}
