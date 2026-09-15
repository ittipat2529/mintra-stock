/**
 * ตัวกลางระหว่างหน้าเว็บกับระบบสต็อก
 *
 * ระบบนี้แยกขาดจากสมุดบัญชีรายรับรายจ่าย — คนละรีโป คนละบัญชีผู้ใช้ คนละ Worker
 * ที่นี่ดูแลแต่ "จำนวนของ" ไม่มีรายการเงินเข้าออกและไม่เขียนอะไรลงสมุดบัญชี
 *
 * หน้าเว็บไม่มีสิทธิ์อะไรในตัวเอง ทุกคำสั่งวิ่งผ่านที่นี่
 * ตรวจ session แล้วตรวจกฎสิทธิ์ก่อนแตะข้อมูลเสมอ
 * การซ่อนปุ่มในหน้าเว็บเป็นเรื่องความสะดวก กำแพงจริงอยู่ในไฟล์นี้
 *
 * ของสองอย่างอยู่คนละที่ด้วยเหตุผลของมัน
 *   ผู้ใช้และประวัติรายวัน  อยู่ในรีโป GitHub (data/) — แก้น้อย ต้องตามประวัติได้
 *   ยอดสต็อกสด            อยู่ใน Durable Object — แก้ทุกวินาที ต้องห้ามยอดเพี้ยน
 */

import {
  hashPassword, verifyPassword, createSession, readSession,
  sessionCookie, readCookie, SESSION_COOKIE, SESSION_MAX_AGE
} from "./auth.js";
import { readFile, update, PATHS, HttpError } from "./store.js";
import {
  StockRoom, STOCK_PATHS, STOCK_ROLES, stockRoleOf,
  canScan, canManageProducts, canReserve
} from "./stock.js";

// Durable Object ต้องถูก export จากไฟล์หลักของ Worker ไม่งั้น wrangler หาคลาสไม่เจอ
export { StockRoom };

/**
 * สิทธิ์ของระบบสต็อกทั้งหมดมีแค่ชุดนี้ ไม่ได้ยืมมาจากระบบบัญชี
 *   owner      เจ้าของ — ทำได้ทุกอย่าง รวมถึงจัดการผู้ใช้และสร้างยอดใหม่
 *   manager    หัวหน้าคลัง — ทะเบียนสินค้า ต้นทุน ปรับยอด ปิดรอบนับ
 *   warehouse  คลัง — ยิงรับเข้า/แพ็คส่ง/รับคืน ย้ายคลัง นับสต็อก
 *   sales      ฝ่ายขาย — ดูยอดและจองของ ยิงสต็อกไม่ได้
 *   readonly   ดูอย่างเดียว — เห็นยอด แต่แตะอะไรไม่ได้เลย
 */
const ROLES = ["owner", "manager", "warehouse", "sales", "readonly"];

const ROLE_LABELS = {
  owner: "เจ้าของ",
  manager: "หัวหน้าคลัง",
  warehouse: "คลัง",
  sales: "ฝ่ายขาย",
  readonly: "ดูอย่างเดียว"
};

/* ---------- ตัวช่วยตอบกลับ ---------- */

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // ห้ามแคชเด็ดขาด คำตอบของ API สะท้อนสถานะที่เปลี่ยนตลอด
      // เช่น needsSetup ที่พลิกทันทีเมื่อมีคนสร้างบัญชีแรก
      // ถ้า edge แคชไว้ คนถัดไปจะเห็นฟอร์มสร้างบัญชีทั้งที่มีคนสร้างแล้ว
      "Cache-Control": "no-store, must-revalidate",
      ...headers
    }
  });
}

function fail(status, message, code) {
  return json({ error: message, code: code || null }, status);
}

/* ---------- ผู้ใช้ ---------- */

async function loadUsers(env) {
  const r = await readFile(env, PATHS.users);
  return (r.json && Array.isArray(r.json.users)) ? r.json.users : [];
}

function publicUser(u) {
  return {
    username: u.username,
    name: u.name || u.username,
    role: u.role,
    stockRole: stockRoleOf(u)
  };
}

