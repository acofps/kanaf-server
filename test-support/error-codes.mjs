/* ============================================================
   رموز الأخطاء التي يردّها الخادم — KANAF-ORD-0015 §2.4

   قراءة ثابتة للكود (بلا تشغيل): كل رمز يُنتَج حرفياً بأحد الأشكال الأربعة
     json({ error: "x" }) · httpError(4xx, "x") · new Error("x") · bad("x")
   ثم الرموز المبنية بقالب (invalid_${k}) موسَّعة بقيمها المعروفة.
   «يصل اللوحة» = يُنتَج في admin/* أو في وحدة مشتركة تناديها مسارات اللوحة.
   ============================================================ */
import fs from "node:fs";
import { execFileSync } from "node:child_process";

export const PANEL_SHARED = ["billing/discounts.js", "payments/refund.js", "notifications/messages.js", "notifications/service.js",
  "notifications/push.js", "integrations/crypto.js", "invoicing/slot.js", "auth/tokens.js", "billing/autorenew.js"];
/* الرموز المبنية بقالب، بقيمها: admin/user-edit (أعلام منطقية)، admin/content (وقتا الجدولة)، admin/sent-messages (الفلاتر). */
export const DYNAMIC = {
  "admin/user-edit.js": ["invalid_remindersOn", "invalid_marketingOptOut", "member_password_too_short", "member_password_too_long", "member_password_too_common"],
  "admin/content.js": ["invalid_publish_at", "invalid_unpublish_at"],
  "admin/sent-messages.js": ["invalid_source", "invalid_channel", "invalid_status"],
};
/* مدقّقا ملف العضو اللذان تناديهما admin/user-edit من userdata/routes.js. */
const SHARED_FUNCS = [["userdata/routes.js", "export async function validateProfilePatch"], ["userdata/routes.js", "export async function storeAvatar"]];

const C = "([a-z][a-z0-9]*(?:_[a-z0-9]+)+|[a-z]{4,})";
const PATS = [`error:\\s*["'\`]${C}["'\`]`, `httpError\\(\\s*\\d+\\s*,\\s*["'\`]${C}["'\`]`, `new Error\\(\\s*["'\`]${C}["'\`]\\s*\\)`, `\\bbad\\(\\s*["'\`]${C}["'\`]`].map((p) => new RegExp(p, "g"));
const codesIn = (src) => new Set(PATS.flatMap((re) => [...src.matchAll(re)].map((m) => m[1])));

export function serverFiles() {
  return execFileSync("git", ["ls-files", "*.js"], { encoding: "utf8" }).split("\n")
    .filter((f) => f && !/^(admin-ui|admin-src)\//.test(f) && !f.startsWith("test") && !f.startsWith("ops/check") && !f.startsWith("ops/rollback"));
}

/** { all: Map<code, Set<file>>, panel: Map<code, Set<file>> } */
export function extractCodes() {
  const all = new Map(), panel = new Map();
  const add = (m, c, f) => { if (!m.has(c)) m.set(c, new Set()); m.get(c).add(f); };
  for (const f of serverFiles()) {
    const src = fs.readFileSync(f, "utf8");
    const isPanel = f.startsWith("admin/") || PANEL_SHARED.includes(f);
    for (const c of codesIn(src)) { add(all, c, f); if (isPanel) add(panel, c, f); }
    for (const c of DYNAMIC[f] || []) { add(all, c, f); add(panel, c, f); }
  }
  for (const [f, head] of SHARED_FUNCS) {
    const src = fs.readFileSync(f, "utf8"); const i = src.indexOf(head);
    if (i < 0) throw new Error(`${f}: ${head} not found`);
    const body = src.slice(i, src.indexOf("\nexport ", i + head.length) > 0 ? src.indexOf("\nexport ", i + head.length) : undefined);
    for (const c of codesIn(body)) add(panel, c, `${f}#${head.split(" ").pop()}`);
  }
  return { all, panel };
}
