-- ============================================================
-- 023 — سجلّ أخطاء النظام (KANAF-ORD-0013 §11)
--
-- على نمط سجلّي الإجراءات والوصول: جدول بسيط يُقرأ بصفحات في اللوحة.
-- 🔴 لا يُخزَّن فيه إلا ما نُقّي (ops/error-log.js): لا بيانات شخصية،
--    ولا نص مستخدم، ولا رمز أو سرّ، ولا سلسلة اتصال.
-- المتكرر صفّ واحد: fingerprint فريد، بعدّاد وأول/آخر ظهور — خطأ يتكرر آلاف
-- المرات لا يملأ القاعدة. والسقف ودورة التنظيف في ops/error-log.js.
-- ============================================================
CREATE TABLE IF NOT EXISTS system_errors (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint   TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL,              -- اسم الخطأ أو رمزه (TypeError، 23505…)
  message       TEXT NOT NULL,              -- منقّاة، بحدّ 500 حرف
  stack         TEXT,                       -- منقّاة، بحدّ 4000 حرف
  location      TEXT NOT NULL,              -- المسار أو العملية: "GET /admin/users/:id" أو "admin/users:detail"
  http_status   INTEGER,
  count         INTEGER NOT NULL DEFAULT 1,
  first_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_system_errors_last_seen ON system_errors (last_seen DESC);
