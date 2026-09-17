/**
 * สต็อกสินค้า — Durable Object ที่ถือตัวเลขสด
 *
 * ทำไมไม่เก็บในรีโปเหมือนสมุดบัญชี (เหตุผลเต็มอยู่ใน STOCK.md)
 *   - ยิงหนึ่งครั้งต้อง commit = รอ 0.6–1.5 วินาที คนแพ็คของยิงรัวไม่ได้
 *   - สต็อกทุกตัวอยู่ไฟล์เดียวกัน สองคนยิงพร้อมกันคนหลังชน 409 ตลอด
 *   - ดึงข้อมูลใหม่ทุก 45 วินาที = หน้าต่าง 45 วินาทีที่ขายของชิ้นเดียวซ้ำได้
 *
 * Durable Object ตัวหนึ่งทำงานทีละคำสั่งโดยธรรมชาติ และ sql.exec เป็นแบบ synchronous
 * ดังนั้นลำดับ อ่าน–ตัด–เขียน ที่ไม่มี await คั่น จะไม่มีคำขออื่นแทรกได้เลย
 * นี่คือเหตุผลที่ตัดสต็อกที่นี่ปลอดภัยโดยไม่ต้องล็อกอะไร — ห้ามใส่ await กลางฟังก์ชัน #apply
 *
 * ความจริงตัวจริงคือตาราง movements ซึ่งเพิ่มได้ ลบไม่ได้
 * ตาราง stock เป็นแค่สำเนาไว้อ่านเร็ว สองตารางไม่ตรงกันให้เชื่อ movements แล้วสั่ง rebuild
 *
 * รีโปยังเป็นคลังประวัติ — Cron ตอน 23:55 ทุกคืน commit ยอดปิดวันและการเคลื่อนไหวลง data/stock/
 */

export const STOCK_PATHS = {
  products: "data/stock/products.json",
  balance: (d) => `data/stock/balance/${d}.json`,
  movements: (m) => `data/stock/movements/${m}.json`
};

/** โหมดยิงที่รองรับ — นับสต็อกเป็นของเฟส 3 */
export const SCAN_MODES = {
  receive: { sign: 1, type: "receive", label: "รับเข้า" },
  issue: { sign: -1, type: "issue", label: "แพ็คส่ง" },
  return_in: { sign: 1, type: "return_in", label: "รับคืน", needReason: true }
};

/**
 * เหตุผลการคืนกำหนดว่าของเข้าคลังไหน — **เซิร์ฟเวอร์ตัดสิน ไม่ใช่คนยิงเลือก**
 * ธุรกิจ COD มีของตีกลับทุกวัน และนี่คือจุดที่สต็อกเพี้ยนบ่อยที่สุด
 * ของเสียหายต้องไม่กลับเข้ากองที่ขายได้ ไม่งั้นฝ่ายขายจะขายของที่ขายไม่ได้
 */
export const RETURN_REASONS = {
  refused:     { label: "ลูกค้าปฏิเสธรับ / ติดต่อไม่ได้", location: "main" },
  box_damaged: { label: "กล่องบุบ ของยังดี", location: "main" },
  damaged:     { label: "สินค้าเสียหาย / หมดอายุ", location: "damaged" },
  other:       { label: "อื่น ๆ (ต้องเขียนหมายเหตุ)", location: "main", needNote: true }
};

/**
 * เหตุผลการปรับยอด — บังคับเลือก เพราะสิทธิ์ปรับยอดแบบไม่จำกัดคือช่องกลบของหาย
 * ทุกการปรับขึ้นรายงานให้เจ้าของเห็นว่าใครปรับอะไรด้วยเหตุผลอะไร
 */
export const ADJUST_REASONS = {
  broken:   "ของแตก/เสียหายในคลัง",
  found:    "เจอของที่หาไม่เจอก่อนหน้านี้",
  lost:     "ของหาย",
  miskey:   "ลงข้อมูลผิดก่อนหน้านี้",
  expired:  "หมดอายุ ต้องทิ้ง",
  other:    "อื่น ๆ (ต้องเขียนหมายเหตุ)"
};

/**
 * การจองไม่ผูกคลัง — พร้อมขายรวมทุกกองที่ขายได้ แต่ตัวเลข reserved ต้องเก็บไว้ที่แถวใดแถวหนึ่ง
 * เลือกกองที่ขายได้กองแรกที่ยังใช้งาน (ปกติคือ main) ถ้าไม่มีเลยการจองจะทำไม่ได้
 * และบอกเหตุผลตรง ๆ ดีกว่าเก็บ reserved ไว้ในกองที่ไม่มีใครนับ
 */
const FALLBACK_RESERVE_LOCATION = "main";
const DEFAULT_RESERVE_HOURS = 24;
const AVG_DAYS = 14;
// ช่วงตั้งต้นของกราฟ "ของไหนออกเยอะ ออกน้อย" — หนึ่งเดือนเห็นรอบการสั่งของพอดี
// สั้นกว่านี้ของที่ขายสัปดาห์ละครั้งจะดูเหมือนไม่ขยับ
const MOVER_DAYS = 30;

export const STOCK_ROLES = ["readonly", "sales", "warehouse", "manager"];

/**
 * ระบบนี้มีสิทธิ์ชุดเดียว ไม่ได้ยืมมาจากที่อื่น
 * เจ้าของได้สิทธิ์สูงสุดเสมอ และอะไรที่อ่านไม่ออกถือว่าดูอย่างเดียว
 * ตั้งใจให้ผิดพลาดไปทางแคบ ไม่ใช่ทางกว้าง
 */
export function stockRoleOf(user) {
  if (!user) return "readonly";
  if (user.role === "owner") return "manager";
  const r = String(user.role || "");
  return STOCK_ROLES.includes(r) ? r : "readonly";
}

export function canScan(role) { return role === "warehouse" || role === "manager"; }
export function canManageProducts(role) { return role === "manager"; }
/** ดูอย่างเดียวจองไม่ได้ ที่เหลือจองได้ทุกระดับ เพราะฝ่ายขายคือคนที่ต้องใช้ปุ่มนี้ */
export function canReserve(role) { return role !== "readonly"; }