async function requireSession(request, env) {
  const raw = readCookie(request, SESSION_COOKIE);
  const sess = await readSession(env.SESSION_SECRET, raw);
  if (!sess) throw new HttpError(401, "กรุณาเข้าสู่ระบบ", "NO_SESSION");

  // อ่านจากไฟล์ทุกครั้ง เพื่อให้การถอดสิทธิ์มีผลทันที ไม่ต้องรอ session หมดอายุ
  const users = await loadUsers(env);
  const user = users.find(u => u.username === sess.u);
  if (!user) throw new HttpError(401, "บัญชีนี้ถูกถอดออกจากระบบแล้ว", "NO_USER");
  return user;
}

function requireOwner(user) {
  if (user.role !== "owner") throw new HttpError(403, "เฉพาะเจ้าของเท่านั้นที่ทำรายการนี้ได้", "FORBIDDEN");
}

function normUser(v) {
  const s = String(v || "").trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(s)) {
    throw new HttpError(400, "ชื่อผู้ใช้ใช้ได้เฉพาะ a-z 0-9 . _ - ยาว 3–30 ตัว", "BAD_INPUT");
  }
  return s;
}

function checkPassword(v) {
  const s = String(v || "");
  if (s.length < 8) throw new HttpError(400, "รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร", "BAD_INPUT");
  if (s.length > 200) throw new HttpError(400, "รหัสผ่านยาวเกินไป", "BAD_INPUT");
  return s;
}

/* ================= เส้นทาง ================= */

