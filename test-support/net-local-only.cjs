/* حاجز شبكة لعمليات التمرين (KANAF-ORD-0002 PKG-D): يُحمَّل بـ node --require قبل كود الخادم،
   فيرفض أي اتصال TCP/TLS لغير 127.0.0.1/localhost/::1 (والمقابس المحلية). الخادم القديم (baseline)
   لا يملك حارس test-support، فهذا يضمن ألا يصل أي طلب منه إلى مزود حي أو إلى الإنتاج. */
const net = require("node:net");
const LOCAL = new Set(["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"]);
const blocked = (o) => o && !o.path && o.host !== undefined && !LOCAL.has(String(o.host));
const orig = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // net.connect() يمرّر مصفوفة مُطبَّعة [options, cb]؛ النداء المباشر يمرّر options أو (port, host)
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const o = typeof first === "object" && first !== null ? { host: "localhost", ...first }
    : { port: first, host: typeof args[1] === "string" ? args[1] : "localhost" };
  if (blocked(o)) {
    const err = new Error(`NET_BLOCKED ${o.host}`);
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return orig.apply(this, args);
};
