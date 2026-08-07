import express from "express";
import { authRouter } from "./auth/routes.js";
import { query } from "./db/pool.js";

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use("/api/auth", authRouter);
const server = app.listen(4557);
const B = "http://127.0.0.1:4557/api/auth";

const sent = [];
const realLog = console.log;
console.log = (...a) => { const l = a.join(" "); if (l.includes("[dev] Would send")) sent.push(l); };
console.error = () => {};

const post = async (p, b, h = {}) => {
  const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const get = async (p, h = {}) => {
  const r = await fetch(B + p, { headers: h });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

function codeFor(email, label) {
  const entry = [...sent].reverse().find((m) => m.includes(email) && m.includes(label));
  if (!entry) return null;
  return (/: (\d{6})/.exec(entry) || [])[1] || null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const log = (label, cond, extra = "") => results.push([label, cond, extra]);

async function signUp(email, name, password) {
  await post("/register", { name, email, password, confirmedAdult: true, agreedPolicy: true });
  const code = codeFor(email, "كود تأكيد");
  const r = await post("/verify-email", { email, code });
  return r.body;
}

async function run() {
  const EMAIL = "reset@example.com";
  const OLD = "old-kanaf-pass-1";
  const NEW = "new-kanaf-pass-2";

  const session = await signUp(EMAIL, "مها", OLD);
  log("setup: verified account with a live session", !!session.accessToken);

  // 1. forgot-password always answers ok
  let r = await post("/forgot-password", { email: EMAIL });
  log("forgot-password -> 200 ok", r.status === 200 && r.body.ok === true, JSON.stringify(r.body));

  r = await post("/forgot-password", { email: "does-not-exist@example.com" });
  log("unknown address gives the identical response", r.status === 200 && r.body.ok === true, JSON.stringify(r.body));

  await sleep(300); // the route replies before sending; let the send finish
  const resetCode = codeFor(EMAIL, "كود استعادة");
  log("reset code was mailed", Boolean(resetCode), String(resetCode));
  log("no code mailed to the unknown address", !sent.some((m) => m.includes("does-not-exist@example.com")));

  // 2. A signup code must not work as a reset code
  const signupCode = codeFor(EMAIL, "كود تأكيد");
  r = await post("/reset-password", { email: EMAIL, code: signupCode, newPassword: NEW });
  log("signup code rejected for reset (purposes are separate)", r.status === 400, JSON.stringify(r.body));

  // 3. Wrong reset code
  r = await post("/reset-password", { email: EMAIL, code: "000000", newPassword: NEW });
  log("wrong reset code rejected", r.status === 400 && r.body.error === "incorrect", JSON.stringify(r.body));

  // 4. Weak new password refused before the code is spent
  r = await post("/reset-password", { email: EMAIL, code: resetCode, newPassword: "short" });
  log("weak new password refused", r.status === 400 && r.body.error === "password_too_short", JSON.stringify(r.body));

  // 5. Real reset
  r = await post("/reset-password", { email: EMAIL, code: resetCode, newPassword: NEW });
  log("reset succeeds and returns a session", r.status === 200 && !!r.body.accessToken, JSON.stringify(r.body).slice(0, 90));
  const newSession = r.body;

  // 6. Old password dead, new one works
  r = await post("/login", { email: EMAIL, password: OLD });
  log("old password no longer works", r.status === 401, String(r.status));
  r = await post("/login", { email: EMAIL, password: NEW });
  log("new password works", r.status === 200, String(r.status));

  // 7. THE IMPORTANT ONE — the pre-reset session must be evicted
  r = await post("/refresh", { refreshToken: session.refreshToken });
  log("pre-reset refresh token was revoked", r.status === 401, JSON.stringify(r.body));

  // 8. The session handed back by reset itself still works
  r = await post("/refresh", { refreshToken: newSession.refreshToken });
  log("session issued by reset is usable", r.status === 200, String(r.status));

  // 9. Reset code is single-use
  r = await post("/reset-password", { email: EMAIL, code: resetCode, newPassword: "third-kanaf-pass-3" });
  log("reset code cannot be replayed", r.status === 400 && r.body.error === "no_code", JSON.stringify(r.body));

  // 10. Reset clears a lockout
  for (let i = 0; i < 8; i++) await post("/login", { email: EMAIL, password: "wrong-attempt-here" });
  r = await post("/login", { email: EMAIL, password: NEW });
  log("account locked after 8 failures", r.status === 429 && r.body.error === "account_locked", JSON.stringify(r.body));

  // The 60s per-address reset cooldown is real, so wait it out rather
  // than pretending it isn't there.
  await sleep(61000);
  await post("/forgot-password", { email: EMAIL });
  await sleep(300);
  const code2 = codeFor(EMAIL, "كود استعادة");
  log("second reset code issued despite the lockout", Boolean(code2) && code2 !== resetCode);
  r = await post("/reset-password", { email: EMAIL, code: code2, newPassword: "fourth-kanaf-pass-4" });
  log("reset works while locked out", r.status === 200, JSON.stringify(r.body).slice(0, 70));
  r = await post("/login", { email: EMAIL, password: "fourth-kanaf-pass-4" });
  log("lockout cleared by the reset", r.status === 200, JSON.stringify(r.body).slice(0, 70));

  // 11. Unverified accounts get no reset code
  await post("/register", { name: "غير مؤكد", email: "pending@example.com", password: OLD, confirmedAdult: true, agreedPolicy: true });
  r = await post("/forgot-password", { email: "pending@example.com" });
  await sleep(300);
  log("unverified account: same ok response", r.status === 200 && r.body.ok === true);
  log("unverified account: no reset code sent", !sent.some((m) => m.includes("pending@example.com") && m.includes("كود استعادة")));

  // 12. change-password also evicts other sessions
  const s1 = await post("/login", { email: EMAIL, password: "fourth-kanaf-pass-4" });
  const s2 = await post("/login", { email: EMAIL, password: "fourth-kanaf-pass-4" });
  r = await post("/change-password",
    { currentPassword: "fourth-kanaf-pass-4", newPassword: "fifth-kanaf-pass-5" },
    { Authorization: `Bearer ${s2.body.accessToken}` });
  log("change-password succeeds", r.status === 200 && !!r.body.accessToken, JSON.stringify(r.body).slice(0, 70));
  const other = await post("/refresh", { refreshToken: s1.body.refreshToken });
  log("change-password evicts the other session", other.status === 401, JSON.stringify(other.body));

  r = await post("/change-password",
    { currentPassword: "wrong-current-pass", newPassword: "sixth-kanaf-pass-6" },
    { Authorization: `Bearer ${s2.body.accessToken}` });
  log("change-password needs the current password", r.status === 401, String(r.status));

  r = await post("/change-password",
    { currentPassword: "whatever", newPassword: "seventh-kanaf-pass-7" },
    { Authorization: "Bearer not-a-real-token" });
  log("malformed token -> 401, not 500", r.status === 401, JSON.stringify(r.body));

  r = await post("/change-password", { currentPassword: "whatever", newPassword: "eighth-kanaf-pass-8" });
  log("missing token -> 401", r.status === 401, String(r.status));

  // 13. Signup cooldown doesn't block a reset
  const FRESH = "cooldown@example.com";
  await signUp(FRESH, "ريم", OLD);
  r = await post("/forgot-password", { email: FRESH });
  await sleep(300);
  log("reset works right after signup (separate cooldowns)", Boolean(codeFor(FRESH, "كود استعادة")));

  console.log = realLog;
  let pass = 0, fail = 0;
  for (const [label, cond, extra] of results) {
    if (cond) { pass++; console.log(`  PASS  ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` (got: ${extra})` : ""}`); }
  }
  console.log(`\n  ${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.log = realLog; console.error(e); server.close(); process.exit(1); });