async function route(request, env, url) {
  const p = url.pathname;
  const method = request.method;
  const body = (method === "POST" || method === "PUT")
    ? await request.json().catch(() => ({}))
    : {};

  /* --- ตั้งค่าเจ้าของคนแรก ใช้ได้ครั้งเดียวตอนยังไม่มีผู้ใช้เลย --- */
  if (p === "/api/setup" && method === "POST") {
    const users = await loadUsers(env);
    if (users.length) throw new HttpError(410, "ระบบตั้งค่าเรียบร้อยแล้ว ใช้หน้านี้ไม่ได้อีก", "DONE");

    const username = normUser(body.username);
    checkPassword(body.password);
    const cred = await hashPassword(body.password);

    await update(env, PATHS.users, () => ({
      users: [{
        username, name: String(body.name || username).slice(0, 60), role: "owner",
        ...cred, createdAt: new Date().toISOString(), mustChangePassword: false
      }]
    }), "สร้างบัญชีเจ้าของคนแรกของระบบสต็อก", username, () => ({ users: [] }));

    const token = await createSession(env.SESSION_SECRET, username, "owner");
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token, SESSION_MAX_AGE) });
  }

  if (p === "/api/setup" && method === "GET") {
    // ชื่อบริษัทอยู่บนหน้าล็อกอินอยู่แล้ว จึงส่งได้ก่อนเข้าสู่ระบบ
    const company = {
      name: env.COMPANY_NAME || "บริษัทของคุณ",
      short: env.COMPANY_SHORT || env.COMPANY_NAME || "สต็อก",
      logo: env.COMPANY_LOGO || "",
      theme: env.COMPANY_THEME || ""
    };

    // ต่อฐานข้อมูลไม่ได้ก็ยังต้องขึ้นชื่อบริษัทให้ถูก หน้าล็อกอินจะได้ไม่ว่างเปล่า
    try {
      const users = await loadUsers(env);
      return json({ needsSetup: users.length === 0, company });
    } catch (err) {
      return json({ needsSetup: false, company, storeError: err.message });
    }
  }

  /* --- เข้าสู่ระบบ --- */
  if (p === "/api/login" && method === "POST") {
    const username = String(body.username || "").trim().toLowerCase();
    const users = await loadUsers(env);
    const user = users.find(u => u.username === username);

    // ตรวจรหัสเสมอแม้ไม่พบผู้ใช้ เพื่อไม่ให้เดาได้จากเวลาตอบกลับว่ามีชื่อนี้ไหม
    const ok = await verifyPassword(String(body.password || ""), user || {
      salt: "AAAAAAAAAAAAAAAAAAAAAA", hash: "x", iterations: 20000
    });

    if (!user || !ok) {
      await new Promise(r => setTimeout(r, 400));
      throw new HttpError(401, "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง", "BAD_LOGIN");
    }

    const token = await createSession(env.SESSION_SECRET, user.username, user.role);
    return json({ ok: true, mustChangePassword: !!user.mustChangePassword },
      200, { "Set-Cookie": sessionCookie(token, SESSION_MAX_AGE) });
  }

  if (p === "/api/logout" && method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
  }

  /* --- ต่อจากนี้ต้องเข้าสู่ระบบแล้วทั้งหมด --- */
  const me = await requireSession(request, env);

  /**
   * สิ่งที่หน้าเว็บต้องรู้ตอนเปิด — เบามาก ไม่มียอดสต็อกอยู่ในนี้
   * ยอดสต็อกมาจาก /api/stock/snapshot แล้ววิ่งต่อด้วย WebSocket
   */
  if (p === "/api/state" && method === "GET") {
    const out = {
      me: { ...publicUser(me), mustChangePassword: !!me.mustChangePassword },
      stockRole: stockRoleOf(me),
      roles: ROLES,
      roleLabels: ROLE_LABELS
    };
    if (me.role === "owner") out.users = (await loadUsers(env)).map(publicUser);
    return json(out);
  }

  /* --- เปลี่ยนรหัสผ่านตัวเอง --- */
  if (p === "/api/password" && method === "POST") {
    if (!(await verifyPassword(String(body.current || ""), me))) {
      throw new HttpError(403, "รหัสผ่านเดิมไม่ถูกต้อง", "BAD_PASSWORD");
    }
    checkPassword(body.next);
    const cred = await hashPassword(body.next);
    await update(env, PATHS.users, (doc) => {
      const u = doc.users.find(x => x.username === me.username);
      if (!u) return null;
      Object.assign(u, cred, { mustChangePassword: false });
      return doc;
    }, "เปลี่ยนรหัสผ่านของ " + me.username, me.username, () => ({ users: [] }));
    return json({ ok: true });
  }

  /* --- สต็อกสินค้า คือทั้งหมดของระบบนี้ --- */
  if (p.startsWith("/api/stock")) return stock(p, method, body, url, env, me, request);

  /* --- จัดการผู้ใช้ (เจ้าของเท่านั้น) --- */
  if (p === "/api/users" && method === "POST") {
    requireOwner(me);
    const username = normUser(body.username);
    const role = String(body.role || "");
    if (!ROLES.includes(role)) throw new HttpError(400, "ระดับสิทธิ์ไม่ถูกต้อง", "BAD_INPUT");

    const all = await loadUsers(env);
    const existing = all.find(u => u.username === username);
    const wantsNewPassword = !!body.password;

    // คนใหม่ต้องมีรหัสชั่วคราวเสมอ ส่วนคนเดิมถ้าไม่ส่งรหัสมา แปลว่าแก้แค่ระดับหรือชื่อ
    // จะได้เปลี่ยนสิทธิ์โดยไม่ต้องรีเซ็ตรหัสของเขาทิ้ง
    if (!existing && !wantsNewPassword) {
      throw new HttpError(400, "ผู้ใช้ใหม่ต้องตั้งรหัสผ่านชั่วคราวด้วย", "BAD_INPUT");
    }
    if (wantsNewPassword) checkPassword(body.password);

    // กันระบบไร้เจ้าของ ถ้าเหลือเจ้าของคนเดียวจะลดระดับไม่ได้
    if (existing && existing.role === "owner" && role !== "owner") {
      if (all.filter(u => u.role === "owner").length <= 1) {
        throw new HttpError(400, "ต้องมีเจ้าของอย่างน้อยหนึ่งคน ตั้งคนอื่นเป็นเจ้าของก่อนจึงจะลดระดับตัวเองได้", "LAST_OWNER");
      }
    }

    const cred = wantsNewPassword ? await hashPassword(body.password) : null;

    await update(env, PATHS.users, (doc) => {
      const found = doc.users.find(u => u.username === username);
      if (found) {
        found.role = role;
        found.name = String(body.name || found.name || username).slice(0, 60);
        if (cred) Object.assign(found, cred, { mustChangePassword: true });
      } else {
        doc.users.push({
          username, name: String(body.name || username).slice(0, 60), role,
          ...cred, createdAt: new Date().toISOString(), mustChangePassword: true
        });
      }
      return doc;
    }, existing
         ? (cred ? `ตั้งรหัสใหม่และระดับ ${role} ให้ ${username}` : `เปลี่ยนระดับ ${username} เป็น ${role}`)
         : `เพิ่มผู้ใช้ ${username} ระดับ ${role}`,
       me.username, () => ({ users: [] }));

    return json({ users: (await loadUsers(env)).map(publicUser), changedPassword: wantsNewPassword });
  }

  const userMatch = p.match(/^\/api\/users\/([a-z0-9._-]+)$/);
  if (userMatch && method === "DELETE") {
    requireOwner(me);
    const username = userMatch[1];
    if (username === me.username) throw new HttpError(400, "ถอดบัญชีตัวเองไม่ได้", "BAD_INPUT");

    await update(env, PATHS.users, (doc) => {
      const before = doc.users.length;
      doc.users = doc.users.filter(u => u.username !== username);
      return doc.users.length === before ? null : doc;
    }, `ถอดผู้ใช้ ${username}`, me.username, () => ({ users: [] }));

    return json({ users: (await loadUsers(env)).map(publicUser) });
  }

  throw new HttpError(404, "ไม่รู้จักคำสั่งนี้", "NO_ROUTE");
}
/* ================= สต็อกสินค้า ================= */

