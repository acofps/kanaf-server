// Run once, manually, from the server:
//   node db/seed_first_admin.js "الاسم" "email@domain.com" "كلمة مرور قوية"
// Never leave this runnable from a public route — it's a CLI script
// on purpose, not an API endpoint.
import "dotenv/config";
import { pool } from "./pool.js";
import { hashPassword } from "../admin/auth.js";

const [name, email, password] = process.argv.slice(2);

if (!name || !email || !password) {
  console.error('Usage: node db/seed_first_admin.js "الاسم" "email@domain.com" "كلمة مرور قوية"');
  process.exit(1);
}
if (password.length < 15) {
  // Matches the NIST SP 800-63B guidance the engineering review cited
  // for single-factor password auth.
  console.error("Password must be at least 15 characters for a single-factor admin account.");
  process.exit(1);
}

const hash = await hashPassword(password);
const normalizedEmail = email.trim().toLowerCase();
const { rows } = await pool.query(
  `INSERT INTO admin_users (name, email, password_hash, role)
   VALUES ($1, $2, $3, 'owner')
   ON CONFLICT (LOWER(email)) DO UPDATE SET password_hash = EXCLUDED.password_hash
   RETURNING id, name, email, role`,
  [name.trim(), normalizedEmail, hash]
);
console.log("Owner admin ready:", rows[0]);
await pool.end();
