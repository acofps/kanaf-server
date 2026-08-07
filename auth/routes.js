import express from "express";
import rateLimit from "express-rate-limit";
import { query, withTransaction } from "../db/pool.js";
import { sendEmail } from "../mail/send.js";
import {
  validatePassword, hashPassword, comparePassword,
  issueAccessToken, issueRefreshToken, rotateRefreshToken,
  revokeRefreshToken, revokeAllUserSessions, ACCESS_TOKEN_TTL,
} from "./tokens.js";
import {
  normalizeEmail, isPlausibleEmail, issueCode, checkCode,
  checkSendRate, CODE_CONSTANTS,
} from "./codes.js";
import { requireUserAuth } from "./middleware.js";

export const authRouter = express.Router();

/* ---------------------------------------------------------
   ACCOUNT-EXISTENCE PRIVACY

   When someone registers with an address that already has a verified
   account, this returns the SAME response as a fresh signup and mails
   the address a "you already have an account" note instead of a code.

   The reason is specific to what Kanaf is. On an ordinary service,
   leaking that an address is registered is a minor annoyance. Here,
   confirming that a given person has an account confirms that they
   use a mental-health app — which is exactly the kind of disclosure
   the break-glass system and the soft-delete policy exist to prevent.
   A registration form that answers "this email is taken" hands that
   out to anyone with an email address and a browser.

   The cost is real: a user who forgot they had an account sees a
   code screen and no code. It's mitigated by the email they receive
   and by putting a visible "already have an account? sign in" link on
   that screen — the app MUST include one.

   Flip this to true if you'd rather have the clearer error message.
--------------------------------------------------------- */
const REVEAL_EXISTING_ACCOUNTS = false;

const LOCKOUT_THRESHOLD = 8;
const LOCKOUT_MINUTES = 15;

/* ---------------------------------------------------------
   Tighter limit than the global 60-per-15-min in index.js. That
   global cap allows 60 signup attempts per IP per window, which is
   plenty for credential stuffing. Per-address limits live in
   codes.js; this is the per-IP layer on top.
--------------------------------------------------------- */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX || 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_requests" },
});
authRouter.use(authLimiter);

function clientContext(req) {
  return { userAgent: req.headers["user-agent"] || null, ipAddress: req.ip || null };
}

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerified: Boolean(row.email_verified_at),
    confirmedAdult: row.confirmed_adult,
    remindersOn: row.reminders_on,
    darkMode: row.dark_mode,
    createdAt: row.created_at,
  };
}

async function issueSession(user, req) {
  const accessToken = issueAccessToken(user);
  const refreshToken = await issueRefreshToken(user.id, clientContext(req));
  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL };
}

function verificationEmailBody(name, code, ttlMinutes) {
  return `أهلاً ${name}،

كود تأكيد بريدك في كنف: ${code}

الكود صالح لمدة ${ttlMinutes} دقائق.
إذا ما طلبت هذا الكود، تجاهل الرسالة ولا تشاركها مع أحد.

فريق كنف
kanaf.me`;
}

function resetEmailBody(name, code, ttlMinutes) {
  return `أهلاً ${name}،

كود استعادة كلمة المرور في كنف: ${code}

الكود صالح لمدة ${ttlMinutes} دقائق، ويُستخدم مرة واحدة.
إذا ما طلبت استعادة كلمة المرور، تجاهل الرسالة — كلمة مرورك ما تغيّرت ولا يحتاج منك أي إجراء.

فريق كنف
kanaf.me`;
}

function existingAccountEmailBody(name) {
  return `أهلاً ${name}،

وصلنا طلب إنشاء حساب في كنف بهذا البريد، وعندك حساب مسجّل مسبقاً.

لو كنت أنت: سجّل الدخول مباشرة من app.kanaf.me
لو ما كنت أنت: ما صار شيء، حسابك بأمان ولا يحتاج أي إجراء.

فريق كنف
kanaf.me`;
}

