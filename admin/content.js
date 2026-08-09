import express from "express";
import { query, withTransaction } from "../db/pool.js";
import { requireAdminAuth, requirePermission, requireUuidParam, logAdminAction } from "./middleware.js";
import { getAdminCatalog, recordContentChange } from "../content/catalog.js";

export const adminContentRouter = express.Router();

/* حارس معرّف UUID يأتي من admin/middleware.js — كان معرَّفاً هنا
   وفي admin/notifications.js بنسختين متطابقتين، ومغيَّباً عن
   admin/routes.js و admin/billing.js حيث معظم المسارات ذات
   المعرّفات. نسخة واحدة الآن. */

/* ============================================================
   إدارة المحتوى — الحلقة المغلقة، مفتوحة.

   ------------------------------------------------------------
   ما الذي تغيّر عن النسخة السابقة من هذه المسارات
   ------------------------------------------------------------
   كانت ثلاثة مسارات تقرأ وتكتب في content_items — وهو جدول لم
   يحتوِ صفاً واحداً منذ إنشائه، ولم يقرأه تطبيق المستخدم إطلاقاً.
   أي أن "إدارة المحتوى" كانت واجهة فوق فراغ من الطرفين.

   الآن: الجدول مبذور بالمحتوى الحقيقي (الترحيل 007)، والتطبيق
   يقرأ /api/content/catalog، فكل تغيير هنا ينعكس على مستخدم حقيقي
   في الطلب التالي.

   ------------------------------------------------------------
   الصلاحيات — ولماذا هي غير متماثلة
   ------------------------------------------------------------
   content_manager  : يقرأ، ويحرّر العرض (عنوان/تصنيف/ترتيب).
   admin            : يعتمد أو يرفض، ويطلق أو يوقف، ويجدول، ويغيّر
                      الطبقة (free/plus).
   owner            : النشر الجماعي.

   لماذا لا يعتمد content_manager محتواه بنفسه؟ لأن الاعتماد هنا
   **سريري** لا تحريري: يقرر أن نصاً نفسياً صالح للعرض على شخص قد
   يكون في ضائقة. فصل من يكتب عمّن يعتمد ليس بيروقراطية.

   ولماذا الطبقة (free/plus) عند admin لا content_manager؟ لأنها
   قرار مالي: تحويل رحلة إلى مجانية يلغي سبب اشتراك.
   ============================================================ */

/* ------------------------------------------------------------
   GET /admin/content
   بحث وفلترة وترقيم من طرف الخادم (البند 10).
   ------------------------------------------------------------ */
