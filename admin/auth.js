import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { query } from "../db/pool.js";

const JWT_SECRET = process.env.ADMIN_JWT_SECRET;
const ACCESS_EXPIRES_IN = process.env.ADMIN_JWT_EXPIRES_IN || "15m";
const REFRESH_EXPIRES_IN = process.env.ADMIN_REFRESH_EXPIRES_IN || "7d";

if (!JWT_SECRET || JWT_SECRET === "change-this-to-a-long-random-string") {
  // Fail loudly at boot instead of silently signing tokens with a
  // guessable secret — this is exactly the class of mistake that
  // turned the old admin panel into a "type the password in devtools"
  // situation.
  console.error(
    "FATAL: ADMIN_JWT_SECRET is missing or still the placeholder value. " +
    "Generate a real one: openssl rand -hex 32 — and set it in .env before starting the server."
  );
  process.exit(1);
}

const BCRYPT_ROUNDS = 12;

export async function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}

/**
 * Verifies email + password against admin_users. Returns the admin
 * row (without password_hash) on success, or null on any failure —
 * deliberately the same response shape whether the email doesn't
 * exist or the password is wrong, so the API never confirms which
 * admin emails are valid to someone probing it.
 */
/* ============================================================
   تهدئة لكل حساب — KANAF-ORD-0001 R15-23

   بعد THROTTLE_FREE_ATTEMPTS إخفاقات متتالية يُهدَّأ الحساب دقيقة،
   وتتضاعف المدة مع كل إخفاق بعدها حتى سقف ربع ساعة — **لا قفل دائم**،
   فلا يصير التخمين المتعمّد أداة لحجب المالك عن حسابه إلى أجل غير
   مسمّى. الدخول الناجح يصفّر العدّاد.

   والرد واحد في كل الحالات (بريد مجهول، كلمة خاطئة، حساب معطّل، حساب
   مُهدَّأ): invalid_credentials بنفس الزمن تقريباً — مقارنة bcrypt
   تجري دائماً (على تجزئة وهمية حين لا حساب)، فلا يكشف الزمن ولا الرد
   وجود بريد إدارة ولا حالة تهدئته. ثمن ذلك أن المسؤول المُهدَّأ لا
   يُقال له «انتظر»؛ رسالة اللوحة تذكر الاحتمالين معاً.
   ============================================================ */
const THROTTLE_FREE_ATTEMPTS = Number(process.env.ADMIN_LOGIN_FREE_ATTEMPTS || 5);
const THROTTLE_BASE_MS = 60 * 1000;
const THROTTLE_MAX_MS = 15 * 60 * 1000;
const DUMMY_ADMIN_HASH = bcrypt.hashSync("kanaf-dummy-" + Math.random(), BCRYPT_ROUNDS);

async function recordAdminFailure(adminId) {
  const { rows } = await query(
    `INSERT INTO admin_auth_state (admin_user_id, failed_count, last_failed_at, updated_at)
     VALUES ($1, 1, now(), now())
     ON CONFLICT (admin_user_id) DO UPDATE
       SET failed_count = admin_auth_state.failed_count + 1, last_failed_at = now(), updated_at = now()
     RETURNING failed_count`,
    [adminId]
  );
  const n = rows[0].failed_count;
  if (n >= THROTTLE_FREE_ATTEMPTS) {
    const ms = Math.min(THROTTLE_BASE_MS * 2 ** (n - THROTTLE_FREE_ATTEMPTS), THROTTLE_MAX_MS);
    await query(`UPDATE admin_auth_state SET locked_until = now() + ($2 || ' milliseconds')::interval WHERE admin_user_id = $1`, [adminId, String(ms)]);
  }
}

export async function verifyAdminCredentials(email, plaintextPassword) {
  const { rows } = await query(
    `SELECT a.id, a.name, a.email, a.password_hash, a.role, a.active,
            (s.locked_until IS NOT NULL AND s.locked_until > now()) AS throttled
     FROM admin_users a LEFT JOIN admin_auth_state s ON s.admin_user_id = a.id
     WHERE LOWER(a.email) = LOWER($1)`,
    [email]
  );
  const admin = rows[0];
  // المقارنة تجري دائماً — زمن الرد لا يميّز بين الحالات.
  const matches = await bcrypt.compare(String(plaintextPassword || ""), admin?.password_hash || DUMMY_ADMIN_HASH).catch(() => false);
  if (!admin || !admin.active) return null;
  if (admin.throttled) return null;
  if (!matches) { await recordAdminFailure(admin.id); return null; }

  await query(`DELETE FROM admin_auth_state WHERE admin_user_id = $1`, [admin.id]);
  const { password_hash, throttled, ...safeAdmin } = admin;
  return safeAdmin;
}

export function issueAccessToken(admin) {
  return jwt.sign(
    { sub: admin.id, role: admin.role, type: "access" },
    JWT_SECRET,
    { expiresIn: ACCESS_EXPIRES_IN }
  );
}

export function issueRefreshToken(admin) {
  return jwt.sign(
    { sub: admin.id, type: "refresh" },
    JWT_SECRET,
    { expiresIn: REFRESH_EXPIRES_IN }
  );
}

export function verifyToken(token) {
  // Throws if invalid/expired — callers should try/catch this.
  return jwt.verify(token, JWT_SECRET);
}

export async function touchLastLogin(adminId) {
  await query(`UPDATE admin_users SET last_login_at = now() WHERE id = $1`, [adminId]);
}

/**
 * Converts a jsonwebtoken-style duration string ("15m", "7d", "30s")
 * to milliseconds, so ADMIN_JWT_EXPIRES_IN / ADMIN_REFRESH_EXPIRES_IN
 * stay the single source of truth for both the JWT's own expiry and
 * the cookie's maxAge — no duplicated duration in two formats.
 */
function durationToMs(str) {
  const match = /^(\d+)([smhd])$/.exec(str);
  if (!match) return 15 * 60 * 1000; // safe fallback: 15 minutes
  const [, n, unit] = match;
  const multipliers = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
  return Number(n) * multipliers[unit];
}

const IS_PRODUCTION = process.env.NODE_ENV === "production";

const BASE_COOKIE_OPTS = {
  httpOnly: true, // the whole point — client-side JS (and therefore XSS) can never read this
  secure: IS_PRODUCTION, // require HTTPS in production; relaxed for local http:// dev
  sameSite: "strict", // this is a same-origin admin panel only ever loaded from its own subdomain — Strict blocks the cookie being sent on any cross-site request, which is real CSRF protection without needing a separate CSRF-token scheme
};

/**
 * Sets both auth cookies on a login/refresh response. The refresh
 * cookie is scoped to only the refresh route's path — the browser
 * won't attach it to every other /admin/* request, shrinking its
 * exposure window even within this same origin.
 */
export function setAuthCookies(res, { accessToken, refreshToken }) {
  if (accessToken) {
    res.cookie("kanaf_admin_access", accessToken, {
      ...BASE_COOKIE_OPTS,
      maxAge: durationToMs(ACCESS_EXPIRES_IN),
      path: "/admin",
    });
  }
  if (refreshToken) {
    res.cookie("kanaf_admin_refresh", refreshToken, {
      ...BASE_COOKIE_OPTS,
      maxAge: durationToMs(REFRESH_EXPIRES_IN),
      path: "/admin/auth/refresh",
    });
  }
}

export function clearAuthCookies(res) {
  res.clearCookie("kanaf_admin_access", { ...BASE_COOKIE_OPTS, path: "/admin" });
  res.clearCookie("kanaf_admin_refresh", { ...BASE_COOKIE_OPTS, path: "/admin/auth/refresh" });
}
