// Create a user, or reset their password if the email already exists.
//   node scripts/create-user.mjs <email> <name> <role>     (role: admin|inspector|cleaner)
// Prints the generated password once. Client users are created from the admin UI
// (they need a client_id).
import pg from 'pg';
import { hashPassword, newPassword } from '../lib/auth.mjs';

const [email, name, role = 'admin'] = process.argv.slice(2);
if (!email || !name || !['admin', 'inspector', 'cleaner'].includes(role)) {
  console.error('usage: node scripts/create-user.mjs <email> <name> <admin|inspector|cleaner>');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const pass = newPassword();
const { rows } = await pool.query(
  `insert into users (email, name, role, pass_hash) values ($1, $2, $3, $4)
   on conflict (lower(email)) do update set pass_hash = excluded.pass_hash, active = true
   returning (xmax = 0) as created`,
  [email.trim(), name, role, hashPassword(pass)]);
await pool.query('delete from sessions where user_id = (select id from users where lower(email) = lower($1))', [email.trim()]);
console.log(`${rows[0].created ? 'Created' : 'Password reset for'} ${email} (${role})  password: ${pass}`);
await pool.end();
