# الأرقام اللاتينية في تطبيق تنفس — KANAF-ORD-0008 §2.6

**القاعدة:** كل رقم يراه المستخدم لاتيني (0-9). يشمل ذلك الأسعار والتواريخ والأوقات والعدّادات والنسب والأكواد.

## أين تُطبَّق

1. **كل نداء تنسيق يسمّي لغته صراحةً.** النداء بلا لغة يأخذ لغة الجهاز، فعند مستخدم جهازه بالعربية تخرج أرقام هندية (٠١٢٣).

   ```js
   // ✗ يتبع لغة الجهاز
   n.toLocaleString();
   date.toLocaleDateString("ar-SA");
   new Intl.NumberFormat("ar").format(n);

   // ✓ عربي بأرقام لاتينية وتقويم ميلادي
   date.toLocaleDateString("ar-SA-u-ca-gregory-nu-latn", { year: "numeric", month: "2-digit", day: "2-digit" });
   new Intl.NumberFormat("ar-SA-u-nu-latn", { maximumFractionDigits: 2 }).format(n);
   // ✓ أو إنجليزي للأرقام المجرّدة
   n.toLocaleString("en-US");
   ```

2. **التقويم ميلادي** (`-u-ca-gregory`). الفاتورة تحمل تاريخها الميلادي، وعرض هجري بجانبه يجعل المستخدم يرى يومين لتاريخ واحد.

3. **CSS:** `font-variant-numeric: lining-nums tabular-nums;` على `*`، كما في اللوحة.

4. **المدخلات:** حوّل الأرقام الهندية إلى لاتينية **قبل** الإرسال إلى الخادم في حقول الأكواد والهاتف والمبالغ. كود التحقق المكتوب على لوحة مفاتيح عربية قد يصل `١٢٣٤٥٦`:

   ```js
   const toLatin = (s) => String(s).replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x0660)
                                   .replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x06F0);
   ```

5. **النصوص الثابتة:** لا أرقام هندية مكتوبة حرفياً في النصوص (مثل «٣ أيام»).

## الفحص الآلي

في الخادم ملف يطبّق هذه القاعدة على اللوحة والخادم، وهو `test-27-static-checks.mjs` على `rebrand/tanaffus`:
- يرفض أي `toLocale*` أو `Intl.NumberFormat` أو `Intl.DateTimeFormat` بلا لغة صريحة `en…` أو `-nu-latn`.
- ويحمل فحصاً سلبياً لنفسه.

انسخ الدالة `findDigitViolations` منه إلى اختبارات التطبيق، ووجّهها إلى مجلد `src/` فيه.

ثم ابحث عن الأرقام الهندية المكتوبة حرفياً:

```bash
git grep -nP '[\x{0660}-\x{0669}\x{06F0}-\x{06F9}]' -- src
```

(إن لم يدعم git grep هذا النطاق، استعمل `grep -rnP` على المجلد نفسه.)
