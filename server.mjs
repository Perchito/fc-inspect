import express from 'express';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import {
  SESSION_DAYS, verifyPassword, newToken, tokenHash, readCookie,
  loginBlocked, loginFailed, loginOk,
} from './lib/auth.mjs';
import { adminRoutes } from './lib/admin.mjs';
import { inspectionRoutes, loadInspection } from './lib/inspections.mjs';
import { reviewRoutes, pdfFor, purgeDeleted } from './lib/review.mjs';
import { actionRoutes, remindOverdue } from './lib/actions.mjs';
import { pdfFilename, PDF_PARTS } from './lib/pdf.mjs';
import { portalRoutes } from './lib/portal.mjs';

const { DATABASE_URL, PORT = 4620 } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const app = express();
app.set('trust proxy', 'loopback'); // cloudflared on localhost sets X-Forwarded-Proto
app.use(express.json({ limit: '2mb' }));

const COOKIE = 'fci_session';
const clientIp = (req) => String(req.headers['cf-connecting-ip'] || req.ip);

// ── session ─────────────────────────────────────────────
app.use(async (req, res, next) => {
  const token = readCookie(req, COOKIE);
  if (!token) return next();
  try {
    const { rows } = await pool.query(
      `select u.id, u.email, u.name, u.role, u.client_id from sessions s
         join users u on u.id = s.user_id
        where s.token_hash = $1 and s.expires_at > now() and u.active and u.role in ('admin', 'inspector', 'cleaner')`,
      [tokenHash(token)]);
    req.user = rows[0];
    next();
  } catch (e) { next(e); }
});

const requireUser = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  if (roles.length && !roles.includes(req.user.role)) return res.status(403).json({ error: 'Not allowed' });
  next();
};

app.post('/api/login', async (req, res) => {
  const ip = clientIp(req);
  if (loginBlocked(ip)) return res.status(429).json({ error: 'Too many attempts — try again in 15 minutes.' });
  const { email = '', password = '' } = req.body || {};
  // for now only admins and supervisors (inspector role) log in; clients get reports as emailed PDFs
  const { rows } = await pool.query(`select id, pass_hash from users where lower(email) = lower($1) and active and role in ('admin', 'inspector', 'cleaner')`, [String(email).trim()]); // cleaners: My actions + notifications only
  if (!rows[0] || !verifyPassword(String(password), rows[0].pass_hash)) {
    loginFailed(ip);
    console.warn(`[auth] failed login for ${String(email).slice(0, 80)} from ${ip}`);
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  loginOk(ip);
  const token = newToken();
  await pool.query(`insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + $3::interval)`,
    [tokenHash(token), rows[0].id, `${SESSION_DAYS} days`]);
  await pool.query('delete from sessions where expires_at < now()');
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_DAYS * 86400_000 });
  res.json({ ok: true });
});

app.post('/api/logout', async (req, res) => {
  const token = readCookie(req, COOKIE);
  if (token) await pool.query('delete from sessions where token_hash = $1', [tokenHash(token)]);
  res.clearCookie(COOKIE).json({ ok: true });
});

app.get('/api/me', requireUser(), (req, res) => res.json(req.user));
app.use('/api/admin', requireUser('admin'), adminRoutes(pool), reviewRoutes(pool));

// report PDF: anyone who may see the inspection (clients/cleaners only once approved)
app.get('/api/inspections/:id/pdf', requireUser(), async (req, res) => {
  const insp = await loadInspection(pool, req.user, req.params.id);
  if (!insp) return res.status(404).json({ error: 'Inspection not found' });
  const pdf = await pdfFor(pool, insp, Object.fromEntries(PDF_PARTS.map((k) => [k, req.query[k] !== '0'])));
  res.set({
    'content-type': 'application/pdf', 'cache-control': 'private, no-store',
    'content-disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${pdfFilename(insp)}"`,
  }).send(pdf);
});
app.use('/api', inspectionRoutes(pool, requireUser), portalRoutes(pool, requireUser), actionRoutes(pool, requireUser));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Cloudflare rewrites .js/.css to a 4h browser cache, so index.html (never
// cached) points at them with ?v=<start time>: every restart busts it.
const VERSION = Date.now().toString(36);
const indexHtml = readFileSync('public/index.html', 'utf8').replaceAll('__V__', VERSION);
app.get(['/', '/index.html'], (req, res) => res.set('Cache-Control', 'no-cache').type('html').send(indexHtml));
// front-end modules get the same stamp, so `import './ui.js?v=__V__'` resolves to one shared module per deploy
const jsCache = new Map();
app.get(/^\/[\w-]+\.js$/, (req, res, next) => {
  if (!jsCache.has(req.path)) {
    try { jsCache.set(req.path, readFileSync(`public${req.path}`, 'utf8').replaceAll('__V__', VERSION)); } catch { return next(); }
  }
  res.set('Cache-Control', 'no-cache').type('js').send(jsCache.get(req.path));
});
app.use(express.static('public', { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

// Postgres errors that are the caller's fault, in plain words
const PG_ERRORS = {
  '22P02': [400, 'Invalid id'],
  '23503': [409, 'This is still linked to other records (e.g. inspections), so it was left as it is'],
  '23505': [409, 'That email already has a login — find them in the Team list (they may be Inactive) and use Edit or Reset password'],
};
app.use((err, req, res, next) => {
  if (err.status === 400) return res.status(400).json({ error: err.message });
  if (err.status === 413) return res.status(413).json({ error: 'That file is too big' });
  if (PG_ERRORS[err.code]) { const [status, error] = PG_ERRORS[err.code]; return res.status(status).json({ error }); }
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, () => console.log(`FC Inspect on :${PORT}`));
// Recently deleted keeps inspections 30 days; check now and every 6 hours
const purge = () => purgeDeleted(pool).catch((e) => console.error('[purge]', e.message));
purge(); setInterval(purge, 6 * 3600_000).unref();
// overdue action reminders (each action at most once a day)
const remind = () => remindOverdue(pool).catch((e) => console.error('[remind]', e.message));
setTimeout(remind, 60_000).unref(); setInterval(remind, 3600_000).unref();
