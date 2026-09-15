/**
 * Service worker — ให้แอปเปิดได้ตอนไม่มีเน็ต
 *
 * คลังเป็นที่ที่ WiFi แย่ที่สุดในบริษัทเสมอ ถ้าเปิดหน้าไม่ขึ้นตอนเน็ตหลุด
 * คนแพ็คของก็จะแพ็คต่อโดยไม่ยิง แล้วสต็อกจะเพี้ยนหนักกว่าเดิมแบบไม่มีใครรู้
 *
 * กฎสำคัญ — **ห้ามแคช /api เด็ดขาด** คำตอบของ API คือสถานะที่เปลี่ยนทุกวินาที
 * ถ้าแคชไว้ ฝ่ายขายจะเห็นตัวเลขเก่าโดยไม่รู้ตัว ซึ่งอันตรายกว่าไม่มีตัวเลขเลย
 * คิวการยิงตอนออฟไลน์เก็บใน IndexedDB ที่ฝั่งหน้าเว็บ ไม่ใช่ที่นี่
 */
var CACHE = "mintra-stock-shell-v1";

/* เปลือกแอปที่ต้องมีเพื่อให้หน้าเปิดขึ้นได้ ไม่รวมข้อมูล */
var SHELL = [
  "/", "/index.html",
  "/styles.css", "/shell.js", "/stock.js", "/label.js", "/crypto.js"
];

self.addEventListener("install", function (ev) {
  ev.waitUntil(
    caches.open(CACHE).then(function (c) {
      // โลโก้ของแต่ละบริษัทคนละไฟล์ พลาดตัวใดตัวหนึ่งไม่ควรทำให้ติดตั้งล้ม
      return Promise.all(SHELL.map(function (u) {
        return c.add(new Request(u, { cache: "reload" })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (ev) {
  ev.waitUntil(
    caches.keys()
      .then(function (ks) {
        return Promise.all(ks.filter(function (k) { return k !== CACHE; })
                             .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

function sameOrigin(url) { return url.origin === self.location.origin; }

function isFont(url) {
  return url.host === "fonts.googleapis.com" || url.host === "fonts.gstatic.com";
}

/** อัปเดตแคชเบื้องหลัง คำตอบที่ส่งให้หน้าเว็บมาจากแคชไปก่อนแล้ว */
function revalidate(req) {
  return fetch(req).then(function (res) {
    if (res && (res.ok || res.type === "opaque")) {
      caches.open(CACHE).then(function (c) { c.put(req, res.clone()); });
    }
    return res;
  });
}

self.addEventListener("fetch", function (ev) {
  var req = ev.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);

  // API ต้องวิ่งออกเน็ตเสมอ ล้มก็ต้องล้มให้หน้าเว็บรู้ ไม่ใช่ตอบของเก่าให้
  if (sameOrigin(url) && url.pathname.indexOf("/api/") === 0) return;

  // เปิดหน้าใหม่: เอาของสดก่อน ถ้าไม่มีเน็ตค่อยใช้เปลือกที่แคชไว้
  if (req.mode === "navigate") {
    ev.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          caches.open(CACHE).then(function (c) { c.put("/index.html", res.clone()); });
        }
        return res;
      }).catch(function () {
        return caches.match("/index.html").then(function (hit) {
          return hit || new Response("ออฟไลน์ และยังไม่มีสำเนาหน้าเว็บในเครื่อง", {
            status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" }
          });
        });
      })
    );
    return;
  }

  if (!sameOrigin(url) && !isFont(url)) return;

  // ที่เหลือ: ตอบจากแคชทันทีแล้วค่อยอัปเดตเบื้องหลัง เปิดซ้ำจึงเร็วและใช้ได้ตอนออฟไลน์
  ev.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) {
        revalidate(req).catch(function () {});
        return hit;
      }
      return revalidate(req).catch(function () {
        return new Response("", { status: 504 });
      });
    })
  );
});

/** หน้าเว็บสั่งให้เคลียร์แคชได้ ใช้ตอน deploy ใหม่แล้วอยากบังคับโหลดสด */
self.addEventListener("message", function (ev) {
  if (ev.data && ev.data.t === "clear") {
    caches.delete(CACHE).then(function () {
      if (ev.source && ev.source.postMessage) ev.source.postMessage({ t: "cleared" });
    });
  }
});