/**
 * หนึ่งบริษัท = หนึ่ง Durable Object เพราะแต่ละบริษัทเป็น environment ของตัวเอง
 * ข้อมูลของแต่ละบริษัทจึงปนกันไม่ได้
 */
function stockStub(env) {
  if (!env.STOCK) {
    throw new HttpError(500, "ยังไม่ได้ตั้งค่าที่เก็บสต็อก — ให้เจ้าของ deploy ใหม่", "NO_STOCK_BINDING");
  }
  return env.STOCK.get(env.STOCK.idFromName("main"));
}

/** ส่งต่อไปที่ Durable Object แล้วส่งคำตอบกลับตรง ๆ พร้อมกฎห้ามแคชเหมือน API อื่น */
async function stockCall(env, path, method, payload) {
  const res = await stockStub(env).fetch(new Request("https://stock" + path, {
    method: method || "GET",
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined
  }));
  const data = await res.json().catch(() => ({ error: "ที่เก็บสต็อกตอบกลับไม่ถูกต้อง", code: "STOCK_ERROR" }));
  return json(data, res.status);
}

function requireScan(role) {
  if (!canScan(role)) {
    throw new HttpError(403, "บัญชีนี้ยิงสต็อกไม่ได้ — ต้องเป็นระดับคลังขึ้นไป", "FORBIDDEN");
  }
}

function requireStockManager(role) {
  if (!canManageProducts(role)) {
    throw new HttpError(403, "เฉพาะหัวหน้าคลังขึ้นไปที่ทำรายการนี้ได้", "FORBIDDEN");
  }
}

function requireReserve(role) {
  if (!canReserve(role)) {
    throw new HttpError(403, "บัญชีนี้เป็นระดับดูอย่างเดียว จองของไม่ได้", "FORBIDDEN");
  }
}

