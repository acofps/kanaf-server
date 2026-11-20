# دليل الإصدار — «تنفس» إلى الإنتاج (KANAF-ORD-0012 §6)

> **هذا دليل تحضير، وليس إذناً بالنشر.** المالك وحده يقرّر متى يبدأ. لم يُنفَّذ أي سطر منه على الإنتاج. ولم يتصل كاتبه بقاعدة الإنتاج ولا بخادمه.

**المرشح:** الفرع `rebrand/tanaffus`. هو ما يُدمج في `main` في الخطوة 4، ورأسه ورأس `release/ord-0012` واحد.
**الحزمة شُغّلت على** `3708732`: ‏983 ناجحاً، و0 فاشلاً، في 38 ملفاً.
- وما بعدها نسختان: `1938146` تمسّ المسبار وحده، وهو أداة تشخيص لا تعمل على الخادم. ثم وثائق.
- فلا شيء بعد `3708732` يغيّر سلوك الإنتاج.
**تحضير المرحلة الأولى:** `n03-prep-v2-22fead5` عند `4e4679a`. هو `22fead5` نفسه، وفوقه ملفات الترحيل العشرة وحدها.
**الإنتاج اليوم:** `main` = `22fead5`.

## كيف تقرأ كل خطوة

| | |
|---|---|
| **افعل** | الإجراء نفسه. كل أمر سطر واحد، يُلصق في Render ← `kanaf-server` ← **Shell**. |
| **النجاح** | ما يجب أن تراه حرفياً. |
| **إن فشل** | ماذا تفعل، وما الذي لا تفعله. |

**قاعدتان لكل الأوامر:**
- لا تكتب أي سرّ في الأمر. الأوامر تقرأ `SETUP_TOKEN` و`DATABASE_URL` من بيئة الخدمة، ولا تطبعهما.
- إن قالت رسالة `pg module not found`، نفّذ `cd /opt/render/project/src` ثم أعد الأمر.

---

## الخطوة 0 — نسخة احتياطية، مُتحقَّق منها باستعادة فعلية

**افعل:**
1. اطلب من dimofinf بتذكرة: «نسخة كاملة (`pg_dump --format=custom`) لقاعدة `kanaf_kanaf`، ثم استعادتها في قاعدة مؤقتة جديدة على الخادم نفسه، وإرسال ناتج هذا الاستعلام من القاعدتين معاً»:
   ```sql
   SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname;
   ```
2. احفظ ملف النسخة عندك، خارج الخادم.

**النجاح:**
- القائمتان متطابقتان: الجداول نفسها، وأعداد الصفوف نفسها.
- وسجل الترحيلات في النسخة المستعادة 9 صفوف: `002…010` و`DB006`.

**إن فشل:** لا تتقدّم. نسخة لم تُستعَد ليست نسخة. وهذا التمرين نفسه مُجرَّب محلياً على البنية نفسها (`test-support/restore-drill.mjs`): صفر فروق في الصفوف والمحتوى والتسلسلات والمالكين والصلاحيات وسجل الترحيلات.

> **لماذا بتذكرة؟** صدفة Render لا تحمل `pg_dump`. وقاعدة الإنتاج على خادم dimofinf.

---

## الخطوة 1 — `SETUP_TOKEN` موجود، والقاعدة كما نظن

**افعل (1-أ) — وجود المتغيّرات، بلا طباعة قيمها:**
```bash
node -e "for (const k of ['SETUP_TOKEN','DATABASE_URL','DB_SSL']) console.log(k, process.env[k] ? 'present' : 'MISSING')"
```

**النجاح:** ثلاثة أسطر، كلها `present`.

**إن فشل:** `SETUP_TOKEN MISSING` يعني أن مسار الترحيل سيرد `403 setup_disabled`. أضفه في Render ← Environment بقيمة عشوائية طويلة، مثل ناتج:
```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```
ثم انتظر إعادة التشغيل، وأعد 1-أ.

