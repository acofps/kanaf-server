# سجلات DNS لـ`tanfs.net` — تُطلب من dimofinf (KANAF-ORD-0012 §6.4)

> **لماذا بتذكرة لا من cPanel:**
> - خوادم أسماء النطاق هي `ns1…ns4.dimofinf.sa`.
> - ومحرّر المناطق (Zone Editor) في cPanel لا أثر له (§1).
> - فكل سجل أدناه يطلبه المالك من dimofinf كما هو، حرفاً بحرف.

> **قيمة واحدة لا أستطيع كتابتها:** مفتاح DKIM العام. يولّده خادم البريد عند dimofinf، لا أنا.
> كل ما سواه مكتوب حرفياً.

> **العنوان `168.119.123.56`:**
> - هو الخادم الجديد الذي نُقلت إليه الاستضافة وقاعدة البيانات (§1).
> - **اطلب من dimofinf تأكيد أنه نفسه عنوان الويب والبريد لحسابك بعد النقل.** إن قالوا غيره، فضعه مكانه في كل سطر.
> - استعلامات DNS محجوبة عن جلستي، فلم أقرأ المنطقة الحالية.

## نص التذكرة — انسخه كما هو

```
السلام عليكم،
نرجو إضافة/تعديل السجلات التالية في منطقة النطاق tanfs.net (خوادم الأسماء لديكم ns1-4.dimofinf.sa)،
ثم تفعيل DKIM للنطاق بمفتاح 2048 بت وإرسال قيمته لنا، وإصدار شهادة AutoSSL تشمل mail.tanfs.net.

A      tanfs.net.                    168.119.123.56          TTL 3600
A      mail.tanfs.net.               168.119.123.56          TTL 3600
A      app.tanfs.net.                168.119.123.56          TTL 3600
CNAME  www.tanfs.net.                tanfs.net.              TTL 3600
MX     tanfs.net.          10        mail.tanfs.net.         TTL 3600
TXT    tanfs.net.                    "v=spf1 +a +mx +ip4:168.119.123.56 ~all"
TXT    default._domainkey.tanfs.net. (مفتاح DKIM 2048 الذي يولّده خادمكم)
TXT    _dmarc.tanfs.net.             "v=DMARC1; p=none; rua=mailto:info@tanfs.net; fo=1; adkim=r; aspf=r"

ونرجو تأكيد:
1) أن 168.119.123.56 هو عنوان الويب والبريد لحسابنا بعد النقل.
2) أن سجل PTR للعنوان 168.119.123.56 يعيد اسم مضيف يعود سجل A الخاص به إلى العنوان نفسه.
3) أن سجل SPF واحد فقط للنطاق (لا سجلّان).
شكراً.
```

## لماذا كل سطر

| السجل | لماذا |
|---|---|
| A للجذر و`app` و`mail` | الموقع، وتطبيق الويب (`app.tanfs.net`)، وخادم البريد |
| CNAME لـ`www` | يحوّل إلى الجذر |
| MX | البريد الوارد إلى `info@` و`noreply@` (الصندوقان موجودان، §1) |
| SPF | يجيز لخادم الاستضافة وحده الإرسال باسم النطاق |
| DKIM 2048 | توقيع الرسائل |
| DMARC `p=none` | مراقبة بلا حجب |
| PTR | مطلوب لقبول البريد عند Gmail وOutlook. يتبع العنوان لا النطاق، فهو عند dimofinf حصراً |

**تفصيل بعض البنود:**
- **SPF:** Render لا يرسل بنفسه، بل يمرّر عبر SMTP إلى `mail.tanfs.net`، فلا `include:`. والسجل واحد فقط، لأن سجلّين يُبطلان SPF كله.
- **DKIM:** قيمة `p=` تقارب 392 محرفاً. فإن جاءت نحو 216 فهي 1024 بت، فاطلب 2048.
- **DMARC:** لا يُشدَّد إلى `quarantine` قبل أسبوع من تقارير نظيفة.
  - التقارير تذهب إلى `info@tanfs.net` الموجود، لا إلى صندوق جديد. هذا تغيير عن ORD-0010 مسجَّل في `DECISIONS.md`.

## التحقق — بعد ردّ dimofinf

من أي جهاز عليه `dig`:

```bash
dig +short A mail.tanfs.net
```

```bash
dig +short MX tanfs.net
```

```bash
dig +short TXT tanfs.net
```

```bash
dig +short TXT default._domainkey.tanfs.net
```

```bash
dig +short TXT _dmarc.tanfs.net
```

```bash
dig +short -x 168.119.123.56
```

**النجاح:**
- الأوامر الخمسة الأولى تعيد القيم أعلاه، والسادس يعيد اسم مضيف.
- ورسالة اختبار من `noreply@tanfs.net` إلى Gmail، فيها «Show original»: `SPF: PASS`، و`DKIM: PASS`، و`DMARC: PASS`.

**ثم فقط** الخطوة 6 في `RELEASE_RUNBOOK.md`.

## `VAPID_SUBJECT`

- مضبوط اليوم على Render: `mailto:info@tanfs.net` (§1).
- وهو صندوق موجود، فلا حاجة لـ`support@` الذي اقترحه ORD-0010.
- لا يحتاج سجلاً.
