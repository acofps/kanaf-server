-- 002_consumer_auth.sql
-- Adds everything the consumer (app user) authentication layer needs.
-- Safe to run more than once: every statement is IF NOT EXISTS.
--
-- Run once against the production database, BEFORE deploying the code
-- that depends on it. The server will fail its queries until this runs.
--
-- No BEGIN/COMMIT here on purpose: db/migrate.js wraps each file in a
-- transaction itself, and a nested BEGIN would be ignored with a
-- warning. Apply this via POST /api/setup/run-migrations, or with
-- psql if you ever have shell access.

/* ---------------------------------------------------------
   Login throttling state.

   These three fields belong on the users row conceptually, and the
   first version of this migration put them there with ALTER TABLE.
   That failed in production with "must be owner of relation users":
   the original 15 tables are owned by the `postgres` superuser (the
   schema was loaded with that account), while the application
   connects as `kanaf_adel`, which is not a member of that role.
   ALTER TABLE requires ownership, so those columns can never be
   added by the app's own database user.

   A separate table sidesteps that entirely — `kanaf_adel` owns
   anything it creates. The foreign key is real, not decorative:
   the app user does hold REFERENCES on users, so ON DELETE CASCADE
   still cleans this up if a row is ever hard-deleted.

   Counting failures in memory instead was never an option: it would
   reset on every Render redeploy and wouldn't be shared across
   server instances — the same flaw the old in-memory
   verification-code Map had.
--------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS user_auth_state (
  user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  failed_login_count  INT NOT NULL DEFAULT 0,
  locked_until        TIMESTAMPTZ,
  last_login_at       TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A row here is created lazily, on the first login attempt. Absence
-- means "no failures, never locked", so every read must COALESCE
-- rather than assume the row exists.
CREATE INDEX IF NOT EXISTS idx_user_auth_state_locked
  ON user_auth_state (locked_until)
  WHERE locked_until IS NOT NULL;

/* ---------------------------------------------------------
   Email verification codes.
   Keyed by email (not user_id) because a code is issued for an
   address before we know the account survives — and because a
   re-registration over an unverified account reuses the address
   while replacing the row's password.

   The code is stored as a bcrypt hash, never plaintext: a 6-digit
   code is a short-lived password, and a leaked database dump
   should not hand an attacker live codes for every pending signup.
--------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS email_verification_codes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT NOT NULL,              -- always stored lowercased
  code_hash    TEXT NOT NULL,              -- bcrypt
  purpose      TEXT NOT NULL DEFAULT 'signup' CHECK (purpose IN ('signup', 'password_reset')),
  attempts     INT NOT NULL DEFAULT 0,     -- wrong guesses so far; the code dies at MAX_ATTEMPTS
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,                -- set on success OR on attempt-exhaustion; either way it's dead
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The hot path is "newest live code for this address", so index exactly that.
CREATE INDEX IF NOT EXISTS idx_verification_codes_email_live
  ON email_verification_codes (LOWER(email), created_at DESC)
  WHERE consumed_at IS NULL;

-- Used by the per-address send-rate check, which counts recent rows
-- regardless of whether they were consumed.
CREATE INDEX IF NOT EXISTS idx_verification_codes_email_created
  ON email_verification_codes (LOWER(email), created_at DESC);

/* ---------------------------------------------------------
   Refresh sessions.
   The access token is a short-lived JWT (stateless, unrevocable by
   design). The refresh token is a random opaque string stored here
   as a SHA-256 hash — which is what makes logout real: deleting the
   row actually ends the session, instead of trusting the client to
   discard a token it may have already leaked.

   SHA-256 rather than bcrypt here on purpose: the token is 256 bits
   of CSPRNG output, so it isn't guessable and doesn't need a slow
   hash — and refresh happens often enough that bcrypt's cost would
   be felt.
--------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS user_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,      -- sha256 hex of the refresh token
  user_agent    TEXT,
  ip_address    TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions (user_id) WHERE revoked_at IS NULL;


/* ---------------------------------------------------------
   Housekeeping — run periodically (a cron job, or manually for now).
   Neither table self-prunes, and both grow on every signup attempt.

   DELETE FROM email_verification_codes WHERE created_at < now() - interval '7 days';
   DELETE FROM user_sessions WHERE expires_at < now() - interval '30 days';
--------------------------------------------------------- */