**افعل (1-ب) — المسبار، قراءة فقط** (إضافة مني على ترتيب الأمر: يحسم الملكية قبل أي ترحيل):
```bash
curl -sSL https://raw.githubusercontent.com/acofps/kanaf-server/19381461c85806e216e7e6513a50327dc7a9ef32/test-support/probe-ord0011.mjs -o /tmp/p.mjs && node /tmp/p.mjs
```
بديل إن لم يوجد `curl`:
```bash
node -e "fetch('https://raw.githubusercontent.com/acofps/kanaf-server/19381461c85806e216e7e6513a50327dc7a9ef32/test-support/probe-ord0011.mjs').then(r=>r.text()).then(t=>require('fs').writeFileSync('/tmp/p.mjs',t))" && node /tmp/p.mjs
```
بصمة الملف الصحيح `sha256 60a52aa47f534b18…82ffacb0`. تتحقق منها بـ`sha256sum /tmp/p.mjs`.

**النجاح — كل البنود معاً:**

| السطر | المطلوب |
|---|---|
| `SAFE` | `read_only=on` |
| `CONN` | `url_has_sslmode=false` و`encrypted=true` |
| `MIG applied` | `9: 002,003,004,005,007,008,009,010,DB006` |
| `MIG pending from 011-020` | العشرة كلها |
| `TBL users` | العمود الثالث فيه **`R`**، أي أن دور التطبيق يملك REFERENCES على `users` |
| `SEQVAL kanaf_invoice_number_seq` | `=3` |
| `NUMBERING` | `invoice_prefix=INV credit_note_prefix=CN token=KANAF` |

ويحسم المسبار ادعاء dimofinf عن الملكية في السطر `OWN all_tables_owned_by_app_role`.
- **إن كان `true`:** فالادعاء صحيح، و`R` موجودة على `users` حكماً.
- **وإن كان `false`:** فالشرط الوحيد الحاسم هو `R` على `users`.

جُرِّب النمطان كلاهما هنا (انظر `REHEARSAL.md`)، ونجحت الترحيلات العشرة في كلٍّ منهما.

**إن فشل:**
- **`R` ناقصة على `users`:** الترحيلة 011 ستفشل بالرسالة `permission denied for table users`. هذا مقيس في البروفة السلبية. **لا تتقدّم.** اطلب من dimofinf حرفياً:
  ```sql
  GRANT REFERENCES ON TABLE users TO kanaf_kanaf;
  ```
  ثم أعد المسبار.
- **`url_has_sslmode=true`:** احذف `?sslmode=…` من `DATABASE_URL`، وأبقِ `DB_SSL=true`. السبب: pg 8.22 يحوّل `sslmode=require` إلى تحقّق كامل من الشهادة، ويتجاهل `DB_SSL` (`.env.example`، ‏`db/pool.js`).
- **`MIG` أو `SEQVAL` غير المتوقَّع:** لا تتقدّم. والصق المخرَج كاملاً للمستشار.
  - `SEQVAL` أكبر من 3 يعني أن فاتورة صدرت بعد قراءة §1، فخطوة الترقيم ستتوقف وحدها.
- **`FAIL … certificate`:** هي مشكلة `sslmode` نفسها أعلاه.

---

## الخطوة 2 — دمج `n03-prep-v2-22fead5` في `main` (المرحلة 1: الترحيلات بالكود القديم)

**افعل:**
1. GitHub ← Pull requests ← New ← base: `main`، compare: `n03-prep-v2-22fead5`.
2. تحقّق أن تبويب **Files changed** يُظهر **10 ملفات، كلها في `db/migrations/`** (`011`…`020`)، ولا شيء غيرها.
3. ادمج.
4. Render ← Deploys: انتظر حالة **Live** للنشر الجديد.

**النجاح:**
- النشر Live.
- والتطبيق يعمل كما كان. فالكود هو `22fead5` حرفاً بحرف، ولم يُطبَّق شيء بعد.

**إن فشل:** هذه الخطوة لا تغيّر كوداً ولا مخططاً، فالفشل هنا فشل بناء على Render لا علاقة له بالملفات.
- اضغط **Rollback** على النشر السابق في Render.
- والقاعدة لم تُمسّ.

---

## الخطوة 3 — تشغيل الترحيلات `POST /api/setup/run-migrations`

