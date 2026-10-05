/* ============================================================
   مولّد مصفوفة الصلاحيات من الكود — KANAF-ORD-0001 R15-24

     node tools/rbac-matrix.mjs [مجلد_الإخراج]

   يكتب rbac-matrix.json و RBAC_MATRIX.md (الافتراضي test-support/.local/).
   لا يتصل بقاعدة ولا بالشبكة: يستورد وحدات المسارات فقط (مجمّع pg لا
   يتصل حتى أول استعلام) ويقرأ مكدس Express نفسه، فكل مسار يظهر بالصلاحية
   التي يفرضها فعلاً — لا بما تقوله وثيقة.

   مصادر الحقيقة:
     • الأدوار والصلاحيات: admin/permissions.js (ROLES, PERMISSION_CATALOG, can)
     • صلاحية كل مسار: وسم kanafPermissions / kanafAnyPermissions الذي تضعه
       requirePermission / requireAnyPermission في admin/middleware.js
     • نقاط التركيب: سطور app.use("/x", router) في index.js
   والأعداد (56/5 وغيرها) تُحسب هنا ولا تُكتب يدوياً في أي مكان.
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* قيم وهمية تكفي لاستيراد الوحدات؛ لا تُستعمل لاتصال. */
for (const k of ["USER_JWT_SECRET", "ADMIN_JWT_SECRET"]) process.env[k] ||= crypto.randomBytes(32).toString("hex");

/** نقاط التركيب من index.js: [{ mount, name, module }] */
function readMounts() {
  const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  const modOf = {};
  for (const m of src.matchAll(/^import\s*\{([^}]+)\}\s*from\s*"(\.\/[^"]+)"/gm)) {
    for (const n of m[1].split(",").map((x) => x.trim().split(/\s+as\s+/).pop()).filter(Boolean)) modOf[n] = m[2];
  }
  return [...src.matchAll(/^app\.use\("([^"]+)",\s*(\w+)\)/gm)]
    .filter((m) => modOf[m[2]])
    .map((m) => ({ mount: m[1], name: m[2], module: modOf[m[2]] }));
}

/** مسارات معرّفة مباشرة على app في index.js (عامة/مستخدم) — بالنص لأنها خارج أي router. */
function readInlineAppRoutes() {
  const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  return [...src.matchAll(/^app\.(get|post|put|patch|delete)\(\s*"([^"]+)"\s*,([^\n]*)/gm)].map((m) => ({
    method: m[1].toUpperCase(), path: m[2], localPath: m[2], source: "index.js",
    middleware: (m[3].match(/\b(require\w+|crisisFirewall|assistantGate|\w+Limiter)\b/g) || []),
    permissions: [], anyPermissions: [],
  }));
}