adminContentRouter.get("/content", requireAdminAuth, requirePermission("content:view"), async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const published =
      req.query.published === "true" ? true : req.query.published === "false" ? false : null;

    const result = await getAdminCatalog({
      type: req.query.type || null,
      status: req.query.status || null,
      search: (req.query.search || "").trim() || null,
      published,
      limit,
      offset,
    });
    /* `content` اسم مكرر متعمَّد.

       حزمة لوحة الإدارة المنشورة داخل المستودع (admin-ui) تقرأ
       `d.content` — وهي مبنيّة ومصدرها غير موجود على GitHub، فلا
       يمكن إعادة بنائها من هنا. تغيير شكل الرد وحده كان سيجعل
       صفحة المحتوى تعرض قائمة فارغة بلا خطأ ظاهر: نفس صنف العطب
       الصامت الذي تعالجه هذه المرحلة.

       `items` هو الاسم الجديد، و`content` يشير إلى نفس المصفوفة
       حتى تُبنى اللوحة من جديد. */
    res.json({ ...result, content: result.items });
  } catch (err) {
    console.error("[admin/content] list failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ------------------------------------------------------------
   GET /admin/content/:type/:key — عنصر واحد بتاريخه الكامل.
   ------------------------------------------------------------ */
adminContentRouter.get("/content/:type/:key", requireAdminAuth, requirePermission("content:view"), async (req, res) => {
  try {
    const { items } = await getAdminCatalog({ type: req.params.type, limit: 200 });
    const item = items.find((i) => i.content_key === req.params.key);
    if (!item) return res.status(404).json({ error: "not_found" });

    const { rows: history } = await query(
      `SELECT cv.change_kind, cv.old_value, cv.new_value, cv.note, cv.created_at,
              au.name AS changed_by_name
       FROM content_versions cv
       LEFT JOIN admin_users au ON au.id = cv.changed_by
       WHERE cv.content_type = $1 AND cv.content_key = $2
       ORDER BY cv.created_at DESC
       LIMIT 50`,
      [req.params.type, req.params.key]
    );

    res.json({ item, history });
  } catch (err) {
    console.error("[admin/content] detail failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ------------------------------------------------------------
   POST /admin/content/:id/review  { status, notes }
   المراجعة السريرية. رفض المحتوى يُنزل مفتاح الإطلاق معه — وإلا
   بقي محتوى مرفوض معروضاً لأن أحداً نسي خطوة ثانية.
   ------------------------------------------------------------ */
adminContentRouter.post("/content/:id/review", requireAdminAuth, requirePermission("content:review"), requireUuidParam("id"), async (req, res) => {
  const { status, notes } = req.body || {};
  if (!["approved", "rejected", "retired"].includes(status)) {
    return res.status(400).json({ error: "invalid_status" });
  }
  try {
    const result = await withTransaction(async (client) => {
      const { rows: before } = await client.query(
        `SELECT content_type, content_key, content_version, clinical_review_status, launch_enabled
         FROM content_items WHERE id = $1 FOR UPDATE`,
        [req.params.id]
      );
      const prev = before[0];
      if (!prev) throw Object.assign(new Error("not_found"), { status: 404 });

      const { rows } = await client.query(
        `UPDATE content_items
         SET clinical_review_status = $1, reviewer_admin_id = $2, reviewed_at = now(),
             review_notes = $3,
             launch_enabled = CASE WHEN $1 = 'approved' THEN launch_enabled ELSE false END,
             updated_at = now()
         WHERE id = $4
         RETURNING content_type, content_key, content_version, clinical_review_status, launch_enabled`,
        [status, req.admin.id, notes || null, req.params.id]
      );

      await recordContentChange(client, {
        contentType: prev.content_type,
        contentKey: prev.content_key,
        contentVersion: prev.content_version,
        changeKind: "review",
        oldValue: { clinical_review_status: prev.clinical_review_status, launch_enabled: prev.launch_enabled },
        newValue: { clinical_review_status: rows[0].clinical_review_status, launch_enabled: rows[0].launch_enabled },
        changedBy: req.admin.id,
        note: notes || null,
      });

      return { prev, next: rows[0] };
    });

    await logAdminAction({
      adminUserId: req.admin.id,
      action: "content_review",
      oldValue: { status: result.prev.clinical_review_status },
      newValue: { status: result.next.clinical_review_status },
      reason: notes || "مراجعة سريرية",
      metadata: { content_type: result.next.content_type, content_key: result.next.content_key },
      ipAddress: req.ip,
    });

    res.json(result.next);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("[admin/content] review failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ------------------------------------------------------------
   POST /admin/content/:id/toggle-launch  { enabled, reason }

   كاسر الدائرة: يوقف محتواً حياً فوراً بلا إعادة مراجعة، ويعيده
   بضغطة. مستقل عن الاعتماد السريري عمداً — إيقاف طارئ لا ينبغي أن
   يكلّف دورة مراجعة كاملة لاستعادته.

   لا يقبل التفعيل لغير المعتمد: نشر محتوى لم يُراجَع سريرياً على
   مستخدم في ضائقة هو أخطر ما يمكن أن تفعله هذه اللوحة.
   ------------------------------------------------------------ */
adminContentRouter.post("/content/:id/toggle-launch", requireAdminAuth, requirePermission("content:toggle_launch"), requireUuidParam("id"), async (req, res) => {
  const enabled = !!req.body?.enabled;
  const reason = String(req.body?.reason || "").trim();
  try {
    const result = await withTransaction(async (client) => {
      const { rows: before } = await client.query(
        `SELECT content_type, content_key, content_version, clinical_review_status, launch_enabled
         FROM content_items WHERE id = $1 FOR UPDATE`,
        [req.params.id]
      );
      const prev = before[0];
      if (!prev) throw Object.assign(new Error("not_found"), { status: 404 });
      if (enabled && prev.clinical_review_status !== "approved") {
        throw Object.assign(new Error("cannot_enable_unapproved_content"), { status: 409 });
      }

      const { rows } = await client.query(
        `UPDATE content_items SET launch_enabled = $1, updated_at = now()
         WHERE id = $2 RETURNING content_type, content_key, launch_enabled`,
        [enabled, req.params.id]
      );

      await recordContentChange(client, {
        contentType: prev.content_type,
        contentKey: prev.content_key,
        contentVersion: prev.content_version,
        changeKind: enabled ? "publish" : "unpublish",
        oldValue: { launch_enabled: prev.launch_enabled },
        newValue: { launch_enabled: enabled },
        changedBy: req.admin.id,
        note: reason || null,
      });

      return { prev, next: rows[0] };
    });

    await logAdminAction({
      adminUserId: req.admin.id,
      action: enabled ? "content_publish" : "content_unpublish",
      oldValue: { launch_enabled: result.prev.launch_enabled },
      newValue: { launch_enabled: enabled },
      reason: reason || (enabled ? "نشر محتوى" : "إيقاف محتوى"),
      metadata: { content_type: result.next.content_type, content_key: result.next.content_key },
      ipAddress: req.ip,
    });

    res.json(result.next);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("[admin/content] toggle-launch failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ------------------------------------------------------------
   PATCH /admin/content/:type/:key/presentation
   { title?, category?, displayOrder?, subscriptionTier?, reason? }

   تغيير الطبقة يحتاج admin؛ الباقي يكفيه content_manager. الفحص
   داخل المعالج لا في وسيطة، لأن الصلاحية تعتمد على **الحقل
   المرسل** لا على المسار.
   ------------------------------------------------------------ */
adminContentRouter.patch(
  "/content/:type/:key/presentation",
  requireAdminAuth,
  requirePermission("content:edit_presentation"),
  async (req, res) => {
    const { title, category, displayOrder, subscriptionTier } = req.body || {};
    const reason = String(req.body?.reason || "").trim();

    // COALESCE أدناه يعامل "" كقيمة صالحة، فعنوان فارغ كان يمرّ
    // ويظهر بطاقة بلا اسم في التطبيق.
    if (title !== undefined && (typeof title !== "string" || !title.trim())) {
      return res.status(400).json({ error: "title_cannot_be_empty" });
    }
    if (displayOrder !== undefined && !Number.isInteger(displayOrder)) {
      return res.status(400).json({ error: "invalid_display_order" });
    }

    if (subscriptionTier !== undefined) {
      if (!["free", "plus"].includes(subscriptionTier)) {
        return res.status(400).json({ error: "invalid_subscription_tier" });
      }
      /* الصلاحية تعتمد على الحقل المرسل لا على المسار، فالفحص
         هنا لا في وسيطة. وكان يقارن رتبة رقمية (rank < 3) — أي
         النموذج الخطّي نفسه الذي منح مدير المحتوى وصولاً للمحاسبة.
         صار سؤالاً بالاسم. */
      if (!req.admin.can("content:change_tier")) {
        return res.status(403).json({
          error: "tier_change_requires_admin",
          message: "تغيير الطبقة قرار مالي — يحتاج صلاحية مدير.",
        });
      }
    }

    try {
      const result = await withTransaction(async (client) => {
        const { rows: before } = await client.query(
          `SELECT title, category, display_order, subscription_tier
           FROM content_presentation WHERE content_type = $1 AND content_key = $2 FOR UPDATE`,
          [req.params.type, req.params.key]
        );
        const prev = before[0];
        if (!prev) throw Object.assign(new Error("not_found"), { status: 404 });

        const { rows } = await client.query(
          `UPDATE content_presentation
           SET title = COALESCE($3, title),
               category = COALESCE($4, category),
               display_order = COALESCE($5, display_order),
               subscription_tier = COALESCE($6, subscription_tier),
               updated_by = $7, updated_at = now()
           WHERE content_type = $1 AND content_key = $2
           RETURNING title, category, display_order, subscription_tier`,
          [
            req.params.type, req.params.key,
            title === undefined ? null : title.trim(), category ?? null,
            displayOrder ?? null, subscriptionTier ?? null,
            req.admin.id,
          ]
        );

        await recordContentChange(client, {
          contentType: req.params.type,
          contentKey: req.params.key,
          changeKind: subscriptionTier !== undefined ? "tier_change" : "presentation",
          oldValue: prev,
          newValue: rows[0],
          changedBy: req.admin.id,
          note: reason || null,
        });

        return { prev, next: rows[0] };
      });

      await logAdminAction({
        adminUserId: req.admin.id,
        action: "content_presentation_update",
        oldValue: result.prev,
        newValue: result.next,
        reason: reason || "تحديث عرض محتوى",
        metadata: { content_type: req.params.type, content_key: req.params.key },
        ipAddress: req.ip,
      });

      res.json(result.next);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      console.error("[admin/content] presentation update failed:", err);
      res.status(500).json({ error: "internal_error" });
    }
  }
);

/* ------------------------------------------------------------
   POST /admin/content/:type/:key/schedule
   { publishAt, unpublishAt, reason }

   الجدولة كلها هنا: تاريخان في صف واحد. لا وظيفة خلفية، لأن
   الكاشف يقارنهما بـnow() في كل قراءة (content/catalog.js).

   نتيجتان مهمتان:
     • يستحيل أن يظهر عنصر "منشور" قبل وقته.
     • ويستحيل أن يتأخر نشره لأن وظيفة ما لم تعمل.

   ISO 8601 بإزاحة صريحة إلزامي. "2026-09-01T09:00:00+03:00" تعني
   التاسعة صباحاً بالرياض بالضبط، وتُخزَّن لحظة مطلقة.
   ------------------------------------------------------------ */
adminContentRouter.post("/content/:type/:key/schedule", requireAdminAuth, requirePermission("content:schedule"), async (req, res) => {
  const { publishAt, unpublishAt } = req.body || {};
  const reason = String(req.body?.reason || "").trim();

  const parse = (v, label) => {
    if (v === null || v === undefined || v === "") return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw Object.assign(new Error(`invalid_${label}`), { status: 400 });
    return d.toISOString();
  };

  try {
    const pub = parse(publishAt, "publish_at");
    const unpub = parse(unpublishAt, "unpublish_at");
    if (pub && unpub && new Date(unpub) <= new Date(pub)) {
      return res.status(400).json({ error: "unpublish_before_publish" });
    }

    const result = await withTransaction(async (client) => {
      const { rows: before } = await client.query(
        `SELECT publish_at, unpublish_at FROM content_presentation
         WHERE content_type = $1 AND content_key = $2 FOR UPDATE`,
        [req.params.type, req.params.key]
      );
      const prev = before[0];
      if (!prev) throw Object.assign(new Error("not_found"), { status: 404 });

      const { rows } = await client.query(
        `UPDATE content_presentation
         SET publish_at = $3, unpublish_at = $4, scheduled_by = $5, updated_at = now()
         WHERE content_type = $1 AND content_key = $2
         RETURNING publish_at, unpublish_at`,
        [req.params.type, req.params.key, pub, unpub, req.admin.id]
      );

      await recordContentChange(client, {
        contentType: req.params.type,
        contentKey: req.params.key,
        changeKind: "schedule",
        oldValue: prev,
        newValue: rows[0],
        changedBy: req.admin.id,
        note: reason || null,
      });

      return { prev, next: rows[0] };
    });

    await logAdminAction({
      adminUserId: req.admin.id,
      action: "content_schedule",
      oldValue: result.prev,
      newValue: result.next,
      reason: reason || "جدولة نشر محتوى",
      metadata: { content_type: req.params.type, content_key: req.params.key },
      ipAddress: req.ip,
    });

    res.json(result.next);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("[admin/content] schedule failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ------------------------------------------------------------
   POST /admin/content/bulk-publish  { type?, keys?, reason }

   لماذا يوجد أصلاً: الترحيل 007 يبذر 64 عنصراً بحالة "مسودة"،
   وهو الوصف الصادق لواقعها (كلها review_required في كود التطبيق).
   اعتمادها واحداً واحداً من الواجهة 64 خطوة، وأول تشغيل يحتاج
   خطوة واحدة.

   محصور في owner لأنه ينشر محتوى نفسياً على كل المستخدمين دفعة
   واحدة — أقوى فعل في هذه اللوحة كلها. ويكتب سطراً في
   content_versions لكل عنصر، فالنشر الجماعي ليس استثناءً من
   التدقيق.
   ------------------------------------------------------------ */
adminContentRouter.post("/content/bulk-publish", requireAdminAuth, requirePermission("content:bulk_publish"), async (req, res) => {
  const { type, keys } = req.body || {};
  const all = req.body?.all === true;
  const reason = String(req.body?.reason || "").trim();
  if (!reason) return res.status(400).json({ error: "reason_required" });

  /* ⚠️ نطاق صريح إلزامي.

     النسخة الأولى كانت تشمل كل شيء حين لا يُمرَّر نطاق. أخطر ما
     في اللوحة يعمل بالافتراض لا بالقصد. الآن: type أو keys أو
     all: true صراحةً. */
  if (!type && !(Array.isArray(keys) && keys.length) && !all) {
    return res.status(400).json({
      error: "scope_required",
      message: "حدّد type أو keys، أو أرسل all: true صراحةً لنشر كل المحتوى.",
    });
  }

  try {
    const result = await withTransaction(async (client) => {
      const params = [req.admin.id];
      let filter = "";
      if (type) { params.push(type); filter += ` AND content_type = $${params.length}`; }
      if (Array.isArray(keys) && keys.length) { params.push(keys); filter += ` AND content_key = ANY($${params.length}::text[])`; }

      /* ⚠️ 'rejected' مستثنى، و review_notes لا تُدهس.

         العطب في النسخة الأولى: الشرط كان `<> 'retired'` وحده، فكان
         النشر الجماعي **يعكس رفضاً سريرياً** ويمحو ملاحظة المراجع
         التي تشرح سبب الرفض. أي أن أقوى زر في اللوحة يبطل بوابة
         السلامة التي وُجد ليفرضها — في تطبيق صحة نفسية.

         سبب النشر الجماعي يُكتب في content_versions.note لا في
         review_notes: الأخير ملك المراجع السريري. */
      const { rows } = await client.query(
        `UPDATE content_items
         SET clinical_review_status = 'approved', launch_enabled = true,
             reviewer_admin_id = $1, reviewed_at = now(), updated_at = now()
         WHERE clinical_review_status NOT IN ('retired', 'rejected') ${filter}
         RETURNING content_type, content_key, content_version`,
        params
      );

      for (const r of rows) {
        await recordContentChange(client, {
          contentType: r.content_type,
          contentKey: r.content_key,
          contentVersion: r.content_version,
          changeKind: "publish",
          oldValue: null,
          newValue: { clinical_review_status: "approved", launch_enabled: true },
          changedBy: req.admin.id,
          note: `نشر جماعي: ${reason}`,
        });
      }
      return rows;
    });

    await logAdminAction({
      adminUserId: req.admin.id,
      action: "content_bulk_publish",
      newValue: { count: result.length, type: type || "all" },
      reason,
      metadata: { keys: result.map((r) => r.content_key).slice(0, 100) },
      ipAddress: req.ip,
    });

    res.json({
      published: result.length,
      items: result,
      note: "العناصر المرفوضة سريرياً لم تُمس — تُراجَع كل واحدة على حدة.",
    });
  } catch (err) {
    console.error("[admin/content] bulk publish failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});
