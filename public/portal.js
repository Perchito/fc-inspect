// Client portal and cleaner view: approved reports only. Clients can sign off and message the office.
// same ?v= as app.js uses, so these are the very same module instances (one upload outbox)
const v = new URL(import.meta.url).search;
const { itemPhotos, thread } = await import(`./review.js${v}`);
const { signaturePad } = await import(`./inspect.js${v}`);

const fmt = (d) => d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const day = (d) => new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });

export function portalViews({ api, post, esc, toast, shell, me }) {
  const isClient = () => me().role === 'client';

  async function list() {
    const rows = await api('/portal/inspections');
    shell(`
      <h1>${isClient() ? 'Your inspection reports' : 'Reports for your sites'}</h1>
      <p class="muted">${isClient() ? 'Reports appear here once FC Cleaning has checked and approved them.' : 'Approved inspections of the sites you clean.'}</p>
      ${rows.length ? `<ul class="list">${rows.map((i) => `
        <li><a class="list-link" href="#/reports/${i.id}">
          <span class="grow"><strong>${esc(i.site_name)}</strong><br>
            <span class="muted small">${day(i.started_at)} · ${i.mode === 'before_after' ? 'Before &amp; after' : 'Quality check'}${i.comment_count && isClient() ? ` · ${i.comment_count} message${i.comment_count === 1 ? '' : 's'}` : ''}</span></span>
          ${isClient() ? (i.client_signed_at ? '<span class="pill ok">Signed off</span>' : '<span class="pill warn">Awaiting your sign-off</span>') : ''}
        </a></li>`).join('')}</ul>`
        : '<p class="empty">No reports yet.</p>'}`);
  }

  async function report(id) {
    const insp = await api(`/inspections/${id}`);
    const client = isClient();
    const view = shell(`
      <p><a href="#/reports">← All reports</a></p>
      <section class="card">
        <h1>${esc(insp.site_name)}</h1>
        ${insp.site_address ? `<p class="muted">${esc(insp.site_address)}</p>` : ''}
        <dl class="facts">
          <dt>Date</dt><dd>${day(insp.started_at)}</dd>
          <dt>Inspection</dt><dd>${insp.mode === 'before_after' ? 'Before &amp; after' : 'Quality check'} · ${esc(insp.template_name)}</dd>
          <dt>Inspector</dt><dd>${esc(insp.inspector_name)}</dd>
          ${insp.client_signed_at ? `<dt>Signed off</dt><dd>${fmt(insp.client_signed_at)} by ${esc(insp.client_signed_by_name)}</dd>` : ''}
        </dl>
        <div class="row" style="margin-top:12px">
          <a class="btn" href="/api/inspections/${id}/pdf" target="_blank" rel="noopener">View PDF</a>
          <a class="btn" href="/api/inspections/${id}/pdf?download=1">Download PDF</a>
        </div>
      </section>
      ${insp.items.map((it, n) => `
        <section class="card">
          <h2>${n + 1}. ${esc(it.label)}</h2>
          ${it.note ? `<p class="note">${esc(it.note)}</p>` : ''}
          ${itemPhotos(insp, it)}
        </section>`).join('')}
      ${client ? `
        <section class="card stack">
          <h2>Questions or issues?</h2>
          ${insp.comments.length ? thread(insp.comments, esc) : '<p class="muted small">Send a message to the FC Cleaning office about this report.</p>'}
          <form id="reply" class="stack"><label class="small">Your message<textarea name="body" rows="3" required></textarea></label>
            <div class="row end"><button class="btn">Send message</button></div></form>
        </section>
        ${insp.client_signed_at ? `<section class="card"><h2>Signed off</h2><img class="sig-img" src="${esc(insp.client_sig)}" alt="Your signature">
            <p class="muted small">${fmt(insp.client_signed_at)} by ${esc(insp.client_signed_by_name)}</p></section>`
          : `<section class="card stack" id="signoff">
            <div class="row between"><h2>Sign off this report</h2><button class="btn" id="clear" type="button">Clear</button></div>
            <canvas id="sig" class="sig" aria-label="Sign here with your finger or mouse"></canvas>
            <p class="muted small">Signing confirms you have seen this report. If something isn't right, send a message above instead.</p>
            <button class="btn primary big" id="sign" disabled>Sign off</button>
          </section>`}` : ''}`);

    view.querySelector('#reply')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button'); btn.disabled = true;
      try { await post(`/inspections/${id}/comments`, { body: e.target.body.value }); toast('Message sent to FC Cleaning'); report(id); }
      catch (err) { toast(err.message, true); btn.disabled = false; }
    });
    const canvas = view.querySelector('#sig');
    if (canvas) {
      const pad = signaturePad(canvas), $sign = view.querySelector('#sign');
      pad.onInk((inked) => { $sign.disabled = !inked; });
      view.querySelector('#clear').onclick = () => pad.clear();
      $sign.onclick = async () => {
        $sign.disabled = true;
        try { await post(`/portal/inspections/${id}/sign`, { signature: pad.dataUrl() }); toast('Thank you — report signed off'); report(id); }
        catch (err) { toast(err.message, true); $sign.disabled = false; }
      };
    }
  }

  return { list, report };
}
