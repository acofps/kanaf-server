-- 003_admin_user_operations.sql
-- Phase 2: account suspension state + an audit log for admin MUTATIONS.
--
-- Safe to run more than once. Apply with:  node db/migrate.js

/* ---------------------------------------------------------
   SUSPENSION STATE

   Lives on user_auth_state, not on users, for the reason documented
   in 002: the original 15 tables are owned by the `postgres`
   superuser and the app connects as `kanaf_adel`, so ALTER TABLE on
   users fails with "must be owner of relation". user_auth_state is
   owned by kanaf_adel, so it CAN be altered — which makes it the
   right home for any new per-user auth state.

   Deliberately NOT a free-text `status` column. Account status is
   DERIVED at read time from facts that already exist:

     deleted_at IS NOT NULL        -> deleted
     suspended_at IS NOT NULL      -> suspended
     email_verified_at IS NULL     -> pending_verification
     otherwise                     -> active

   A stored status column would be a second source of truth that can
   drift out of step with deleted_at and email_verified_at. Deriving
   it means the four states can never contradict the underlying data.
--------------------------------------------------------- */
ALTER TABLE user_auth_state ADD COLUMN IF NOT EXISTS suspended_at     TIMESTAMPTZ;
ALTER TABLE user_auth_state ADD COLUMN IF NOT EXISTS suspended_reason TEXT;
ALTER TABLE user_auth_state ADD COLUMN IF NOT EXISTS suspended_by     UUID;

CREATE INDEX IF NOT EXISTS idx_user_auth_state_suspended
  ON user_auth_state (suspended_at)
  WHERE suspended_at IS NOT NULL;

/* ---------------------------------------------------------
   ADMIN MUTATION LOG

   Separate from admin_access_log on purpose, and this is a design
   decision rather than a workaround:

   - admin_access_log answers "who READ sensitive data, and why".
     It is insert-only, has no before/after columns, and its existing
     contract is relied on by /admin/access-log. Adding columns to it
     is impossible anyway (owned by postgres).
   - admin_action_log answers "who CHANGED state, from what, to what".

   Conflating reads and writes in one table would make both harder to
   query and would force nullable before/after columns onto every
   read entry.

   No foreign key to admin_users: REFERENCES on that table is not
   confirmed for kanaf_adel, and a migration that might fail on a
   privilege check is worse than a log that stores the id plainly.
   The id always originates from a verified admin JWT, and this table
   is insert-only, so the integrity risk is minimal. The FK to users
   IS present — REFERENCES on users is confirmed.
--------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS admin_action_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id   UUID NOT NULL,
  target_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  action          TEXT NOT NULL,
  old_value       JSONB,
  new_value       JSONB,
  reason          TEXT NOT NULL,
  metadata        JSONB,
  ip_address      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_action_log_target
  ON admin_action_log (target_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_action_log_admin
  ON admin_action_log (admin_user_id, created_at DESC);

/* ---------------------------------------------------------
   NOTE ON INDEXES FOR THE USERS LIST

   The users list searches with ILIKE '%term%' on name and email.
   A trigram index would make that fast, but CREATE INDEX requires
   ownership of the table — so no index can ever be added to users
   by this application. See 02_USER_ADMIN_OPERATIONS_AUDIT.md for the
   measured impact and the threshold at which it starts to matter.
--------------------------------------------------------- */
