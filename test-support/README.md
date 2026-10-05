# بيئة الاختبار المعزولة — test-support/

> **لا يُشغَّل أي ملف `test-*.mjs` على قاعدة الإنتاج.** كل ملف يستورد
> الحارس `test-support/guard.mjs` أول سطر، والحارس يُنهي العملية برمز
> 97 قبل أي اتصال كاتب إن لم يكن الهدف قاعدة اختبار معلنة.

## لماذا
في 10 أغسطس 2026 شُغّل ملف اختبار على قاعدة الإنتاج فدهس تواريخ تسجيل
مستخدمين حقيقيين. وثلاثة ملفات (الفوترة، الصمود، المحتوى) فيها عبارات
تمحو كل المستخدمين أو تعيد ترقيم الفواتير الضريبية أو تطفئ الكتالوج
كله لو وصلت إلى قاعدة حية.

## ما يشترطه الحارس (كله، لا واحد منه)
| الشرط | يفشل مغلقاً عند |
|---|---|
| `TEST_DATABASE_URL` | غيابه — لا fallback إلى `DATABASE_URL` أبداً |
| لا بيئة مختلطة | `DATABASE_URL` مضبوط بقيمة مختلفة |
| المضيف | غير loopback/مقبس محلي، أو أي مضيف إنتاج معروف (kanaf.me، onrender.com…) حتى لو أُعلن |
| الدور | `kanaf_adel` أو `postgres` بالاسم، أو أي دور superuser فعلياً (من pg_roles) |
| علامة البيئة | غياب جدول `kanaf_test_env_marker` أو nonce لا يطابق `KANAF_TEST_MARKER` |
| المزودات | مفتاح دفع `sk_live_`، أو `NODE_ENV=production`؛ وتُفرَّغ أسرار SMTP/VAPID/Anthropic |
| الشبكة | أي اتصال TCP/TLS إلى غير loopback يُرفض داخل العملية |
| قاعدة مخصّصة | الملفات التي تكتب كتابات عامة (`requireDedicatedDatabase`) ترفض قاعدة لم تُنشأ لها |

## التشغيل (مرة لكل بيئة)
1. عنقود PostgreSQL محلي **مخصّص للاختبار** (لا يحوي قواعد أخرى).
2. `SUPERUSER_URL=postgresql://<su>:<pass>@127.0.0.1:<port>/postgres node test-support/setup-isolated-db.mjs`
   - ينشئ دور تشغيل `kanaf_runtime_test` (بلا superuser)، ويطبّق `db/schema.sql`
     بالمستخدم الفائق (يحاكي `postgres` مالك الجداول الأصلية)، ثم الترحيلات
     بدور التشغيل — فيختبر قيد الملكية وترتيب الترحيلات معاً.
3. `node test-support/guard-negative-tests.mjs` — يجب أن ينجح كله قبل أي اختبار كاتب.
4. `node test-support/run-tests.mjs` — قاعدة جديدة لكل ملف من القالب، تُحذف بعده.
   السجلات في `test-support/.local/logs/` (مستثنى من git).
5. `node test-support/check-guard-imports.mjs` — كل ملف اختبار محروس.

PDF: إن لم يكن chrome-headless-shell منزّلاً عبر puppeteer، اضبط
`PUPPETEER_EXECUTABLE_PATH` إلى متصفح محلي قبل الخطوة 4.

## ما لا يحميه الحارس
- لا يمنع شخصاً يملك سر الإنتاج من الاتصال بالإنتاج بأداة أخرى (psql).
- الحماية داخل عملية Node التي استوردت الحارس فقط.
