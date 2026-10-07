// Admin API: clients, sites, templates, users. Mounted at /api/admin behind requireUser('admin').
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { hashPassword, newPassword } from './auth.mjs';

const ROLES = ['admin', 'inspector', 'cleaner', 'client'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class BadRequest extends Error { status = 400; }
export const str = (v, field, { required = false, max = 500 } = {}) => {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : null;
  if (s === null) throw new BadRequest(`${field} must be text`);
  if (required && !s) throw new BadRequest(`${field} is required`);
  if (s.length > max) throw new BadRequest(`${field} is too long`);
  return s || null;
};
const ids = (v, field) => {
  if (v == null) return [];
  if (!Array.isArray(v) || !v.every((x) => UUID.test(x))) throw new BadRequest(`${field} must be a list of ids`);
  return [...new Set(v)];
};
export function cleanItems(v) {
  if (!Array.isArray(v)) throw new BadRequest('items must be a list');
  if (v.length > 200) throw new BadRequest('Too many items');
  const seen = new Set();
  return v.map((it, i) => {
    let key = typeof it?.key === 'string' && /^[a-z0-9]{1,16}$/.test(it.key) ? it.key : '';
    while (!key || seen.has(key)) key = randomBytes(5).toString('hex');
    seen.add(key);
    return { key, label: str(it?.label, `Item ${i + 1} name`, { required: true, max: 200 }), hint: str(it?.hint, 'Hint', { max: 500 }) || '', area: str(it?.area, 'Area name', { max: 200 }) || '' };
  });
}

export function adminRoutes(pool) {
  const r = Router();
  const one = async (sql, args) => (await pool.query(sql, args)).rows[0];
  const notFound = (res) => res.status(404).json({ error: 'Not found' });

  // ── clients ───────────────────────────────────────────
  r.get('/clients', async (req, res) => {
    res.json((await pool.query(
      `select c.*, (select count(*)::int from sites s where s.client_id = c.id) as site_count,
              (select count(*)::int from inspections i join sites s on s.id = i.site_id where s.client_id = c.id and i.status <> 'draft') as inspection_count,
              (select count(*)::int from inspection_items ii join inspections i on i.id = ii.inspection_id join sites s on s.id = i.site_id
                where s.client_id = c.id and ii.score < 7 and ii.action_done_at is null and i.status in ('submitted', 'approved')) as open_actions
         from clients c where not c.prospect order by lower(c.name)`)).rows);
  });
  const clientFields = (b) => [
    str(b.name, 'Name', { required: true, max: 200 }), str(b.contact_name, 'Contact name', { max: 200 }),
    str(b.email, 'Email', { max: 200 }), str(b.phone, 'Phone', { max: 50 }),
  ];
  r.post('/clients', async (req, res) => {
    res.json(await one('insert into clients (name, contact_name, email, phone) values ($1,$2,$3,$4) returning *', clientFields(req.body)));
  });
  r.put('/clients/:id', async (req, res) => {
    const row = await one('update clients set name=$2, contact_name=$3, email=$4, phone=$5 where id=$1 returning *', [req.params.id, ...clientFields(req.body)]);
    row ? res.json(row) : notFound(res);
  });
  r.delete('/clients/:id', async (req, res) => {
    const { rowCount } = await pool.query('delete from clients where id=$1', [req.params.id]);
    rowCount ? res.json({ ok: true }) : notFound(res);
  });

  // ── sites (with their templates + cleaners) ───────────
  r.get('/sites', async (req, res) => {
    const where = req.query.client_id ? 'where s.client_id = $1' : '';
    res.json((await pool.query(
      `select s.*,
              coalesce((select json_agg(template_id) from site_templates where site_id = s.id), '[]') as template_ids,
              coalesce((select json_agg(user_id) from site_cleaners where site_id = s.id), '[]') as cleaner_ids
         from sites s ${where} order by lower(s.name)`, req.query.client_id ? [req.query.client_id] : [])).rows);
  });
  async function saveSite(id, b) {
    const name = str(b.name, 'Site name', { required: true, max: 200 }), address = str(b.address, 'Address', { max: 500 });
    const templateIds = ids(b.template_ids, 'Templates'), cleanerIds = ids(b.cleaner_ids, 'Cleaners');
    const db = await pool.connect();
    try {
      await db.query('begin');
      const site = id
        ? (await db.query('update sites set name=$2, address=$3 where id=$1 returning *', [id, name, address])).rows[0]
        : (await db.query('insert into sites (client_id, name, address) values ($1,$2,$3) returning *', [b.client_id, name, address])).rows[0];
      if (!site) { await db.query('rollback'); return null; }
      await db.query('delete from site_templates where site_id=$1', [site.id]);
      await db.query('insert into site_templates select $1, unnest($2::uuid[])', [site.id, templateIds]);
      await db.query('delete from site_cleaners where site_id=$1', [site.id]);
      // only real cleaners can be assigned
      await db.query(`insert into site_cleaners select $1, id from users where id = any($2::uuid[]) and role = 'cleaner'`, [site.id, cleanerIds]);
      await db.query('commit');
      return site;
    } catch (e) { await db.query('rollback'); throw e; } finally { db.release(); }
  }
  r.post('/sites', async (req, res) => {
    if (!UUID.test(req.body.client_id)) throw new BadRequest('client_id is required');
    res.json(await saveSite(null, req.body));
  });
  r.put('/sites/:id', async (req, res) => {
    const site = await saveSite(req.params.id, req.body);
    site ? res.json(site) : notFound(res);
  });
  r.delete('/sites/:id', async (req, res) => {
    const { rowCount } = await pool.query('delete from sites where id=$1', [req.params.id]);
    rowCount ? res.json({ ok: true }) : notFound(res);
  });

  // ── templates ─────────────────────────────────────────
  r.get('/templates', async (req, res) => {
    res.json((await pool.query(
      `select t.*, (select count(*)::int from site_templates st where st.template_id = t.id) as site_count,
              (select count(*)::int from inspections i where i.template_id = t.id) as use_count
         from templates t order by lower(t.name)`)).rows);
  });
  r.post('/templates', async (req, res) => {
    res.json(await one('insert into templates (name, items) values ($1, $2) returning *',
      [str(req.body.name, 'Template name', { required: true, max: 200 }), JSON.stringify(cleanItems(req.body.items ?? []))]));
  });
  r.put('/templates/:id', async (req, res) => {
    const row = await one('update templates set name=$2, items=$3 where id=$1 returning *',
      [req.params.id, str(req.body.name, 'Template name', { required: true, max: 200 }), JSON.stringify(cleanItems(req.body.items))]);
    row ? res.json(row) : notFound(res);
  });
  r.delete('/templates/:id', async (req, res) => {
    const { rowCount } = await pool.query('delete from templates where id=$1', [req.params.id]);
    rowCount ? res.json({ ok: true }) : notFound(res);
  });

  // ── users ─────────────────────────────────────────────
  r.get('/users', async (req, res) => {
    res.json((await pool.query(
      `select u.id, u.email, u.name, u.role, u.client_id, u.active, u.created_at, c.name as client_name
         from users u left join clients c on c.id = u.client_id
        order by u.active desc, u.role, lower(u.name)`)).rows);
  });
  const userFields = (b) => {
    const role = b.role;
    if (!ROLES.includes(role)) throw new BadRequest('Pick a role');
    const email = str(b.email, 'Email', { required: true, max: 200 });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequest('That email looks wrong');
    if (role === 'client' && !UUID.test(b.client_id)) throw new BadRequest('Pick which client this login belongs to');
    return [email, str(b.name, 'Name', { required: true, max: 200 }), role, role === 'client' ? b.client_id : null];
  };
  r.post('/users', async (req, res) => {
    const password = newPassword();
    const user = await one(
      `insert into users (email, name, role, client_id, pass_hash) values ($1,$2,$3,$4,$5)
       returning id, email, name, role, client_id, active`, [...userFields(req.body), hashPassword(password)]);
    res.json({ ...user, password });
  });
  r.put('/users/:id', async (req, res) => {
    const [email, name, role, clientId] = userFields(req.body);
    const active = req.body.active !== false;
    if (req.params.id === req.user.id && (role !== 'admin' || !active)) throw new BadRequest("You can't remove your own admin access");
    const user = await one(
      `update users set email=$2, name=$3, role=$4, client_id=$5, active=$6 where id=$1
       returning id, email, name, role, client_id, active`, [req.params.id, email, name, role, clientId, active]);
    if (!user) return notFound(res);
    if (!active) await pool.query('delete from sessions where user_id=$1', [user.id]);
    if (role !== 'cleaner') await pool.query('delete from site_cleaners where user_id=$1', [user.id]);
    res.json(user);
  });
  r.post('/users/:id/reset-password', async (req, res) => {
    const password = newPassword();
    const user = await one('update users set pass_hash=$2 where id=$1 returning id, email', [req.params.id, hashPassword(password)]);
    if (!user) return notFound(res);
    await pool.query('delete from sessions where user_id=$1', [user.id]);
    res.json({ ...user, password });
  });

  return r;
}