> **مرة واحدة فقط، ولا تكرّر النقر.** مشغّل `22fead5` بلا قفل استشاري.
> - إن تزامن نداءان فلن يُطبَّق ملف مرتين. هذا مقيس في `n03-drill`: البنود S1c وS1d وS1e.
> - لكن قد يرد أحدهما 500. وحينها اذهب إلى 3-ب ولا تُعِد 3-أ.

**افعل (3-أ):**
```bash
node -e "fetch('https://kanaf-server.onrender.com/api/setup/run-migrations',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:process.env.SETUP_TOKEN})}).then(async r=>console.log(r.status,await r.text()))"
```

**النجاح:**
- `200 {"ok":true,"results":[…]}`.
- كل ملف من `011` إلى `020` حالته `"applied"`، والبقية `"skipped"`.
- الزمن المقيس للعشرة نحو 60ms على جداول شبه فارغة (`REHEARSAL.md`).

**افعل (3-ب) — التحقّق:**
```bash
node -e "fetch('https://kanaf-server.onrender.com/api/setup/migration-status?token='+encodeURIComponent(process.env.SETUP_TOKEN)).then(async r=>{const j=await r.json();console.log(r.status,(j.migrations||[]).filter(m=>!m.applied).map(m=>m.filename).join(',')||'NONE PENDING')})"
```

**النجاح:** `200 NONE PENDING`.

**وأعد المسبار** (الخطوة 1-ب). المطلوب:
- `MIG applied 19` و`pending … none`.
- وإن كانت الجداول الأصلية مملوكة للمستخدم الفائق، فالسطر `app_tables_fingerprint 39 #5571ac0795`.

**إن فشل:**
- **الرد `500` وفي `results` ملف حالته `"failed"`:**
  - الملف الفاشل لم يترك أثراً، فهو في معاملته. وما قبله طُبِّق وسُجِّل. والمشغّل توقّف عنده.
  - **التطبيق ما زال يعمل:** الكود `22fead5` لا يقرأ أي جدول جديد، ويعمل على المخطط المرحَّل كله (`n03-drill` R1a–R1c) فضلاً عن بعضه.
  - انسخ رسالة الخطأ.
  - إن كانت `permission denied for table users` فارجع إلى الخطوة 1-ب، واطلب الصلاحية من dimofinf. ثم أعد 3-أ مرة واحدة، فيستأنف من الملف الفاشل.
- **الرد `403 invalid_token`:** رمز الإعداد غير مطابق. لم يحدث شيء. راجع الخطوة 1-أ.
- **انقطاع بلا رد:** لا تعِد 3-أ. نفّذ 3-ب لترى ما طُبِّق.
- **لا تحاول أبداً** حذف صفوف من `schema_migrations`، ولا تعديل ملف ترحيل.

> **انتبه:** 3-ب بكود `22fead5` يمرّر الرمز في عنوان الطلب، فقد يظهر في سجلات طلبات Render. ولهذا بند في «يحتاج المالك»: تدوير `SETUP_TOKEN` بعد الإصدار.

---

## الخطوة 4 — دمج `rebrand/tanaffus` في `main` (المرحلة 2: الكود الجديد على مخطط جاهز)

**افعل:**
1. PR: base `main`، وcompare `rebrand/tanaffus`.
   - الدمج نظيف بلا تعارض. ملفات الترحيل العشرة متطابقة بايتاً ببايت على الجانبين.
   - وشجرة الناتج مطابقة لشجرة المرشح تماماً، وهذا مقيس بـ`git merge-tree`.
2. ادمج، وانتظر **Live**.
3. أعد 3-ب.

**النجاح:**
- `NONE PENDING`، فلا ترحيل معلّق ولا نافذة.
- وفي سجل الإقلاع على Render:
  - `[invoice] مولّد الفواتير جاهز (… بايت في …ms).`
  - و`SMTP is not configured — …`، وهو متوقَّع حتى الخطوة 6.
- ودخول اللوحة يعمل.

**إن فشل** (مثلاً: دخول اللوحة 500، أو السجل يحمل `مولّد الفواتير غير جاهز`):
- **التراجع:** Render ← Deploys ← النشر السابق (كود prep) ← **Rollback**. أو Revert للـPR في GitHub.
  - الكود القديم يعمل على المخطط الجديد. والأحداث المحجوزة تبقى كما هي: `n03-drill` R2a–R2d.
  - ولا تتراجع عن أي ترحيلة. انظر «التراجع لكل ترحيلة» أدناه.
