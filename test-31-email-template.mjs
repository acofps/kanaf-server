import "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد
/**
 * اختبارات قبول KANAF-ORD-0008 §9 — قالب البريد الموحّد.
 *  T) رابط الإلغاء إلزامي في التسويقية ومحظور في رسائل الخدمة؛ الشعار مرفق cid لا رابط شبكة؛ كل نص مُهرَّب.
 *  L) روابط التذييل لا تظهر قبل ضبطها، ولا يقبل الإعداد إلا نطاق المتجر الرسمي.
 */
const { query, pool } = await import("./db/pool.js");
const { renderEmail, footerLinks, serviceEmailExtra, LOGO_CID } = await import("./notifications/email-template.js");
const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
try {
  const svc = renderEmail({ title: "كود", text: "x", kind: "service" });
  ok("T1 رسالة خدمة بلا رابط إلغاء اشتراك", !/إلغاء الاشتراك|unsubscribe/i.test(svc.html));
  const mk = renderEmail({ title: "عرض", text: "x", kind: "marketing", unsubscribeUrl: "https://e.invalid/u?t=1" });
  ok("T2 التسويقية تحمل رابط الإلغاء", mk.html.includes("https://e.invalid/u?t=1") && mk.html.includes("إلغاء الاشتراك"));
  let threw = false; try { renderEmail({ title: "a", text: "b", kind: "marketing" }); } catch { threw = true; }
  ok("T3 تسويقية بلا رابط إلغاء → ترفض البناء", threw);
  ok("T4 الشعار مرفق cid، ولا صورة من الشبكة", svc.html.includes(`cid:${LOGO_CID}`) && svc.attachments[0].cid === LOGO_CID && svc.attachments[0].content.length > 1000 && !/<img[^>]+src="https?:/.test(svc.html));
  const x = renderEmail({ title: "<script>alert(1)</script>", text: '<img src=x onerror=alert(1)> "q"', kind: "service" });
  ok("T5 العنوان والنص مُهرَّبان", !x.html.includes("<script>") && !x.html.includes("<img src=x") && x.html.includes("&lt;script&gt;"));

  /* L) روابط التذييل */
  await query(`UPDATE app_settings SET value = 'null'::jsonb WHERE key IN ('app_store_url','google_play_url','social_tiktok_handle','social_x_handle','social_instagram_handle')`);
  let links = await footerLinks();
  const none = renderEmail({ title: "a", text: "b", kind: "service", links });
  ok("L1 قبل الضبط: لا زر متجر ولا حساب", !links.appStore && !links.googlePlay && links.social.length === 0 && !none.html.includes("App Store"));
  await query(`UPDATE app_settings SET value = to_jsonb($1::text) WHERE key = 'app_store_url'`, ["https://evil.example/apps.apple.com"]);
  await query(`UPDATE app_settings SET value = to_jsonb($1::text) WHERE key = 'google_play_url'`, ["https://play.google.com/store/apps/details?id=x"]);
  await query(`UPDATE app_settings SET value = to_jsonb($1::text) WHERE key = 'social_tiktok_handle'`, ["../evil"]);
  links = await footerLinks();
  ok("L2 رابط بنطاق غير رسمي أو معرّف بمحارف خارج القائمة البيضاء يُسقط ولا يُعرض", links.appStore === null && links.googlePlay === "https://play.google.com/store/apps/details?id=x" && links.social.length === 0, JSON.stringify(links));
  const extra = await serviceEmailExtra("عنوان", "نص");
  ok("L3 رسالة الخدمة الفعلية تحمل زر Google Play المضبوط وحده", extra.html.includes("Google Play") && !extra.html.includes("App Store"));

  /* V) مدقّقات الإعدادات الجديدة */
  process.env.ADMIN_JWT_SECRET ||= "x".repeat(64);
  const { SETTINGS_REGISTRY } = await import("./admin/settings.js");
  const keys = SETTINGS_REGISTRY.map((s) => s.key);
  ok("V1 الإعدادات الثلاثة مسجّلة وقابلة للتعديل من اللوحة", ["app_store_url", "google_play_url", "social_tiktok_handle"].every((k) => keys.includes(k)));
} catch (e) { R.push(["!! stopped: " + String(e.stack || e).slice(0, 300), false]); }
let p = 0, f = 0;
for (const [l, c, x] of R) { if (c) { p++; console.log(`  PASS  ${l}`); } else { f++; console.log(`  FAIL  ${l}${x ? `  (${x})` : ""}`); } }
console.log(`\n  ${p} passed, ${f} failed`);
await pool.end().catch(() => {});
process.exit(f ? 1 : 0);