const DDL = [
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`,

  `CREATE TABLE IF NOT EXISTS products (
     sku TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     unit TEXT NOT NULL DEFAULT 'ชิ้น',
     category TEXT NOT NULL DEFAULT '',
     reorderPoint INTEGER NOT NULL DEFAULT 0,
     active INTEGER NOT NULL DEFAULT 1,
     createdBy TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL DEFAULT '',
     updatedBy TEXT NOT NULL DEFAULT '', updatedAt TEXT NOT NULL DEFAULT ''
   )`,

  `CREATE TABLE IF NOT EXISTS barcodes (
     barcode TEXT PRIMARY KEY,
     sku TEXT NOT NULL,
     packQty INTEGER NOT NULL DEFAULT 1,
     label TEXT NOT NULL DEFAULT '',
     createdBy TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS idx_barcodes_sku ON barcodes(sku)`,

  // type='sellable' เท่านั้นที่ถูกนับเป็นพร้อมขาย ของเสียหายจึงขายต่อไม่ได้โดยโครงสร้าง
  `CREATE TABLE IF NOT EXISTS locations (
     id TEXT PRIMARY KEY, name TEXT NOT NULL,
     type TEXT NOT NULL DEFAULT 'sellable', active INTEGER NOT NULL DEFAULT 1
   )`,

  // reserved ยังไม่มีใครเขียนในเฟส 1 แต่ใส่ไว้ตั้งแต่ต้นเพื่อให้เฟส 2 ไม่ต้องย้ายข้อมูล
  `CREATE TABLE IF NOT EXISTS stock (
     sku TEXT NOT NULL, locationId TEXT NOT NULL,
     onHand INTEGER NOT NULL DEFAULT 0,
     reserved INTEGER NOT NULL DEFAULT 0,
     updatedAt TEXT NOT NULL DEFAULT '',
     PRIMARY KEY (sku, locationId)
   )`,

  `CREATE TABLE IF NOT EXISTS movements (
     id TEXT PRIMARY KEY,
     ts TEXT NOT NULL,
     sku TEXT NOT NULL, locationId TEXT NOT NULL,
     qty INTEGER NOT NULL,
     type TEXT NOT NULL,
     reason TEXT NOT NULL DEFAULT '',
     refType TEXT NOT NULL DEFAULT '', refId TEXT NOT NULL DEFAULT '',
     scanId TEXT UNIQUE,
     userId TEXT NOT NULL, device TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS idx_mov_ts ON movements(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_mov_sku ON movements(sku, ts)`,

  /* การจองของฝ่ายขาย — ล็อกของไว้ระหว่างที่ปิดออเดอร์แล้วแต่คลังยังไม่แพ็ค
     pickedQty รองรับการแพ็คทีละส่วน ออเดอร์ที่จอง 5 แต่แพ็คไป 2 ยังเหลือจองอยู่ 3 */
  `CREATE TABLE IF NOT EXISTS reservations (
     id TEXT PRIMARY KEY,
     sku TEXT NOT NULL,
     qty INTEGER NOT NULL,
     pickedQty INTEGER NOT NULL DEFAULT 0,
     orderRef TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'open',
     expiresAt TEXT NOT NULL DEFAULT '',
     createdBy TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL DEFAULT '',
     closedBy TEXT NOT NULL DEFAULT '', closedAt TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS idx_res_open ON reservations(status, expiresAt)`,
  `CREATE INDEX IF NOT EXISTS idx_res_order ON reservations(orderRef, sku, status)`,
  `CREATE INDEX IF NOT EXISTS idx_res_mine ON reservations(createdBy, status)`,

  /* รอบนับสต็อก — ยอดคาดหมายถูก "แช่" ไว้ตอนเปิดรอบ
     ระหว่างนับยังยิงงานปกติได้ การเคลื่อนไหวระหว่างนับจึงถูกคิดแยกตอนปิดรอบ */
  `CREATE TABLE IF NOT EXISTS counts (
     id TEXT PRIMARY KEY,
     locationId TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'open',
     startedBy TEXT NOT NULL DEFAULT '', startedAt TEXT NOT NULL DEFAULT '',
     closedBy TEXT NOT NULL DEFAULT '', closedAt TEXT NOT NULL DEFAULT '',
     note TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE TABLE IF NOT EXISTS count_lines (
     countId TEXT NOT NULL, sku TEXT NOT NULL,
     expected INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (countId, sku)
   )`,

  /* การยิงนับเก็บเป็นรายครั้ง ไม่ใช่ยอดรวม
     ทำให้ยิงซ้ำตัวเดิมได้ (ระบบบวกให้) กัน scanId ซ้ำได้ และย้อนได้ว่าใครนับอะไร
     และที่สำคัญที่สุด — SKU ที่ไม่มีแถวที่นี่เลยคือ "ยังไม่นับ" ซึ่งต่างจาก "นับได้ 0" */
  `CREATE TABLE IF NOT EXISTS count_scans (
     scanId TEXT PRIMARY KEY,
     countId TEXT NOT NULL, sku TEXT NOT NULL,
     qty INTEGER NOT NULL DEFAULT 0,
     ts TEXT NOT NULL DEFAULT '', userId TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS idx_cscan ON count_scans(countId, sku)`,

  /* บิลรับเข้า — คลังยิงแต่จำนวน หัวหน้าใส่ต้นทุนทีหลังจากบิลตัวจริง
     เก็บแค่ว่าใครใส่ต้นทุนเมื่อไหร่ ระบบนี้ไม่ลงบัญชีให้ใคร */
  `CREATE TABLE IF NOT EXISTS receipts (
     refId TEXT PRIMARY KEY,
     costedAt TEXT NOT NULL DEFAULT '', costedBy TEXT NOT NULL DEFAULT ''
   )`,

  // คิว "ข้ามไว้ก่อน" — ของที่ยิงแล้วไม่รู้จัก ต้องไม่ทำให้งานคลังหยุด
  `CREATE TABLE IF NOT EXISTS pending_barcodes (
     barcode TEXT PRIMARY KEY,
     mode TEXT NOT NULL DEFAULT '',
     times INTEGER NOT NULL DEFAULT 0,
     qty INTEGER NOT NULL DEFAULT 0,
     firstSeen TEXT NOT NULL DEFAULT '', lastSeen TEXT NOT NULL DEFAULT '',
     lastUser TEXT NOT NULL DEFAULT ''
   )`
];

const DEFAULT_LOCATIONS = [
  ["main", "คลังหลัก", "sellable"],
  ["damaged", "ของเสียหาย", "blocked"]
];

const MAX_UNITS = 5000;
const MAX_BATCH = 200;
const RECENT_LIMIT = 40;

/**
 * รหัสสินค้าที่ระบบรันให้ — คำนำหน้า + เลขสี่หลัก เช่น MT-0001
 * คำนำหน้าแก้ได้ในหน้าค่าตั้ง แต่จำนวนหลักตายตัว
 * เพราะเปลี่ยนแล้วรหัสเก่ากับใหม่จะเรียงไม่ตรงกัน (MT-999 มาก่อน MT-1000)
 */
const DEFAULT_SKU_PREFIX = "MT-";
const SKU_DIGITS = 4;

/**
 * บาร์โค้ดที่ระบบรันให้ — 13 หลักแบบ EAN-13 ขึ้นต้นด้วย 20
 *
 * ช่วง 20–29 เป็นช่วงที่มาตรฐาน GS1 สงวนไว้ให้องค์กรใช้ภายใน
 * จึงไม่มีทางชนกับบาร์โค้ดของสินค้าจากซัพพลายเออร์รายไหนในโลก
 *
 * เป็นตัวเลขล้วนโดยตั้งใจ — เครื่องยิงทำตัวเป็นคีย์บอร์ด
 * ถ้ารหัสมีตัวอักษรแล้วเครื่องคอมตั้งภาษาไทยไว้ ตัวอักษรจะกลายเป็นภาษาไทย
 * ส่วนตัวเลขออกมาถูกทุกภาษา
 */
const BARCODE_PREFIX = "20";

function nowIso() { return new Date().toISOString(); }

/**
 * ช่วงเวลาของ "วันนี้" ตามเวลาไทย แปลงเป็น UTC เพื่อเทียบกับ ts ที่เก็บเป็น ISO
 * ต้องคิดแบบนี้ ไม่งั้นยอดของวันจะตัดตอนเจ็ดโมงเช้าแทนเที่ยงคืน
 */
function bkkDay(now) {
  const date = new Date((now || Date.now()) + 7 * 3600000).toISOString().slice(0, 10);
  const midnight = Date.parse(date + "T00:00:00Z");
  return {
    date,
    startUtc: new Date(midnight - 7 * 3600000).toISOString(),
    endUtc: new Date(midnight + 17 * 3600000).toISOString()
  };
}
function newId(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
/**
 * ตัวเลขในช่วงที่กำหนด ถ้าไม่ส่งมาใช้ค่าเริ่มต้น
 *
 * ต้องดัก null กับสตริงว่างเองก่อน เพราะ Number(null) และ Number("") ได้ 0
 * ซึ่งเป็นตัวเลขที่ finite แล้วโค้ดจะเดินต่อไปบีบมันขึ้นเป็นค่าต่ำสุด
 * แทนที่จะคืนค่าเริ่มต้น — เท่ากับว่า "ไม่ส่งมา" กลายเป็น "ส่งค่าต่ำสุดมา"
 *
 * ที่เจอจริง — /movements ที่ไม่ส่ง limit ได้ limit=1 (ค่าต่ำสุด) ไม่ใช่ 40
 * แสดงประวัติการยิงแค่รายการเดียว ทั้งที่ควรเห็นสี่สิบรายการ
 * และ /reserve ที่ส่ง qty เป็นสตริงว่างจะจอง 1 ชิ้นเงียบ ๆ แทนที่จะฟ้องว่าไม่ใส่จำนวน
 */
function clampInt(v, min, max, dflt) {
  if (v === null || v === undefined || v === "") return dflt;
  const n = Math.trunc(Number(v));
  if (!isFinite(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}
function str(v, max) { return String(v == null ? "" : v).trim().slice(0, max); }

function bad(message, code) {
  return { __error: { status: 400, message, code: code || "BAD_INPUT" } };
}

export class StockRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      for (const stmt of DDL) this.sql.exec(stmt);
      // CREATE TABLE IF NOT EXISTS ไม่เพิ่มคอลัมน์ให้ตารางที่มีอยู่แล้ว
      // ฐานข้อมูลที่ตั้งขึ้นตอนเฟส 1 จึงต้องเติมคอลัมน์ใหม่ทางนี้
      this.#ensureColumn("movements", "note", "TEXT NOT NULL DEFAULT ''");
      this.#ensureColumn("movements", "costPerUnit", "REAL");
      this.#ensureColumn("products", "costAvg", "REAL NOT NULL DEFAULT 0");
      for (const [id, name, type] of DEFAULT_LOCATIONS) {
        this.sql.exec(
          `INSERT INTO locations (id, name, type) VALUES (?, ?, ?)
           ON CONFLICT(id) DO NOTHING`, id, name, type);
      }
      this.sql.exec(`INSERT INTO meta (k, v) VALUES ('version', '0') ON CONFLICT(k) DO NOTHING`);
    });
  }

  #ensureColumn(table, column, decl) {
    const cols = this.sql.exec(`PRAGMA table_info(${table})`).toArray();
    if (cols.some(c => c.name === column)) return;
    this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }

  #setting(key, dflt) {
    const r = this.sql.exec(`SELECT v FROM meta WHERE k=?`, key).toArray()[0];
    const n = r ? Number(r.v) : NaN;
    return isFinite(n) && n > 0 ? n : dflt;
  }

  /** ค่าตั้งที่เป็นข้อความ เช่นคำนำหน้ารหัสสินค้า — #setting รับแต่ตัวเลข */
  #settingStr(key, dflt) {
    const r = this.sql.exec(`SELECT v FROM meta WHERE k=?`, key).toArray()[0];
    return r && r.v ? String(r.v) : dflt;
  }

  #putSetting(key, value) {
    this.sql.exec(`INSERT INTO meta (k, v) VALUES (?, ?)
                   ON CONFLICT(k) DO UPDATE SET v = excluded.v`, key, String(value));
  }

  /* ---------- รหัสสินค้าและบาร์โค้ดที่ระบบรันให้ ----------

     ทั้งสองตัวถูกแจกที่นี่ ไม่ใช่ที่หน้าเว็บ เพราะ Durable Object ทำงานทีละคำขอ
     หัวหน้าคลังสองคนกดเพิ่มสินค้าพร้อมกันจึงได้เลขคนละตัวเสมอ
     ถ้าให้หน้าเว็บคิดเลขเอง สองคนจะได้เลขเดียวกันแล้วทับกัน

     ตัวนับเดินหน้าอย่างเดียว ไม่เคยถอยและไม่เอาเลขที่ลบไปแล้วมาใช้ซ้ำ
     เพราะฉลากที่พิมพ์แล้วแปะไปกับของจริง เลขซ้ำหมายถึงของสองตัวถูกยิงเป็นตัวเดียวกัน  */

  /**
     ข้ามเลขที่มีคนใช้ไปแล้ว — ผู้ใช้ยังพิมพ์รหัสเองได้ ถ้าเขาพิมพ์ MT-0009 ไว้
     ตัวรันต้องไม่ไปทับ และ LIMIT กันไว้ไม่ให้วนไม่จบถ้าข้อมูลพิสดาร
   */
  #nextSkuSync() {
    const prefix = this.#settingStr("skuPrefix", DEFAULT_SKU_PREFIX);
    let n = Math.max(1, Math.trunc(this.#setting("skuNext", 1)));
    for (let guard = 0; guard < 100000; guard++) {
      const sku = prefix + String(n).padStart(SKU_DIGITS, "0");
      const taken = this.sql.exec(`SELECT sku FROM products WHERE sku=?`, sku).toArray()[0];
      if (!taken) {
        this.#putSetting("skuNext", n + 1);
        return sku;
      }
      n++;
    }
    return null;
  }

  /**
     หลักตรวจสอบแบบ EAN-13 — คิดจากสิบสองหลักแรก
     ถ้าเครื่องยิงอ่านเลขผิดไปหลักเดียว หลักนี้จะไม่ตรงและจับได้
   */
  #eanCheck(twelve) {
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      sum += Number(twelve[i]) * (i % 2 === 0 ? 1 : 3);
    }
    return String((10 - (sum % 10)) % 10);
  }

  /**
     ขึ้นต้น 20 — ช่วง 20–29 เป็นช่วงที่มาตรฐาน GS1 สงวนไว้ให้ใช้ในองค์กร
     จึงไม่มีทางชนกับบาร์โค้ดของสินค้าจากซัพพลายเออร์รายไหน
   */
  #nextBarcodeSync() {
    let n = Math.max(1, Math.trunc(this.#setting("barcodeNext", 1)));
    for (let guard = 0; guard < 100000; guard++) {
      const body = BARCODE_PREFIX + String(n).padStart(12 - BARCODE_PREFIX.length, "0");
      const code = body + this.#eanCheck(body);
      const taken = this.sql.exec(`SELECT barcode FROM barcodes WHERE barcode=?`, code).toArray()[0];
      if (!taken) {
        this.#putSetting("barcodeNext", n + 1);
        return code;
      }
      n++;
    }
    return null;
  }

  /**
     เลขถัดไปที่จะได้ ไว้ให้หน้าเว็บขึ้นตัวอย่าง — ไม่จองเลขและไม่ขยับตัวนับ
     ข้ามเลขที่ถูกใช้ไปแล้วด้วย ไม่งั้นตัวอย่างจะบอกเลขที่คนพิมพ์จองมือไว้
     แล้วพอกดบันทึกจะได้อีกเลข ซึ่งดูเหมือนระบบเพี้ยนทั้งที่ทำถูก
   */
  #previewCodes() {
    const prefix = this.#settingStr("skuPrefix", DEFAULT_SKU_PREFIX);

    let sn = Math.max(1, Math.trunc(this.#setting("skuNext", 1)));
    let nextSku = "";
    for (let guard = 0; guard < 10000; guard++) {
      const cand = prefix + String(sn).padStart(SKU_DIGITS, "0");
      if (!this.sql.exec(`SELECT sku FROM products WHERE sku=?`, cand).toArray()[0]) { nextSku = cand; break; }
      sn++;
    }

    let bn = Math.max(1, Math.trunc(this.#setting("barcodeNext", 1)));
    let nextBarcode = "";
    for (let guard = 0; guard < 10000; guard++) {
      const bbody = BARCODE_PREFIX + String(bn).padStart(12 - BARCODE_PREFIX.length, "0");
      const cand = bbody + this.#eanCheck(bbody);
      if (!this.sql.exec(`SELECT barcode FROM barcodes WHERE barcode=?`, cand).toArray()[0]) { nextBarcode = cand; break; }
      bn++;
    }

    return { skuPrefix: prefix, nextSku, nextBarcode };
  }

  /* ---------- เลขเวอร์ชัน ใช้ให้หน้าจอรู้ว่าพลาดข่าวไปหรือเปล่า ---------- */

  #version() {
    const r = this.sql.exec(`SELECT v FROM meta WHERE k='version'`).toArray()[0];
    return r ? Number(r.v) || 0 : 0;
  }

  #bump() {
    const next = this.#version() + 1;
    this.sql.exec(`UPDATE meta SET v=? WHERE k='version'`, String(next));
    return next;
  }

  /* ---------- อ่านยอด ---------- */

  #rowsFor(skus) {
    // ยอดของ SKU ที่ระบุ ถ้าไม่ระบุคือทุกตัวที่ยังใช้งาน
    const where = skus && skus.length
      ? `WHERE p.sku IN (${skus.map(() => "?").join(",")})`
      : `WHERE p.active=1`;
    const args = skus && skus.length ? skus : [];
    return this.sql.exec(
      `SELECT p.sku, p.name, p.unit, p.category, p.reorderPoint, p.active,
              COALESCE(SUM(CASE WHEN l.type='sellable' THEN s.onHand ELSE 0 END), 0) AS onHand,
              COALESCE(SUM(CASE WHEN l.type='sellable' THEN s.reserved ELSE 0 END), 0) AS reserved,
              COALESCE(SUM(CASE WHEN l.type<>'sellable' THEN s.onHand ELSE 0 END), 0) AS blocked
         FROM products p
         LEFT JOIN stock s ON s.sku = p.sku
         LEFT JOIN locations l ON l.id = s.locationId
         ${where}
         GROUP BY p.sku
         ORDER BY p.name`, ...args
    ).toArray().map(r => ({
      sku: r.sku, name: r.name, unit: r.unit, category: r.category,
      reorderPoint: Number(r.reorderPoint) || 0,
      onHand: Number(r.onHand) || 0,
      reserved: Number(r.reserved) || 0,
      blocked: Number(r.blocked) || 0,
      available: (Number(r.onHand) || 0) - (Number(r.reserved) || 0)
    }));
  }

  #snapshot() {
    return {
      version: this.#version(),
      serverTime: nowIso(),
      reserveHours: this.#setting("reserveHours", DEFAULT_RESERVE_HOURS),
      returnReasons: Object.keys(RETURN_REASONS).map(k => ({
        key: k, label: RETURN_REASONS[k].label,
        location: RETURN_REASONS[k].location, needNote: !!RETURN_REASONS[k].needNote
      })),
      locations: this.sql.exec(`SELECT id, name, type FROM locations WHERE active=1`).toArray(),
      products: this.#rowsFor(null),
      // ส่งแผนที่บาร์โค้ดไปด้วย หน้าจอจะขึ้นชื่อสินค้าทันทีที่ยิงโดยไม่ต้องรอเซิร์ฟเวอร์
      barcodes: this.sql.exec(`SELECT barcode, sku, packQty, label FROM barcodes`).toArray()
    };
  }

  /* ---------- กระจายข่าวให้ทุกจอ ---------- */

  #broadcast(msg) {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(text); } catch { /* สายตายแล้ว ไม่ต้องทำอะไร ปล่อยให้ close มาเอง */ }
    }
  }

  #announce(skus, version) {
    if (!skus.length) return;
    this.#broadcast({ t: "delta", version, rows: this.#rowsFor(skus) });
  }

  /* ---------- ยิงหนึ่งครั้ง ----------
   * ห้ามมี await ในฟังก์ชันนี้ ทั้งก้อนต้องทำจบในทีเดียว
   * ไม่งั้นคำขออื่นแทรกกลางระหว่างอ่านยอดกับเขียนยอดได้ แล้วตัวเลขจะเพี้ยน
   */
  #apply(p) {
    const scanId = str(p.scanId, 64);
    if (!scanId) return bad("ไม่มี scanId — คำขอนี้กันยิงซ้ำไม่ได้");

    const mode = SCAN_MODES[String(p.mode || "")];
    if (!mode) return bad("โหมดยิงไม่ถูกต้อง");

    // ยิงซ้ำจากเน็ตกระตุก — ตอบว่าสำเร็จเฉย ๆ ไม่ตัดเพิ่ม
    const dup = this.sql.exec(
      `SELECT m.sku, m.qty, p.name FROM movements m
         LEFT JOIN products p ON p.sku = m.sku
        WHERE m.scanId=?`, scanId).toArray()[0];
    if (dup) {
      const row = this.#rowsFor([dup.sku])[0];
      return {
        ok: true, duplicate: true, sku: dup.sku, name: dup.name || dup.sku,
        delta: Number(dup.qty) || 0, row, version: this.#version(), changed: []
      };
    }

    // รับคืนบังคับเลือกเหตุผล และ**เหตุผลเป็นตัวกำหนดคลัง** ไม่ใช่คนยิง
    // ของเสียหายจึงกลับเข้ากองที่ขายได้ไม่ได้เลย ต่อให้ส่ง locationId มาเองก็ไม่ผ่าน
    let reasonKey = "", note = str(p.note, 160), locationId;
    if (mode.needReason) {
      reasonKey = str(p.reason, 30);
      const rr = RETURN_REASONS[reasonKey];
      if (!rr) return bad("รับคืนต้องเลือกเหตุผล", "NEED_REASON");
      if (rr.needNote && !note) return bad("เหตุผล \"อื่น ๆ\" ต้องเขียนหมายเหตุด้วย", "NEED_NOTE");
      locationId = rr.location;
    } else {
      locationId = str(p.locationId, 40) || "main";
    }

    const loc = this.sql.exec(`SELECT id FROM locations WHERE id=? AND active=1`, locationId).toArray()[0];
    if (!loc) return bad("ไม่พบคลังนี้");

    const units = clampInt(p.units, 1, MAX_UNITS, 1);
    const barcode = str(p.barcode, 64);
    let sku = str(p.sku, 40);
    let packQty = 1;

    if (barcode) {
      const bc = this.sql.exec(`SELECT sku, packQty FROM barcodes WHERE barcode=?`, barcode).toArray()[0];
      if (!bc) return { ok: false, unknownBarcode: true, barcode };
      sku = bc.sku;
      packQty = clampInt(bc.packQty, 1, 10000, 1);
    }
    if (!sku) return bad("ต้องระบุบาร์โค้ดหรือรหัสสินค้า");

    const prod = this.sql.exec(`SELECT sku, name, unit FROM products WHERE sku=?`, sku).toArray()[0];
    if (!prod) return bad("ไม่พบสินค้ารหัสนี้", "NOT_FOUND");

    const qty = mode.sign * packQty * units;

    const refId = str(p.refId, 60);

    /* ต้นทุนต่อหน่วยใส่มาพร้อมการยิงรับเข้าได้ ไม่ต้องรอไปใส่ทีหลังที่แท็บต้นทุน
       รับเฉพาะโหมดรับเข้า เพราะแพ็คส่งกับรับคืนไม่ได้กำหนดต้นทุน มันใช้ค่าถัวเฉลี่ยที่มีอยู่
       ใครมีสิทธิ์ใส่เป็นเรื่องที่ Worker ตัดสินก่อนส่งมาถึงนี่ (คนคลังไม่เห็นช่องนี้เลย) */
    let costPerUnit = null;
    if (mode.type === "receive" && p.costPerUnit != null && p.costPerUnit !== "") {
      const c = Number(p.costPerUnit);
      if (!isFinite(c) || c < 0 || c > 1e9) return bad("ต้นทุนต่อหน่วยไม่ถูกต้อง");
      costPerUnit = Math.round(c * 10000) / 10000;
    }

    this.sql.exec(
      `INSERT INTO movements (id, ts, sku, locationId, qty, type, reason, note, refType, refId, scanId, userId, device, costPerUnit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId("mv"), nowIso(), sku, locationId, qty, mode.type, reasonKey, note,
      str(p.refType, 20) || (mode.type === "receive" ? "bill" : "order"),
      refId, scanId, str(p.userId, 40), str(p.device, 60), costPerUnit);

    this.sql.exec(
      `INSERT INTO stock (sku, locationId, onHand, reserved, updatedAt)
       VALUES (?, ?, ?, 0, ?)
       ON CONFLICT(sku, locationId) DO UPDATE SET onHand = onHand + ?, updatedAt = ?`,
      sku, locationId, qty, nowIso(), qty, nowIso());

    /* แพ็คส่งที่มีเลขออเดอร์ตรงกับที่จองไว้ = แปลงการจองเป็นการตัดจริง
       ต้องลด reserved ตามด้วย ไม่งั้นพร้อมขายจะถูกหักสองรอบ
       (ครั้งแรกตอนจอง ครั้งที่สองตอน onHand ลด) ซึ่งเป็นบั๊กที่หาสาเหตุยากที่สุด */
    let pickedFrom = 0;
    if (mode.type === "issue" && refId) {
      let need = Math.abs(qty);
      const open = this.sql.exec(
        `SELECT id, qty, pickedQty FROM reservations
          WHERE sku=? AND orderRef=? AND status='open' ORDER BY createdAt`, sku, refId).toArray();
      for (const r of open) {
        if (need <= 0) break;
        const remain = (Number(r.qty) || 0) - (Number(r.pickedQty) || 0);
        if (remain <= 0) continue;
        const take = Math.min(remain, need);
        const done = (Number(r.pickedQty) || 0) + take >= (Number(r.qty) || 0);
        this.sql.exec(
          `UPDATE reservations SET pickedQty = pickedQty + ?, status = ?,
             closedBy = ?, closedAt = ? WHERE id = ?`,
          take, done ? "picked" : "open",
          done ? str(p.userId, 40) : "", done ? nowIso() : "", r.id);
        this.sql.exec(
          `UPDATE stock SET reserved = MAX(0, reserved - ?), updatedAt = ?
            WHERE sku = ? AND locationId = ?`, take, nowIso(), sku, this.#reserveLoc());
        need -= take;
        pickedFrom += take;
      }
    }

    // คิดต้นทุนถัวเฉลี่ยใหม่ทันทีที่มีต้นทุนเข้ามา — #recomputeCost ไม่มี await จึงเรียกที่นี่ได้
    const costAvg = costPerUnit == null ? null : this.#recomputeCost(sku);

    const version = this.#bump();
    const row = this.#rowsFor([sku])[0];

    return {
      ok: true, duplicate: false, sku, name: prod.name, unit: prod.unit,
      delta: qty, packQty, units, row, version, changed: [sku],
      locationId, reason: reasonKey, pickedFromReservation: pickedFrom,
      // ส่งกลับให้หน้าจอยืนยันว่าต้นทุนเข้าไปแล้วเท่าไร และถัวเฉลี่ยใหม่เป็นเท่าไร
      costPerUnit, costAvg,
      // ไม่บล็อกตอนติดลบ ของอยู่ในมือคนแพ็คแล้ว ความจริงคือตัวเลขในระบบผิด
      // แต่ต้องดังพอให้รู้ทันที และขึ้นในรายการที่หัวหน้าต้องไปนับ
      negative: row ? row.onHand < 0 : false
    };
  }

  /* ---------- การจอง ----------
   * กุญแจที่ทำให้แอดมินสองคนไม่ขายชิ้นสุดท้ายชนกัน
   * กด จอง แล้วพร้อมขายลดทุกจอทันที คนที่สองจึงเห็น 0 แล้วบอกลูกค้าตรง
   *
   * ต่างจากการยิงตรงที่ **จองเกินที่มีถูกบล็อก** เพราะยังไม่มีของอยู่ในมือใคร
   * จองเกินคือสัญญาที่รักษาไม่ได้ ส่วนยิงเกินคือตัวเลขในระบบผิด คนละเรื่องกัน
   */
  #reserveSync(p) {
    const sku = str(p.sku, 40).toUpperCase();
    const qty = clampInt(p.qty, 1, MAX_UNITS, 0);
    if (!qty) return bad("จำนวนที่จองต้องมากกว่าศูนย์");

    const orderRef = str(p.orderRef, 60);
    if (!orderRef) return bad("ต้องใส่เลขออเดอร์หรือชื่อลูกค้า", "NEED_REF");

    const prod = this.sql.exec(`SELECT sku, name, unit FROM products WHERE sku=? AND active=1`, sku).toArray()[0];
    if (!prod) return bad("ไม่พบสินค้ารหัสนี้ หรือปิดการขายไปแล้ว", "NOT_FOUND");

    const before = this.#rowsFor([sku])[0];
    if (!before || qty > before.available) {
      return bad("พร้อมขายเหลือ " + ((before && before.available) || 0)
        + " จองได้ไม่เกินนี้ — จองเกินคือสัญญาที่รักษาไม่ได้", "NOT_ENOUGH");
    }

    const hours = this.#setting("reserveHours", DEFAULT_RESERVE_HOURS);
    const id = newId("rs");
    const expiresAt = new Date(Date.now() + hours * 3600000).toISOString();

    this.sql.exec(
      `INSERT INTO reservations (id, sku, qty, orderRef, status, expiresAt, createdBy, createdAt)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`,
      id, sku, qty, orderRef, expiresAt, str(p.userId, 40), nowIso());

    this.sql.exec(
      `INSERT INTO stock (sku, locationId, onHand, reserved, updatedAt)
       VALUES (?, ?, 0, ?, ?)
       ON CONFLICT(sku, locationId) DO UPDATE SET reserved = reserved + ?, updatedAt = ?`,
      sku, this.#reserveLoc(), qty, nowIso(), qty, nowIso());

    const version = this.#bump();
    return {
      ok: true, id, sku, name: prod.name, qty, orderRef, expiresAt, hours,
      row: this.#rowsFor([sku])[0], version, changed: [sku]
    };
  }

  #closeSync(p, status) {
    const id = str(p.id, 64);
    const r = this.sql.exec(`SELECT * FROM reservations WHERE id=?`, id).toArray()[0];
    if (!r) return bad("ไม่พบการจองนี้", "NOT_FOUND");
    if (r.status !== "open") return bad("การจองนี้ปิดไปแล้ว (" + r.status + ")", "CLOSED");

    // ยกเลิกการจองของคนอื่นได้เฉพาะหัวหน้าคลังขึ้นไป
    if (r.createdBy !== str(p.userId, 40) && !p.isManager) {
      return { __error: { status: 403, message: "การจองนี้เป็นของ " + r.createdBy
        + " — ยกเลิกได้เฉพาะเจ้าของการจองหรือหัวหน้าคลัง", code: "NOT_YOURS" } };
    }

    const remain = Math.max(0, (Number(r.qty) || 0) - (Number(r.pickedQty) || 0));
    this.sql.exec(
      `UPDATE reservations SET status=?, closedBy=?, closedAt=? WHERE id=?`,
      status, str(p.userId, 40), nowIso(), id);
    if (remain > 0) {
      this.sql.exec(
        `UPDATE stock SET reserved = MAX(0, reserved - ?), updatedAt = ?
          WHERE sku = ? AND locationId = ?`, remain, nowIso(), r.sku, this.#reserveLoc());
    }

    const version = this.#bump();
    return { ok: true, id, sku: r.sku, released: remain, row: this.#rowsFor([r.sku])[0], version, changed: [r.sku] };
  }

  #extendSync(p) {
    const id = str(p.id, 64);
    const r = this.sql.exec(`SELECT * FROM reservations WHERE id=?`, id).toArray()[0];
    if (!r) return bad("ไม่พบการจองนี้", "NOT_FOUND");
    if (r.status !== "open") return bad("ต่ออายุได้เฉพาะการจองที่ยังเปิดอยู่", "CLOSED");
    if (r.createdBy !== str(p.userId, 40) && !p.isManager) {
      return { __error: { status: 403, message: "ต่ออายุได้เฉพาะเจ้าของการจองหรือหัวหน้าคลัง", code: "NOT_YOURS" } };
    }
    const hours = this.#setting("reserveHours", DEFAULT_RESERVE_HOURS);
    const expiresAt = new Date(Date.now() + hours * 3600000).toISOString();
    this.sql.exec(`UPDATE reservations SET expiresAt=? WHERE id=?`, expiresAt, id);
    return { ok: true, id, expiresAt, hours, version: this.#version(), changed: [] };
  }

  /**
   * ปล่อยของคืนจากการจองที่หมดอายุ
   * การจองที่ค้างคือสต็อกที่ขายไม่ได้ทั้งที่ของอยู่บนชั้น ลูกค้าเงียบหายแล้วไม่มีใครมายกเลิก
   * เรียกทั้งจาก alarm และตอนอ่านยอด เพื่อให้ถูกต้องแม้ alarm พลาด
   */
  #expireDueSync() {
    const now = nowIso();
    const due = this.sql.exec(
      `SELECT id, sku, qty, pickedQty, orderRef, createdBy FROM reservations
        WHERE status='open' AND expiresAt <> '' AND expiresAt <= ?`, now).toArray();
    if (!due.length) return null;

    const changed = new Set();
    due.forEach(r => {
      const remain = Math.max(0, (Number(r.qty) || 0) - (Number(r.pickedQty) || 0));
      this.sql.exec(`UPDATE reservations SET status='expired', closedAt=? WHERE id=?`, now, r.id);
      if (remain > 0) {
        this.sql.exec(
          `UPDATE stock SET reserved = MAX(0, reserved - ?), updatedAt = ?
            WHERE sku = ? AND locationId = ?`, remain, now, r.sku, this.#reserveLoc());
      }
      changed.add(r.sku);
    });

    return {
      version: this.#bump(),
      changed: [...changed],
      // แจ้งคนที่จองไว้ ไม่ปล่อยของคืนแบบเงียบ ๆ
      expired: due.map(r => ({
        id: r.id, sku: r.sku, orderRef: r.orderRef, createdBy: r.createdBy,
        released: Math.max(0, (Number(r.qty) || 0) - (Number(r.pickedQty) || 0))
      }))
    };
  }

  /** ปล่อยของคืนแล้วบอกทุกจอ ใช้ร่วมกันระหว่าง alarm กับการอ่านยอด */
  #sweepExpired() {
    const res = this.#expireDueSync();
    if (!res) return null;
    this.#announce(res.changed, res.version);
    this.#broadcast({ t: "expired", version: res.version, items: res.expired });
    return res;
  }

  async #rearmAlarm() {
    const r = this.sql.exec(
      `SELECT MIN(expiresAt) AS t FROM reservations WHERE status='open' AND expiresAt <> ''`).toArray()[0];
    const t = r && r.t ? Date.parse(r.t) : NaN;
    const cur = await this.ctx.storage.getAlarm();
    if (!isFinite(t)) {
      if (cur != null) await this.ctx.storage.deleteAlarm();
      return;
    }
    const when = Math.max(t, Date.now() + 1000);
    // ขยับ alarm เฉพาะเมื่อเวลาต่างกันจริง กันเขียน storage ทุกครั้งที่มีคนจอง
    if (cur == null || Math.abs(cur - when) > 30000) await this.ctx.storage.setAlarm(when);
  }

  async alarm() {
    this.#sweepExpired();
    await this.#rearmAlarm();
  }

  #reservations(q) {
    const where = [], args = [];
    const status = str(q.get("status"), 20);
    if (status) { where.push("r.status = ?"); args.push(status); }
    const mine = str(q.get("mine"), 40);
    if (mine) { where.push("r.createdBy = ?"); args.push(mine); }
    const sku = str(q.get("sku"), 40);
    if (sku) { where.push("r.sku = ?"); args.push(sku); }

    return {
      reservations: this.sql.exec(
        `SELECT r.id, r.sku, r.qty, r.pickedQty, r.orderRef, r.status, r.expiresAt,
                r.createdBy, r.createdAt, r.closedBy, r.closedAt, p.name, p.unit
           FROM reservations r LEFT JOIN products p ON p.sku = r.sku
          ${where.length ? "WHERE " + where.join(" AND ") : ""}
          ORDER BY r.createdAt DESC LIMIT 200`, ...args).toArray(),
      serverTime: nowIso(),
      reserveHours: this.#setting("reserveHours", DEFAULT_RESERVE_HOURS)
    };
  }

  /* ---------- ของใกล้หมด ----------
   * "เหลือ 8 ชิ้น" ไม่พอให้ตัดสินใจ ต้องรู้ว่าพอขายอีกกี่วัน
   * แอดมินจะได้ตอบลูกค้าว่า "เหลือน้อย ถ้าสนใจแนะนำให้สั่งวันนี้"
   */
  #alerts(rows) {
    const since = new Date(Date.now() - AVG_DAYS * 86400000).toISOString();
    const outs = this.sql.exec(
      `SELECT sku, SUM(-qty) AS q FROM movements
        WHERE type='issue' AND ts >= ? GROUP BY sku`, since).toArray();
    const avg = {};
    outs.forEach(r => { avg[r.sku] = Math.max(0, (Number(r.q) || 0) / AVG_DAYS); });

    const list = (rows || this.#rowsFor(null)).map(p => {
      const per = avg[p.sku] || 0;
      return Object.assign({}, p, {
        avgPerDay: Math.round(per * 100) / 100,
        daysLeft: per > 0 ? Math.round((p.available / per) * 10) / 10 : null,
        level: p.available <= 0 ? "out"
             : (p.reorderPoint > 0 && p.available <= p.reorderPoint) ? "low" : "ok"
      });
    });

    const rank = { out: 0, low: 1, ok: 2 };
    return list
      .filter(x => x.level !== "ok" || x.onHand < 0)
      .sort((a, b) => (rank[a.level] - rank[b.level])
        || ((a.daysLeft == null ? 999 : a.daysLeft) - (b.daysLeft == null ? 999 : b.daysLeft)));
  }

  /* ---------- ของไหนออกเยอะ ออกน้อย ----------
   * "เหลือเท่าไร" ตอบได้แล้วจาก snapshot แต่คำถามที่ตามมาทุกครั้งคือ
   * "ตัวไหนขายดี" กับ "ตัวไหนค้างอยู่เฉย ๆ" — สองคำถามนี้คือคำตอบเดียวกัน
   * เรียงจากมากไปน้อย หัวแถวคือของที่ต้องสั่งเพิ่ม ท้ายแถวคือเงินที่จมอยู่
   *
   * นับ "ออก" จากการแพ็คส่งเท่านั้น (type='issue') ไม่รวมการปรับยอดและการย้ายคลัง
   * เพราะปรับยอดคือการแก้ตัวเลขให้ตรงของจริง ไม่ใช่ของที่ขายออกไป
   * ถ้าเอามารวมด้วย ของที่นับขาดบ่อยจะกลายเป็น "ขายดี" ทันที
   *
   * ส่งทุกตัวในทะเบียนกลับไป รวมตัวที่ออกเป็นศูนย์ด้วย
   * เพราะ "ไม่มีในผลลัพธ์" กับ "ไม่ขยับเลย" คนละความหมาย และอันหลังคือคำตอบที่ถาม
   */
  #movers(q) {
    const days = clampInt(q && q.get("days"), 1, 365, MOVER_DAYS);
    const since = new Date(Date.now() - days * 86400000).toISOString();

    /* qty ของการแพ็คส่งเก็บเป็นเลขลบ (ยอดลด) จึงต้องกลับเครื่องหมายก่อนรวม */
    const agg = {};
    this.sql.exec(
      `SELECT sku,
              SUM(CASE WHEN type='issue'     THEN -qty ELSE 0 END) AS out,
              SUM(CASE WHEN type='return_in' THEN  qty ELSE 0 END) AS back,
              SUM(CASE WHEN type='receive'   THEN  qty ELSE 0 END) AS got,
              SUM(CASE WHEN type='issue'     THEN 1 ELSE 0 END)    AS picks,
              COUNT(DISTINCT CASE WHEN type='issue' AND refId <> '' THEN refId END) AS orders,
              MAX(CASE WHEN type='issue' THEN ts ELSE '' END) AS lastOut
         FROM movements
        WHERE ts >= ?
        GROUP BY sku`, since).toArray()
      .forEach(r => { agg[r.sku] = r; });

    /* ตัวที่ไม่ขยับในช่วงนี้ ต้องบอกได้ว่า "ครั้งสุดท้ายเมื่อไร" ไม่ใช่แค่ว่าไม่มีข้อมูล
       ของที่ขายเดือนละครั้งกับของที่ไม่เคยขายเลย ต้องสั่งของคนละแบบ */
    const everOut = {};
    this.sql.exec(`SELECT sku, MAX(ts) AS t FROM movements WHERE type='issue' GROUP BY sku`)
      .toArray().forEach(r => { everOut[r.sku] = r.t || ""; });

    const now = Date.now();
    const rows = this.#rowsFor(null).map(p => {
      const a = agg[p.sku] || {};
      const out = Number(a.out) || 0;
      const last = str(a.lastOut, 40) || everOut[p.sku] || "";
      const t = last ? Date.parse(last) : NaN;
      const perDay = out / days;
      return {
        sku: p.sku, name: p.name, unit: p.unit, category: p.category,
        onHand: p.onHand, available: p.available,
        out,
        back: Number(a.back) || 0,
        got: Number(a.got) || 0,
        picks: Number(a.picks) || 0,
        orders: Number(a.orders) || 0,
        lastOut: last,
        idleDays: isFinite(t) ? Math.floor((now - t) / 86400000) : null,
        perDay: Math.round(perDay * 100) / 100,
        daysLeft: perDay > 0 ? Math.round((p.available / perDay) * 10) / 10 : null
      };
    }).sort((a, b) => (b.out - a.out) || a.name.localeCompare(b.name, "th"));

    return {
      days, since, serverTime: nowIso(), version: this.#version(),
      rows,
      totalOut: rows.reduce((n, r) => n + r.out, 0),
      moved: rows.filter(r => r.out > 0).length,
      idle: rows.filter(r => r.out === 0).length,
      /* ไม่ขยับแต่ยังมีของค้างคลัง = เงินจมจริง ๆ ต่างจากของที่ไม่ขยับเพราะของหมด */
      idleWithStock: rows.filter(r => r.out === 0 && r.onHand > 0).length
    };
  }

  /* ---------- จอติดผนังคลัง ----------
   * ทีวีเครื่องเดียว ไม่มีใครต้องกดอะไร ทุกฝ่ายอ่านตัวเลขชุดเดียวกัน
   */
  #board() {
    const day = bkkDay();
    const by = {};
    this.sql.exec(
      `SELECT type, SUM(qty) AS q, COUNT(*) AS c FROM movements
        WHERE ts >= ? AND ts < ? GROUP BY type`, day.startUtc, day.endUtc)
      .toArray().forEach(r => { by[r.type] = { qty: Number(r.q) || 0, scans: Number(r.c) || 0 }; });

    const rows = this.#rowsFor(null);
    const openRes = this.sql.exec(
      `SELECT COUNT(*) AS c, COUNT(DISTINCT orderRef) AS o,
              COALESCE(SUM(qty - pickedQty), 0) AS q
         FROM reservations WHERE status='open'`).toArray()[0] || {};
    const pend = this.sql.exec(`SELECT COUNT(*) AS c FROM pending_barcodes`).toArray()[0] || {};

    return {
      date: day.date,
      version: this.#version(),
      serverTime: nowIso(),
      today: {
        received: (by.receive && by.receive.qty) || 0,
        issued: Math.abs((by.issue && by.issue.qty) || 0),
        returned: (by.return_in && by.return_in.qty) || 0,
        scans: Object.keys(by).reduce((a, k) => a + by[k].scans, 0)
      },
      alerts: this.#alerts(rows).slice(0, 8),
      waitingPack: { orders: Number(openRes.o) || 0, lines: Number(openRes.c) || 0, qty: Number(openRes.q) || 0 },
      pendingBarcodes: Number(pend.c) || 0,
      negative: rows.filter(r => r.onHand < 0).map(r => ({ sku: r.sku, name: r.name, onHand: r.onHand }))
    };
  }

  /* ---------- คลังหลายที่ ---------- */

  #reserveLoc() {
    const r = this.sql.exec(
      `SELECT id FROM locations WHERE type='sellable' AND active=1
        ORDER BY (id = ?) DESC, id LIMIT 1`, FALLBACK_RESERVE_LOCATION).toArray()[0];
    return r ? r.id : FALLBACK_RESERVE_LOCATION;
  }

  #saveLocation(p) {
    const id = str(p.id, 40).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(id)) {
      return bad("รหัสคลังใช้ได้แค่ a-z 0-9 _ - และต้องยาว 2 ตัวขึ้นไป");
    }
    const name = str(p.name, 60);
    if (!name) return bad("ต้องใส่ชื่อคลัง");
    const type = p.type === "blocked" ? "blocked" : "sellable";
    const active = p.active === false ? 0 : 1;

    const cur = this.sql.exec(`SELECT id, type, active FROM locations WHERE id=?`, id).toArray()[0];

    /* ปิดคลังที่ยังมีของอยู่ไม่ได้ ต้องย้ายออกให้หมดก่อน
       ไม่งั้นของจะหายจากทุกตัวเลขโดยที่ยังอยู่บนชั้นจริง */
    if (cur && cur.active && !active) {
      const left = this.sql.exec(
        `SELECT COALESCE(SUM(onHand), 0) AS q FROM stock WHERE locationId=?`, id).toArray()[0];
      if ((Number(left && left.q) || 0) !== 0) {
        return bad("คลังนี้ยังมีของอยู่ " + (Number(left.q) || 0)
          + " ชิ้น ย้ายออกให้หมดก่อนจึงจะปิดได้", "NOT_EMPTY");
      }
    }

    /* เปลี่ยนประเภทคลังที่มีของอยู่ = พร้อมขายของทุกตัวในคลังนั้นเด้งทันที
       ทำได้ แต่ต้องรู้ตัว จึงบังคับส่ง confirmType มายืนยัน */
    if (cur && cur.type !== type && !p.confirmType) {
      const left2 = this.sql.exec(
        `SELECT COALESCE(SUM(onHand), 0) AS q FROM stock WHERE locationId=?`, id).toArray()[0];
      if ((Number(left2 && left2.q) || 0) !== 0) {
        return bad("คลังนี้มีของอยู่ " + (Number(left2.q) || 0) + " ชิ้น "
          + (type === "blocked" ? "เปลี่ยนเป็นกองที่ขายไม่ได้จะทำให้พร้อมขายลดทันที"
                                : "เปลี่ยนเป็นกองที่ขายได้จะทำให้พร้อมขายเพิ่มทันที")
          + " — ยืนยันก่อน", "CONFIRM_TYPE");
      }
    }

    this.sql.exec(
      `INSERT INTO locations (id, name, type, active) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type, active=excluded.active`,
      id, name, type, active);

    const version = this.#bump();
    this.#broadcast({ t: "reload", version });
    return {
      ok: true, id, created: !cur, version,
      locations: this.sql.exec(`SELECT id, name, type, active FROM locations ORDER BY id`).toArray()
    };
  }

  /** ของตัวหนึ่งกระจายอยู่คลังไหนบ้าง — หน้ารายละเอียดใช้ตอนมีหลายคลัง */
  #where(sku) {
    const prod = this.sql.exec(`SELECT sku, name, unit FROM products WHERE sku=?`, sku).toArray()[0];
    if (!prod) return bad("ไม่พบสินค้ารหัสนี้", "NOT_FOUND");
    return {
      sku: prod.sku, name: prod.name, unit: prod.unit,
      rows: this.sql.exec(
        `SELECT l.id AS locationId, l.name, l.type,
                COALESCE(s.onHand, 0) AS onHand, COALESCE(s.reserved, 0) AS reserved
           FROM locations l
           LEFT JOIN stock s ON s.locationId = l.id AND s.sku = ?
          WHERE l.active = 1
          ORDER BY (l.type = 'sellable') DESC, l.id`, sku).toArray()
    };
  }

  /**
   * ย้ายคลัง — สองแถวคู่กัน ออกจากที่หนึ่ง เข้าอีกที่หนึ่ง
   * ไม่ใช่รายรับไม่ใช่รายจ่าย ของทั้งบริษัทไม่ขยับ ขยับแค่ว่าอยู่ที่ไหน
   * แนวคิดเดียวกับปุ่มโอนระหว่างกระเป๋าเงินในสมุดบัญชี
   */
  #transferSync(p) {
    const scanId = str(p.scanId, 64);
    if (!scanId) return bad("ไม่มี scanId — คำขอนี้กันยิงซ้ำไม่ได้");

    const dup = this.sql.exec(
      `SELECT sku FROM movements WHERE scanId=?`, scanId).toArray()[0];
    if (dup) {
      return { ok: true, duplicate: true, sku: dup.sku,
               row: this.#rowsFor([dup.sku])[0], version: this.#version(), changed: [] };
    }

    const sku = str(p.sku, 40).toUpperCase();
    const from = str(p.fromLocationId, 40);
    const to = str(p.toLocationId, 40);
    if (from === to) return bad("คลังต้นทางกับปลายทางเป็นที่เดียวกัน");

    const qty = clampInt(p.qty, 1, MAX_UNITS, 0);
    if (!qty) return bad("จำนวนที่ย้ายต้องมากกว่าศูนย์");

    const prod = this.sql.exec(`SELECT sku, name, unit FROM products WHERE sku=?`, sku).toArray()[0];
    if (!prod) return bad("ไม่พบสินค้ารหัสนี้", "NOT_FOUND");

    const lf = this.sql.exec(`SELECT id, name, type FROM locations WHERE id=? AND active=1`, from).toArray()[0];
    const lt = this.sql.exec(`SELECT id, name, type FROM locations WHERE id=? AND active=1`, to).toArray()[0];
    if (!lf) return bad("ไม่พบคลังต้นทาง");
    if (!lt) return bad("ไม่พบคลังปลายทาง");

    const ts = nowIso();
    const note = str(p.note, 160);
    const transferId = newId("tf");

    // สองแถวใช้ refId เดียวกันเพื่อจับคู่กันได้ ส่วน scanId ต้องไม่ซ้ำจึงต่อท้ายแถวขาเข้า
    this.sql.exec(
      `INSERT INTO movements (id, ts, sku, locationId, qty, type, reason, note, refType, refId, scanId, userId, device)
       VALUES (?, ?, ?, ?, ?, 'transfer', 'out', ?, 'transfer', ?, ?, ?, ?)`,
      newId("mv"), ts, sku, from, -qty, note, transferId, scanId, str(p.userId, 40), str(p.device, 60));
    this.sql.exec(
      `INSERT INTO movements (id, ts, sku, locationId, qty, type, reason, note, refType, refId, scanId, userId, device)
       VALUES (?, ?, ?, ?, ?, 'transfer', 'in', ?, 'transfer', ?, ?, ?, ?)`,
      newId("mv"), ts, sku, to, qty, note, transferId, scanId + ":in", str(p.userId, 40), str(p.device, 60));

    [[from, -qty], [to, qty]].forEach(([loc, d]) => {
      this.sql.exec(
        `INSERT INTO stock (sku, locationId, onHand, reserved, updatedAt)
         VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(sku, locationId) DO UPDATE SET onHand = onHand + ?, updatedAt = ?`,
        sku, loc, d, ts, d, ts);
    });

    const version = this.#bump();
    const row = this.#rowsFor([sku])[0];
    const at = this.sql.exec(
      `SELECT onHand, reserved FROM stock WHERE sku=? AND locationId=?`, sku, from).toArray()[0] || {};

    return {
      ok: true, duplicate: false, sku, name: prod.name, unit: prod.unit,
      qty, from: lf.name, to: lt.name, transferId, row, version, changed: [sku],
      // ย้ายออกจากกองที่ขายได้ไปกองที่ขายไม่ได้ = พร้อมขายลด ต้องบอกให้รู้
      availableChanged: lf.type !== lt.type,
      negativeAtSource: (Number(at.onHand) || 0) < 0,
      // ย้ายออกจนต่ำกว่ายอดที่จองไว้ = มีคนจองของที่ไม่อยู่ในกองนั้นแล้ว
      reservedAtRisk: (Number(at.onHand) || 0) < (Number(at.reserved) || 0)
    };
  }

  /* ---------- ต้นทุนถัวเฉลี่ย ----------
   * คิดใหม่ทั้งเส้นจากบิลรับเข้าที่มีต้นทุนแล้ว เรียงตามเวลา
   * ทำแบบนี้เพราะหัวหน้าใส่ต้นทุนทีหลังและอาจใส่ไม่เรียงลำดับ
   * คิดใหม่ทั้งเส้นจึงได้ผลเดียวกันเสมอไม่ว่าจะใส่ตอนไหน
   *
   * FIFO ต้องเก็บทีละล็อตและตัดตามคิว ซึ่งงานคลังจริงยิงไม่ไหวและคนอ่านไม่เข้าใจ
   * ถัวเฉลี่ยให้ตัวเลขเดียวต่อ SKU พอกับงบของ SME และอธิบายให้ใครก็เข้าใจได้
   */
  #recomputeCost(sku) {
    const rows = this.sql.exec(
      `SELECT qty, costPerUnit FROM movements
        WHERE sku=? AND type='receive' AND costPerUnit IS NOT NULL
        ORDER BY ts`, sku).toArray();

    let qty = 0, avg = 0;
    rows.forEach(m => {
      const q = Number(m.qty) || 0;
      const c = Number(m.costPerUnit) || 0;
      if (q <= 0) return;
      const next = qty + q;
      avg = next > 0 ? (qty * avg + q * c) / next : 0;
      qty = next;
    });

    const costAvg = Math.round(avg * 10000) / 10000;
    this.sql.exec(`UPDATE products SET costAvg=? WHERE sku=?`, costAvg, sku);
    return costAvg;
  }

  /**
     ตั้งต้นทุนของสินค้าทั้งตัว — ทางเติมต้นทุนย้อนหลังเมื่อรับของเข้าไปแล้วโดยไม่ใส่ราคา
     เดิมต้นทุนเติมได้ทางเดียวคือเปิดบิลรับเข้า ซึ่งใช้ไม่ได้ถ้าตอนยิงไม่ได้ใส่เลขบิล
     หรือของเข้าระบบมาทางปรับยอด — สินค้าตัวนั้นจะไม่มีต้นทุนตลอดไปและไม่ถูกนับในมูลค่าสต็อก

     costAvg เป็นค่าที่ **คำนวณมาจาก movements** ไม่ใช่ค่าที่เก็บไว้ลอย ๆ
     ถ้าเขียนทับตรง ๆ การรับเข้าครั้งถัดไปจะคิดใหม่จาก movements แล้วค่าที่ตั้งมือไว้หายเงียบ ๆ
     จึงเขียนต้นทุนลงบน "การรับเข้าที่ยังไม่มีต้นทุน" ให้แทน แล้วปล่อยให้สูตรเดิมคิดเอง
     ผลที่ได้จึงอยู่ทน และเข้ากับตรรกะถัวเฉลี่ยทั้งระบบโดยไม่ต้องมีข้อยกเว้น
   */
  #setSkuCostSync(p) {
    const sku = str(p.sku, 40).toUpperCase();
    const prod = this.sql.exec(`SELECT sku, name FROM products WHERE sku=?`, sku).toArray()[0];
    if (!prod) return bad("ไม่พบสินค้ารหัสนี้", "NOT_FOUND");

    const c = Number(p.costPerUnit);
    if (!isFinite(c) || c < 0 || c > 1e9) return bad("ต้นทุนต่อหน่วยไม่ถูกต้อง");
    const cost = Math.round(c * 10000) / 10000;

    const blank = this.sql.exec(
      `SELECT COUNT(*) AS n FROM movements
        WHERE sku=? AND type='receive' AND qty > 0 AND costPerUnit IS NULL`, sku).toArray()[0];
    const blankCount = Number(blank && blank.n) || 0;

    if (blankCount > 0) {
      this.sql.exec(
        `UPDATE movements SET costPerUnit=?
          WHERE sku=? AND type='receive' AND qty > 0 AND costPerUnit IS NULL`, cost, sku);
      const costAvg = this.#recomputeCost(sku);
      return {
        ok: true, sku, name: prod.name, applied: "movements",
        filled: blankCount, costAvg, version: this.#bump()
      };
    }

    /* ไม่มีการรับเข้าที่ว่างอยู่ แต่มีที่ใส่ต้นทุนไว้แล้ว
       ต้นทุนของบิลที่ผ่านมาเป็นข้อเท็จจริงทางบัญชี เขียนทับทั้งหมดจากที่นี่ไม่ถูก
       ต้องไปแก้ที่บิลนั้น ๆ จึงบอกเลขบิลไปให้เลยว่าต้องไปเปิดใบไหน */
    const costed = this.sql.exec(
      `SELECT DISTINCT refId FROM movements
        WHERE sku=? AND type='receive' AND qty > 0 AND costPerUnit IS NOT NULL
          AND refId <> '' LIMIT 5`, sku).toArray();
    const anyCosted = this.sql.exec(
      `SELECT COUNT(*) AS n FROM movements
        WHERE sku=? AND type='receive' AND qty > 0 AND costPerUnit IS NOT NULL`, sku).toArray()[0];

    if ((Number(anyCosted && anyCosted.n) || 0) > 0) {
      const bills = costed.map(r => r.refId).join(", ");
      return bad("สินค้าตัวนี้มีต้นทุนจากบิลรับเข้าอยู่แล้ว แก้ได้ที่บิลนั้น"
        + (bills ? " — บิล " + bills : " (บิลไม่มีเลขอ้างอิง)"), "HAS_RECEIPTS");
    }

    /* ไม่มีการรับเข้าเลย เช่นของเข้าระบบมาทางปรับยอด — ไม่มีสูตรไหนมาคิดทับ
       เขียน costAvg ตรง ๆ ได้ แต่ต้องรู้ว่าพอมีบิลรับเข้าที่มีต้นทุนจริงเข้ามา
       สูตรจะคิดใหม่จากบิลนั้นและทับค่านี้ ซึ่งถูกต้องแล้ว บิลจริงชนะเลขที่พิมพ์เอง */
    this.sql.exec(`UPDATE products SET costAvg=? WHERE sku=?`, cost, sku);
    return {
      ok: true, sku, name: prod.name, applied: "direct",
      filled: 0, costAvg: cost, version: this.#bump()
    };
  }

  /**
     ล้างข้อมูลทดสอบก่อนเริ่มใช้จริง — ยอดเป็นศูนย์ ประวัติหายหมด แต่ทะเบียนสินค้าอยู่ครบ
     ตอนลองใช้ช่วงแรกจะมีการยิงเล่น ยอดติดลบ การจองค้าง รอบนับที่ไม่จบ
     ถ้ายกของพวกนั้นเข้าวันเปิดใช้จริงด้วย ตัวเลขวันแรกจะผิดตั้งแต่ต้น
     และไม่มีใครแยกออกว่าอะไรคือของจริงอะไรคือของลอง

     ล้าง   ยอดคงเหลือ · การเคลื่อนไหว · การจอง · รอบนับ · บิลรับเข้า · คิวรอผูกบาร์โค้ด · ต้นทุน
     เก็บ   ทะเบียนสินค้า · บาร์โค้ด · คลัง · ค่าตั้ง (อายุการจอง คำนำหน้ารหัส ตัวรันเลข)

     ต้นทุนถูกล้างด้วย เพราะ costAvg คำนวณมาจาก movements — ลบ movements แล้วเก็บ costAvg ไว้
     จะได้ตัวเลขที่ไม่มีอะไรรองรับ อธิบายที่มาไม่ได้ และจะถูกคิดใหม่ทับตอนรับเข้าครั้งแรกอยู่ดี

     ไม่ล้างตัวรันเลขรหัสสินค้ากับบาร์โค้ด เพราะสินค้ายังถือรหัสเดิมอยู่
     ถอยตัวนับกลับไปจะไปชนรหัสที่ถูกใช้แล้ว
   */
  #resetSync(p) {
    // ต้องพิมพ์คำยืนยันมาให้ตรง กันคำขอที่หลุดมาโดยไม่มีเจตนา
    if (str(p.confirm, 20) !== "RESET") {
      return bad("ต้องยืนยันก่อนล้างข้อมูล", "NEED_CONFIRM");
    }

    const count = (sql) => {
      const r = this.sql.exec(sql).toArray()[0];
      return Number(r && r.n) || 0;
    };
    // นับก่อนลบ เพื่อบอกเจ้าของได้ว่าหายไปเท่าไร และอะไรที่ยังอยู่
    const cleared = {
      movements: count(`SELECT COUNT(*) AS n FROM movements`),
      // บิลรับเข้าที่เจ้าของเห็นในหน้าบิล มาจากการจัดกลุ่ม movements ไม่ใช่ตาราง receipts
      // ตาราง receipts เก็บแค่สถานะว่าบิลนั้นลงต้นทุนครบแล้วหรือยัง
      receipts: count(
        `SELECT COUNT(*) AS n FROM (
           SELECT refId FROM movements WHERE type='receive' AND refId <> '' GROUP BY refId)`),
      reservations: count(`SELECT COUNT(*) AS n FROM reservations`),
      counts: count(`SELECT COUNT(*) AS n FROM counts`),
      pending: count(`SELECT COUNT(*) AS n FROM pending_barcodes`),
      stockRows: count(`SELECT COUNT(*) AS n FROM stock`)
    };
    const kept = {
      products: count(`SELECT COUNT(*) AS n FROM products`),
      barcodes: count(`SELECT COUNT(*) AS n FROM barcodes`),
      locations: count(`SELECT COUNT(*) AS n FROM locations`)
    };

    this.sql.exec(`DELETE FROM count_scans`);
    this.sql.exec(`DELETE FROM count_lines`);
    this.sql.exec(`DELETE FROM counts`);
    this.sql.exec(`DELETE FROM reservations`);
    this.sql.exec(`DELETE FROM receipts`);
    this.sql.exec(`DELETE FROM pending_barcodes`);
    this.sql.exec(`DELETE FROM movements`);
    this.sql.exec(`DELETE FROM stock`);
    this.sql.exec(`UPDATE products SET costAvg = 0`);

    this.#putSetting("resetAt", nowIso());
    this.#putSetting("resetBy", str(p.userId, 40));

    return { ok: true, cleared, kept, version: this.#bump() };
  }

  /** มูลค่าสต็อก — เห็นได้เฉพาะหัวหน้าคลังขึ้นไป ไม่เคยอยู่ใน snapshot ที่ส่งให้ทุกคน */
  #value() {
    const rows = this.sql.exec(
      `SELECT s.sku, s.locationId, s.onHand, p.name, p.unit, p.costAvg, l.type AS locType, l.name AS locName
         FROM stock s
         JOIN products p ON p.sku = s.sku
         LEFT JOIN locations l ON l.id = s.locationId
        WHERE s.onHand <> 0`).toArray();

    const byLoc = {}, byProd = {};
    let total = 0, noCost = 0;

    rows.forEach(r => {
      const on = Number(r.onHand) || 0;
      const cost = Number(r.costAvg) || 0;
      const v = Math.round(on * cost * 100) / 100;
      total += v;
      if (cost === 0 && on > 0) noCost++;

      const lk = r.locationId;
      if (!byLoc[lk]) byLoc[lk] = { locationId: lk, name: r.locName || lk, type: r.locType || "", qty: 0, value: 0 };
      byLoc[lk].qty += on;
      byLoc[lk].value = Math.round((byLoc[lk].value + v) * 100) / 100;

      if (!byProd[r.sku]) byProd[r.sku] = { sku: r.sku, name: r.name, unit: r.unit, costAvg: cost, qty: 0, value: 0 };
      byProd[r.sku].qty += on;
      byProd[r.sku].value = Math.round((byProd[r.sku].value + v) * 100) / 100;
    });

    /* ของไม่ขยับ — เงินจมอยู่กับอะไร คิดจากการตัดออกครั้งล่าสุด */
    const lastOut = {};
    this.sql.exec(
      `SELECT sku, MAX(ts) AS t FROM movements WHERE type='issue' GROUP BY sku`)
      .toArray().forEach(r => { lastOut[r.sku] = r.t; });

    const now = Date.now();
    const dead = Object.keys(byProd).map(k => {
      const t = lastOut[k] ? Date.parse(lastOut[k]) : NaN;
      return Object.assign({}, byProd[k], {
        lastIssue: lastOut[k] || "",
        idleDays: isFinite(t) ? Math.floor((now - t) / 86400000) : null
      });
    }).filter(x => x.qty > 0 && (x.idleDays == null || x.idleDays >= 60))
      .sort((a, b) => b.value - a.value);

    return {
      total: Math.round(total * 100) / 100,
      byLocation: Object.keys(byLoc).map(k => byLoc[k]).sort((a, b) => b.value - a.value),
      products: Object.keys(byProd).map(k => byProd[k]).sort((a, b) => b.value - a.value),
      dead: dead.slice(0, 40),
      deadValue: Math.round(dead.reduce((a, x) => a + x.value, 0) * 100) / 100,
      withoutCost: noCost
    };
  }

  /* ---------- ปรับยอด ----------
   * หัวหน้าคลังขึ้นไปเท่านั้น และบังคับใส่เหตุผล
   * ปรับยอดได้แบบไม่จำกัดคือช่องกลบของหาย จึงต้องมีประวัติที่ลบไม่ได้และมีคนอ่าน
   */
  #adjustSync(p) {
    const sku = str(p.sku, 40).toUpperCase();
    const locationId = str(p.locationId, 40) || "main";
    const reason = str(p.reason, 30);
    const note = str(p.note, 160);

    if (!ADJUST_REASONS[reason]) return bad("ปรับยอดต้องเลือกเหตุผล", "NEED_REASON");
    if (reason === "other" && !note) return bad("เหตุผล \"อื่น ๆ\" ต้องเขียนหมายเหตุด้วย", "NEED_NOTE");

    const prod = this.sql.exec(`SELECT sku, name FROM products WHERE sku=?`, sku).toArray()[0];
    if (!prod) return bad("ไม่พบสินค้ารหัสนี้", "NOT_FOUND");
    const loc = this.sql.exec(`SELECT id FROM locations WHERE id=? AND active=1`, locationId).toArray()[0];
    if (!loc) return bad("ไม่พบคลังนี้");

    const cur = this.sql.exec(
      `SELECT onHand FROM stock WHERE sku=? AND locationId=?`, sku, locationId).toArray()[0];
    const onHand = Number(cur && cur.onHand) || 0;

    // รับได้สองแบบ — ใส่ยอดที่ถูกต้อง หรือใส่ผลต่าง
    let delta;
    if (p.targetOnHand != null && p.targetOnHand !== "") {
      delta = clampInt(p.targetOnHand, -1e9, 1e9, onHand) - onHand;
    } else {
      delta = clampInt(p.delta, -1e9, 1e9, 0);
    }
    if (!delta) return bad("ยอดใหม่เท่ากับยอดเดิม ไม่มีอะไรต้องปรับ");

    const scanId = str(p.scanId, 64) || newId("aj");
    const dup = this.sql.exec(`SELECT sku FROM movements WHERE scanId=?`, scanId).toArray()[0];
    if (dup) return { ok: true, duplicate: true, sku, row: this.#rowsFor([sku])[0], version: this.#version(), changed: [] };

    this.sql.exec(
      `INSERT INTO movements (id, ts, sku, locationId, qty, type, reason, note, refType, refId, scanId, userId)
       VALUES (?, ?, ?, ?, ?, 'adjust', ?, ?, 'adjust', '', ?, ?)`,
      newId("mv"), nowIso(), sku, locationId, delta, reason, note, scanId, str(p.userId, 40));

    this.sql.exec(
      `INSERT INTO stock (sku, locationId, onHand, reserved, updatedAt)
       VALUES (?, ?, ?, 0, ?)
       ON CONFLICT(sku, locationId) DO UPDATE SET onHand = onHand + ?, updatedAt = ?`,
      sku, locationId, delta, nowIso(), delta, nowIso());

    const version = this.#bump();
    return {
      ok: true, sku, name: prod.name, delta, before: onHand, after: onHand + delta,
      row: this.#rowsFor([sku])[0], version, changed: [sku]
    };
  }

  #adjustments(days) {
    const since = new Date(Date.now() - clampInt(days, 1, 365, 7) * 86400000).toISOString();
    return this.sql.exec(
      `SELECT m.id, m.ts, m.sku, m.locationId, m.qty, m.reason, m.note, m.userId, p.name
         FROM movements m LEFT JOIN products p ON p.sku = m.sku
        WHERE m.type='adjust' AND m.ts >= ? ORDER BY m.ts DESC LIMIT 300`, since).toArray();
  }

  /* ---------- รอบนับสต็อก ---------- */

  #openCount(p) {
    const locationId = str(p.locationId, 40) || "main";
    const loc = this.sql.exec(`SELECT id, name FROM locations WHERE id=? AND active=1`, locationId).toArray()[0];
    if (!loc) return bad("ไม่พบคลังนี้");

    const already = this.sql.exec(
      `SELECT id FROM counts WHERE locationId=? AND status='open'`, locationId).toArray()[0];
    if (already) return bad("คลังนี้มีรอบนับที่เปิดอยู่แล้ว (" + already.id + ")", "ALREADY_OPEN");

    const id = "cnt_" + bkkDay().date.replace(/-/g, "").slice(2) + "_" + Math.random().toString(36).slice(2, 6);
    this.sql.exec(
      `INSERT INTO counts (id, locationId, status, startedBy, startedAt)
       VALUES (?, ?, 'open', ?, ?)`, id, locationId, str(p.userId, 40), nowIso());

    /* แช่ยอดคาดหมายของ **ทุกสินค้าที่ยังขายอยู่** ไม่ใช่แค่ตัวที่มีของ
       ไม่งั้นของที่ระบบว่าหมดแต่จริง ๆ มีอยู่บนชั้นจะไม่มีแถวให้นับ */
    this.sql.exec(
      `INSERT INTO count_lines (countId, sku, expected)
       SELECT ?, p.sku, COALESCE(s.onHand, 0)
         FROM products p
         LEFT JOIN stock s ON s.sku = p.sku AND s.locationId = ?
        WHERE p.active = 1`, id, locationId);

    const n = this.sql.exec(`SELECT COUNT(*) AS c FROM count_lines WHERE countId=?`, id).toArray()[0];
    return { ok: true, id, locationId, locationName: loc.name, lines: Number(n && n.c) || 0 };
  }

  #countScan(p) {
    const countId = str(p.countId, 64);
    const c = this.sql.exec(`SELECT * FROM counts WHERE id=?`, countId).toArray()[0];
    if (!c) return bad("ไม่พบรอบนับนี้", "NOT_FOUND");
    if (c.status !== "open") return bad("รอบนับนี้ปิดไปแล้ว", "CLOSED");

    const scanId = str(p.scanId, 64);
    if (!scanId) return bad("ไม่มี scanId — คำขอนี้กันยิงซ้ำไม่ได้");

    const dup = this.sql.exec(`SELECT sku, qty FROM count_scans WHERE scanId=?`, scanId).toArray()[0];
    if (dup) {
      return { ok: true, duplicate: true, sku: dup.sku, added: Number(dup.qty) || 0,
               counted: this.#countedOf(countId, dup.sku) };
    }

    const units = clampInt(p.units, 1, MAX_UNITS, 1);
    const barcode = str(p.barcode, 64);
    let sku = str(p.sku, 40).toUpperCase(), packQty = 1;

    if (barcode) {
      const bc = this.sql.exec(`SELECT sku, packQty FROM barcodes WHERE barcode=?`, barcode).toArray()[0];
      if (!bc) return { ok: false, unknownBarcode: true, barcode };
      sku = bc.sku;
      packQty = clampInt(bc.packQty, 1, 10000, 1);
    }
    if (!sku) return bad("ต้องระบุบาร์โค้ดหรือรหัสสินค้า");

    const prod = this.sql.exec(`SELECT sku, name, unit FROM products WHERE sku=?`, sku).toArray()[0];
    if (!prod) return bad("ไม่พบสินค้ารหัสนี้", "NOT_FOUND");

    const qty = packQty * units;
    this.sql.exec(
      `INSERT INTO count_scans (scanId, countId, sku, qty, ts, userId)
       VALUES (?, ?, ?, ?, ?, ?)`, scanId, countId, sku, qty, nowIso(), str(p.userId, 40));

    // สินค้าที่ยังไม่มีแถวคาดหมาย (เพิ่งเพิ่มหลังเปิดรอบ) ให้สร้างให้ด้วย คาดหมาย = 0
    this.sql.exec(
      `INSERT INTO count_lines (countId, sku, expected) VALUES (?, ?, 0)
       ON CONFLICT(countId, sku) DO NOTHING`, countId, sku);

    return {
      ok: true, duplicate: false, sku, name: prod.name, unit: prod.unit,
      added: qty, packQty, units, counted: this.#countedOf(countId, sku)
    };
  }

  #countedOf(countId, sku) {
    const r = this.sql.exec(
      `SELECT SUM(qty) AS q FROM count_scans WHERE countId=? AND sku=?`, countId, sku).toArray()[0];
    return r && r.q != null ? Number(r.q) : null;
  }

  /**
   * รายงานผลต่าง
   * counted = null แปลว่า **ยังไม่นับ** ซึ่งต่างจากนับได้ 0 คนละเรื่องเลย
   * ระบบที่เหมาว่าไม่ยิง = ไม่มี จะล้างสต็อกทั้งคลังทิ้งเพราะคนนับเดินไม่ทั่ว
   */
  #countReport(countId) {
    const c = this.sql.exec(`SELECT * FROM counts WHERE id=?`, countId).toArray()[0];
    if (!c) return bad("ไม่พบรอบนับนี้", "NOT_FOUND");

    const counted = {};
    this.sql.exec(
      `SELECT sku, SUM(qty) AS q, COUNT(*) AS n, MAX(ts) AS t
         FROM count_scans WHERE countId=? GROUP BY sku`, countId)
      .toArray().forEach(r => { counted[r.sku] = { qty: Number(r.q) || 0, scans: Number(r.n) || 0, at: r.t }; });

    // การเคลื่อนไหวหลังเปิดรอบ คิดแยกออกจากผลต่าง เพราะระหว่างนับยังยิงงานปกติได้
    const moved = {};
    this.sql.exec(
      `SELECT sku, SUM(qty) AS q FROM movements
        WHERE locationId=? AND ts >= ? GROUP BY sku`, c.locationId, c.startedAt)
      .toArray().forEach(r => { moved[r.sku] = Number(r.q) || 0; });

    const lines = this.sql.exec(
      `SELECT cl.sku, cl.expected, p.name, p.unit, p.costAvg
         FROM count_lines cl LEFT JOIN products p ON p.sku = cl.sku
        WHERE cl.countId=? ORDER BY p.name`, countId).toArray().map(l => {
      const cnt = counted[l.sku] || null;
      const expected = Number(l.expected) || 0;
      const mv = moved[l.sku] || 0;
      const diff = cnt ? cnt.qty - expected : null;
      const cost = Number(l.costAvg) || 0;
      return {
        sku: l.sku, name: l.name || l.sku, unit: l.unit || "",
        expected, counted: cnt ? cnt.qty : null,
        scans: cnt ? cnt.scans : 0, countedAt: cnt ? cnt.at : "",
        movedDuringCount: mv,
        diff,
        diffValue: diff == null ? null : Math.round(diff * cost * 100) / 100,
        state: cnt == null ? "uncounted" : diff === 0 ? "match" : diff < 0 ? "short" : "over"
      };
    });

    const pick = (k) => lines.filter(l => l.state === k);
    const counters = this.sql.exec(
      `SELECT DISTINCT userId FROM count_scans WHERE countId=?`, countId).toArray().map(r => r.userId);

    return {
      count: {
        id: c.id, locationId: c.locationId, status: c.status,
        startedBy: c.startedBy, startedAt: c.startedAt,
        closedBy: c.closedBy, closedAt: c.closedAt, note: c.note
      },
      counters,
      lines,
      totals: {
        lines: lines.length,
        match: pick("match").length,
        short: pick("short").length,
        over: pick("over").length,
        uncounted: pick("uncounted").length,
        countedLines: lines.length - pick("uncounted").length,
        diffValue: Math.round(lines.reduce((a, l) => a + (l.diffValue || 0), 0) * 100) / 100
      }
    };
  }

  /**
   * ปิดรอบ — ลง movement ประเภท count ให้ตรงของจริง
   * แตะเฉพาะแถวที่ยิงนับแล้ว แถวที่ยังไม่นับไม่ถูกแตะเลย
   * ผลต่างคิดจาก counted − expected ที่แช่ไว้ ส่วนการเคลื่อนไหวระหว่างนับซ้อนทับอยู่แล้ว
   */
  #closeCountSync(p) {
    const countId = str(p.countId, 64);
    const c = this.sql.exec(`SELECT * FROM counts WHERE id=?`, countId).toArray()[0];
    if (!c) return bad("ไม่พบรอบนับนี้", "NOT_FOUND");
    if (c.status !== "open") return bad("รอบนับนี้ปิดไปแล้ว", "CLOSED");

    const actor = str(p.userId, 40);

    /* คนนับกับคนปิดรอบต้องเป็นคนละคน
       คนที่นับเองแล้วยืนยันผลต่างเองได้ เท่ากับแก้ตัวเลขให้ตรงมือตัวเองได้ */
    const scanned = this.sql.exec(
      `SELECT DISTINCT userId FROM count_scans WHERE countId=?`, countId).toArray().map(r => r.userId);
    if (scanned.indexOf(actor) >= 0 && !p.force) {
      return { __error: { status: 403,
        message: "คุณเป็นคนยิงนับในรอบนี้ — คนนับกับคนปิดรอบต้องเป็นคนละคน "
               + "ให้หัวหน้าคนอื่นหรือเจ้าของยืนยันผลต่าง",
        code: "SAME_PERSON" } };
    }
    if (!scanned.length) return bad("รอบนี้ยังไม่มีใครยิงนับเลย", "NOTHING_COUNTED");

    const rep = this.#countReport(countId);
    const changed = new Set();
    let posted = 0;

    rep.lines.forEach(l => {
      if (l.state === "uncounted" || !l.diff) return;
      this.sql.exec(
        `INSERT INTO movements (id, ts, sku, locationId, qty, type, reason, note, refType, refId, scanId, userId)
         VALUES (?, ?, ?, ?, ?, 'count', 'count', ?, 'count', ?, ?, ?)`,
        newId("mv"), nowIso(), l.sku, c.locationId, l.diff,
        "นับได้ " + l.counted + " คาดหมาย " + l.expected, countId,
        "cnt:" + countId + ":" + l.sku, actor);
      this.sql.exec(
        `INSERT INTO stock (sku, locationId, onHand, reserved, updatedAt)
         VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(sku, locationId) DO UPDATE SET onHand = onHand + ?, updatedAt = ?`,
        l.sku, c.locationId, l.diff, nowIso(), l.diff, nowIso());
      changed.add(l.sku);
      posted++;
    });

    this.sql.exec(
      `UPDATE counts SET status='closed', closedBy=?, closedAt=?, note=? WHERE id=?`,
      actor, nowIso(), str(p.note, 200), countId);

    return {
      ok: true, countId, posted,
      untouched: rep.totals.uncounted,
      diffValue: rep.totals.diffValue,
      version: this.#bump(), changed: [...changed]
    };
  }

  #counts() {
    return this.sql.exec(
      `SELECT c.*,
              (SELECT COUNT(DISTINCT sku) FROM count_scans cs WHERE cs.countId = c.id) AS countedLines,
              (SELECT COUNT(*) FROM count_lines cl WHERE cl.countId = c.id) AS lines
         FROM counts c ORDER BY c.startedAt DESC LIMIT 50`).toArray();
  }

  /* ---------- บิลรับเข้าและต้นทุน ----------
   * คลังยิงแต่จำนวน ต้นทุนหัวหน้าใส่ทีหลังจากบิลตัวจริง
   * คนแพ็คของจึงไม่เห็นต้นทุนจริง ๆ ไม่ใช่แค่ซ่อนปุ่มในหน้าเว็บ
   */
  #receipts(onlyPending) {
    const bills = this.sql.exec(
      `SELECT m.refId,
              MIN(m.ts) AS firstAt, MAX(m.ts) AS lastAt,
              SUM(m.qty) AS qty,
              COUNT(DISTINCT m.sku) AS skus,
              SUM(CASE WHEN m.costPerUnit IS NULL THEN 1 ELSE 0 END) AS missing,
              SUM(CASE WHEN m.costPerUnit IS NULL THEN 0 ELSE m.qty * m.costPerUnit END) AS amount,
              GROUP_CONCAT(DISTINCT m.userId) AS users
         FROM movements m
        WHERE m.type='receive' AND m.refId <> ''
        GROUP BY m.refId
        ORDER BY MIN(m.ts) DESC
        LIMIT 200`).toArray();

    const state = {};
    this.sql.exec(`SELECT * FROM receipts`).toArray().forEach(r => { state[r.refId] = r; });

    const list = bills.map(b => {
      const st = state[b.refId] || {};
      return {
        refId: b.refId,
        firstAt: b.firstAt, lastAt: b.lastAt,
        qty: Number(b.qty) || 0,
        skus: Number(b.skus) || 0,
        missingCost: Number(b.missing) || 0,
        amount: Math.round((Number(b.amount) || 0) * 100) / 100,
        users: b.users || "",
        costedAt: st.costedAt || "", costedBy: st.costedBy || ""
      };
    });

    // "ค้าง" คือยังมีบรรทัดที่ไม่มีต้นทุน ระบบนี้ไม่มีขั้นลงบัญชีให้รออีกขั้น
    return { receipts: onlyPending ? list.filter(b => b.missingCost > 0) : list };
  }

  #receiptLines(refId) {
    const rows = this.sql.exec(
      `SELECT m.sku, p.name, p.unit, p.costAvg,
              SUM(m.qty) AS qty,
              MAX(m.costPerUnit) AS costPerUnit,
              SUM(CASE WHEN m.costPerUnit IS NULL THEN 1 ELSE 0 END) AS missing
         FROM movements m LEFT JOIN products p ON p.sku = m.sku
        WHERE m.type='receive' AND m.refId=?
        GROUP BY m.sku ORDER BY p.name`, refId).toArray();
    if (!rows.length) return bad("ไม่พบบิลรับเข้าเลขนี้", "NOT_FOUND");

    const st = this.sql.exec(`SELECT * FROM receipts WHERE refId=?`, refId).toArray()[0] || {};
    const lines = rows.map(r => ({
      sku: r.sku, name: r.name || r.sku, unit: r.unit || "",
      qty: Number(r.qty) || 0,
      costPerUnit: r.costPerUnit == null ? null : Number(r.costPerUnit),
      missing: Number(r.missing) || 0,
      costAvg: Number(r.costAvg) || 0
    }));
    return {
      refId, lines,
      amount: Math.round(lines.reduce((a, l) => a + (l.costPerUnit || 0) * l.qty, 0) * 100) / 100,
      state: {
        costedAt: st.costedAt || "", costedBy: st.costedBy || ""
      }
    };
  }

  #setCostSync(p) {
    const refId = str(p.refId, 60);
    if (!refId) return bad("ต้องระบุเลขบิล");

    const lines = Array.isArray(p.lines) ? p.lines.slice(0, 500) : [];
    if (!lines.length) return bad("ไม่มีรายการต้นทุนที่จะบันทึก");

    const touched = new Set();
    lines.forEach(l => {
      const sku = str(l.sku, 40).toUpperCase();
      const c = Number(l.costPerUnit);
      if (!sku || !isFinite(c) || c < 0 || c > 1e9) return;
      const cost = Math.round(c * 10000) / 10000;
      this.sql.exec(
        `UPDATE movements SET costPerUnit=? WHERE type='receive' AND refId=? AND sku=?`,
        cost, refId, sku);
      touched.add(sku);
    });
    if (!touched.size) return bad("ต้นทุนที่ส่งมาไม่ถูกต้อง");

    [...touched].forEach(sku => this.#recomputeCost(sku));

    this.sql.exec(
      `INSERT INTO receipts (refId, costedAt, costedBy) VALUES (?, ?, ?)
       ON CONFLICT(refId) DO UPDATE SET costedAt=excluded.costedAt, costedBy=excluded.costedBy`,
      refId, nowIso(), str(p.userId, 40));

    const det = this.#receiptLines(refId);
    return { ok: true, refId, amount: det.amount, lines: det.lines, version: this.#bump(), changed: [] };
  }

  /* ---------- HTTP ภายใน เรียกจาก Worker เท่านั้น ---------- */

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/live") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("ต้องเป็น websocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      // hibernation — จอที่เปิดค้างไว้ทั้งวันโดยไม่มีใครยิงจึงแทบไม่มีต้นทุน
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].send(JSON.stringify({ t: "hello", version: this.#version(), serverTime: nowIso() }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};

    if (path === "/snapshot") {
      this.#sweepExpired();
      return this.#json(this.#snapshot());
    }

    if (path === "/board") {
      this.#sweepExpired();
      return this.#json(this.#board());
    }

    if (path === "/alerts") {
      this.#sweepExpired();
      return this.#json({ alerts: this.#alerts(null), version: this.#version(), avgDays: AVG_DAYS });
    }

    if (path === "/movers") {
      return this.#json(this.#movers(url.searchParams));
    }

    if (path === "/reservations") {
      this.#sweepExpired();
      return this.#json(this.#reservations(url.searchParams));
    }

    if (path === "/reserve" && request.method === "POST") {
      const res = this.#reserveSync(body);
      if (res.__error) return this.#json(res, res.__error.status);
      this.#announce(res.changed, res.version);
      await this.#rearmAlarm();
      return this.#json(res);
    }

    if (path === "/reserve/release" && request.method === "POST") {
      const res = this.#closeSync(body, "cancelled");
      if (res.__error) return this.#json(res, res.__error.status);
      this.#announce(res.changed, res.version);
      await this.#rearmAlarm();
      return this.#json(res);
    }

    if (path === "/reserve/extend" && request.method === "POST") {
      const res = this.#extendSync(body);
      if (res.__error) return this.#json(res, res.__error.status);
      await this.#rearmAlarm();
      return this.#json(res);
    }

    if (path === "/reserve/sweep" && request.method === "POST") {
      // ไว้ทดสอบว่าการหมดอายุทำงานถูก ไม่ต้องรอ alarm
      const res = this.#sweepExpired();
      await this.#rearmAlarm();
      return this.#json({ ok: true, expired: (res && res.expired) || [], version: this.#version() });
    }

    if (path === "/config" && request.method === "POST") {
      const hours = clampInt(body.reserveHours, 1, 24 * 30, DEFAULT_RESERVE_HOURS);
      this.#putSetting("reserveHours", hours);

      // คำนำหน้ารหัสสินค้า — เปลี่ยนได้ แต่มีผลกับตัวที่เพิ่มหลังจากนี้เท่านั้น
      // รหัสเก่าไม่ถูกแก้ตาม เพราะมันถูกพิมพ์แปะไปกับของจริงแล้ว
      if (body.skuPrefix != null) {
        const pre = str(body.skuPrefix, 12).toUpperCase();
        if (pre && !/^[A-Z0-9][A-Z0-9._-]{0,11}$/.test(pre)) {
          return this.#json(bad("คำนำหน้ารหัสใช้ได้แค่ A-Z 0-9 . _ - และต้องเริ่มด้วยตัวอักษรหรือเลข"), 400);
        }
        this.#putSetting("skuPrefix", pre || DEFAULT_SKU_PREFIX);
      }

      return this.#json({ ok: true, reserveHours: hours, ...this.#previewCodes() });
    }

    if (path === "/scan") {
      const res = this.#apply(body);
      if (res.__error) return this.#json(res, res.__error.status);
      if (res.changed && res.changed.length) this.#announce(res.changed, res.version);
      return this.#json(res);
    }

    if (path === "/scan/batch") {
      // ส่งคิวที่ค้างในเครื่องขึ้นมาทีเดียว กันซ้ำด้วย scanId เหมือนเดิม
      const list = Array.isArray(body.scans) ? body.scans.slice(0, MAX_BATCH) : [];
      const results = [];
      const touched = new Set();
      let version = this.#version();
      for (const s of list) {
        const r = this.#apply({ ...s, userId: body.userId, device: body.device });
        results.push(r.__error ? { ok: false, error: r.__error.message, scanId: s && s.scanId } : r);
        if (r.changed) r.changed.forEach(k => touched.add(k));
        if (r.version) version = r.version;
      }
      this.#announce([...touched], version);
      return this.#json({
        ok: true, version, results,
        applied: results.filter(r => r.ok && !r.duplicate).length,
        duplicates: results.filter(r => r.duplicate).length,
        failed: results.filter(r => !r.ok).length
      });
    }

    if (path === "/products" && request.method === "GET") {
      // หน้าจัดการสินค้าต้องเห็นตัวที่ปิดใช้งานด้วย จึงส่งทะเบียนทั้งหมดไม่ใช่แค่ตัวที่ยังขาย
      return this.#json({
        products: this.#allProducts(),
        barcodes: this.sql.exec(`SELECT barcode, sku, packQty, label FROM barcodes ORDER BY sku`).toArray(),
        // บอกว่าล้างข้อมูลทดสอบไปเมื่อไรและใครกด เจ้าของจะได้ไม่กดซ้ำเพราะไม่แน่ใจ
        resetAt: this.#settingStr("resetAt", ""),
        resetBy: this.#settingStr("resetBy", ""),
        ...this.#previewCodes()
      });
    }

    if (path === "/products" && request.method === "POST") {
      const name = str(body.name, 120);
      if (!name) return this.#json(bad("ต้องใส่ชื่อสินค้า"), 400);

      // เว้นช่องรหัสไว้ = ให้ระบบรันให้ · พิมพ์มาเอง = ใช้ตามที่พิมพ์
      // ตรวจชื่อก่อนแจกรหัส ไม่งั้นกดพลาดทีเดียวเลขก็เดินหน้าไปฟรี ๆ
      let sku = str(body.sku, 40).toUpperCase();
      const autoSku = !sku;
      if (autoSku) {
        sku = this.#nextSkuSync();
        if (!sku) return this.#json(bad("ระบบหาเลขรหัสสินค้าที่ว่างไม่ได้", "NO_CODE"), 500);
      }
      if (!/^[A-Z0-9][A-Z0-9._-]{1,39}$/.test(sku)) return this.#json(bad("รหัสสินค้าใช้ได้แค่ A-Z 0-9 . _ - และต้องยาว 2 ตัวขึ้นไป"), 400);

      const exists = this.sql.exec(`SELECT sku FROM products WHERE sku=?`, sku).toArray()[0];
      const unit = str(body.unit, 20) || "ชิ้น";
      const category = str(body.category, 40);
      const reorderPoint = clampInt(body.reorderPoint, 0, 1e6, 0);
      const active = body.active === false ? 0 : 1;
      const who = str(body.userId, 40);

      if (exists) {
        this.sql.exec(
          `UPDATE products SET name=?, unit=?, category=?, reorderPoint=?, active=?, updatedBy=?, updatedAt=?
            WHERE sku=?`, name, unit, category, reorderPoint, active, who, nowIso(), sku);
      } else {
        this.sql.exec(
          `INSERT INTO products (sku, name, unit, category, reorderPoint, active, createdBy, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          sku, name, unit, category, reorderPoint, active, who, nowIso());
      }

      // ออกบาร์โค้ดให้ในคำขอเดียวกัน — ของที่ไม่มีบาร์โค้ดจากโรงงานยิงไม่ได้
      // ถ้าต้องกดสองที คนจะลืมกดที่สอง แล้วสินค้าตัวนั้นก็ยิงไม่ได้ทั้งที่อยู่ในทะเบียน
      let newBarcode = null;
      if (body.autoBarcode && !exists) {
        newBarcode = this.#nextBarcodeSync();
        if (newBarcode) {
          this.sql.exec(
            `INSERT INTO barcodes (barcode, sku, packQty, label, createdBy, createdAt)
             VALUES (?, ?, 1, '', ?, ?)`,
            newBarcode, sku, who, nowIso());
        }
      }

      const version = this.#bump();
      this.#announce([sku], version);
      return this.#json({
        ok: true, sku, autoSku, barcode: newBarcode,
        created: !exists, version, products: this.#allProducts(),
        ...this.#previewCodes()
      });
    }

    if (path === "/products/bulk") {
      // นำเข้าสินค้าหลายตัวทีเดียว ใช้ตอนเริ่มระบบ ยิงซ้ำได้ ของเดิมถูกอัปเดตทับ
      const list = Array.isArray(body.products) ? body.products.slice(0, 2000) : [];
      let created = 0, updated = 0, skipped = 0, coded = 0;
      const who = str(body.userId, 40);
      for (const p of list) {
        const name = str(p.name, 120);
        if (!name) { skipped++; continue; }

        // ไฟล์ที่ไม่มีคอลัมน์ sku หรือเว้นช่องไว้ = ให้ระบบรันรหัสให้ทีละแถว
        // นำเข้าไฟล์ที่มีแต่ชื่อสินค้าได้เลย ไม่ต้องไปคิดรหัสมาก่อน
        //
        // แต่ต้องจับคู่กับของเดิมด้วยชื่อก่อนแจกรหัสใหม่ ไม่งั้นนำเข้าไฟล์เดิมซ้ำ
        // จะได้สินค้าคู่แฝดทุกตัว แต่ละตัวมีบาร์โค้ดของตัวเอง — ของหนึ่งอย่าง
        // กลายเป็นสองอย่างในทะเบียน แล้วยอดสต็อกก็แยกกันไปคนละทาง
        // ในไฟล์ที่ไม่มีรหัส ชื่อคือสิ่งเดียวที่บอกได้ว่าแถวนี้คือของตัวไหน
        let sku = str(p.sku, 40).toUpperCase();
        if (!sku) {
          const byName = this.sql.exec(`SELECT sku FROM products WHERE name=?`, name).toArray()[0];
          sku = byName ? byName.sku : (this.#nextSkuSync() || "");
        }
        if (!/^[A-Z0-9][A-Z0-9._-]{1,39}$/.test(sku)) { skipped++; continue; }
        const had = this.sql.exec(`SELECT sku FROM products WHERE sku=?`, sku).toArray()[0];
        this.sql.exec(
          `INSERT INTO products (sku, name, unit, category, reorderPoint, createdBy, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(sku) DO UPDATE SET name=excluded.name, unit=excluded.unit,
             category=excluded.category, reorderPoint=excluded.reorderPoint,
             updatedBy=excluded.createdBy, updatedAt=excluded.createdAt`,
          sku, name, str(p.unit, 20) || "ชิ้น", str(p.category, 40),
          clampInt(p.reorderPoint, 0, 1e6, 0), who, nowIso());
        if (had) updated++; else created++;

        let bc = str(p.barcode, 64);

        // ไม่มีบาร์โค้ดในไฟล์และผู้ใช้ติ๊กให้ออกให้ = ออกให้เฉพาะตัวที่ยังไม่มีบาร์โค้ดผูกอยู่
        // ตัวที่มีอยู่แล้วต้องไม่ถูกแจกใบที่สองทุกครั้งที่นำเข้าซ้ำ
        if (!bc && body.autoBarcode) {
          const had = this.sql.exec(`SELECT barcode FROM barcodes WHERE sku=? LIMIT 1`, sku).toArray()[0];
          if (!had) { bc = this.#nextBarcodeSync() || ""; if (bc) coded++; }
        }

        if (bc) {
          this.sql.exec(
            `INSERT INTO barcodes (barcode, sku, packQty, label, createdBy, createdAt)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(barcode) DO UPDATE SET sku=excluded.sku, packQty=excluded.packQty`,
            bc, sku, clampInt(p.packQty, 1, 10000, 1), str(p.packLabel, 20), who, nowIso());
        }
      }
      const version = this.#bump();
      this.#broadcast({ t: "reload", version });
      return this.#json({ ok: true, created, updated, skipped, coded, version, ...this.#previewCodes() });
    }

    if (path === "/barcodes" && request.method === "POST") {
      const sku = str(body.sku, 40).toUpperCase();
      const prod = this.sql.exec(`SELECT sku FROM products WHERE sku=?`, sku).toArray()[0];
      if (!prod) return this.#json(bad("ไม่พบสินค้ารหัสนี้", "NOT_FOUND"), 400);

      // เว้นช่องบาร์โค้ดไว้ = ให้ระบบรันให้ · ยิงบาร์โค้ดของโรงงานลงช่อง = ใช้ตัวนั้น
      // ตรวจว่ามีสินค้าตัวนี้จริงก่อนแจกเลข ไม่งั้นเลขเดินหน้าไปโดยไม่มีของผูก
      let barcode = str(body.barcode, 64);
      const autoBarcode = !barcode;
      if (autoBarcode) {
        barcode = this.#nextBarcodeSync();
        if (!barcode) return this.#json(bad("ระบบหาเลขบาร์โค้ดที่ว่างไม่ได้", "NO_CODE"), 500);
      }

      this.sql.exec(
        `INSERT INTO barcodes (barcode, sku, packQty, label, createdBy, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(barcode) DO UPDATE SET sku=excluded.sku, packQty=excluded.packQty, label=excluded.label`,
        barcode, sku, clampInt(body.packQty, 1, 10000, 1), str(body.label, 20),
        str(body.userId, 40), nowIso());
      this.sql.exec(`DELETE FROM pending_barcodes WHERE barcode=?`, barcode);

      const version = this.#bump();
      this.#broadcast({ t: "reload", version });
      return this.#json({ ok: true, version, barcode, sku, autoBarcode, ...this.#previewCodes() });
    }

    if (path === "/barcodes/delete") {
      this.sql.exec(`DELETE FROM barcodes WHERE barcode=?`, str(body.barcode, 64));
      const version = this.#bump();
      this.#broadcast({ t: "reload", version });
      return this.#json({ ok: true, version });
    }

    if (path === "/pending" && request.method === "GET") {
      return this.#json({
        pending: this.sql.exec(
          `SELECT barcode, mode, times, qty, firstSeen, lastSeen, lastUser
             FROM pending_barcodes ORDER BY lastSeen DESC LIMIT 200`).toArray()
      });
    }

    if (path === "/pending" && request.method === "POST") {
      // "ข้ามไว้ก่อน" — จำไว้ว่ายิงอะไรไปกี่ครั้ง หัวหน้าจะได้เคลียร์ตอนเย็นแล้วลงยอดให้ถูก
      const barcode = str(body.barcode, 64);
      if (!barcode) return this.#json(bad("ต้องใส่บาร์โค้ด"), 400);
      const qty = clampInt(body.qty, 0, MAX_UNITS, 1);
      this.sql.exec(
        `INSERT INTO pending_barcodes (barcode, mode, times, qty, firstSeen, lastSeen, lastUser)
         VALUES (?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT(barcode) DO UPDATE SET
           times = times + 1, qty = qty + excluded.qty,
           mode = excluded.mode, lastSeen = excluded.lastSeen, lastUser = excluded.lastUser`,
        barcode, str(body.mode, 20), qty, nowIso(), nowIso(), str(body.userId, 40));
      return this.#json({ ok: true, barcode });
    }

    if (path === "/pending/clear") {
      this.sql.exec(`DELETE FROM pending_barcodes WHERE barcode=?`, str(body.barcode, 64));
      return this.#json({ ok: true });
    }

    /* --- คลังหลายที่และการย้ายคลัง --- */
    if (path === "/locations" && request.method === "POST") {
      const res = this.#saveLocation(body);
      return this.#json(res, res.__error && res.__error.status);
    }

    if (path === "/locations" && request.method === "GET") {
      return this.#json({
        locations: this.sql.exec(
          `SELECT l.id, l.name, l.type, l.active,
                  COALESCE((SELECT SUM(s.onHand) FROM stock s WHERE s.locationId = l.id), 0) AS onHand,
                  COALESCE((SELECT COUNT(*) FROM stock s WHERE s.locationId = l.id AND s.onHand <> 0), 0) AS skus
             FROM locations l ORDER BY (l.type='sellable') DESC, l.id`).toArray(),
        reserveLocation: this.#reserveLoc()
      });
    }

    if (path === "/where") {
      const res = this.#where(str(url.searchParams.get("sku"), 40).toUpperCase());
      return this.#json(res, res.__error && res.__error.status);
    }

    if (path === "/transfer" && request.method === "POST") {
      const res = this.#transferSync(body);
      if (res.__error) return this.#json(res, res.__error.status);
      if (res.changed && res.changed.length) this.#announce(res.changed, res.version);
      return this.#json(res);
    }

    /* --- มูลค่าสต็อกและต้นทุน หัวหน้าคลังขึ้นไปเท่านั้น --- */
    if (path === "/value") return this.#json(Object.assign({ version: this.#version() }, this.#value()));

    if (path === "/adjustments") {
      return this.#json({ adjustments: this.#adjustments(url.searchParams.get("days")) });
    }

    if (path === "/adjust" && request.method === "POST") {
      const res = this.#adjustSync(body);
      if (res.__error) return this.#json(res, res.__error.status);
      if (res.changed && res.changed.length) this.#announce(res.changed, res.version);
      return this.#json(res);
    }

    /* --- รอบนับสต็อก --- */
    if (path === "/counts") return this.#json({ counts: this.#counts(), reasons: ADJUST_REASONS });

    if (path === "/count") {
      const res = this.#countReport(str(url.searchParams.get("id"), 64));
      return this.#json(res, res.__error && res.__error.status);
    }

    if (path === "/count/open" && request.method === "POST") {
      const res = this.#openCount(body);
      return this.#json(res, res.__error && res.__error.status);
    }

    if (path === "/count/scan" && request.method === "POST") {
      const res = this.#countScan(body);
      return this.#json(res, res.__error && res.__error.status);
    }

    if (path === "/count/close" && request.method === "POST") {
      const res = this.#closeCountSync(body);
      if (res.__error) return this.#json(res, res.__error.status);
      this.#announce(res.changed, res.version);
      return this.#json(res);
    }

    if (path === "/count/cancel" && request.method === "POST") {
      const id = str(body.countId, 64);
      const c = this.sql.exec(`SELECT status FROM counts WHERE id=?`, id).toArray()[0];
      if (!c) return this.#json(bad("ไม่พบรอบนับนี้", "NOT_FOUND"), 400);
      if (c.status !== "open") return this.#json(bad("รอบนับนี้ปิดไปแล้ว", "CLOSED"), 400);
      // ยกเลิกรอบไม่ลบผลที่ยิงนับไว้ ประวัติยังอยู่ แค่ไม่เอาไปปรับยอด
      this.sql.exec(`UPDATE counts SET status='cancelled', closedBy=?, closedAt=?, note=? WHERE id=?`,
        str(body.userId, 40), nowIso(), str(body.note, 200), id);
      return this.#json({ ok: true, countId: id });
    }

    /* --- บิลรับเข้าและต้นทุน --- */
    if (path === "/receipts") {
      return this.#json(this.#receipts(url.searchParams.get("pending") === "1"));
    }

    if (path === "/receipt") {
      const res = this.#receiptLines(str(url.searchParams.get("refId"), 60));
      return this.#json(res, res.__error && res.__error.status);
    }

    if (path === "/reset" && request.method === "POST") {
      const res = this.#resetSync(body);
      if (res.__error) return this.#json(res, res.__error.status);
      this.#broadcast({ t: "reload", version: res.version });
      return this.#json(res);
    }

    if (path === "/cost" && request.method === "POST") {
      const res = this.#setSkuCostSync(body);
      if (res.__error) return this.#json(res, res.__error.status);
      this.#broadcast({ t: "reload", version: res.version });
      return this.#json(res);
    }

    if (path === "/receipt/cost" && request.method === "POST") {
      const res = this.#setCostSync(body);
      if (res.__error) return this.#json(res, res.__error.status);
      this.#broadcast({ t: "reload", version: res.version });
      return this.#json(res);
    }

    if (path === "/movements") {
      const sku = str(url.searchParams.get("sku"), 40);
      const limit = clampInt(url.searchParams.get("limit"), 1, 200, RECENT_LIMIT);
      const rows = sku
        ? this.sql.exec(
            `SELECT m.*, p.name FROM movements m LEFT JOIN products p ON p.sku=m.sku
              WHERE m.sku=? ORDER BY m.ts DESC LIMIT ?`, sku, limit).toArray()
        : this.sql.exec(
            `SELECT m.*, p.name FROM movements m LEFT JOIN products p ON p.sku=m.sku
              ORDER BY m.ts DESC LIMIT ?`, limit).toArray();
      return this.#json({ movements: rows });
    }

    if (path === "/rebuild") {
      // สร้างยอดใหม่จาก movements ทั้งหมด ใช้เมื่อสงสัยว่าสำเนาไว้อ่านเร็วไม่ตรงความจริง
      this.sql.exec(`DELETE FROM stock`);
      this.sql.exec(
        `INSERT INTO stock (sku, locationId, onHand, reserved, updatedAt)
         SELECT sku, locationId, SUM(qty), 0, ?
           FROM movements GROUP BY sku, locationId`, nowIso());
      const version = this.#bump();
      this.#broadcast({ t: "reload", version });
      const n = this.sql.exec(`SELECT COUNT(*) AS c FROM movements`).toArray()[0];
      return this.#json({ ok: true, version, fromMovements: Number(n && n.c) || 0 });
    }

    if (path === "/archive") {
      // ยอดปิดวันและการเคลื่อนไหวของวันนั้น ส่งให้ Worker เอาไป commit ลงรีโป
      const day = str(url.searchParams.get("date"), 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return this.#json(bad("วันที่ไม่ถูกต้อง"), 400);
      return this.#json({
        date: day,
        version: this.#version(),
        products: this.#allProducts(),
        barcodes: this.sql.exec(`SELECT barcode, sku, packQty, label FROM barcodes ORDER BY barcode`).toArray(),
        balance: this.sql.exec(
          `SELECT s.sku, s.locationId, s.onHand, s.reserved
             FROM stock s WHERE s.onHand <> 0 OR s.reserved <> 0
            ORDER BY s.sku, s.locationId`).toArray(),
        counts: this.sql.exec(
          `SELECT id, locationId, status, startedBy, startedAt, closedBy, closedAt
             FROM counts ORDER BY startedAt DESC LIMIT 24`).toArray(),
        reservations: this.sql.exec(
          `SELECT id, sku, qty, pickedQty, orderRef, status, expiresAt, createdBy, createdAt
             FROM reservations WHERE status='open' ORDER BY createdAt`).toArray(),
        movements: this.sql.exec(
          `SELECT id, ts, sku, locationId, qty, type, reason, note, refType, refId,
                  costPerUnit, userId, device
             FROM movements WHERE ts >= ? AND ts < ? ORDER BY ts`,
          day + "T00:00:00.000Z", day + "T23:59:59.999Z").toArray()
      });
    }

    return this.#json({ error: "ไม่รู้จักคำสั่งนี้" }, 404);
  }

  /**
     ส่งจำนวนการรับเข้าที่มี/ไม่มีต้นทุนไปด้วย เพื่อให้หน้าเว็บรู้ว่าจะตั้งต้นทุนได้ทางไหน
     ไม่งั้นหน้าเว็บต้องเดา แล้วจะเขียนคำอธิบายที่เซิร์ฟเวอร์ไม่ทำตาม
     เช่นบอกว่า "ใส่ค่าใหม่เพื่อทับ" ทั้งที่ของตัวนั้นมีต้นทุนจากบิลแล้วและจะถูกปฏิเสธ
   */
  #allProducts() {
    return this.sql.exec(
      `SELECT p.sku, p.name, p.unit, p.category, p.reorderPoint, p.costAvg,
              p.active, p.createdAt, p.updatedAt,
              (SELECT COUNT(*) FROM movements m
                 WHERE m.sku = p.sku AND m.type = 'receive' AND m.qty > 0
                   AND m.costPerUnit IS NULL) AS uncostedReceives,
              (SELECT COUNT(*) FROM movements m
                 WHERE m.sku = p.sku AND m.type = 'receive' AND m.qty > 0
                   AND m.costPerUnit IS NOT NULL) AS costedReceives
         FROM products p ORDER BY p.name`).toArray();
  }

  #json(data, status) {
    const code = (data && data.__error && data.__error.status) || status || 200;
    const out = data && data.__error
      ? { error: data.__error.message, code: data.__error.code }
      : data;
    return new Response(JSON.stringify(out), {
      status: code,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  }

  /* ---------- WebSocket แบบ hibernation ---------- */

  webSocketMessage(ws, msg) {
    // หน้าจอส่ง ping มาเพื่อให้รู้ว่าสายยังดี และขอ snapshot ใหม่เมื่อพลาดข่าว
    let data = null;
    try { data = JSON.parse(String(msg)); } catch { return; }
    if (!data) return;
    if (data.t === "ping") { ws.send(JSON.stringify({ t: "pong", version: this.#version() })); return; }
    if (data.t === "resync") { ws.send(JSON.stringify({ t: "snapshot", ...this.#snapshot() })); }
  }

  webSocketClose(ws, code, reason, wasClean) {
    try { ws.close(code === 1006 ? 1000 : code, reason); } catch { /* ปิดไปแล้ว */ }
  }

  webSocketError() { /* สายเสีย ปล่อยให้ close จัดการ */ }
}
