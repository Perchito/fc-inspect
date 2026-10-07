import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

export const SESSION_DAYS = 30;

export function hashPassword(pass) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(pass, salt, 64).toString('hex')}`;
}

// also accepts FC Staff Hub hashes ("s2:salt:hash", stronger scrypt): Staff Hub copies its logins here
const S2 = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export function verifyPassword(pass, stored) {
  const parts = String(stored).split(':'), s2 = parts[0] === 's2' && parts.length === 3;
  const [salt, hash] = s2 ? parts.slice(1) : parts;
  const want = Buffer.from(hash || '', 'hex');
  if (!salt || want.length !== 64) return false;
  return timingSafeEqual(want, scryptSync(String(pass), Buffer.from(salt, 'hex'), want.length, s2 ? S2 : undefined));
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
  const staffHash = 's2:7b67d093fd3595661c60ebdc0a218a46:aa93e8e9818bf6d6c0e1ab4caa366ab538d8f63aab985d805c9ff6c58ec5cc77cb23411e52bf7fa5bbab6e27e60fc96ed70326f8891a6d8c63b266a9654d36f8'; // made by FC Staff Hub's hashPassword('both apps')
  console.assert(verifyPassword('both apps', staffHash) && !verifyPassword('nope', staffHash), 'staff hub hash');
  console.assert(verifyPassword('x1', hashPassword('x1')), 'own hash still works');
  console.log('auth ok');
}