- **المولّد غير جاهز:**
  - السبب الوحيد المعروف: أمر البناء لم ينزّل متصفّح puppeteer الجديد. ترقية الحزم رفعت puppeteer من 25.12.0 إلى 25.18.1، فصار المتصفّح المطلوب `chrome-headless-shell 157.0.8103.78`.
  - **ما جُرِّب:** نُزِّل هذا المتصفّح هنا بنفس آلية puppeteer، ورسم الفواتير به وحده (بلا Chrome النظام) نجح 56/56.
  - **العلاج:** Render ← Manual Deploy ← **Clear build cache & deploy**.

---

## الخطوة 5 — ترقيم «تنفس» يبدأ من 1 (`ops/tnfs-numbering.mjs`)

> **صيغة الرقم محسومة بقرار المالك D-TN-05** (`DECISIONS.md`): `TNFS-INV-000001` للفواتير، و`TNFS-CN-000001` للإشعارات الدائنة، ولا تعديل على `formatDocumentNumber`. **لا يُعاد فتحها هنا.**

> **مباشرة بعد الخطوة 4، وقبل أي عملية دفع.**
> - **السبب:** كل فاتورة تصدر بينهما ترفع العدّاد إلى 4، فيتوقف الأمر وحده. وحينها يعود القرار إليك.
> - **مقيس على قاعدة معزولة:** `test-34-tnfs-numbering.mjs`، ‏13/13.

**افعل (5-أ) — تجربة لا أثر لها:**
```bash
cd /opt/render/project/src && node ops/tnfs-numbering.mjs
```

**النجاح:** هذه الأسطر بالترتيب.
```
BEFORE prefixes=INV/CN token=KANAF invoice_seq=3(called=true) … next_invoice=INV-KANAF-000004 next_credit_note=CN-KANAF-000001
AFTER  prefixes=TNFS-INV/TNFS-CN token=NULL invoice_seq=1(called=false)[would-be] … next_invoice=TNFS-INV-000001 next_credit_note=TNFS-CN-000001
DRY-RUN rolled back — nothing changed. Re-run with --apply to commit.
```

**افعل (5-ب) — التثبيت:**
```bash
cd /opt/render/project/src && node ops/tnfs-numbering.mjs --apply
```

**النجاح:**
- `APPLIED committed`.
- ثم `AFTER … next_invoice=TNFS-INV-000001 next_credit_note=TNFS-CN-000001`.

**إن فشل:**
- **`STOP …`:** لم يتغيّر شيء. السطر يقول السبب حرفياً:
  - العدّاد ليس 3.
  - أو تسلسل الإشعارات الدائنة مُستعمَل.
  - أو وثيقة `TNFS-` موجودة.

  كلها قرار جديد لك، لا يُتّخذ في الصدفة.
- **`FAIL commit failed, invoice sequence restored to 3`:** البادئتان لم تتغيّرا، وأُعيد العدّاد صراحةً إلى 3.
  - السبب أن `setval` لا يتراجع مع المعاملة. هذا مقيس، وهو العطب الذي كشفه `test-34` في مسودتي الأولى.
  - أعد المسبار وتأكد من `SEQVAL …=3`.
  - هذا الفرع وحده غير مُختبَر آلياً، لأن فشل COMMIT يصعب افتعاله.

**ما لا يُمسّ:** الفواتير الثلاث الصادرة تبقى `INV-KANAF-000001…3` كما هي. لا يُعاد توليد شيء. ولا يُمسّ `zatca_*_seq` القديمان.

---

## الخطوة 6 — متغيّرات البريد على Render

**قبلها:** سجلات DNS في `DNS_RECORDS.md` مطبَّقة عند dimofinf، وتعيد القيم المطلوبة.

**افعل:** Render ← Environment. أضف هذه المتغيّرات ولا تغيّر غيرها:

