// Admin review screens: inspections inbox and the full report with approve / send back / PDF / email.
const STATUS = {
  draft: ['In progress', 'pill'], returned: ['Sent back', 'pill warn'],
  submitted: ['To review', 'pill'], approved: ['Approved', 'pill ok'],
};
const FILTERS = [['submitted', 'To review'], ['returned', 'Sent back'], ['approved', 'Approved'], ['draft', 'In progress'], ['', 'All']];
const LOW = 7;
export const scorePill = (score) => score ? `<span class="score-pill${score < LOW ? ' low' : ''}">${score}/10</span>` : '';
const dueText = (d) => new Date(`${d}T12:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
// one item's urgent action plan (staff only)
export function actionPlan(it, esc, { canToggle = false, inspectionId = '' } = {}) {
  if (!(it.score && it.score < LOW && it.action_what)) return '';
  const overdue = !it.action_done_at && it.action_due && it.action_due < new Date().toISOString().slice(0, 10);
  return `<div class="plan${it.action_done_at ? ' done' : overdue ? ' overdue' : ''}">
    <strong>${it.action_done_at ? 'Action done' : overdue ? 'Action OVERDUE' : 'Urgent action'}</strong>
    <p>${esc(it.action_what)}</p>
    <p class="small">Who: <strong>${esc(it.action_who)}</strong> · Deadline: <strong>${it.action_due ? dueText(it.action_due) : '—'}</strong>
      ${it.action_done_at ? ` · done ${fmt(it.action_done_at)}${it.action_done_by_name ? ` by ${esc(it.action_done_by_name)}` : ''}` : ''}</p>
    ${canToggle ? `<button class="btn" data-done="${esc(it.item_key)}" data-insp="${inspectionId}" data-state="${it.action_done_at ? '1' : '0'}">${it.action_done_at ? 'Reopen' : 'Mark done'}</button>` : ''}
  </div>`;
}
const fmt = (d) => d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const day = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

// photos of one item: a grid, or before/after pairs. Shared with the client/cleaner portal.
export function itemPhotos(insp, it, editing = false) {
  const photo = (p, alt) => p
    ? `<figure><a href="/api/photos/${p.id}" target="_blank" rel="noopener"><img src="/api/photos/${p.id}" alt="${alt}" loading="lazy"></a>
        ${editing ? `<button class="thumb-del" data-del="${p.id}" aria-label="Delete ${alt.toLowerCase()}">✕</button>` : ''}</figure>`
    : '<div class="after-slot muted">—</div>';
  const ps = insp.photos.filter((p) => p.item_key === it.item_key);
  if (!ps.length) return '<p class="muted small">No photos</p>';
  if (insp.mode !== 'before_after') return `<div class="thumbs big">${ps.map((p) => photo(p, 'Photo')).join('')}</div>`;
  const befores = ps.filter((p) => p.phase !== 'after');
  const orphans = ps.filter((p) => p.phase === 'after' && !befores.some((b) => b.id === p.pair_id));
  return `<div class="pair-head"><span>Before</span><span>After</span></div><div class="pairs">${befores.map((b) =>
    `<div class="pair">${photo(b, 'Before photo')}${photo(ps.find((a) => a.phase === 'after' && a.pair_id === b.id), 'After photo')}</div>`).join('')}
    ${orphans.map((a) => `<div class="pair">${photo(null)}${photo(a, 'After photo')}</div>`).join('')}</div>`;
}

// a comment thread as HTML
export const thread = (comments, esc) => comments.map((c) =>
  `<p class="comment"><strong>${esc(c.name)}</strong> <span class="muted small">${fmt(c.created_at)}</span><br>${esc(c.body)}</p>`).join('');

const avgOf = (insp) => { const s = insp.items.map((i) => i.score).filter(Boolean); return s.length ? (s.reduce((a, b) => a + b, 0) / s.length).toFixed(1) : null; };

export function reviewViews({ api, post, put, del, esc, toast, shell, formDialog, confirmDialog }) {
  async function list(status = 'submitted') {
    const rows = await api(`/admin/inspections${status ? `?status=${status}` : ''}`);
    shell(`
      <div class="row between"><h1>Inspections</h1></div>
      <nav class="chips" aria-label="Filter">${FILTERS.map(([s, label]) =>
        `<a href="#/inspections${s ? `/f/${s}` : '/f/all'}" ${s === status ? 'aria-current="true"' : ''}>${label}</a>`).join('')}</nav>
      ${rows.length ? `<ul class="list">${rows.map((i) => `
        <li><a class="list-link" href="#/inspections/${i.id}">
          <span class="grow"><strong>${esc(i.site_name)}</strong> <span class="muted">· ${esc(i.client_name)}</span><br>
            <span class="muted small">${i.mode === 'before_after' ? 'Before &amp; after' : 'Quality check'} · ${esc(i.inspector_name)} · ${fmt(i.finished_at || i.started_at)} · ${i.photo_count} photos</span></span>
          ${i.open_actions ? `<span class="pill urgent-pill">URGENT · ${i.open_actions}</span>` : ''}${scorePill(i.avg_score && +i.avg_score)}
          <span class="${STATUS[i.status][1]}">${STATUS[i.status][0]}</span>
          ${i.emailed_at ? '<span class="pill">Emailed</span>' : ''}${i.client_signed_at ? '<span class="pill ok">Client signed</span>' : ''}
        </a></li>`).join('')}</ul>`
        : `<p class="empty">${status === 'submitted' ? 'Nothing waiting for review.' : 'No inspections here.'}</p>`}`);
  }

  async function detail(id) {
    const [insp, mail] = await Promise.all([api(`/inspections/${id}`), api('/admin/email-status')]);
    const editing = insp.status === 'submitted';
    const ba = insp.mode === 'before_after';
    const maps = (g) => g ? `<a href="https://www.google.com/maps?q=${g.lat},${g.lng}" target="_blank" rel="noopener">${g.lat.toFixed(5)}, ${g.lng.toFixed(5)}</a> <span class="muted">±${g.accuracy ?? '?'} m</span>` : '<span class="muted">not recorded</span>';
    const photosOf = (it) => itemPhotos(insp, it, editing);
    const [label, cls] = STATUS[insp.status];
    const internal = insp.comments.filter((c) => c.audience !== 'client');
    const clientMsgs = insp.comments.filter((c) => c.audience === 'client');

    const view = shell(`
      <p><a href="#/inspections">← Inspections</a></p>
      <section class="card">
        <div class="row between"><h1>${esc(insp.site_name)}</h1><span class="${cls}">${label}</span></div>
        <p class="muted">${esc(insp.client_name)}${insp.site_address ? ` · ${esc(insp.site_address)}` : ''}</p>
        <dl class="facts">
          <dt>Inspection</dt><dd>${ba ? 'Before &amp; after' : 'Quality check'} · ${esc(insp.template_name)}</dd>
          <dt>Inspector</dt><dd>${esc(insp.inspector_name)}</dd>
          ${avgOf(insp) ? `<dt>Overall score</dt><dd>${scorePill(+avgOf(insp))}</dd>` : ''}
          ${ba ? '<dt>Visibility</dt><dd>Internal — cleaners for this site can see it once approved; never shown to the client</dd>' : ''}
          <dt>Started</dt><dd>${fmt(insp.started_at)} · ${maps(insp.start_gps)}</dd>
          <dt>Finished</dt><dd>${fmt(insp.finished_at)} · ${maps(insp.end_gps)}</dd>
          ${insp.approved_at ? `<dt>Approved</dt><dd>${fmt(insp.approved_at)} by ${esc(insp.approved_by_name)}</dd>` : ''}
          ${insp.emailed_at ? `<dt>Emailed</dt><dd>${fmt(insp.emailed_at)} to ${esc(insp.emailed_to)}</dd>` : ''}
          ${insp.client_signed_at ? `<dt>Client sign-off</dt><dd>${fmt(insp.client_signed_at)} by ${esc(insp.client_signed_by_name)}</dd>` : ''}
        </dl>
      </section>
      ${internal.length ? `<section class="card"><h2>Notes to the inspector</h2>${thread(internal, esc)}</section>` : ''}
      ${insp.status === 'approved' ? `<section class="card"><h2>Messages with the client</h2>
        ${clientMsgs.length ? thread(clientMsgs, esc) : '<p class="muted small">No messages yet. The client can reply from their portal.</p>'}
        <form id="reply" class="stack reply"><label class="small">Reply to the client<textarea name="body" rows="3" required></textarea></label>
          <div class="row end"><button class="btn">Send reply</button></div></form></section>` : ''}
      ${editing ? '<p class="muted small">You can tidy up notes and delete photos before approving. The client only sees the report once it\'s approved.</p>' : ''}
      ${insp.items.map((it, n) => `
        <section class="card">
          <div class="row between"><h2>${n + 1}. ${esc(it.label)}${it.added && insp.template_id ? ' <span class="pill">Added on site</span>' : ''}</h2>${scorePill(it.score)}</div>
          ${actionPlan(it, esc, { canToggle: insp.status !== 'draft', inspectionId: id })}
          ${editing ? `<label class="small">Notes<textarea data-note="${esc(it.item_key)}" rows="3">${esc(it.note)}</textarea></label>`
            : it.note ? `<p class="note">${esc(it.note)}</p>` : ''}
          ${photosOf(it)}
        </section>`).join('')}
      ${insp.inspector_sig ? `<section class="card"><h2>Inspector signature</h2><img class="sig-img" src="${esc(insp.inspector_sig)}" alt="Signature of ${esc(insp.inspector_name)}"></section>` : ''}
      ${insp.client_sig ? `<section class="card"><h2>Client sign-off</h2><img class="sig-img" src="${esc(insp.client_sig)}" alt="Client signature"></section>` : ''}
      <div class="row between sticky-bar review-bar">
        <a class="btn" href="/api/inspections/${id}/pdf" target="_blank" rel="noopener">${insp.status === 'approved' ? 'View PDF' : 'Preview PDF'}</a>
        <div class="row">
          ${editing ? '<button class="btn" id="return">Send back</button><button class="btn primary" id="approve">Approve</button>' : ''}
          ${insp.status === 'approved' ? `${insp.client_signed_at ? '' : '<button class="btn" id="unapprove">Unapprove</button>'}
            <a class="btn" href="/api/inspections/${id}/pdf?download=1">Download PDF</a>
            ${ba ? '' : `<button class="btn primary" id="email">`}${ba ? '' : `${insp.emailed_at ? 'Email again' : 'Email to client'}</button>`}` : ''}
        </div>
      </div>`);

    const reload = () => detail(id);
    bindDone(view, reload);
    view.querySelector('#reply')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await post(`/inspections/${id}/comments`, { body: e.target.body.value }); toast('Reply posted — the client sees it in their portal'); reload(); }
      catch (err) { toast(err.message, true); }
    });
    view.querySelectorAll('[data-note]').forEach((ta) => ta.addEventListener('change', async () => {
      try { await put(`/admin/inspections/${id}/items/${encodeURIComponent(ta.dataset.note)}`, { note: ta.value }); toast('Note saved'); }
      catch (e) { toast(e.message, true); }
    }));
    view.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      const p = insp.photos.find((x) => x.id === b.dataset.del);
      const paired = p.phase === 'before' && insp.photos.some((a) => a.pair_id === p.id);
      if (!(await confirmDialog(paired ? 'Delete this before photo and its after photo?' : 'Delete this photo?'))) return;
      try { await del(`/admin/inspections/${id}/photos/${p.id}`); reload(); } catch (e) { toast(e.message, true); }
    });
    view.querySelector('#approve')?.addEventListener('click', async () => {
      if (!(await confirmDialog('Approve this inspection? The client will be able to see it in their portal.', 'Approve'))) return;
      try { await post(`/admin/inspections/${id}/approve`); toast('Approved'); reload(); } catch (e) { toast(e.message, true); }
    });
    view.querySelector('#return')?.addEventListener('click', async () => {
      const ok = await formDialog({
        title: 'Send back to the inspector', submitLabel: 'Send back',
        fields: [{ name: 'comment', label: 'What needs changing?', type: 'textarea', required: true }],
        onSubmit: (v) => post(`/admin/inspections/${id}/return`, v),
      });
      if (ok) { toast('Sent back'); location.hash = '#/inspections'; }
    });
    view.querySelector('#unapprove')?.addEventListener('click', async () => {
      if (!(await confirmDialog('Move this back to "To review"? The client stops seeing it until you approve again.', 'Unapprove'))) return;
      try { await post(`/admin/inspections/${id}/unapprove`); reload(); } catch (e) { toast(e.message, true); }
    });
    view.querySelector('#email')?.addEventListener('click', async () => {
      if (!mail.configured) return toast('Email is not set up on the server yet', true);
      const greeting = insp.client_contact ? insp.client_contact.split(' ')[0] : 'there';
      const sent = await formDialog({
        title: 'Email report to client', submitLabel: 'Send',
        fields: [
          { name: 'to', label: 'To (separate several with commas)', type: 'text', value: insp.client_email || '', required: true },
          { name: 'subject', label: 'Subject', value: `Inspection report — ${insp.site_name} — ${day(insp.started_at)}`, required: true },
          { name: 'message', label: 'Message', type: 'textarea', value:
            `Hi ${greeting},\n\nPlease find attached the inspection report for ${insp.site_name}, carried out on ${day(insp.started_at)}.\n\nKind regards,\nFC Cleaning Company` },
        ],
        onSubmit: (v) => post(`/admin/inspections/${id}/email`, v),
      });
      if (sent) { toast(`Sent to ${sent.emailed_to}`); reload(); }
    });
  }

  async function actions(done = false) {
    const rows = await api(`/admin/actions${done ? '?done=1' : ''}`);
    const view = shell(`
      <div class="row between"><h1>Urgent actions</h1></div>
      <p class="muted">Items scored below ${LOW}/10 and their action plans.</p>
      <nav class="chips"><a href="#/actions" ${done ? '' : 'aria-current="true"'}>Open</a><a href="#/actions/done" ${done ? 'aria-current="true"' : ''}>Done</a></nav>
      ${rows.length ? rows.map((a) => `
        <section class="card">
          <div class="row between"><div><strong>${esc(a.site_name)}</strong> <span class="muted">· ${esc(a.client_name)}</span><br>
            <a href="#/inspections/${a.inspection_id}">${esc(a.label)}</a> <span class="muted small">· ${esc(a.inspector_name)} · ${fmt(a.finished_at)}</span></div>
            ${scorePill(a.score)}</div>
          ${actionPlan(a, esc, { canToggle: true, inspectionId: a.inspection_id })}
        </section>`).join('') : `<p class="empty">${done ? 'Nothing marked done yet.' : 'No open urgent actions.'}</p>`}`);
    bindDone(view, () => actions(done));
  }

  function bindDone(view, reload) {
    view.querySelectorAll('[data-done]').forEach((b) => b.onclick = async () => {
      try {
        await post(`/admin/inspections/${b.dataset.insp}/items/${encodeURIComponent(b.dataset.done)}/action-done`, { done: b.dataset.state === '0' });
        toast(b.dataset.state === '0' ? 'Marked done' : 'Reopened'); reload();
      } catch (e) { toast(e.message, true); }
    });
  }

  return { list, detail, actions };
}
