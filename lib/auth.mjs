import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

export const SESSION_DAYS = 30;

export function hashPassword(pass) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(pass, salt, 64).toString('hex')}`;
}

export function verifyPassword(pass, stored) {
  const [salt, hash] = String(stored).split(':');
  const want = Buffer.from(hash || '', 'hex');
  if (!salt || want.length !== 64) return false;
  return timingSafeEqual(want, scryptSync(pass, Buffer.from(salt, 'hex'), want.length));
}

export const newToken = () => randomBytes(32).toString('base64url');
export const tokenHash = (t) => createHash('sha256').update(String(t)).digest('hex');
export const newPassword = () => randomBytes(9).toString('base64url');

export function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// Failed-login limiter: 10 misses per IP per 15 min. In-memory, so a restart
// clears it — fine for a handful of users.
const fails = new Map();
const WINDOW_MS = 15 * 60_000, MAX_FAILS = 10;
export function loginBlocked(ip) {
  const f = fails.get(ip);
  if (f && Date.now() - f.since > WINDOW_MS) fails.delete(ip);
  return (fails.get(ip)?.count || 0) >= MAX_FAILS;
}
export function loginFailed(ip) {
  const f = fails.get(ip) || { count: 0, since: Date.now() };
  f.count++;
  fails.set(ip, f);
}
export const loginOk = (ip) => fails.delete(ip);

if (import.meta.url === `file://${process.argv[1]}`) {
  const h = hashPassword('secret pass');
  console.assert(verifyPassword('secret pass', h), 'right password');
  console.assert(!verifyPassword('wrong', h), 'wrong password');
  console.assert(!verifyPassword('x', 'garbage'), 'bad hash');
  for (let i = 0; i < 10; i++) loginFailed('1.2.3.4');
  console.assert(loginBlocked('1.2.3.4') && !loginBlocked('5.6.7.8'), 'limiter');
  console.log('auth ok');
}