| المتغيّر | القيمة |
|---|---|
| `SMTP_HOST` | `mail.tanfs.net` |
| `SMTP_PORT` | `465` |
| `SMTP_USER` | `noreply@tanfs.net` |
| `SMTP_PASS` | كلمة مرور صندوق `noreply@tanfs.net`. تكتبها أنت في Render وحده |
| `EMAIL_FROM` | `تنفس <noreply@tanfs.net>` |

**النجاح:** بعد إعادة التشغيل، سجل الإقلاع فيه `SMTP connection verified.`

**إن فشل:**
- **`SMTP verification FAILED — … certificate` أو `altnames`:** شهادة الخادم لا تشمل `mail.tanfs.net`.
  - اطلب من dimofinf إصدار AutoSSL لـ`mail.tanfs.net`.
  - أو اطلب اسم مضيف الخادم الذي تغطيه شهادته، وضعه في `SMTP_HOST`.
  - **لا** تعطّل التحقق من الشهادة.
- **`Invalid login` أو `535`:** كلمة المرور. أعد ضبطها من cPanel ← Email Accounts.
- **`ETIMEDOUT`:** المنفذ 465 محجوب. جرّب `SMTP_PORT=587`، فالكود يستعمل STARTTLS تلقائياً على غير 465.

---

## الخطوة 7 — فحوص ما بعد النشر

انظر `POST_DEPLOY_CHECKLIST.md`.

---

## التراجع لكل ترحيلة — بصدق

**المبدأ:**
- **نتراجع عن الكود لا عن الترحيلات.** كل الترحيلات العشر إضافية: جداول جديدة، أو صفوف إعداد جديدة، أو قيد CHECK يُوسَّع.
- الكود القديم (`22fead5`) يتجاهلها كلها. هذا مُختبَر: تراجع المرحلتين في `n03-drill`.
- وحذفها لا يعيد شيئاً للكود القديم، ويُتلف ما كُتب فيها بعد النشر.

| الترحيلة | ما تضيفه | التراجع لو أُصرّ عليه | الثمن |
|---|---|---|---|
| 011 | `user_safety_plans`، `user_support_contacts`، `account_deletion_requests` | `DROP TABLE` للثلاثة، ثم حذف صف `011_…` من `schema_migrations` | **تُفقد خطط الأمان وطلبات الحذف المكتوبة بعد النشر.** لا يُنصح |
| 012 | صف `assistant_access_policy` في `app_settings` | `DELETE` الصف + صف السجل | لا شيء. الكود يفترض `all_verified` |
| 013 | `admin_auth_state` | `DROP TABLE` + صف السجل | يضيع عدّاد محاولات الدخول، وهو مؤقت أصلاً |
| 014 | `user_write_receipts` | `DROP TABLE` + صف السجل | يضيع منع التكرار للكتابات المعلّقة لدى التطبيق |
| 015 | `invoice_payment_expectations`، `payment_event_holds` | `DROP TABLE` + صف السجل | **تضيع الأحداث المحجوزة وتوقّعات المبالغ.** لا يُنصح بحال |
| 016 | `system_message_log` | `DROP TABLE` + صف السجل | يضيع سجل الرسائل المرسلة |
| 017 | قيد CHECK أوسع على `notification_campaigns.audience` | إعادة القيد بالقيم الخمس الأصلية | **يفشل** إن وُجدت حملة بفئة `abandoned_carts` أو `inactive`. تُحذف أولاً |
| 018 | `discount_codes`، `discount_code_redemptions` | `DROP TABLE` للاثنين + صف السجل | تضيع الأكواد المعرَّفة. لا ربط لها بالدفع |
| 019 | `integration_credentials` | `DROP TABLE` + صف السجل | تضيع الاعتمادات المحفوظة، وهي مشفّرة |
| 020 | ثلاثة صفوف روابط التذييل في `app_settings` | `DELETE` الصفوف + صف السجل | لا شيء. التذييل يُخفي الرابط الفارغ |

- **ومن ينفّذ التراجع؟** ليس عند المالك سطر SQL على الإنتاج. فأي تراجع عن ترحيلة هو تذكرة لـdimofinf.
- **ولهذا كانت الخطوة 0 إلزامية:** الاستعادة من النسخة هي التراجع الحقيقي الوحيد عن كل شيء. وثمنها ضياع ما كُتب بعد أخذ النسخة.