/* =========================================================
   POST /api/auth/register
   { name, email, password, confirmedAdult, agreedPolicy }
   -> { ok: true, next: "verify" }

   This is the INSERT INTO users that did not exist anywhere in the
   repository — the reason the admin panel's user list was empty. The
   panel and the schema were always correct; nothing wrote a row.

   The account is created immediately with email_verified_at NULL, so
   it appears in the admin panel right away with a pending state,
   rather than materialising only after verification.
========================================================= */
authRouter.post("/register", async (req, res) => {
  try {
    const { name, email, password, confirmedAdult, agreedPolicy } = req.body || {};

    const cleanName = String(name || "").trim();
    const cleanEmail = normalizeEmail(email);

    if (!cleanName || cleanName.length < 2 || cleanName.length > 80) {
      return res.status(400).json({ error: "name_required" });
    }
    if (!isPlausibleEmail(cleanEmail)) {
      return res.status(400).json({ error: "invalid_email" });
    }
    if (confirmedAdult !== true) {
      return res.status(400).json({ error: "adult_confirmation_required" });
    }
    if (agreedPolicy !== true) {
      return res.status(400).json({ error: "policy_agreement_required" });
    }

    const passwordCheck = validatePassword(password);
    if (!passwordCheck.ok) return res.status(400).json({ ...passwordCheck, ok: undefined });

    const passwordHash = await hashPassword(password);

    // The whole decision happens inside one transaction with a row
    // lock, so two simultaneous registrations for the same address
    // can't both pass the "does it exist" check.
    const outcome = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT id, email_verified_at FROM users
         WHERE LOWER(email) = $1 AND deleted_at IS NULL
         FOR UPDATE`,
        [cleanEmail]
      );
      const existing = rows[0];

      if (existing && existing.email_verified_at) {
        return { kind: "already_verified" };
      }

      if (existing) {
        // An unverified account is a claim on the address, not
        // ownership of it — nobody has proven they can read this
        // inbox. Overwriting it lets someone who typo'd their
        // password on the first attempt simply try again, instead of
        // permanently locking themselves out of their own address.
        await client.query(
          `UPDATE users
           SET name = $1, password_hash = $2, confirmed_adult = true,
               agreed_policy_at = now(), updated_at = now()
           WHERE id = $3`,
          [cleanName, passwordHash, existing.id]
        );
        return { kind: "created", userId: existing.id };
      }

      const { rows: inserted } = await client.query(
        `INSERT INTO users (name, email, password_hash, confirmed_adult, agreed_policy_at)
         VALUES ($1, $2, $3, true, now())
         RETURNING id`,
        [cleanName, cleanEmail, passwordHash]
      );
      return { kind: "created", userId: inserted[0].id };
    });

    if (outcome.kind === "already_verified") {
      if (REVEAL_EXISTING_ACCOUNTS) {
        return res.status(409).json({ error: "email_already_registered" });
      }
      // Mail failure here must not change the response shape, or the
      // timing/status difference re-leaks what the branch exists to hide.
      try {
        await sendEmail(cleanEmail, "محاولة إنشاء حساب — كنف", existingAccountEmailBody(cleanName));
      } catch (err) {
        console.error("existing-account notice failed:", err.message);
      }
      return res.status(201).json({ ok: true, next: "verify" });
    }

    // The send-rate check belongs HERE, not before the branch above.
    // Run earlier, it answered 429 for an address with recent codes
    // and 201 for an unknown one — which handed back exactly the
    // account-existence signal this endpoint's uniform response was
    // built to withhold. Caught by the duplicate-registration test.
    //
    // On this branch the address is new or unverified, so a cooldown
    // reveals only that an unverified signup is already in flight —
    // a state that expires in minutes and belongs to whoever is
    // asking anyway.
    const rate = await checkSendRate(cleanEmail, "signup");
    if (!rate.allowed) {
      return res.status(429).json({ error: rate.reason, retryAfterSeconds: rate.retryAfterSeconds });
    }

    const { code, ttlMinutes } = await issueCode(cleanEmail, "signup");

    try {
      await sendEmail(cleanEmail, "كود التحقق — كنف", verificationEmailBody(cleanName, code, ttlMinutes));
    } catch (err) {
      // The row exists and the code is stored, so the account is
      // recoverable via resend — but say so plainly rather than
      // returning ok and leaving the user staring at an empty inbox.
      console.error("verification email failed:", err.message);
      return res.status(502).json({ error: "email_send_failed", next: "verify" });
    }

    res.status(201).json({ ok: true, next: "verify" });
  } catch (err) {
    if (err?.code === "23505") {
      // Lost the race against a concurrent insert on idx_users_email_lower.
      return res.status(201).json({ ok: true, next: "verify" });
    }
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* =========================================================
   POST /api/auth/verify-email  { email, code }
   -> { ok: true, user, accessToken, refreshToken }

   Unlike the old /api/verify-code, which answered {verified:true}
   and issued nothing — leaving no way for any later request to prove
   the check happened — this returns a real session.
========================================================= */
authRouter.post("/verify-email", async (req, res) => {
  try {
    const cleanEmail = normalizeEmail(req.body?.email);
    if (!isPlausibleEmail(cleanEmail)) return res.status(400).json({ error: "invalid_email" });

    const result = await checkCode(cleanEmail, req.body?.code, "signup");
    if (!result.ok) {
      return res.status(400).json({ error: result.reason, attemptsLeft: result.attemptsLeft });
    }

    const { rows } = await query(
      `UPDATE users
       SET email_verified_at = COALESCE(email_verified_at, now()),
           failed_login_count = 0, locked_until = NULL, updated_at = now()
       WHERE LOWER(email) = $1 AND deleted_at IS NULL
       RETURNING id, name, email, email_verified_at, confirmed_adult, reminders_on, dark_mode, created_at`,
      [cleanEmail]
    );

    const user = rows[0];
    if (!user) {
      // A valid code with no account behind it: the row was deleted
      // between issuing and verifying.
      return res.status(404).json({ error: "account_not_found" });
    }

    const session = await issueSession(user, req);
    res.json({ ok: true, user: publicUser(user), ...session });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* =========================================================
   POST /api/auth/resend-code  { email }
   Always answers ok — same existence-privacy reasoning as register.
========================================================= */
authRouter.post("/resend-code", async (req, res) => {
  try {
    const cleanEmail = normalizeEmail(req.body?.email);
    if (!isPlausibleEmail(cleanEmail)) return res.status(400).json({ error: "invalid_email" });

    const rate = await checkSendRate(cleanEmail, "signup");
    if (!rate.allowed) {
      return res.status(429).json({ error: rate.reason, retryAfterSeconds: rate.retryAfterSeconds });
    }

    const { rows } = await query(
      `SELECT id, name, email_verified_at FROM users
       WHERE LOWER(email) = $1 AND deleted_at IS NULL`,
      [cleanEmail]
    );
    const user = rows[0];

    if (!user || user.email_verified_at) {
      return res.json({ ok: true, cooldownSeconds: CODE_CONSTANTS.RESEND_COOLDOWN_SECONDS });
    }

    const { code, ttlMinutes } = await issueCode(cleanEmail, "signup");
    try {
      await sendEmail(cleanEmail, "كود التحقق — كنف", verificationEmailBody(user.name, code, ttlMinutes));
    } catch (err) {
      console.error("resend failed:", err.message);
      return res.status(502).json({ error: "email_send_failed" });
    }

    res.json({ ok: true, cooldownSeconds: CODE_CONSTANTS.RESEND_COOLDOWN_SECONDS });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* =========================================================
   POST /api/auth/login  { email, password }
========================================================= */
authRouter.post("/login", async (req, res) => {
  try {
    const cleanEmail = normalizeEmail(req.body?.email);
    const password = req.body?.password;

    if (!isPlausibleEmail(cleanEmail) || !password) {
      return res.status(400).json({ error: "email_and_password_required" });
    }

    const { rows } = await query(
      `SELECT id, name, email, password_hash, email_verified_at, confirmed_adult,
              reminders_on, dark_mode, created_at, failed_login_count, locked_until
       FROM users WHERE LOWER(email) = $1 AND deleted_at IS NULL`,
      [cleanEmail]
    );
    const user = rows[0];

    if (user?.locked_until && new Date(user.locked_until) > new Date()) {
      const seconds = Math.ceil((new Date(user.locked_until) - Date.now()) / 1000);
      return res.status(429).json({ error: "account_locked", retryAfterSeconds: seconds });
    }

    // Runs against a dummy hash when the account doesn't exist, so
    // response time doesn't distinguish the two cases.
    const matches = await comparePassword(password, user?.password_hash);

    if (!user || !matches) {
      if (user) {
        const next = user.failed_login_count + 1;
        const lock = next >= LOCKOUT_THRESHOLD
          ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000).toISOString()
          : null;
        await query(
          `UPDATE users SET failed_login_count = $1, locked_until = COALESCE($2, locked_until) WHERE id = $3`,
          [next, lock, user.id]
        );
      }
      return res.status(401).json({ error: "invalid_credentials" });
    }

    if (!user.email_verified_at) {
      // Correct password, unproven address. Distinct from a bad
      // password so the app routes to the code screen — and it only
      // tells the caller something they just proved they know.
      return res.status(403).json({ error: "email_not_verified", next: "verify" });
    }

    await query(
      `UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`,
      [user.id]
    );

    const session = await issueSession(user, req);
    res.json({ ok: true, user: publicUser(user), ...session });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* =========================================================
   POST /api/auth/refresh  { refreshToken }
   The presented token is revoked and replaced on every call.
========================================================= */
authRouter.post("/refresh", async (req, res) => {
  try {
    const rotated = await rotateRefreshToken(req.body?.refreshToken, clientContext(req));
    if (!rotated) return res.status(401).json({ error: "invalid_refresh_token" });

    const { rows } = await query(
      `SELECT id, name, email, email_verified_at, confirmed_adult, reminders_on, dark_mode, created_at
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [rotated.userId]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: "account_not_found" });

    res.json({
      ok: true,
      user: publicUser(user),
      accessToken: issueAccessToken(user),
      refreshToken: rotated.refreshToken,
      expiresIn: ACCESS_TOKEN_TTL,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* =========================================================
   POST /api/auth/logout  { refreshToken }
========================================================= */
authRouter.post("/logout", async (req, res) => {
  try {
    await revokeRefreshToken(req.body?.refreshToken);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* =========================================================
   GET /api/auth/me — who the bearer token belongs to.
========================================================= */
authRouter.get("/me", requireUserAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, name, email, email_verified_at, confirmed_adult, reminders_on, dark_mode, created_at
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [req.userId]
    );
    if (!rows[0]) return res.status(401).json({ error: "account_not_found" });
    res.json({ user: publicUser(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* =========================================================
   POST /api/auth/forgot-password  { email }
   -> { ok: true }   ALWAYS, whatever happened.

   Note this returns 200 even when the per-address cooldown suppresses
   the send. A 429 here would depend on recent code activity for the
   address, which is the same enumeration signal the register route
   had to be restructured to remove — and the per-IP limiter above
   already covers the abuse case this would otherwise catch.

   Reset codes are issued only for VERIFIED accounts. Someone stuck on
   an unverified account isn't locked out: an unverified row is
   overwritable, so they can simply register again with the same
   address (see the register route).
========================================================= */
authRouter.post("/forgot-password", async (req, res) => {
  const cleanEmail = normalizeEmail(req.body?.email);
  if (!isPlausibleEmail(cleanEmail)) return res.status(400).json({ error: "invalid_email" });

  // Answer first, work after. Every branch below returns the same
  // body, so there's nothing to wait for — and replying immediately
  // keeps a slow SMTP handshake from making "account exists" visible
  // in the response time.
  res.json({ ok: true });

  try {
    const { rows } = await query(
      `SELECT id, name, email_verified_at FROM users
       WHERE LOWER(email) = $1 AND deleted_at IS NULL`,
      [cleanEmail]
    );
    const user = rows[0];
    if (!user || !user.email_verified_at) return;

    const rate = await checkSendRate(cleanEmail, "password_reset");
    if (!rate.allowed) return;

    const { code, ttlMinutes } = await issueCode(cleanEmail, "password_reset");
    await sendEmail(cleanEmail, "استعادة كلمة المرور — كنف", resetEmailBody(user.name, code, ttlMinutes));
  } catch (err) {
    console.error("forgot-password:", err.message);
  }
});

/* =========================================================
   POST /api/auth/reset-password  { email, code, newPassword }
   -> { ok: true, user, accessToken, refreshToken }

   Every existing session is revoked. A password reset is the standard
   response to "someone else may be in my account", so it has to
   actually evict them — leaving old refresh tokens alive would make
   the reset cosmetic for up to 30 days.
========================================================= */
authRouter.post("/reset-password", async (req, res) => {
  try {
    const cleanEmail = normalizeEmail(req.body?.email);
    if (!isPlausibleEmail(cleanEmail)) return res.status(400).json({ error: "invalid_email" });

    const check = validatePassword(req.body?.newPassword);
    if (!check.ok) return res.status(400).json({ ...check, ok: undefined });

    const result = await checkCode(cleanEmail, req.body?.code, "password_reset");
    if (!result.ok) {
      return res.status(400).json({ error: result.reason, attemptsLeft: result.attemptsLeft });
    }

    const passwordHash = await hashPassword(req.body.newPassword);
    const { rows } = await query(
      `UPDATE users
       SET password_hash = $1, failed_login_count = 0, locked_until = NULL, updated_at = now()
       WHERE LOWER(email) = $2 AND deleted_at IS NULL AND email_verified_at IS NOT NULL
       RETURNING id, name, email, email_verified_at, confirmed_adult, reminders_on, dark_mode, created_at`,
      [passwordHash, cleanEmail]
    );

    const user = rows[0];
    if (!user) return res.status(404).json({ error: "account_not_found" });

    await revokeAllUserSessions(user.id);

    const session = await issueSession(user, req);
    res.json({ ok: true, user: publicUser(user), ...session });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* =========================================================
   POST /api/auth/change-password  { currentPassword, newPassword }
   Requires a valid access token. Every other session is revoked —
   the standard response to "my password may have been compromised"
   has to actually end the attacker's session.
========================================================= */
authRouter.post("/change-password", requireUserAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const check = validatePassword(newPassword);
    if (!check.ok) return res.status(400).json({ ...check, ok: undefined });

    const { rows } = await query(
      `SELECT id, password_hash FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [req.userId]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: "account_not_found" });

    const matches = await comparePassword(currentPassword, user.password_hash);
    if (!matches) return res.status(401).json({ error: "invalid_credentials" });

    await query(
      `UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`,
      [await hashPassword(newPassword), user.id]
    );
    await revokeAllUserSessions(user.id);

    const session = await issueSession({ id: user.id }, req);
    res.json({ ok: true, ...session });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});