const prefixOf = (layer) => {
  const src = layer.regexp?.source || "";
  if (layer.regexp?.fast_slash || src === "^\\/?(?=\\/|$)") return "";
  return src.replace(/^\^/, "").replace(/\\\/\?\(\?=\\\/\|\$\)$/, "").replace(/\\\//g, "/");
};

function walk(router, base, inherited, out, source) {
  let routerLevel = [...inherited];
  for (const layer of router.stack || []) {
    if (layer.route) {
      const handles = layer.route.stack.map((l) => l.handle);
      const names = handles.map((h) => h.name).filter((n) => n && n !== "<anonymous>");
      const perms = handles.flatMap((h) => h.kanafPermissions || []);
      const any = handles.flatMap((h) => h.kanafAnyPermissions || []);
      for (const method of Object.keys(layer.route.methods).filter((k) => layer.route.methods[k])) {
        out.push({
          method: method.toUpperCase(), path: (base + layer.route.path).replace(/\/+/g, "/"), localPath: layer.route.path, source,
          middleware: [...new Set([...routerLevel.map((h) => h.name).filter(Boolean), ...names])],
          permissions: [...new Set([...routerLevel.flatMap((h) => h.kanafPermissions || []), ...perms])],
          anyPermissions: [...new Set([...routerLevel.flatMap((h) => h.kanafAnyPermissions || []), ...any])],
        });
      }
    } else if (layer.handle?.stack) {
      walk(layer.handle, base + prefixOf(layer), routerLevel, out, source);
    } else if (typeof layer.handle === "function") {
      routerLevel.push(layer.handle);   // router.use(mw) يسري على ما بعده
    }
  }
}

export async function collect() {
  const perms = await import(pathToFileURL(path.join(ROOT, "admin/permissions.js")).href);
  const routes = [];
  for (const { mount, name, module } of readMounts()) {
    const mod = await import(pathToFileURL(path.join(ROOT, module)).href);
    walk(mod[name], mount, [], routes, module.replace(/^\.\//, ""));
  }
  routes.push(...readInlineAppRoutes());
  for (const r of routes) {
    r.isAdmin = r.path.startsWith("/admin");
    r.rolesAllowed = !r.isAdmin ? null
      : !r.middleware.includes("requireAdminAuth") ? ["(public)"]
      : perms.ROLES.filter((role) =>
          r.permissions.every((p) => perms.can(role, p)) &&
          (r.anyPermissions.length === 0 || r.anyPermissions.some((p) => perms.can(role, p))));
  }
  routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

  /* فحوص مضمّنة في المخرج نفسه */
  const used = new Set(routes.flatMap((r) => [...r.permissions, ...r.anyPermissions]));
  const inlineUsed = new Set();
  for (const f of fs.readdirSync(path.join(ROOT, "admin")).filter((f) => f.endsWith(".js"))) {
    for (const m of fs.readFileSync(path.join(ROOT, "admin", f), "utf8").matchAll(/\.can\("([a-z_]+:[a-z_]+)"\)/g)) inlineUsed.add(m[1]);
  }
  const requireRoleCallers = fs.readdirSync(path.join(ROOT, "admin")).filter((f) => f.endsWith(".js") && f !== "middleware.js")
    .filter((f) => /\brequireRole\(/.test(fs.readFileSync(path.join(ROOT, "admin", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));

  return {
    roles: perms.ROLES.map((r) => ({ role: r, label: perms.ROLE_LABEL[r], description: perms.ROLE_DESCRIPTION[r], count: perms.permissionsFor(r).length })),
    permissions: perms.matrixRows().map((row) => ({
      ...row,
      routes: routes.filter((r) => r.permissions.includes(row.permission) || r.anyPermissions.includes(row.permission)).map((r) => `${r.method} ${r.path}`),
      inlineCheck: inlineUsed.has(row.permission),
    })),
    routes,
    checks: {
      permissionCount: perms.ALL_PERMISSIONS.length,
      roleCount: perms.ROLES.length,
      unknownPermissionsOnRoutes: [...used].filter((p) => !perms.ALL_PERMISSIONS.includes(p)),
      permissionsWithoutRouteOrInlineCheck: perms.ALL_PERMISSIONS.filter((p) => !used.has(p) && !inlineUsed.has(p)),
      adminRoutesWithoutAuth: routes.filter((r) => r.isAdmin && !r.middleware.includes("requireAdminAuth")).map((r) => `${r.method} ${r.path}`),
      adminRoutesAuthOnly: routes.filter((r) => r.isAdmin && r.middleware.includes("requireAdminAuth") && !r.permissions.length && !r.anyPermissions.length).map((r) => `${r.method} ${r.path}`),
      requireRoleCallers,
    },
  };
}

function toMarkdown(d) {
  const R = d.roles.map((r) => r.role);
  const L = [];
  L.push("# مصفوفة الصلاحيات — مولّدة من الكود", "",
    "> لا تحرّر هذا الملف يدوياً. المولّد: `node tools/rbac-matrix.mjs`. المصدر: `admin/permissions.js` ومكدس مسارات Express.", "",
    `الأدوار: ${d.checks.roleCount} · الصلاحيات: ${d.checks.permissionCount} · مسارات الإدارة: ${d.routes.filter((r) => r.isAdmin).length}`, "",
    "## الأدوار", "", "| الدور | الاسم | عدد الصلاحيات | الوصف |", "|---|---|---|---|",
    ...d.roles.map((r) => `| \`${r.role}\` | ${r.label} | ${r.count} | ${r.description} |`), "",
    "## الدور × الصلاحية", "", `| الصلاحية | الوصف | ${R.join(" | ")} | المسارات |`, `|---|---|${R.map(() => "---").join("|")}|---|`,
    ...d.permissions.map((p) => `| \`${p.permission}\` | ${p.description} | ${R.map((r) => (p.roles[r] ? "✔" : "·")).join(" | ")} | ${p.routes.length ? p.routes.map((x) => `\`${x}\``).join("<br>") : p.inlineCheck ? "(فحص داخل معالج)" : "—"} |`), "",
    "## مسارات الإدارة", "", "| الطريقة | المسار | الصلاحية | الأدوار المسموح لها | الملف |", "|---|---|---|---|---|",
    ...d.routes.filter((r) => r.isAdmin).map((r) => `| ${r.method} | \`${r.path}\` | ${[...r.permissions.map((p) => `\`${p}\``), ...(r.anyPermissions.length ? [`أيٌّ من: ${r.anyPermissions.map((p) => `\`${p}\``).join("، ")}`] : [])].join(" + ") || (r.middleware.includes("requireAdminAuth") ? "دخول فقط" : "عام")} | ${r.rolesAllowed.join("، ")} | ${r.source} |`), "",
    "## فحوص", "", "```json", JSON.stringify(d.checks, null, 2), "```", "");
  return L.join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = path.resolve(process.argv[2] || path.join(ROOT, "test-support", ".local"));
  fs.mkdirSync(out, { recursive: true });
  const d = await collect();
  fs.writeFileSync(path.join(out, "rbac-matrix.json"), JSON.stringify(d, null, 2));
  fs.writeFileSync(path.join(out, "RBAC_MATRIX.md"), toMarkdown(d));
  console.log(JSON.stringify(d.checks, null, 2));
  process.exit(0);
}