/** เวลาไทยคือ UTC+7 ตายตัว ไม่มี daylight saving จึงบวกตรง ๆ ได้ */
function bangkokDate(d) {
  return new Date(d.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * เก็บประวัติลงรีโปของระบบสต็อกเอง — git ยังเป็น audit trail
 * แต่เป็นระดับวัน ไม่ใช่ระดับการยิง
 * และถ้า Durable Object เสียหายทั้งก้อน สร้างใหม่จากไฟล์พวกนี้ได้
 */
async function archiveStock(env, dayIso) {
  const res = await stockStub(env).fetch(new Request("https://stock/archive?date=" + dayIso));
  if (!res.ok) throw new HttpError(502, "อ่านสต็อกเพื่อเก็บประวัติไม่สำเร็จ", "STOCK_ARCHIVE");
  const data = await res.json();
  const actor = "stock-archive";

  // ทะเบียนสินค้าเขียนเฉพาะเมื่อเปลี่ยน ไม่งั้นจะมี commit เปล่าทุกคืน
  await update(env, STOCK_PATHS.products, (doc) => {
    const same = JSON.stringify(doc.products || []) === JSON.stringify(data.products)
              && JSON.stringify(doc.barcodes || []) === JSON.stringify(data.barcodes);
    if (same) return null;
    return { products: data.products, barcodes: data.barcodes, updatedAt: data.date };
  }, `ทะเบียนสินค้า ${data.date}`, actor, () => ({ products: [], barcodes: [] }));

  // เก็บการจองที่ยังเปิดไว้ด้วย เพราะเป็นสิ่งเดียวที่กู้ระบบแล้วต้องไม่หาย
  // การจองที่แพ็คไปแล้วอยู่ในตาราง movements อยู่แล้ว
  await update(env, STOCK_PATHS.balance(data.date), () => ({
    date: data.date, version: data.version,
    balance: data.balance, reservations: data.reservations || []
  }), `ยอดสต็อกปิดวัน ${data.date}`, actor, () => ({}));

  const month = data.date.slice(0, 7);
  await update(env, STOCK_PATHS.movements(month), (doc) => {
    const have = new Set((doc.movements || []).map(m => m.id));
    const add = (data.movements || []).filter(m => !have.has(m.id));
    if (!add.length) return null;
    doc.month = month;
    doc.movements = (doc.movements || []).concat(add);
    return doc;
  }, `การเคลื่อนไหวสต็อก ${data.date} (${(data.movements || []).length} รายการ)`, actor,
     () => ({ month, movements: [] }));

  return {
    date: data.date,
    movements: (data.movements || []).length,
    balance: (data.balance || []).length,
    products: (data.products || []).length
  };
}

async function stock(p, method, body, url, env, me, request) {
  const role = stockRoleOf(me);
  const withMe = (extra) => ({ ...(body || {}), ...(extra || {}), userId: me.username });

  /* --- สายเรียลไทม์ ใครยิงอะไรทุกจอเห็นทันที --- */
  if (p === "/api/stock/live" && method === "GET") {
    if (request.headers.get("Upgrade") !== "websocket") {
      throw new HttpError(426, "เส้นทางนี้ใช้กับ WebSocket เท่านั้น", "NEED_WEBSOCKET");
    }
    const u = new URL(request.url);
    u.pathname = "/live";
    u.search = "";
    return stockStub(env).fetch(new Request(u.toString(), request));
  }

  /* --- ยอดทั้งหมด ทุกฝ่ายดูได้ นี่คือจุดประสงค์ของระบบ --- */
  if (p === "/api/stock/snapshot" && method === "GET") {
    return stockCall(env, "/snapshot");
  }

  /* --- จอติดผนังคลังและของใกล้หมด ทุกฝ่ายดูได้ --- */
  if (p === "/api/stock/board" && method === "GET") {
    return stockCall(env, "/board");
  }

  if (p === "/api/stock/alerts" && method === "GET") {
    return stockCall(env, "/alerts");
  }

  /* --- การจอง กุญแจกันฝ่ายขายขายชนกัน --- */
  if (p === "/api/stock/reservations" && method === "GET") {
    const q = new URLSearchParams();
    // mine=1 แปลว่า "ของฉัน" — ชื่อผู้ใช้มาจาก session ไม่ใช่จากคำขอ
    if (url.searchParams.get("mine")) q.set("mine", me.username);
    ["status", "sku"].forEach(k => {
      if (url.searchParams.get(k)) q.set(k, url.searchParams.get(k));
    });
    return stockCall(env, "/reservations?" + q.toString());
  }

  if (p === "/api/stock/reserve" && method === "POST") {
    requireReserve(role);
    return stockCall(env, "/reserve", "POST", withMe());
  }

  if (p === "/api/stock/reserve/release" && method === "POST") {
    requireReserve(role);
    // การจองของคนอื่นยกเลิกได้เฉพาะหัวหน้าคลัง — ตัดสินที่ Durable Object
    return stockCall(env, "/reserve/release", "POST", withMe({ isManager: canManageProducts(role) }));
  }

  if (p === "/api/stock/reserve/extend" && method === "POST") {
    requireReserve(role);
    return stockCall(env, "/reserve/extend", "POST", withMe({ isManager: canManageProducts(role) }));
  }

  if (p === "/api/stock/reserve/sweep" && method === "POST") {
    requireStockManager(role);
    return stockCall(env, "/reserve/sweep", "POST", withMe());
  }

  if (p === "/api/stock/config" && method === "POST") {
    requireStockManager(role);
    return stockCall(env, "/config", "POST", withMe());
  }

  /* --- คลังหลายที่และการย้ายคลัง --- */
  if (p === "/api/stock/locations" && method === "GET") {
    requireScan(role);
    return stockCall(env, "/locations");
  }

  if (p === "/api/stock/locations" && method === "POST") {
    requireStockManager(role);
    return stockCall(env, "/locations", "POST", withMe());
  }

  if (p === "/api/stock/where" && method === "GET") {
    // ของอยู่คลังไหนบ้าง ทุกฝ่ายดูได้ ไม่มีต้นทุนอยู่ในคำตอบ
    return stockCall(env, "/where?sku=" + encodeURIComponent(url.searchParams.get("sku") || ""));
  }

  if (p === "/api/stock/transfer" && method === "POST") {
    requireScan(role);
    return stockCall(env, "/transfer", "POST", withMe());
  }

  /* --- มูลค่าสต็อกและต้นทุน หัวหน้าคลังขึ้นไป --- */
  if (p === "/api/stock/value" && method === "GET") {
    requireStockManager(role);
    return stockCall(env, "/value");
  }

  if (p === "/api/stock/adjustments" && method === "GET") {
    requireStockManager(role);
    return stockCall(env, "/adjustments?days=" + (url.searchParams.get("days") || 7));
  }

  if (p === "/api/stock/adjust" && method === "POST") {
    requireStockManager(role);
    return stockCall(env, "/adjust", "POST", withMe());
  }

  /* --- รอบนับสต็อก --- */
  if (p === "/api/stock/counts" && method === "GET") {
    requireScan(role);
    return stockCall(env, "/counts");
  }

  if (p === "/api/stock/count" && method === "GET") {
    requireScan(role);
    return stockCall(env, "/count?id=" + encodeURIComponent(url.searchParams.get("id") || ""));
  }

  if (p === "/api/stock/count/open" && method === "POST") {
    requireScan(role);
    return stockCall(env, "/count/open", "POST", withMe());
  }

  if (p === "/api/stock/count/scan" && method === "POST") {
    requireScan(role);
    return stockCall(env, "/count/scan", "POST", withMe());
  }

  if (p === "/api/stock/count/close" && method === "POST") {
    // ปิดรอบได้เฉพาะหัวหน้าคลังขึ้นไป และ Durable Object ยังกันคนที่นับเองอีกชั้น
    requireStockManager(role);
    return stockCall(env, "/count/close", "POST", withMe());
  }

  if (p === "/api/stock/count/cancel" && method === "POST") {
    requireStockManager(role);
    return stockCall(env, "/count/cancel", "POST", withMe());
  }

  /* --- บิลรับเข้าและต้นทุน --- */
  if (p === "/api/stock/receipts" && method === "GET") {
    requireStockManager(role);
    return stockCall(env, "/receipts?pending=" + (url.searchParams.get("pending") === "1" ? "1" : "0"));
  }

  if (p === "/api/stock/receipt" && method === "GET") {
    requireStockManager(role);
    return stockCall(env, "/receipt?refId=" + encodeURIComponent(url.searchParams.get("refId") || ""));
  }

  if (p === "/api/stock/receipt/cost" && method === "POST") {
    requireStockManager(role);
    return stockCall(env, "/receipt/cost", "POST", withMe());
  }

  if (p === "/api/stock/movements" && method === "GET") {
    const q = new URLSearchParams();
    if (url.searchParams.get("sku")) q.set("sku", url.searchParams.get("sku"));
    if (url.searchParams.get("limit")) q.set("limit", url.searchParams.get("limit"));
    return stockCall(env, "/movements?" + q.toString());
  }

  /* --- ยิงสต็อก --- */
  if (p === "/api/stock/scan" && method === "POST") {
    requireScan(role);
    return stockCall(env, "/scan", "POST", withMe());
  }

  if (p === "/api/stock/scan/batch" && method === "POST") {
    requireScan(role);
    return stockCall(env, "/scan/batch", "POST", withMe());
  }

  /* --- คิวรอผูกบาร์โค้ด ("ข้ามไว้ก่อน") --- */
  if (p === "/api/stock/pending" && method === "GET") {
    requireScan(role);
    return stockCall(env, "/pending");
  }

  if (p === "/api/stock/pending" && method === "POST") {
    requireScan(role);
    return stockCall(env, "/pending", "POST", withMe());
  }

  if (p === "/api/stock/pending/clear" && method === "POST") {
    requireStockManager(role);
    return stockCall(env, "/pending/clear", "POST", withMe());
  }

  /* --- ทะเบียนสินค้าและบาร์โค้ด --- */
  if (p === "/api/stock/products" && method === "GET") {
    requireStockManager(role);
    return stockCall(env, "/products");
  }

  if (p === "/api/stock/products" && method === "POST") {
    requireStockManager(role);
    return stockCall(env, "/products", "POST", withMe());
  }

  if (p === "/api/stock/products/bulk" && method === "POST") {
    requireOwner(me);
    return stockCall(env, "/products/bulk", "POST", withMe());
  }

  if (p === "/api/stock/barcodes" && method === "POST") {
    requireStockManager(role);
    return stockCall(env, "/barcodes", "POST", withMe());
  }

  if (p === "/api/stock/barcodes/delete" && method === "POST") {
    requireStockManager(role);
    return stockCall(env, "/barcodes/delete", "POST", withMe());
  }

  /* --- สร้างยอดใหม่จาก movements เจ้าของเท่านั้น --- */
  if (p === "/api/stock/rebuild" && method === "POST") {
    requireOwner(me);
    return stockCall(env, "/rebuild", "POST", withMe());
  }

  /* --- สั่งเก็บประวัติเดี๋ยวนี้ ไว้ทดสอบว่า cron จะทำงานถูก --- */
  if (p === "/api/stock/archive" && method === "POST") {
    requireOwner(me);
    return json(await archiveStock(env, bangkokDate(new Date())));
  }

  throw new HttpError(404, "ไม่รู้จักคำสั่งนี้", "NO_ROUTE");
}

export default {
  /**
   * Cron ตอน 23:55 เวลาไทย — commit ยอดปิดวันและการเคลื่อนไหวลงรีโป
   * ล้มเหลวก็ไม่กระทบตัวเลขสด เพราะความจริงอยู่ใน Durable Object
   * คืนถัดไปจะเก็บของวันนั้นอีกครั้งและข้ามรายการที่มีอยู่แล้วให้เอง
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      archiveStock(env, bangkokDate(new Date()))
        .then((r) => console.log("เก็บประวัติสต็อก", JSON.stringify(r)))
        .catch((err) => console.error("เก็บประวัติสต็อกไม่สำเร็จ", err && err.stack))
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      const res = await env.ASSETS.fetch(request);
      const type = res.headers.get("Content-Type") || "";
      if (!type.includes("text/html")) return res;

      // เติมทุกอย่างที่เป็นของบริษัทตั้งแต่ตอนเสิร์ฟ ไม่ต้องรอจาวาสคริปต์
      // ไม่งั้นจะเห็นโลโก้กับชื่อของบริษัทตั้งต้นแวบหนึ่งก่อนสลับ
      const brand = env.COMPANY_THEME;
      const logo = env.COMPANY_LOGO;
      const name = env.COMPANY_NAME;
      const short = env.COMPANY_SHORT || name;
      if (!brand && !logo && !name) return res;

      let rw = new HTMLRewriter();

      if (brand) {
        rw = rw.on("body", { element(el) { el.setAttribute("data-brand", brand); } });
      }

      if (logo) {
        rw = rw
          .on('link[rel="icon"], link[rel="apple-touch-icon"]', {
            element(el) { el.setAttribute("href", logo); }
          })
          .on("img[data-logo]", {
            element(el) {
              el.setAttribute("src", logo);
              el.setAttribute("alt", "โลโก้ " + short);
            }
          });
      }

      if (name) {
        rw = rw
          .on("title", { element(el) { el.setInnerContent("สต็อกสินค้า — " + short); } })
          .on("[data-company]", { element(el) { el.setInnerContent(name); } });
      }

      // หน้า HTML ถูกเติมชื่อและโลโก้เฉพาะบริษัทแล้ว ห้ามให้ edge แคชข้ามกัน
      const out = rw.transform(res);
      const h = new Headers(out.headers);
      h.set("Cache-Control", "no-store, must-revalidate");
      return new Response(out.body, { status: out.status, headers: h });
    }

    try {
      return await route(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return fail(err.status, err.message, err.code);
      console.error(err && err.stack);
      return fail(500, "เกิดข้อผิดพลาดที่เซิร์ฟเวอร์", "SERVER_ERROR");
    }
  }
};
