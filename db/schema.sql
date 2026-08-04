-- ============================================================
-- Kanaf — PostgreSQL schema (v1)
-- Run once against a fresh database: psql "$DATABASE_URL" -f schema.sql
--
-- DESIGN NOTES (read before extending):
-- 1. Consumer users (`users`) and admin staff (`admin_users`) are
--    COMPLETELY SEPARATE tables with separate auth. An admin account
--    can never log into the consumer app and vice versa. This is the
--    real fix for the "أدمن بنفس التطبيق" finding from the engineering
--    audit — enforced structurally, not just by UI routing.
-- 2. `admin_access_log` has NO application-level UPDATE or DELETE
--    endpoint anywhere in admin/routes.js — inserts only. For true
--    immutability in production, additionally REVOKE UPDATE, DELETE
--    ON admin_access_log FROM the app's database role and only grant
--    INSERT + SELECT (see bottom of this file).
-- 3. Row-Level Security (RLS) policies are included but commented out
--    — enable them once you're running queries through a
--    per-request-scoped Postgres role (see db/README.md).
-- 4. `content_items.launch_enabled` is the real, server-side version
--    of the frontend's JOURNEY_LAUNCH_CONFIG / NOTEBOOK_LAUNCH_CONFIG
--    objects. Once the admin panel is wired up, the frontend should
--    fetch this table instead of hard-coding those JS objects.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

-- ------------------------------------------------------------
-- Consumer users
-- ------------------------------------------------------------
CREATE TABLE users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL,
  email               TEXT NOT NULL,
  password_hash       TEXT NOT NULL,          -- bcrypt, never plaintext — see admin/auth.js for the pattern to mirror
  age_range           TEXT,
  gender              TEXT,
  photo_url           TEXT,
  confirmed_adult     BOOLEAN NOT NULL DEFAULT false,   -- the 18+ self-attestation added to the frontend
  agreed_policy_at    TIMESTAMPTZ,
  email_verified_at   TIMESTAMPTZ,
  pin_hash            TEXT,                    -- bcrypt hash of the local-lock PIN — NEVER store plaintext (engineering audit F3)
  reminders_on        BOOLEAN NOT NULL DEFAULT false,
  marketing_opt_out   BOOLEAN NOT NULL DEFAULT false,   -- set via the real unsubscribe link in every broadcast email — see notifications/unsubscribe.js
  dark_mode           BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ              -- soft-delete marker; a scheduled job hard-deletes rows N days after this is set (see db/README.md "Deletion policy")
);
CREATE UNIQUE INDEX idx_users_email_lower ON users (LOWER(email)) WHERE deleted_at IS NULL;

-- ------------------------------------------------------------
-- Daily check-ins
-- ------------------------------------------------------------
CREATE TABLE daily_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mood        SMALLINT NOT NULL CHECK (mood BETWEEN 0 AND 10),
  sleep       SMALLINT NOT NULL CHECK (sleep BETWEEN 0 AND 10),
  energy      SMALLINT NOT NULL CHECK (energy BETWEEN 0 AND 10),
  note        TEXT,
  tags        TEXT[] NOT NULL DEFAULT '{}',
  logged_on   DATE NOT NULL,                   -- local calendar day the entry belongs to
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Enforces "one entry per day per user" AT THE DATABASE LEVEL —
  -- the real fix for the double-submit bug found in the engineering
  -- audit. The frontend guard (disable button while saving) stays as
  -- the first line of defense; this is the second, authoritative one.
  UNIQUE (user_id, logged_on)
);
CREATE INDEX idx_daily_logs_user_date ON daily_logs (user_id, logged_on DESC);

-- ------------------------------------------------------------
-- Screenings (PHQ-9 / GAD-7 / PC-PTSD-5 / Rosenberg)
-- ------------------------------------------------------------
CREATE TABLE screenings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('phq9', 'gad7', 'ptsd5', 'rosenberg')),
  total       SMALLINT NOT NULL,
  band_label  TEXT NOT NULL,
  answers     JSONB NOT NULL,                  -- raw item-level answers — sensitive; never expose in bulk admin views
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_screenings_user ON screenings (user_id, created_at DESC);

-- ------------------------------------------------------------
-- Subscriptions & invoices (real payment-gateway records land here)
-- ------------------------------------------------------------
CREATE TABLE subscriptions (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id                     TEXT NOT NULL,   -- 'monthly' | '6_months' | 'annual'
  status                      TEXT NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'canceled')),
  started_at                  TIMESTAMPTZ NOT NULL,
  current_period_end          TIMESTAMPTZ,
  canceled_at                 TIMESTAMPTZ,
  payment_provider            TEXT,            -- 'moyasar' etc — set once the gateway is wired
  payment_provider_customer_id TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_subscriptions_user ON subscriptions (user_id);

-- Atomic, safe-under-concurrency numbering for the legal invoice
-- number shown to customers and encoded in the QR code — a Postgres
-- sequence guarantees no two invoices can ever get the same number,
-- even if two webhooks land at the same instant.
CREATE SEQUENCE zatca_invoice_number_seq START 1;

CREATE TABLE invoices (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id     UUID REFERENCES subscriptions(id),
  plan_id             TEXT NOT NULL,             -- which plan this invoice is for — the webhook handler reads this back to activate the right subscription
  amount_sar          NUMERIC(10, 2) NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
  provider_invoice_id TEXT UNIQUE,               -- Moyasar's invoice id — set at creation, before payment happens
  provider_payment_id TEXT,                      -- the gateway's own transaction/charge id — only set once actually paid, for reconciliation
  checkout_url        TEXT,                      -- Moyasar's hosted payment page URL — redirect the user here, we never collect card data ourselves
  -- ZATCA Simplified Tax Invoice fields — populated only once the
  -- invoice is actually paid (an unpaid/abandoned checkout was never
  -- legally "issued", so it never consumes a sequence number).
  zatca_invoice_number TEXT UNIQUE,              -- e.g. 'INV-2026-000042' — the legal, sequential invoice number
  subtotal_sar         NUMERIC(10, 2),            -- amount excluding VAT
  vat_sar               NUMERIC(10, 2),            -- VAT amount (15%)
  zatca_qr_payload      TEXT,                      -- the exact base64 TLV string encoded in the QR — stored for audit/reprint, never regenerated with a different timestamp
  zatca_issued_at       TIMESTAMPTZ,                -- exact timestamp embedded in the QR code (must match what's on the PDF)
  pdf_data              BYTEA,                      -- the generated invoice PDF itself — small enough to store inline at this scale; move to object storage if volume grows
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_invoices_user ON invoices (user_id, created_at DESC);
CREATE INDEX idx_invoices_provider_invoice_id ON invoices (provider_invoice_id);

-- Real ZATCA Credit Note (إشعار دائن) — a distinct legal document
-- required whenever a previously-issued Simplified Tax Invoice is
-- reversed/refunded. Same QR/TLV structure as the invoice itself
-- (confirmed against ZATCA's own guidance before building this),
-- but must reference the original invoice number it corrects.
CREATE SEQUENCE zatca_credit_note_number_seq START 1;

CREATE TABLE credit_notes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_invoice_id   UUID NOT NULL REFERENCES invoices(id),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  zatca_credit_note_number TEXT UNIQUE NOT NULL,
  reason                TEXT,                     -- free text: why the refund happened, for internal/audit reference
  amount_sar            NUMERIC(10, 2) NOT NULL,   -- the credited amount, incl. VAT — normally equals the original invoice's amount_sar (full refund)
  subtotal_sar          NUMERIC(10, 2) NOT NULL,
  vat_sar               NUMERIC(10, 2) NOT NULL,
  zatca_qr_payload       TEXT NOT NULL,
  zatca_issued_at        TIMESTAMPTZ NOT NULL,
  pdf_data               BYTEA,
  provider_refund_id     TEXT,                     -- Moyasar's own refund/payment id, for reconciliation
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_credit_notes_user ON credit_notes (user_id, created_at DESC);
CREATE INDEX idx_credit_notes_original_invoice ON credit_notes (original_invoice_id);

-- ------------------------------------------------------------
-- Contact form submissions
-- ------------------------------------------------------------
CREATE TABLE contact_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  message     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'read', 'replied')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- ADMIN — entirely separate from the consumer tables above
-- ============================================================

CREATE TABLE admin_users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  email           TEXT NOT NULL,
  password_hash   TEXT NOT NULL,               -- bcrypt
  role            TEXT NOT NULL CHECK (role IN ('support', 'content_manager', 'admin', 'owner')),
  mfa_secret      TEXT,                        -- TOTP secret (base32) — set once MFA enrollment is built
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at   TIMESTAMPTZ
);
-- Case-insensitive uniqueness — found by testing that "Owner@Test.com"
-- and "owner@test.com" were treated as different accounts under a
-- plain UNIQUE constraint, which both allows duplicate accounts for
-- the same real email AND locks a real admin out if they type their
-- own email in different case than it was created with. Application
-- code (admin/auth.js, admin/routes.js, db/seed_first_admin.js) also
-- lowercases email on every write and lookup — this index is the
-- backstop in case any future code path forgets to.
CREATE UNIQUE INDEX idx_admin_users_email_lower ON admin_users (LOWER(email));

-- Seller's own registered tax details, managed from the admin panel's
-- Tax Settings page. Enforced as a single row via the singleton
-- UNIQUE+CHECK below — update the existing row rather than inserting
-- a second one. Placed here (after admin_users, not earlier) because
-- updated_by references it — same class of ordering bug already
-- caught and fixed once for subscription_plans below.
CREATE TABLE tax_settings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton   BOOLEAN NOT NULL DEFAULT true UNIQUE CHECK (singleton = true),
  legal_name  TEXT NOT NULL,
  vat_number  TEXT NOT NULL,
  address     TEXT,
  updated_by  UUID REFERENCES admin_users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Subscription plans — managed from the admin panel (Plans page).
-- payments/routes.js reads pricing/duration from THIS table now,
-- not a hardcoded object — editing a plan here actually changes
-- what a user is charged next time they subscribe. Placed here
-- (after admin_users, not earlier) because updated_by references it.
-- ------------------------------------------------------------
CREATE TABLE subscription_plans (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_key       TEXT NOT NULL UNIQUE,        -- stable identifier used in invoices/subscriptions — never reuse a retired key
  name           TEXT NOT NULL,               -- display name, e.g. "الباقة الشهرية"
  price_sar      NUMERIC(10, 2) NOT NULL CHECK (price_sar >= 0),
  duration_days  INTEGER NOT NULL CHECK (duration_days > 0),
  features       TEXT[] NOT NULL DEFAULT '{}', -- short feature bullets shown to the user at checkout
  is_active      BOOLEAN NOT NULL DEFAULT true, -- inactive plans are hidden from new purchases but existing subscribers on them are unaffected
  display_order  INTEGER NOT NULL DEFAULT 0,
  updated_by     UUID REFERENCES admin_users(id), -- who last changed this plan — accountability for a money-affecting change
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only. See design note #2 at top of file for the DB-grant
-- hardening step once you have a dedicated app role.
CREATE TABLE admin_access_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id   UUID NOT NULL REFERENCES admin_users(id),
  target_user_id  UUID REFERENCES users(id),
  action          TEXT NOT NULL,               -- 'view_sensitive_data' | 'reset_password' | 'edit_profile' | ...
  reason          TEXT NOT NULL,               -- required free-text reason, per spec section on admin access
  ip_address      INET,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_admin_access_log_target ON admin_access_log (target_user_id, created_at DESC);
CREATE INDEX idx_admin_access_log_admin ON admin_access_log (admin_user_id, created_at DESC);

-- Emergency ("break-glass") access requiring a second approver —
-- only relevant for the rare case a support agent genuinely needs to
-- see raw sensitive data (e.g. responding to a legal request).
CREATE TABLE break_glass_requests (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by     UUID NOT NULL REFERENCES admin_users(id),
  target_user_id   UUID REFERENCES users(id),
  reason           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  approved_by      UUID REFERENCES admin_users(id),
  approved_at      TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ,                -- access window closes automatically
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (requested_by IS DISTINCT FROM approved_by)  -- a requester can never approve their own request
);

-- Content review workflow — the real, server-side counterpart to the
-- frontend's clinical_review_status fields on journeys/notebooks/CBT
-- tools/overlays. `launch_enabled` replaces the hard-coded
-- JOURNEY_LAUNCH_CONFIG / NOTEBOOK_LAUNCH_CONFIG JS objects once wired.
CREATE TABLE content_items (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type           TEXT NOT NULL CHECK (content_type IN ('journey', 'overlay', 'notebook', 'cbt_tool', 'library_article')),
  content_key            TEXT NOT NULL,        -- matches journey_key / template_key / overlay_key in the frontend registry
  content_version        TEXT NOT NULL,
  clinical_review_status TEXT NOT NULL DEFAULT 'review_required' CHECK (clinical_review_status IN ('review_required', 'approved', 'rejected', 'retired')),
  reviewer_admin_id      UUID REFERENCES admin_users(id),
  reviewed_at            TIMESTAMPTZ,
  review_notes           TEXT,
  launch_enabled         BOOLEAN NOT NULL DEFAULT false,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (content_type, content_key, content_version)
);

-- Anonymized, categorical-only crisis-path telemetry — NEVER joined to
-- a specific user in this table. Purpose: let admins see "how often is
-- the safety path triggering" without seeing who or what was written.
CREATE TABLE crisis_trigger_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_source  TEXT NOT NULL,               -- 'phq9_item9' | 'chat_keyword' | 'journal_keyword' | 'manual_button' | ...
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_crisis_events_time ON crisis_trigger_events (occurred_at DESC);

-- Bulk broadcast email history. This is a genuinely real email
-- delivery (via Resend), NOT a connection to the consumer app's
-- in-app notification bell — that bell is currently local-only
-- client-side state with no backend sync, documented honestly in
-- notifications/README.md.
CREATE TABLE broadcast_notifications (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject          TEXT NOT NULL,
  message          TEXT NOT NULL,               -- plain text as written by the admin; HTML wrapping happens at send time
  audience         TEXT NOT NULL CHECK (audience IN ('all', 'active_subscribers', 'trial_or_free')),
  recipient_count  INTEGER NOT NULL DEFAULT 0,
  failed_count     INTEGER NOT NULL DEFAULT 0,
  sent_by          UUID REFERENCES admin_users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_broadcast_notifications_time ON broadcast_notifications (created_at DESC);

-- ============================================================
-- Row-Level Security — commented out until the app connects through
-- a per-request-scoped Postgres role (see db/README.md). Uncomment
-- and adapt once that's in place; until then this is documentation
-- of intent, not active enforcement.
-- ============================================================
-- ALTER TABLE daily_logs ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY daily_logs_owner ON daily_logs
--   USING (user_id = current_setting('app.current_user_id')::uuid);
--
-- ALTER TABLE screenings ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY screenings_owner ON screenings
--   USING (user_id = current_setting('app.current_user_id')::uuid);

-- ============================================================
-- Hardening the audit log against tampering — run this once you have
-- a dedicated, non-superuser database role that the Node app connects
-- as (replace app_role with that role's actual name):
-- ============================================================
-- REVOKE UPDATE, DELETE ON admin_access_log FROM app_role;
-- GRANT INSERT, SELECT ON admin_access_log TO app_role;

-- ============================================================
-- Seed data — starting plans, matching the values that used to be
-- hardcoded in payments/routes.js. Edit these from the admin panel's
-- Plans page after launch; this seed just keeps a fresh install
-- behaving the same as before the plans-table migration.
-- ============================================================
INSERT INTO subscription_plans (plan_key, name, price_sar, duration_days, features, display_order) VALUES
  ('monthly', 'الباقة الشهرية', 29.00, 30,
    ARRAY['كل أدوات كنف الأربع', 'بوصلة كنف الكاملة', 'كل رحلات كنف ودفاترها', 'مناقشة سند غير محدودة'], 1),
  ('6_months', 'باقة 6 أشهر', 139.00, 182,
    ARRAY['كل مميزات الباقة الشهرية', 'خصم مقارنة بالدفع الشهري', 'أرشيف بوصلة كنف الكامل'], 2),
  ('annual', 'الباقة السنوية', 229.00, 365,
    ARRAY['كل مميزات باقة 6 أشهر', 'أكبر خصم متاح', 'أولوية بدعم العملاء'], 3);
