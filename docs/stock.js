/**
 * สต็อกสินค้า — หน้าจอ
 *
 * ตัวเลขไม่ได้มาจากการดึงซ้ำ ๆ แต่มาจากสาย WebSocket เส้นเดียวที่ค้างไว้
 * ใครยิงอะไรที่ไหน ทุกจอในบริษัทขยับเลขแถวนั้นทันทีโดยไม่โหลดใหม่
 *
 * กฎที่ห้ามยืดหยุ่น — ถ้าสายหลุด ห้ามแสดงตัวเลขเหมือนยังสด
 * ตัวเลขค้างที่ไม่บอกว่าค้าง อันตรายกว่าไม่มีตัวเลขเลย เพราะฝ่ายขายเชื่อไปแล้ว
 *
 * ทุกการยิงมี scanId ที่สร้างในเครื่อง ส่งซ้ำกี่รอบก็ไม่ตัดสต็อกเพิ่ม
 */
(function () {
  "use strict";

  var A = window.StockApp;

  var PANES = [
    { id: "browse", name: "ดูสต็อก" },
    { id: "scan", name: "ยิงสต็อก", needScan: true },
    { id: "count", name: "นับสต็อก", needScan: true },
    { id: "wall", name: "จอผนังคลัง" },
    { id: "cost", name: "ต้นทุนและมูลค่า", needManager: true },
    { id: "products", name: "สินค้า", needManager: true },
    { id: "label", name: "พิมพ์ฉลาก", needManager: true }
  ];

  var MODES = {
    receive: {
      name: "รับเข้า", sub: "เพิ่มของเข้าคลัง",
      ref: "เลขบิลซัพพลายเออร์", ph: "เช่น SUP-2291",
      hint: "ยิงจำนวนเท่านั้น ต้นทุนหัวหน้าใส่ทีหลังจากบิลตัวจริง · "
          + "บาร์โค้ดที่ผูกไว้ว่าเป็นลังจะบวกให้ครบลังในการยิงครั้งเดียว"
    },
    issue: {
      name: "แพ็คส่ง", sub: "ตัดของออกจากคลัง",
      ref: "เลขออเดอร์", ph: "เช่น KRY-88213",
      hint: "ใส่เลขออเดอร์ที่ฝ่ายขายจองไว้ ระบบจะแปลงการจองเป็นการตัดจริงให้เอง · "
          + "ยิงจนติดลบได้ ระบบไม่บล็อก เพราะของอยู่ในมือแล้ว "
          + "แต่จะส่งเสียงยาวและขึ้นเป็นรายการที่หัวหน้าต้องไปนับ"
    },
    return_in: {
      name: "รับคืน", sub: "ของตีกลับเข้าคลัง",
      ref: "เลขออเดอร์ที่ตีกลับ", ph: "เช่น KRY-88190",
      needReason: true,
      hint: "เหตุผลเป็นตัวกำหนดว่าของเข้าคลังไหน ไม่ใช่คนยิงเลือก — "
          + "ของเสียหายเข้ากองแยกและไม่ถูกนับเป็นพร้อมขาย"
    }
  };

  var STALE_MS = 120000;      // เกินสองนาทีถือว่าไม่สดแล้ว ต้องขึ้นแถบแดง
  var POLL_MS = 20000;        // ตอนสายหลุด ถอยไปดึงข้อมูลแทน
  var RECENT_MAX = 12;

  var st = {
    // ไม่มีโหมดตั้งต้น — เดิมตั้งเป็น "issue" แล้วคนเปิดมาใหม่ยิงผิดทางทันที
    // ของหายจากระบบโดยไม่มีใครรู้ อ่านที่ MODE_KEY ว่าจัดการอย่างไร
    role: "readonly", pane: "browse", mode: "",
    version: 0, lastSync: 0,
    products: [], bySku: {}, byBarcode: {}, locations: [],
    q: "", selected: null,
    recent: [], tally: 0,
    master: null, masterBarcodes: [], pending: [],
    ws: null, conn: "off", retry: 0, retryTimer: null, pollTimer: null, tickTimer: null,
    bc: null, editSku: null, loaded: false,
    reasons: [], reason: "", reserveHours: 24,
    nextSku: "", nextBarcode: "", skuPrefix: "",
    mine: [], board: null, alerts: [], boardTimer: null, alertAt: 0,
    counts: [], count: null, countFilter: "all", adjReasons: {},
    value: null, receipts: [], adjustments: [], rc: null,
    queued: 0, flushing: false,
    labelPick: {}, where: null
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return A.esc(s); }
  function n0(v) { return Number(v || 0).toLocaleString("en-US"); }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "s-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
  }

  function canScan() { return st.role === "warehouse" || st.role === "manager"; }
  function canManage() { return st.role === "manager"; }
  function canReserve() { return st.role !== "readonly"; }
  /** ตัวเลขไม่สดแล้วห้ามจอง — จองจากตัวเลขที่ไม่สดคือต้นเหตุของการขายซ้ำ */
  function stale() { return st.conn !== "on" && (!st.lastSync || Date.now() - st.lastSync > STALE_MS); }

  /* ================= เสียง ตอบกลับตอนยิง =================
   * คนคลังไม่มองจอ ฟังเสียงรู้เลยว่าผ่านหรือไม่ผ่าน
   * เสียงต่างกันสี่แบบ สำเร็จ / ไม่รู้จัก / ยิงซ้ำ / จะติดลบ
   */
  var actx = null;
  /**
     เสียงยืนยันการยิง
     ในคลังเสียงดัง คนยิงถือของอยู่และไม่ได้มองจอ เสียงจึงต้องดังพอให้ได้ยินจริง
     ยิงติดเป็นสองจังหวะเสียงสูงขึ้น "ดี้-ด" แยกออกจากเสียงอื่นได้ตั้งแต่จังหวะแรก
     และสั่นด้วยทุกแบบ เผื่อกรณีที่ดังเกินกว่าจะได้ยินอะไรเลย
   */
  var SOUNDS = {
    ok:      { seq: [[1046, 0.09], [1568, 0.15]], gain: 0.55, vib: 45 },
    dup:     { seq: [[420, 0.12]],                gain: 0.34, vib: 25 },
    unknown: { seq: [[1180, 0.08], [1180, 0.08]], gain: 0.5,  vib: 45 },
    bad:     { seq: [[200, 0.45]],                gain: 0.6,  vib: [90, 60, 90] }
  };

  /** ปลุกเสียงตอนคนแตะปุ่ม — เบราว์เซอร์มือถือไม่ให้เล่นเสียงก่อนมีการแตะจอ
      ถ้าไม่ปลุกไว้ก่อน เสียงครั้งแรกจะถูกกลืนหายไปเฉย ๆ */
  function warmAudio() {
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === "suspended") actx.resume();
    } catch (e) { /* เล่นเสียงไม่ได้ก็ยังมีแฟลชกับตัวหนังสือ */ }
  }

  function beep(kind) {
    var sp = SOUNDS[kind] || SOUNDS.ok;
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === "suspended") actx.resume();
      var t = actx.currentTime;
      sp.seq.forEach(function (n) {
        var o = actx.createOscillator(), g = actx.createGain();
        o.type = "square";
        o.frequency.value = n[0];
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(sp.gain, t + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t + n[1]);
        o.connect(g); g.connect(actx.destination);
        o.start(t); o.stop(t + n[1] + 0.02);
        t += n[1] + 0.03;
      });
    } catch (e) { /* เบราว์เซอร์ไม่ให้เล่นเสียงก็ไม่เป็นไร ยังมีสีกับตัวหนังสือ */ }
    if (navigator.vibrate && sp.vib) {
      try { navigator.vibrate(sp.vib); } catch (e) {}
    }
  }

  /* ================= สายเรียลไทม์ ================= */

  function setConn(state) {
    st.conn = state;
    paintConn();
  }

  function paintConn() {
    var live = $("sLive");
    var age = st.lastSync ? Date.now() - st.lastSync : Infinity;
    var isStale = stale();
    var label = st.conn === "on" ? "สด" : (isStale ? "ไม่สด" : "กำลังต่อใหม่");

    if (live) {
      live.textContent = label + (st.conn === "on" ? "" : st.lastSync ? " · ค้างที่ " + hhmmss(st.lastSync) : "");
      live.setAttribute("data-state", st.conn === "on" ? "on" : isStale ? "stale" : "wait");
    }

    var b = $("sConn");
    if (!b) return;
    if (st.conn === "on") { b.hidden = true; }
    else if (isStale) {
      b.hidden = false;
      b.setAttribute("data-tone", "err");
      b.textContent = "ตัวเลขไม่สด — ห้ามยืนยันของกับลูกค้าตอนนี้ · ค้างอยู่ที่ " + hhmmss(st.lastSync)
        + " (" + Math.round(age / 1000) + " วินาทีที่แล้ว) กำลังต่อใหม่";
    } else {
      b.hidden = false;
      b.setAttribute("data-tone", "warn");
      b.textContent = "ขาดการเชื่อมต่อ กำลังต่อใหม่ — ตัวเลขหยุดที่ "
        + (st.lastSync ? hhmmss(st.lastSync) : "ยังไม่เคยโหลด");
    }

    // ตัวเลขที่ไม่สดต้องจางลง ให้ตาเห็นว่าเชื่อไม่ได้ ไม่ใช่แค่ป้ายเล็ก ๆ ที่มุมจอ
    var vs = $("viewStock");
    if (vs) vs.setAttribute("data-stale", st.conn === "on" ? "false" : "true");

    var wl = document.querySelector(".wl-live");
    if (wl) {
      wl.setAttribute("data-state", st.conn === "on" ? "on" : "off");
      wl.textContent = st.conn === "on" ? "ข้อมูลสด" : "ขาดการเชื่อมต่อ";
    }
    var clk = document.querySelector(".wl-clock b");
    if (clk) clk.textContent = hhmm();

    // ปุ่มจองต้องกดไม่ได้ทันทีที่ตัวเลขไม่สด ไม่ใช่รอให้กดแล้วค่อยบอก
    var rb = $("srBtn");
    if (rb && isStale) renderDetail();
  }

  function hhmmss(ms) {
    var d = new Date(ms), p = function (x) { return (x < 10 ? "0" : "") + x; };
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  function connect() {
    if (st.ws && (st.ws.readyState === 0 || st.ws.readyState === 1)) return;
    var proto = location.protocol === "https:" ? "wss://" : "ws://";
    var ws;
    try { ws = new WebSocket(proto + location.host + "/api/stock/live"); }
    catch (e) { scheduleRetry(); return; }
    st.ws = ws;

    ws.onopen = function () {
      st.retry = 0;
      setConn("on");
      stopPolling();
      paintOfflineWarn();
      flushQueue();
    };

    ws.onmessage = function (ev) {
      var m = null;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m) return;

      if (m.t === "hello") { st.lastSync = Date.now(); setConn("on"); return; }

      if (m.t === "delta") {
        // เลขเวอร์ชันข้ามลำดับ = พลาดข่าวบางอันไป ขอ snapshot ใหม่ทั้งก้อน
        if (m.version > st.version + 1 && st.version > 0) { resync(); return; }
        st.version = m.version;
        st.lastSync = Date.now();
        mergeRows(m.rows || []);
        paintConn();
        renderBrowse();
        if (st.pane === "wall") renderWall();
        return;
      }

      if (m.t === "expired") {
        // ไม่ปล่อยของคืนแบบเงียบ ๆ คนที่จองไว้ต้องรู้ว่าของหลุดมือไปแล้ว
        st.version = m.version || st.version;
        var me = A.me && A.me();
        var mine = (m.items || []).filter(function (x) {
          return me && x.createdBy === me.username;
        });
        if (mine.length) {
          A.toast("การจอง " + mine.map(function (x) { return x.orderRef; }).join(", ")
            + " หมดอายุ ระบบปล่อยของคืนแล้ว");
        }
        loadMine();
        return;
      }

      if (m.t === "snapshot") { takeSnapshot(m); return; }
      if (m.t === "reload") { resync(); return; }
      if (m.t === "pong") { st.lastSync = Date.now(); paintConn(); }
    };

    ws.onclose = function () { setConn("off"); scheduleRetry(); startPolling(); paintOfflineWarn(); };
    ws.onerror = function () { /* onclose จะตามมาเอง */ };
  }

  function scheduleRetry() {
    clearTimeout(st.retryTimer);
    if (!isActive()) return;
    var wait = Math.min(1000 * Math.pow(2, st.retry++), 20000);
    st.retryTimer = setTimeout(connect, wait);
  }

  function resync() {
    if (st.ws && st.ws.readyState === 1) { st.ws.send(JSON.stringify({ t: "resync" })); return; }
    fetchSnapshot();
  }

  function startPolling() {
    if (st.pollTimer) return;
    st.pollTimer = setInterval(function () { if (isActive()) fetchSnapshot(); }, POLL_MS);
  }
  function stopPolling() { clearInterval(st.pollTimer); st.pollTimer = null; }

  function isActive() {
    var v = $("viewStock");
    return v && !v.hidden;
  }

  /* ================= ข้อมูล ================= */

  function mergeRows(rows) {
    rows.forEach(function (r) {
      var cur = st.bySku[r.sku];
      if (cur) {
        Object.keys(r).forEach(function (k) { cur[k] = r[k]; });
      } else {
        st.products.push(r);
        st.bySku[r.sku] = r;
      }
    });
  }

  function takeSnapshot(d) {
    st.version = d.version || 0;
    st.lastSync = Date.now();
    st.products = d.products || [];
    st.bySku = {};
    st.products.forEach(function (p) { st.bySku[p.sku] = p; });
    st.byBarcode = {};
    (d.barcodes || []).forEach(function (b) { st.byBarcode[b.barcode] = b; });
    st.locations = d.locations || [];
    if (d.returnReasons) st.reasons = d.returnReasons;
    if (d.reserveHours) {
      st.reserveHours = d.reserveHours;
      if ($("sResHours")) $("sResHours").value = d.reserveHours;
    }
    fillLocations();
    renderReasons();
    paintTransfer();
    paintConn();
    renderBrowse();
    if (st.pane === "products") renderMaster();
  }

  function fetchSnapshot() {
    return A.api("/stock/snapshot").then(takeSnapshot).catch(function (err) {
      if (err && err.code === "NO_STOCK_BINDING") {
        var b = $("sConn");
        b.hidden = false;
        b.setAttribute("data-tone", "err");
        b.textContent = err.message;
        return;
      }
      A.handleErr(err);
    });
  }

  function fillLocations() {
    var sel = $("sLoc");
    if (!sel) return;
    var keep = sel.value;
    sel.innerHTML = st.locations.map(function (l) {
      return '<option value="' + esc(l.id) + '">' + esc(l.name) + "</option>";
    }).join("");
    if (keep) sel.value = keep;
    if (!sel.value && st.locations.length) sel.value = st.locations[0].id;
  }

  /* ================= ดูสต็อก ================= */

  function statusOf(p) {
    if (p.available <= 0) return { k: "out", label: "หมด", cls: "p-opex" };
    if (p.reorderPoint > 0 && p.available <= p.reorderPoint) return { k: "low", label: "ใกล้หมด", cls: "p-cost" };
    return { k: "ok", label: "", cls: "" };
  }

  function matches(p, q) {
    if (!q) return true;
    var s = q.toLowerCase();
    if (p.sku.toLowerCase().indexOf(s) >= 0) return true;
    if ((p.name || "").toLowerCase().indexOf(s) >= 0) return true;
    var bc = st.byBarcode[q];
    return !!(bc && bc.sku === p.sku);
  }

  function renderBrowse() {
    if (st.pane !== "browse") return;
    var q = st.q.trim();
    var list = st.products.filter(function (p) { return matches(p, q); });

    $("sCountNote").textContent = q
      ? list.length + " จาก " + st.products.length + " รายการ"
      : st.products.length + " รายการ";

    if (!st.products.length) {
      $("sList").innerHTML = '<p class="empty">ยังไม่มีสินค้าในระบบ — '
        + (canManage() ? 'ไปที่แท็บ "สินค้า" เพื่อเพิ่มหรือนำเข้าจาก CSV' : "ให้หัวหน้าคลังเพิ่มสินค้าก่อน")
        + "</p>";
      $("sDetail").innerHTML = "";
      return;
    }

    if (!list.length) {
      $("sList").innerHTML = '<p class="empty">ไม่พบสินค้าที่ตรงกับ "' + esc(q) + '"</p>';
    } else {
      $("sList").innerHTML = list.slice(0, 200).map(function (p) {
        var s = statusOf(p);
        var on = st.selected === p.sku;
        return '<button type="button" class="s-row" data-sku="' + esc(p.sku) + '" data-on="' + on + '">'
          + '<span class="s-rn"><b>' + esc(p.name) + "</b>"
          + '<em class="num">' + esc(p.sku) + "</em></span>"
          + (s.label ? '<span class="pill ' + s.cls + '"><i class="dot"></i>' + s.label + "</span>" : "")
          + '<span class="s-rv"><b class="num" data-k="' + s.k + '">' + n0(p.available) + "</b>"
          + "<em>พร้อมขาย</em></span>"
          + "</button>";
      }).join("");
    }

    // เลือกตัวแรกให้เลย เพื่อให้ยิงบาร์โค้ดแล้วเห็นคำตอบทันทีไม่ต้องกดอะไรอีก
    if (!st.selected || !st.bySku[st.selected] || (q && list.length && !list.some(function (p) { return p.sku === st.selected; }))) {
      st.selected = list.length ? list[0].sku : null;
      if (list.length) {
        var el = $("sList").querySelector('[data-sku="' + cssEsc(st.selected) + '"]');
        if (el) el.setAttribute("data-on", "true");
      }
    }
    renderDetail();
    loadAlerts(false);
  }

  function cssEsc(s) { return String(s).replace(/["\\]/g, "\\$&"); }

  function renderDetail() {
    var p = st.selected ? st.bySku[st.selected] : null;
    var box = $("sDetail");
    if (!p) { box.innerHTML = ""; return; }

    var s = statusOf(p);
    var tone = s.k === "out" ? "out" : s.k === "low" ? "low" : "ok";
    var bcs = Object.keys(st.byBarcode).filter(function (b) { return st.byBarcode[b].sku === p.sku; });

    box.innerHTML =
      '<div class="s-hero" data-tone="' + tone + '">'
      +   '<div class="s-h-main">'
      +     '<span class="c-lab">' + esc(p.name) + "</span>"
      +     '<div class="s-h-num"><b class="num">' + n0(p.available) + "</b>"
      +       "<span>" + esc(p.unit || "ชิ้น") + " พร้อมขาย</span></div>"
      +     '<div class="s-h-sub num">' + esc(p.sku)
      +       (bcs.length ? " · บาร์โค้ด " + esc(bcs[0]) + (bcs.length > 1 ? " (+" + (bcs.length - 1) + ")" : "") : " · ยังไม่มีบาร์โค้ด")
      +     "</div>"
      +   "</div>"
      +   '<div class="s-h-side">'
      +     '<div class="s-h-cell"><span>ของในคลัง</span><b class="num">' + n0(p.onHand) + "</b></div>"
      +     '<div class="s-h-cell"><span>จองไว้</span><b class="num">' + n0(p.reserved) + "</b></div>"
      +     '<div class="s-h-cell"><span>เสียหาย</span><b class="num">' + n0(p.blocked) + "</b></div>"
      +     '<p class="s-h-note">' + (p.reserved > 0
              ? "พร้อมขาย = ของในคลัง − จองไว้"
              : "การจองยังไม่เปิดใช้ในเฟสนี้ พร้อมขายจึงเท่ากับของในคลัง")
      +       (p.blocked > 0 ? " · ของเสียหาย " + n0(p.blocked) + " ไม่ถูกนับเป็นพร้อมขาย" : "")
      +     "</p>"
      +   "</div>"
      + "</div>"
      + (sellableLocs().length > 1
          ? '<div class="card" style="margin-top:18px"><h2>ของอยู่คลังไหน</h2>'
            + '<div class="tablewrap" id="sWhere">' + whereTable() + "</div></div>"
          : "")
      + (canReserve() ? reserveCard(p) : "")
      + '<div class="card" style="margin-top:18px">'
      +   "<h2>ความเคลื่อนไหวล่าสุด</h2>"
      +   '<div class="tablewrap" id="sMovWrap"><p class="empty">กำลังโหลด…</p></div>'
      + "</div>";

    loadMovements(p.sku);
    loadWhere(p.sku);
  }

  /**
   * ปุ่มจองคือกุญแจกันแอดมินสองคนขายชิ้นสุดท้ายชนกัน
   * กดแล้วพร้อมขายลดทุกจอทันที คนที่สองจึงเห็นเลขจริงแล้วบอกลูกค้าตรง
   * ตัวเลขไม่สดแล้วปุ่มนี้ต้องกดไม่ได้ เพราะจองจากเลขที่ไม่สดคือต้นเหตุของการขายซ้ำ
   */
  function reserveCard(p) {
    var off = stale();
    var full = p.available <= 0;
    return '<div class="card" style="margin-top:18px">'
      + "<h2>จองให้ลูกค้า</h2>"
      + '<div class="body">'
      +   '<div class="two">'
      +     '<div class="field" style="margin-top:0">'
      +       '<label class="lbl" for="srRef">เลขออเดอร์ หรือชื่อลูกค้า</label>'
      +       '<input type="text" id="srRef" autocomplete="off" placeholder="เช่น KRY-88214"'
      +         (off || full ? " disabled" : "") + ">"
      +     "</div>"
      +     '<div class="field" style="margin-top:0">'
      +       '<label class="lbl" for="srQty">จำนวน</label>'
      +       '<input type="number" id="srQty" class="num" min="1" max="'
      +         Math.max(1, p.available) + '" step="1" value="1"'
      +         (off || full ? " disabled" : "") + ">"
      +     "</div>"
      +   "</div>"
      +   (off
          ? '<div class="banner" data-tone="err" style="margin:15px 0 0">'
            + "ตัวเลขไม่สด จองไม่ได้ — จองจากตัวเลขที่ไม่สดคือต้นเหตุของการขายซ้ำ "
            + "ถ้าลูกค้ารอไม่ได้ให้โทรถามคลังก่อนยืนยัน</div>"
          : full
          ? '<div class="banner" style="margin:15px 0 0">ของหมด จองไม่ได้ '
            + "— จองเกินที่มีคือสัญญาที่รักษาไม่ได้</div>"
          : '<button type="button" class="btn btn-main" id="srBtn">จองให้ลูกค้า</button>')
      +   '<p class="note" style="margin:11px 0 0">การจองหมดอายุเองใน <b>'
      +     st.reserveHours + " ชั่วโมง</b> ถ้าคลังยังไม่ได้แพ็ค ระบบจะปล่อยของคืนและแจ้งคุณ · "
      +     "คลังยิงแพ็คด้วยเลขออเดอร์นี้แล้วการจองจะกลายเป็นการตัดจริงให้เอง</p>"
      + "</div></div>";
  }

  function loadMovements(sku) {
    A.api("/stock/movements?limit=12&sku=" + encodeURIComponent(sku)).then(function (d) {
      var wrap = $("sMovWrap");
      if (!wrap || st.selected !== sku) return;
      var rows = d.movements || [];
      if (!rows.length) { wrap.innerHTML = '<p class="empty">ยังไม่มีการเคลื่อนไหวของตัวนี้</p>'; return; }
      wrap.innerHTML = "<table><thead><tr><th>เวลา</th><th>รายการ</th>"
        + '<th class="r">จำนวน</th><th>อ้างอิง</th><th>คนทำ</th></tr></thead><tbody>'
        + rows.map(function (m) {
            var up = Number(m.qty) > 0;
            return "<tr><td>" + esc(when(m.ts)) + "</td>"
              + '<td><span class="pill ' + (up ? "p-income" : "p-cost") + '"><i class="dot"></i>'
              + esc(typeLabel(m.type)) + "</span></td>"
              + '<td class="r num" style="font-weight:600;color:var(--' + (up ? "income" : "cost") + ')">'
              + (up ? "+" : "") + n0(m.qty) + "</td>"
              + '<td class="num">' + esc(m.refId || "—") + "</td>"
              + "<td>" + esc(m.userId) + "</td></tr>";
          }).join("")
        + "</tbody></table>";
    }).catch(function () { /* ประวัติโหลดไม่ได้ไม่ควรทำให้ตัวเลขหลักหาย */ });
  }

  function typeLabel(t) {
    return { receive: "รับเข้า", issue: "แพ็คส่ง", return_in: "รับคืน",
             adjust: "ปรับยอด", transfer: "ย้ายคลัง", count: "ผลนับ" }[t] || t;
  }

  function when(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    var p = function (x) { return (x < 10 ? "0" : "") + x; };
    return p(d.getDate()) + "/" + p(d.getMonth() + 1) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  /* ================= ยิงสต็อก ================= */

  /**
     โหมดที่เลือกไว้ล่าสุดของเครื่องนี้ เก็บในเครื่อง ไม่ใช่ในเซิร์ฟเวอร์
     เพราะมันเป็นเรื่องของ "เครื่องนี้ตั้งไว้ทำอะไร" ไม่ใช่เรื่องของคน
     แท็บเล็ตที่โต๊ะแพ็คจึงค้างอยู่ที่แพ็คส่งตลอด ไม่ต้องเลือกใหม่ทุกครั้งที่เปิด

     แต่ **ครั้งแรกของเครื่องนั้นไม่มีโหมดตั้งต้นให้** ต้องกดเลือกก่อนถึงจะยิงได้
     เดิมตั้งค่าเริ่มต้นเป็นแพ็คส่ง ซึ่งเป็นทางที่อันตรายที่สุด — คนเปิดมาใหม่
     ตั้งใจจะรับของเข้า แล้วยิงเลย กลายเป็นตัดของออกและยอดติดลบ
     (เกิดขึ้นจริงกับเจ้าของตอนลองใช้ครั้งแรก ยอดติดลบไป 5)
   */
  var MODE_KEY = "mintra-stock:lastMode";

  function rememberMode(m) {
    try { localStorage.setItem(MODE_KEY, m); } catch (e) { /* โหมดส่วนตัว/บล็อกไว้ก็ไม่เป็นไร */ }
  }

  function lastMode() {
    try {
      var m = localStorage.getItem(MODE_KEY);
      return MODES[m] ? m : "";
    } catch (e) { return ""; }
  }

  function setMode(m) {
    if (!MODES[m]) { clearMode(); return; }
    st.mode = m;
    st.tally = 0;
    rememberMode(m);
    var cfg = MODES[m];
    $("sModeBar").setAttribute("data-mode", m);
    $("sModeName").textContent = cfg.name;
    $("sModeSub").textContent = cfg.sub;
    $("sRefLab").textContent = cfg.ref;
    $("sRef").placeholder = cfg.ph;
    $("sTally").textContent = "0";
    $("sReasonWrap").hidden = !cfg.needReason;
    $("sScanForm").hidden = false;
    $("sPickMode").hidden = true;
    paintCostField();
    paintOfflineWarn();
    if (cfg.needReason) {
      if (!st.reason && st.reasons.length) st.reason = st.reasons[0].key;
      renderReasons();
    }
    document.querySelectorAll("#sModeBar .sm-tabs button").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-mode") === m));
    });
    renderRecent();
    focusCode();
  }

  /** ยังไม่เลือกโหมด — ซ่อนฟอร์มทั้งก้อน ไม่ใช่โชว์ฟอร์มที่ยิงไปแล้วไม่รู้เข้าทางไหน */
  function clearMode() {
    st.mode = "";
    st.tally = 0;
    $("sModeBar").setAttribute("data-mode", "none");
    $("sModeName").textContent = "เลือกโหมดก่อน";
    $("sModeSub").textContent = "ยังไม่ได้เลือกว่าจะรับเข้า แพ็คส่ง หรือรับคืน";
    $("sScanForm").hidden = true;
    $("sPickMode").hidden = false;
    $("sCostWrap").hidden = true;
    document.querySelectorAll("#sModeBar .sm-tabs button").forEach(function (b) {
      b.setAttribute("aria-pressed", "false");
    });
    renderRecent();
  }

  /**
   * ตารางสิทธิ์ตอนออฟไลน์ (ตาม STOCK.md)
   *   รับเข้า / รับคืน / นับสต็อก  ยิงได้ เพราะบวกเข้าอย่างเดียว ไม่ต้องรู้ยอดปัจจุบัน
   *   แพ็คส่ง                     ยิงได้ แต่ต้องเตือน เพราะตัดออกโดยไม่รู้ยอดจริง
   *   จอง                         ทำไม่ได้ (บังคับที่ปุ่มจองอยู่แล้ว)
   */
  function paintOfflineWarn() {
    var el = $("sScanHint");
    if (!el) return;
    if (!MODES[st.mode]) { el.textContent = ""; return; }
    var off = navigator.onLine === false || st.conn !== "on";
    if (off && st.mode === "issue") {
      el.innerHTML = '<b style="color:var(--opex)">ออฟไลน์อยู่ — ยิงแพ็คส่งได้ '
        + "แต่เป็นการตัดออกโดยไม่รู้ยอดจริง บางตัวอาจติดลบตอนส่งขึ้นระบบ "
        + "ระบบจะสรุปให้ตรวจหลังส่งเสร็จ</b>";
    } else if (off) {
      el.innerHTML = '<b style="color:var(--cost)">ออฟไลน์อยู่ — โหมดนี้ยิงได้ปกติ '
        + "เพราะเป็นการบวกเข้า ไม่ต้องรู้ยอดปัจจุบัน</b>";
    } else {
      el.textContent = MODES[st.mode].hint;
    }
  }

  /* ================= ยิงด้วยกล้องมือถือ =================
   * ตัวอ่านจริงอยู่ใน cam.js ที่นี่แค่ต่อสายว่ารหัสที่ได้จะไปเข้าทางไหน
   * รหัสจากกล้องเดินทางเส้นเดียวกับรหัสจากเครื่องยิง USB เป๊ะ ๆ
   * ทั้งการกันยิงซ้ำด้วย scanId คิวออฟไลน์ และกล่องผูกบาร์โค้ดที่ไม่รู้จัก
   */

  // cam.js ต้องส่งเสียงเองตอนอ่านติด จึงต้องเอาเสียงออกไปให้มันเรียก
  window.StockSound = { beep: beep, warm: warmAudio };

  function camOk() { return !!(window.StockCam && window.StockCam.supported()); }

  function paintCam() {
    var ok = camOk();
    var why = (window.StockCam && window.StockCam.why && window.StockCam.why()) || "";

    var b = $("sCamBtn");
    if (b) b.hidden = !ok;
    var n = $("sCamNote");
    if (n) {
      // เครื่องที่ใช้ไม่ได้ต้องได้คำอธิบาย ไม่ใช่ปุ่มที่หายไปเงียบ ๆ
      n.hidden = ok || !why;
      n.textContent = ok ? "" : why;
    }
    var q = $("sQCam");
    if (q) q.hidden = !ok;
    var cb = $("scCamBtn");
    if (cb) cb.hidden = !ok;
  }

  /**
     เปิดกล้องแล้วส่งรหัสที่อ่านได้เข้าฟังก์ชันเดิม ไม่มีเส้นทางพิเศษของกล้อง
     กล้องปิดตัวเองหลังอ่านติดครั้งเดียว แล้วเราพาสายตาไปที่ผลลัพธ์ให้เลย
     คนยิงจึงเห็นทันทีว่าเข้าตัวไหนไปเท่าไร ไม่ต้องหาเองว่าผลอยู่ตรงไหนของหน้า
   */
  function camOpen(handler, resultId) {
    if (!camOk()) { A.toast(window.StockCam ? window.StockCam.why() : "เครื่องนี้ใช้กล้องยิงไม่ได้"); return; }
    // ต้องปลุกตอนนี้ ตอนที่นิ้วยังแตะปุ่มอยู่ — เบราว์เซอร์มือถือไม่ให้เล่นเสียงนอกจังหวะนี้
    warmAudio();
    window.StockCam.open(function (code) {
      handler(code);
      showResult(resultId);
    });
  }

  function showResult(id) {
    if (!id) return;
    // รอให้กล้องถอนตัวและหน้าจอกลับมาก่อน ไม่งั้นเลื่อนไปตอนที่ยังวัดตำแหน่งไม่ได้
    setTimeout(function () {
      var el = $(id);
      if (!el) return;
      var box = el.closest ? (el.closest(".card") || el) : el;
      try { box.scrollIntoView({ behavior: "smooth", block: "start" }); }
      catch (e) { box.scrollIntoView(); }
    }, 90);
  }

  function focusCode() {
    var el = $("sCode");
    if (el && st.pane === "scan" && isActive()) el.focus();
  }

  /**
     opts.quietOk = กล้องส่งเสียงยืนยันไปแล้วตอนอ่านติด ไม่ต้องส่งซ้ำ
     แต่เสียง "ผิด" ทุกแบบยังดังเหมือนเดิม เพราะนั่นคือเสียงที่คนต้องได้ยินที่สุด
   */
  function submitScan(raw, opts) {
    var quietOk = !!(opts && opts.quietOk);
    var code = String(raw || "").trim();
    if (!code) return;

    // กำแพงชั้นที่สอง เผื่อมีรหัสเข้ามาทางอื่น เช่นคิวออฟไลน์หรือกล้อง
    if (!MODES[st.mode]) {
      beep("bad");
      A.toast("เลือกโหมดก่อนยิง — รับเข้า แพ็คส่ง หรือรับคืน");
      return;
    }

    var units = Math.max(1, Math.trunc(Number($("sUnits").value) || 1));

    if (MODES[st.mode].needReason && !st.reason) {
      beep("bad");
      A.toast("เลือกเหตุผลที่คืนก่อน");
      return;
    }

    var payload = {
      scanId: uuid(),
      barcode: code,
      mode: st.mode,
      units: units,
      refId: $("sRef").value.trim(),
      // โหมดรับคืนไม่ส่งคลังไป เพราะเหตุผลเป็นตัวกำหนด และเซิร์ฟเวอร์ตัดสินเอง
      locationId: MODES[st.mode].needReason ? undefined : ($("sLoc").value || "main"),
      reason: st.reason,
      note: $("sNote").value.trim(),
      device: (navigator.userAgent.indexOf("Mobile") >= 0 ? "มือถือ" : "คอม")
    };

    // ต้นทุนส่งไปเฉพาะตอนรับเข้าและเฉพาะคนที่มีสิทธิ์ เซิร์ฟเวอร์ตรวจซ้ำอีกชั้น
    var costRaw = (st.mode === "receive" && canManage()) ? $("sCostIn").value.trim() : "";
    if (costRaw !== "" && isFinite(Number(costRaw)) && Number(costRaw) >= 0) {
      payload.costPerUnit = Number(costRaw);
    }

    // ขึ้นชื่อสินค้าให้เห็นทันทีจากแผนที่บาร์โค้ดในเครื่อง ไม่ต้องรอเซิร์ฟเวอร์
    var guess = st.byBarcode[code];
    var guessName = guess && st.bySku[guess.sku] ? st.bySku[guess.sku].name : null;

    /* ออฟไลน์ชัด ๆ ก็เข้าคิวเลย ไม่ต้องรอ fetch หมดเวลา คนแพ็คของยิงรัวอยู่
       จอง (reserve) ไม่มีเส้นทางนี้เลย เพราะจองจากตัวเลขที่ไม่สดคือต้นเหตุของการขายซ้ำ */
    if (navigator.onLine === false) {
      queueAdd("scan", payload).then(function () {
        if (!quietOk) beep("ok");
        pushRecent({ name: guessName || code, delta: 0, queued: true,
                     issueOffline: st.mode === "issue" });
      });
      return;
    }

    A.api("/stock/scan", "POST", payload).then(function (r) {
      if (r.unknownBarcode) { beep("unknown"); openBarcodeDialog(code, units); return; }
      if (!r.ok) { beep("bad"); A.toast(r.error || "ยิงไม่สำเร็จ"); return; }

      if (r.row) { mergeRows([r.row]); st.version = r.version || st.version; st.lastSync = Date.now(); }

      if (r.duplicate) {
        beep("dup");
        pushRecent({ name: r.name, delta: 0, left: r.row ? r.row.onHand : null, dup: true });
      } else {
        st.tally += Math.abs(r.delta || 0);
        $("sTally").textContent = n0(st.tally);
        if (r.negative) beep("bad"); else if (!quietOk) beep("ok");
        pushRecent({
          name: r.name || guessName || code, delta: r.delta,
          left: r.row ? r.row.onHand : null,
          negative: !!r.negative,
          low: r.row && r.row.reorderPoint > 0 && r.row.available <= r.row.reorderPoint,
          packQty: r.packQty, units: r.units,
          damaged: r.locationId === "damaged",
          picked: r.pickedFromReservation || 0,
          cost: r.costPerUnit == null ? null : r.costPerUnit,
          costAvg: r.costAvg == null ? null : r.costAvg
        });

        /* ล้างช่องต้นทุนหลังยิงสำเร็จ — ตั้งใจให้ต้องพิมพ์ใหม่ทุกตัว
           ถ้าค้างไว้ ของตัวถัดไปจะได้ต้นทุนของตัวก่อนแบบเงียบ ๆ
           ซึ่งผิดแบบที่ไม่มีใครเห็น เพราะตัวเลขก็ยังดูสมเหตุสมผล */
        if (payload.costPerUnit != null) $("sCostIn").value = "";
        if (r.pickedFromReservation > 0) loadMine();
        if (r.negative) A.toast("ยอดติดลบแล้ว — ของจริงไม่ตรงตัวเลข ต้องไปนับ");
      }
      renderBrowse();
    }).catch(function (err) {
      // เน็ตล่มระหว่างส่ง = เข้าคิว · เซิร์ฟเวอร์ปฏิเสธ = ของจริงผิด ห้ามเข้าคิว
      if (isNetworkErr(err)) {
        queueAdd("scan", payload).then(function () {
          if (!quietOk) beep("ok");
          pushRecent({ name: guessName || code, delta: 0, queued: true,
                       issueOffline: st.mode === "issue" });
        });
        return;
      }
      beep("bad");
      pushRecent({ name: guessName || code, delta: 0, failed: true, msg: err && err.message });
      A.handleErr(err);
    });
  }

  /**
     ช่องต้นทุนโชว์เฉพาะโหมดรับเข้า และเฉพาะคนที่มีสิทธิ์เห็นต้นทุน
     คนคลังไม่เห็นกล่องนี้เลย ไม่ใช่เห็นแล้วกดไม่ได้ — ตัวเลขต้นทุนไม่ควรผ่านตาเขาตั้งแต่ต้น
   */
  function paintCostField() {
    var box = $("sCostWrap");
    if (!box) return;
    var show = st.mode === "receive" && canManage();
    box.hidden = !show;
    if (!show) { $("sCostIn").value = ""; return; }
    var note = $("sCostNote");
    if (note) {
      note.textContent = "ใส่แล้วระบบคิดต้นทุนถัวเฉลี่ยใหม่ให้ทันที · "
        + "ช่องนี้จะถูกล้างหลังยิงทุกครั้ง กันเอาต้นทุนของตัวก่อนไปใช้กับตัวถัดไป";
    }
  }

  function pushRecent(item) {
    item.at = Date.now();
    st.recent.unshift(item);
    if (st.recent.length > RECENT_MAX) st.recent.length = RECENT_MAX;
    renderRecent();
  }

  function renderRecent() {
    var box = $("sRecent");
    if (!box) return;
    if (!st.recent.length) {
      // ตอนยังไม่เลือกโหมดยังไม่มีช่องบาร์โค้ดให้โฟกัส ห้ามบอกว่ายิงได้เลย
      box.innerHTML = '<p class="empty">' + (MODES[st.mode]
        ? "ยังไม่ได้ยิงอะไรในรอบนี้ — โฟกัสอยู่ที่ช่องบาร์โค้ดแล้ว ยิงได้เลย"
        : "เลือกโหมดก่อน แล้วรายการที่ยิงจะมาขึ้นที่นี่") + "</p>";
      return;
    }
    box.innerHTML = '<div class="s-recent">' + st.recent.map(function (r) {
      var tone = r.failed ? "fail" : r.negative ? "neg" : r.queued ? "wait"
               : r.dup ? "dup" : r.damaged ? "dmg" : r.low ? "low" : "ok";
      var sub = r.failed ? "ส่งไม่สำเร็จ — " + esc(r.msg || "ลองยิงอีกครั้ง")
              : r.queued ? "รอส่ง — ยังไม่ถูกนับในยอด"
                  + (r.issueOffline ? " · ตัดออกโดยไม่รู้ยอดจริง อาจติดลบตอนส่ง" : "")
              : r.dup ? "ยิงซ้ำใบเดิม ระบบไม่นับเพิ่ม"
              : r.negative ? "เหลือ " + n0(r.left) + " — ติดลบแล้ว ต้องไปนับ"
              : (r.damaged ? "เข้ากองของเสียหาย ไม่นับเป็นพร้อมขาย · " : "")
                + (r.picked > 0 ? "หักจากการจอง " + n0(r.picked) + " · " : "")
                + (r.packQty > 1 ? "ยิงลัง × " + r.packQty + " · " : "")
                + (r.cost == null ? "" : "ต้นทุน " + A.baht(r.cost) + "/หน่วย"
                    + (r.costAvg == null ? "" : " · ถัวเฉลี่ย " + A.baht(r.costAvg)) + " · ")
                + (r.left == null ? "" : "เหลือ " + n0(r.left) + (r.low ? " · ใกล้หมด" : ""));
      return '<div class="s-rec" data-tone="' + tone + '">'
        + "<div><b>" + esc(r.name) + "</b><em>" + hhmmss(r.at) + " · " + sub + "</em></div>"
        + '<span class="num">' + (r.queued ? "รอส่ง"
            : (r.delta > 0 ? "+" : "") + (r.delta ? n0(r.delta) : "—")) + "</span>"
        + "</div>";
    }).join("") + "</div>";
  }

  /* ---------- บาร์โค้ดที่ไม่รู้จัก ---------- */

  function openBarcodeDialog(code, units) {
    // กล่องนี้เป็น <dialog> แบบ modal ซึ่งอยู่ใน top layer — ทับหน้ากล้องเสมอ
    // ถ้าปล่อยกล้องถ่ายอยู่ข้างหลัง มันจะยิงรหัสเดิมเข้ามาเรื่อย ๆ ตอนคนกำลังกรอกฟอร์ม
    // และปุ่มปิดกล้องก็ถูกกล่องทับจนกดไม่ได้ ถึงตรงนี้กล้องทำงานของมันจบแล้ว
    if (window.StockCam && window.StockCam.isOpen()) window.StockCam.close();

    st.bc = { code: code, units: units };
    $("sBcVal").textContent = code;
    $("sBcSku").value = "";
    $("sBcQty").value = "1";
    $("sBcHits").innerHTML = "";
    $("sBcBind").hidden = !canManage();
    $("sBcNoPerm").hidden = canManage();
    $("sBcDlg").showModal();
    if (canManage()) setTimeout(function () { $("sBcSku").focus(); }, 30);
  }

  function bcHits() {
    var q = $("sBcSku").value.trim().toLowerCase();
    var box = $("sBcHits");
    if (!q) { box.innerHTML = ""; return; }
    var hits = st.products.filter(function (p) {
      return p.sku.toLowerCase().indexOf(q) >= 0 || (p.name || "").toLowerCase().indexOf(q) >= 0;
    }).slice(0, 6);
    box.innerHTML = hits.map(function (p) {
      return '<button type="button" data-sku="' + esc(p.sku) + '">' + esc(p.name)
        + ' <em class="num">' + esc(p.sku) + "</em></button>";
    }).join("");
  }

  function bindBarcode() {
    if (!st.bc) return;
    var sku = $("sBcSku").value.trim().toUpperCase();
    if (!sku) { A.toast("เลือกสินค้าที่จะผูกก่อน"); return; }
    A.api("/stock/barcodes", "POST", {
      barcode: st.bc.code, sku: sku,
      packQty: Math.max(1, Math.trunc(Number($("sBcQty").value) || 1))
    }).then(function () {
      var code = st.bc.code;
      $("sBcDlg").close();
      A.toast("ผูกบาร์โค้ดแล้ว");
      return fetchSnapshot().then(function () { submitScan(code); });
    }).catch(A.handleErr);
  }

  function skipBarcode() {
    if (!st.bc) return;
    A.api("/stock/pending", "POST", {
      barcode: st.bc.code, mode: st.mode, qty: st.bc.units || 1
    }).then(function () {
      $("sBcDlg").close();
      A.toast("เข้าคิวรอผูกบาร์โค้ดแล้ว ยิงต่อได้เลย");
      loadPending();
      focusCode();
    }).catch(A.handleErr);
  }

  function loadPending() {
    if (!canScan()) return;
    A.api("/stock/pending").then(function (d) {
      st.pending = d.pending || [];
      var card = $("sPendCard");
      card.hidden = !st.pending.length;
      $("sPendNote").textContent = st.pending.length + " บาร์โค้ด";
      $("sPend").innerHTML = "<table><thead><tr><th>บาร์โค้ด</th><th>โหมด</th>"
        + '<th class="r">ยิงไป</th><th>ล่าสุด</th>' + (canManage() ? "<th></th>" : "") + "</tr></thead><tbody>"
        + st.pending.map(function (x) {
            return '<tr><td class="num">' + esc(x.barcode) + "</td>"
              + "<td>" + esc(typeLabel(x.mode)) + "</td>"
              + '<td class="r num">' + n0(x.qty) + " (" + n0(x.times) + " ครั้ง)</td>"
              + "<td>" + esc(when(x.lastSeen)) + '<span class="sub">' + esc(x.lastUser) + "</span></td>"
              + (canManage()
                  ? '<td class="r"><button type="button" class="btn btn-ghost" data-bc="' + esc(x.barcode) + '">ผูกเลย</button></td>'
                  : "")
              + "</tr>";
          }).join("")
        + "</tbody></table>";
    }).catch(function () { /* คิวโหลดไม่ได้ก็ยังยิงงานได้ปกติ */ });
  }

  /* ================= ทะเบียนสินค้า ================= */

  function loadMaster() {
    if (!canManage()) return;
    return A.api("/stock/products").then(function (d) {
      st.master = d.products || [];
      st.masterBarcodes = d.barcodes || [];
      takeCodes(d);
      renderMaster();
    }).catch(A.handleErr);
  }

  /**
     เลขถัดไปที่เซิร์ฟเวอร์บอกมาเป็น "ตัวอย่าง" ไม่ใช่เลขที่จองไว้ให้
     คนแจกเลขจริงคือ Durable Object ตอนกดบันทึก หน้าเว็บไม่เคยคิดเลขเอง
     ถ้าหัวหน้าสองคนเปิดฟอร์มพร้อมกันจะเห็นตัวอย่างเลขเดียวกัน
     แต่พอกดบันทึก แต่ละคนจะได้เลขคนละตัว
   */
  function takeCodes(d) {
    if (d.nextSku) st.nextSku = d.nextSku;
    if (d.nextBarcode) st.nextBarcode = d.nextBarcode;
    if (d.skuPrefix) st.skuPrefix = d.skuPrefix;
    paintCodeHints();
  }

  function paintCodeHints() {
    var sk = $("sfSku"), note = $("sfSkuNote");
    if (sk && !st.editSku) {
      sk.placeholder = st.nextSku ? "ระบบจะให้ " + st.nextSku : "เว้นว่าง = ระบบรันให้";
    }
    if (note) {
      note.textContent = st.editSku ? ""
        : (st.nextSku ? "เว้นว่างไว้จะได้ " + st.nextSku + " · พิมพ์รหัสเองก็ได้ ระบบจะไม่ไปทับ" : "");
    }
    var bn = $("sfBcNote");
    if (bn) bn.textContent = (!st.editSku && st.nextBarcode) ? "(" + st.nextBarcode + ")" : "";

    var pre = $("sResPrefix");
    if (pre && st.skuPrefix && document.activeElement !== pre) pre.value = st.skuPrefix;
    var cn = $("sResCodeNote");
    if (cn) {
      cn.textContent = st.nextSku
        ? "สินค้าตัวถัดไปจะได้รหัส " + st.nextSku + " · บาร์โค้ด " + (st.nextBarcode || "—")
          + " · เปลี่ยนคำนำหน้ามีผลกับตัวที่เพิ่มหลังจากนี้ รหัสเก่าไม่ถูกแก้ตาม"
        : "";
    }
  }

  /**
     บาร์โค้ดที่จะเอาไปติดของชิ้นเดียว = ใบที่ยิงได้หนึ่งชิ้น (packQty 1)
     ถ้าไม่มีก็เอาใบแรกที่เจอ แต่ต้องบอกจำนวนต่อใบกำกับไว้
     ไม่งั้นคนเอาเลขของใบลังไปพิมพ์ติดของชิ้นเดียว แล้วยิงทีเดียวเข้าสิบสองชิ้น
   */
  function bcList(sku) {
    var all = st.masterBarcodes.filter(function (b) { return b.sku === sku; });
    var one = all.filter(function (b) { return Number(b.packQty) === 1; });
    return one.concat(all.filter(function (b) { return Number(b.packQty) !== 1; }));
  }

  function bcCell(sku) {
    var list = bcList(sku);
    if (!list.length) return '<span class="sub">ยังไม่มีบาร์โค้ด</span>';
    var main = list[0];
    var pack = Number(main.packQty) || 1;
    return '<button type="button" class="bc-copy" data-copy="' + esc(main.barcode)
      + '" title="กดเพื่อคัดลอก">' + esc(main.barcode) + "</button>"
      + (pack > 1 ? '<span class="sub">ใบนี้ยิงได้ ' + n0(pack) + " ชิ้น</span>" : "")
      + (list.length > 1 ? '<span class="sub">+ อีก ' + (list.length - 1) + " ใบ</span>" : "");
  }

  function renderMaster() {
    if (!canManage() || !st.master) return;

    $("sPTotal").textContent = st.master.length + " รายการ · บาร์โค้ด " + st.masterBarcodes.length
      + " · กดที่เลขบาร์โค้ดเพื่อคัดลอก";
    $("sImportCard").hidden = !(A.me() && A.me().role === "owner");

    if (!st.master.length) {
      $("sPTable").innerHTML = '<p class="empty">ยังไม่มีสินค้า — เพิ่มทางฟอร์มซ้าย หรือนำเข้าจาก CSV</p>';
      return;
    }

    $("sPTable").innerHTML = "<table><thead><tr><th>สินค้า</th><th>หมวด</th>"
      + '<th class="r">พร้อมขาย</th><th class="r">จุดสั่งซื้อ</th><th>บาร์โค้ด</th><th></th>'
      + "</tr></thead><tbody>"
      + st.master.map(function (m) {
          var live = st.bySku[m.sku];
          return "<tr>"
            + "<td><b>" + esc(m.name) + "</b>"
            + '<span class="sub num">' + esc(m.sku) + " · " + esc(m.unit)
            + (m.active ? "" : " · ปิดใช้งาน") + "</span></td>"
            + "<td>" + esc(m.category || "—") + "</td>"
            + '<td class="r num">' + (live ? n0(live.available) : "0") + "</td>"
            + '<td class="r num">' + n0(m.reorderPoint) + "</td>"
            + "<td>" + bcCell(m.sku) + "</td>"
            + '<td class="r"><button type="button" class="btn btn-ghost" data-edit="' + esc(m.sku) + '">แก้</button></td>'
            + "</tr>";
        }).join("")
      + "</tbody></table>";
  }

  function fillProductForm(m) {
    st.editSku = m ? m.sku : null;
    $("sPfTitle").textContent = m ? "แก้ไข " + m.sku : "เพิ่มสินค้า";
    $("sfSku").value = m ? m.sku : "";
    $("sfSku").disabled = !!m;
    // บาร์โค้ดออกให้เฉพาะตอนเพิ่มสินค้าใหม่ ของเดิมมีอยู่แล้วหรือผูกเองในกล่องด้านล่าง
    $("sfAutoBcRow").hidden = !!m;
    $("sfAutoBc").checked = true;
    paintCodeHints();
    $("sfName").value = m ? m.name : "";
    $("sfUnit").value = m ? m.unit : "";
    $("sfCat").value = m ? (m.category || "") : "";
    $("sfRop").value = m ? m.reorderPoint : 0;
    $("sfActive").checked = m ? !!m.active : true;
    if (m) $("sbSku").value = m.sku;
  }

  function saveProduct() {
    var body = {
      sku: $("sfSku").value.trim(),
      name: $("sfName").value.trim(),
      unit: $("sfUnit").value.trim(),
      category: $("sfCat").value.trim(),
      reorderPoint: Math.max(0, Math.trunc(Number($("sfRop").value) || 0)),
      active: $("sfActive").checked,
      autoBarcode: !st.editSku && $("sfAutoBc").checked
    };
    // รหัสไม่บังคับแล้ว เว้นว่างไว้เซิร์ฟเวอร์รันให้ แต่ชื่อยังบังคับ
    if (!body.name) { A.toast("ต้องใส่ชื่อสินค้า"); return; }
    A.setBusy(true, $("sfSave"), "กำลังบันทึก…");
    A.api("/stock/products", "POST", body).then(function (r) {
      takeCodes(r);
      // บอกรหัสที่ได้ให้ชัด เพราะคนกดไม่ได้พิมพ์มันเอง
      A.toast(r.created
        ? "เพิ่ม " + r.sku + " แล้ว" + (r.barcode ? " · บาร์โค้ด " + r.barcode : "")
        : "แก้ไข " + r.sku + " แล้ว");
      fillProductForm(null);
      $("sfName").value = "";
      $("sfCat").value = "";
      $("sfRop").value = 0;
      // ของที่เพิ่งเพิ่มมักต้องพิมพ์ฉลากต่อ เติม SKU ให้กล่องผูกบาร์โค้ดไว้เลย
      if (r.created) $("sbSku").value = r.sku;
      return Promise.all([loadMaster(), fetchSnapshot()]);
    }).catch(A.handleErr).then(function () {
      A.setBusy(false, $("sfSave"), "บันทึกสินค้า");
    });
  }

  function saveBarcode() {
    var body = {
      barcode: $("sbCode").value.trim(),
      sku: $("sbSku").value.trim().toUpperCase(),
      packQty: Math.max(1, Math.trunc(Number($("sbQty").value) || 1))
    };
    // บาร์โค้ดไม่บังคับแล้ว เว้นว่างไว้เซิร์ฟเวอร์สร้างให้ แต่ต้องรู้ว่าผูกกับตัวไหน
    if (!body.sku) { A.toast("ต้องบอกว่าผูกกับสินค้าตัวไหน"); return; }
    A.api("/stock/barcodes", "POST", body).then(function (r) {
      takeCodes(r);
      A.toast(r.autoBarcode
        ? "สร้างบาร์โค้ด " + r.barcode + " ให้ " + r.sku + " แล้ว"
        : "ผูกบาร์โค้ดแล้ว");
      $("sbCode").value = "";
      return Promise.all([loadMaster(), fetchSnapshot()]);
    }).catch(A.handleErr);
  }

  /* ---------- นำเข้า CSV ---------- */

  function splitCsvLine(line) {
    var out = [], cur = "", q = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out.map(function (x) { return x.trim(); });
  }

  function importCsv(file) {
    var fr = new FileReader();
    fr.onload = function () {
      var text = String(fr.result || "").replace(/^\uFEFF/, "");
      var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
      if (lines.length < 2) { $("sImportNote").textContent = "ไฟล์ว่าง หรือมีแต่หัวตาราง"; return; }

      var head = splitCsvLine(lines[0]).map(function (h) { return h.toLowerCase(); });
      var col = function (name) { return head.indexOf(name); };
      if (col("name") < 0) {
        $("sImportNote").textContent = "หัวตารางต้องมีคอลัมน์ name เป็นอย่างน้อย";
        return;
      }

      var rows = lines.slice(1).map(function (l) {
        var c = splitCsvLine(l);
        var pick = function (k) { var i = col(k); return i >= 0 ? c[i] : ""; };
        return {
          sku: pick("sku"), name: pick("name"), unit: pick("unit"),
          category: pick("category"), reorderPoint: pick("reorderpoint"),
          barcode: pick("barcode"), packQty: pick("packqty")
        };
      }).filter(function (r) { return r.name; });

      if (!rows.length) { $("sImportNote").textContent = "ไม่พบแถวที่ใช้ได้"; return; }
      $("sImportNote").textContent = "กำลังนำเข้า " + rows.length + " แถว…";

      A.api("/stock/products/bulk", "POST", {
        products: rows, autoBarcode: $("sImportAutoBc").checked
      }).then(function (r) {
        takeCodes(r);
        $("sImportNote").textContent = "เพิ่มใหม่ " + r.created + " · อัปเดต " + r.updated
          + (r.coded ? " · สร้างบาร์โค้ดให้ " + r.coded : "")
          + (r.skipped ? " · ข้าม " + r.skipped + " (ไม่มีชื่อสินค้า)" : "");
        A.toast("นำเข้าสินค้าเรียบร้อย");
        return Promise.all([loadMaster(), fetchSnapshot()]);
      }).catch(function (err) {
        $("sImportNote").textContent = (err && err.message) || "นำเข้าไม่สำเร็จ";
      });
    };
    fr.readAsText(file);
  }

  /* ================= คิวการยิงตอนออฟไลน์ =================
   * คลังเป็นที่ที่ WiFi แย่ที่สุดในบริษัทเสมอ ยิงไม่ได้ = คนแพ็คของแพ็คต่อโดยไม่ยิง
   * แล้วสต็อกจะเพี้ยนหนักกว่าเดิมแบบไม่มีใครรู้ จึงต้องยิงค้างไว้ในเครื่องได้
   *
   * ปลอดภัยเพราะทุกการยิงมี scanId ที่สร้างในเครื่องและฝั่งเซิร์ฟเวอร์กันซ้ำด้วยคอลัมน์ UNIQUE
   * ส่งซ้ำกี่รอบก็ไม่ตัดสต็อกเพิ่ม
   *
   * แต่ตัวเลขที่ค้างในคิว **ยังไม่ถูกนับในยอดที่แสดง** และต้องบอกตรง ๆ
   * ไม่ใช่เอาไปบวกลบให้ดูเหมือนส่งแล้ว
   */
  var DB_NAME = "mintra-stock";
  var DB_STORE = "queue";
  var dbp = null;

  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error("เบราว์เซอร์นี้ไม่รองรับการเก็บคิวในเครื่อง")); return; }
      var rq = indexedDB.open(DB_NAME, 1);
      rq.onupgradeneeded = function () {
        var d = rq.result;
        if (!d.objectStoreNames.contains(DB_STORE)) {
          d.createObjectStore(DB_STORE, { keyPath: "scanId" }).createIndex("at", "at");
        }
      };
      rq.onsuccess = function () { resolve(rq.result); };
      rq.onerror = function () { reject(rq.error); };
    });
    return dbp;
  }

  function tx(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(DB_STORE, mode);
        var out = fn(t.objectStore(DB_STORE));
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }

  function queueAdd(kind, payload) {
    return tx("readwrite", function (st2) {
      return st2.put({ scanId: payload.scanId, kind: kind, payload: payload, at: Date.now() });
    }).then(refreshQueue);
  }

  function queueAll() {
    return tx("readonly", function (st2) { return st2.getAll(); });
  }

  function queueDrop(ids) {
    return tx("readwrite", function (st2) { ids.forEach(function (id) { st2.delete(id); }); })
      .then(refreshQueue);
  }

  function refreshQueue() {
    return tx("readonly", function (st2) { return st2.count(); })
      .then(function (n) { st.queued = Number(n) || 0; paintQueue(); return st.queued; })
      .catch(function () { /* อ่านคิวไม่ได้ก็ไม่ควรทำให้หน้าจอพัง */ });
  }

  function paintQueue() {
    var b = $("sQueue");
    if (!b) return;
    if (!st.queued) { b.hidden = true; return; }
    b.hidden = false;
    b.setAttribute("data-tone", "warn");
    b.innerHTML = "<b>รอส่ง " + n0(st.queued) + " รายการ</b> — ยิงต่อได้ตามปกติ ระบบจะส่งให้เองเมื่อเน็ตกลับมา · "
      + "<b>ตัวเลขที่เห็นยังไม่รวมรายการเหล่านี้</b>";
  }

  /** แยกเน็ตล่มออกจากเซิร์ฟเวอร์ปฏิเสธ — ปฏิเสธห้ามเข้าคิว ไม่งั้นจะส่งซ้ำไปตลอด */
  function isNetworkErr(err) { return !(err && err.status); }

  function flushQueue() {
    if (st.flushing) return Promise.resolve();
    return refreshQueue().then(function (n) {
      if (!n) return;
      st.flushing = true;
      return queueAll().then(function (items) {
        items.sort(function (a, b) { return a.at - b.at; });
        var scans = items.filter(function (x) { return x.kind === "scan"; });
        var counts = items.filter(function (x) { return x.kind === "count"; });
        var done = [], problems = [];

        var step = scans.length
          ? A.api("/stock/scan/batch", "POST", { scans: scans.map(function (x) { return x.payload; }) })
              .then(function (r) {
                (r.results || []).forEach(function (res, i) {
                  var q = scans[i];
                  if (!q) return;
                  if (res.ok) {
                    done.push(q.scanId);
                    if (res.negative) problems.push((res.name || q.payload.barcode) + " ติดลบ");
                  } else if (res.unknownBarcode) {
                    done.push(q.scanId);
                    problems.push("บาร์โค้ด " + res.barcode + " ไม่รู้จัก");
                  } else {
                    done.push(q.scanId);
                    problems.push((q.payload.barcode || q.payload.sku) + ": " + (res.error || "ส่งไม่สำเร็จ"));
                  }
                });
              })
          : Promise.resolve();

        return step.then(function () {
          // การยิงนับส่งทีละรายการ เพราะกันซ้ำด้วย scanId อยู่แล้วและไม่มีคำสั่งส่งเป็นชุด
          return counts.reduce(function (chain, q) {
            return chain.then(function () {
              return A.api("/stock/count/scan", "POST", q.payload)
                .then(function () { done.push(q.scanId); })
                .catch(function (err) {
                  if (!isNetworkErr(err)) {
                    done.push(q.scanId);
                    problems.push("นับ " + (q.payload.barcode || q.payload.sku) + ": " + err.message);
                  }
                });
            });
          }, Promise.resolve());
        }).then(function () {
          return done.length ? queueDrop(done) : null;
        }).then(function () {
          /* สรุปให้อ่านเสมอ ไม่เงียบ ไม่กลืนปัญหา */
          if (done.length) {
            A.toast("ส่งขึ้นระบบแล้ว " + done.length + " รายการ"
              + (problems.length ? " · ต้องตรวจ " + problems.length + " รายการ" : ""));
          }
          if (problems.length) {
            var b = $("sQueue");
            b.hidden = false;
            b.setAttribute("data-tone", "err");
            b.innerHTML = "<b>ส่งคิวแล้วแต่มี " + problems.length + " รายการต้องตรวจ</b> — "
              + problems.slice(0, 5).map(esc).join(" · ")
              + (problems.length > 5 ? " และอีก " + (problems.length - 5) + " รายการ" : "");
          }
          return fetchSnapshot();
        });
      }).catch(function () { /* ส่งไม่ได้ก็ค้างในคิวไว้ รอบหน้าค่อยลองใหม่ */ })
        .then(function () { st.flushing = false; });
    });
  }

  /* ================= เหตุผลการคืน ================= */

  function renderReasons() {
    var box = $("sReasons");
    if (!box || !st.reasons.length) return;
    box.innerHTML = st.reasons.map(function (r) {
      var on = st.reason === r.key;
      var where = r.location === "main" ? "เข้ากองที่ขายได้" : "เข้ากองของเสียหาย ไม่นับเป็นพร้อมขาย";
      return '<label class="bopt" data-on="' + on + '">'
        + '<input type="radio" name="sReason" value="' + esc(r.key) + '"' + (on ? " checked" : "") + ">"
        + '<span><span class="t">' + esc(r.label) + "</span>"
        + '<span class="d">' + where + "</span></span></label>";
    }).join("");
    var cur = st.reasons.filter(function (r) { return r.key === st.reason; })[0];
    $("sNoteWrap").hidden = !(cur && cur.needNote);
  }

  /* ================= ของใกล้หมด ================= */

  function loadAlerts(force) {
    // ค่าเฉลี่ยยอดขายไม่ได้เปลี่ยนทุกวินาที ดึงถี่กว่าทุกนาทีไม่ได้ประโยชน์
    if (!force && Date.now() - st.alertAt < 60000) return Promise.resolve();
    st.alertAt = Date.now();
    return A.api("/stock/alerts").then(function (d) {
      st.alerts = d.alerts || [];
      renderAlerts();
    }).catch(function () { /* แจ้งเตือนโหลดไม่ได้ไม่ควรทำให้ตัวเลขหลักหาย */ });
  }

  function renderAlerts() {
    var box = $("sAlerts");
    if (!box) return;
    var out = st.alerts.filter(function (a) { return a.level === "out"; });
    var low = st.alerts.filter(function (a) { return a.level === "low"; });
    var neg = st.alerts.filter(function (a) { return a.onHand < 0; });

    if (!out.length && !low.length && !neg.length) { box.hidden = true; box.innerHTML = ""; return; }

    function bar(cls, head, items, render) {
      if (!items.length) return "";
      return '<div class="due-b ' + cls + '"><div class="due-h"><span>' + head
        + "</span><b>" + items.length + " รายการ</b></div><ul>"
        + items.slice(0, 8).map(render).join("") + "</ul></div>";
    }

    box.innerHTML =
        bar("over", "หมดแล้ว ขายต่อไม่ได้", out, function (a) {
          return "<li><b>" + esc(a.name) + "</b> — พร้อมขาย " + n0(a.available)
            + (a.avgPerDay > 0 ? " · เคยขายเฉลี่ย " + a.avgPerDay + "/วัน" : "") + "</li>";
        })
      + bar("soon", "ใกล้หมด ต้องสั่งเพิ่ม", low, function (a) {
          return "<li><b>" + esc(a.name) + "</b> — เหลือ " + n0(a.available)
            + (a.daysLeft != null ? " · พอขายอีกประมาณ " + a.daysLeft + " วัน" : "")
            + " (จุดสั่งซื้อ " + n0(a.reorderPoint) + ")</li>";
        })
      + bar("over", "ยอดติดลบ ของจริงไม่ตรงตัวเลข ต้องไปนับ", neg, function (a) {
          return "<li><b>" + esc(a.name) + "</b> — ในระบบ " + n0(a.onHand) + "</li>";
        });
    box.hidden = false;
  }

  /* ================= การจอง ================= */

  function leftLabel(iso) {
    var ms = Date.parse(iso) - Date.now();
    if (!isFinite(ms)) return "";
    if (ms <= 0) return "หมดอายุแล้ว";
    var h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? "เหลือ " + h + " ชม. " + m + " นาที" : "เหลือ " + m + " นาที";
  }

  function doReserve() {
    var p = st.selected ? st.bySku[st.selected] : null;
    if (!p) return;
    if (stale()) { A.toast("ตัวเลขไม่สด จองไม่ได้ — รอให้ต่อกลับก่อน"); return; }
    var qty = Math.max(1, Math.trunc(Number($("srQty").value) || 1));
    var ref = $("srRef").value.trim();
    if (!ref) { A.toast("ต้องใส่เลขออเดอร์หรือชื่อลูกค้า"); return; }

    A.setBusy(true, $("srBtn"), "กำลังจอง…");
    A.api("/stock/reserve", "POST", { sku: p.sku, qty: qty, orderRef: ref })
      .then(function (r) {
        if (r.row) { mergeRows([r.row]); st.version = r.version || st.version; st.lastSync = Date.now(); }
        A.toast("จอง " + qty + " " + (p.unit || "ชิ้น") + " ให้ " + ref + " แล้ว");
        renderBrowse();
        return loadMine();
      })
      .catch(A.handleErr)
      .then(function () { A.setBusy(false, $("srBtn"), "จองให้ลูกค้า"); });
  }

  function releaseRes(id) {
    A.api("/stock/reserve/release", "POST", { id: id }).then(function (r) {
      if (r.row) { mergeRows([r.row]); st.version = r.version || st.version; }
      A.toast("ยกเลิกการจองแล้ว ปล่อยของคืน " + n0(r.released) + " ชิ้น");
      renderBrowse();
      return loadMine();
    }).catch(A.handleErr);
  }

  function extendRes(id) {
    A.api("/stock/reserve/extend", "POST", { id: id }).then(function () {
      A.toast("ต่ออายุการจองอีก " + st.reserveHours + " ชั่วโมง");
      return loadMine();
    }).catch(A.handleErr);
  }

  function loadMine() {
    if (!canReserve()) return Promise.resolve();
    return A.api("/stock/reservations?mine=1&status=open").then(function (d) {
      st.mine = d.reservations || [];
      if (d.reserveHours) st.reserveHours = d.reserveHours;
      renderMine();
    }).catch(function () { /* รายการจองโหลดไม่ได้ไม่ควรทำให้ตัวเลขหลักหาย */ });
  }

  function renderMine() {
    var card = $("sMineCard");
    if (!card) return;
    if (!st.mine.length) { card.hidden = true; return; }
    card.hidden = false;
    $("sMineNote").textContent = st.mine.length + " ใบ · หมดอายุเองใน " + st.reserveHours + " ชม.";
    $("sMine").innerHTML = st.mine.map(function (r) {
      var remain = (r.qty || 0) - (r.pickedQty || 0);
      var ms = Date.parse(r.expiresAt) - Date.now();
      var soon = isFinite(ms) && ms < 3 * 3600000;
      return '<div class="s-res">'
        + "<div><b>" + esc(r.name || r.sku) + "</b>"
        + '<em class="num">' + esc(r.orderRef) + " · " + n0(remain) + " " + esc(r.unit || "ชิ้น")
        + (r.pickedQty > 0 ? " (แพ็คไปแล้ว " + n0(r.pickedQty) + ")" : "") + "</em></div>"
        + '<span class="pill ' + (soon ? "p-cost" : "p-income") + '"><i class="dot"></i>'
        + esc(leftLabel(r.expiresAt)) + "</span>"
        + '<button type="button" class="btn btn-ghost" data-ext="' + esc(r.id) + '">ต่ออายุ</button>'
        + '<button type="button" class="btn btn-ghost" data-rel="' + esc(r.id) + '">ยกเลิก</button>'
        + "</div>";
    }).join("");
  }

  /* ================= จอติดผนังคลัง ================= */

  function loadBoard() {
    return A.api("/stock/board").then(function (d) {
      st.board = d;
      renderWall();
    }).catch(A.handleErr);
  }

  function renderWall() {
    var box = $("sWallIn");
    if (!box) return;
    var d = st.board;
    if (!d) { box.innerHTML = '<p class="empty">กำลังโหลด…</p>'; return; }

    var t = d.today || {};
    var alerts = d.alerts || [];
    var brand = (A.brand && A.brand()) || {};

    function big(label, value, tone) {
      return '<div class="wl-cell" data-tone="' + (tone || "") + '">'
        + "<span>" + label + '</span><b class="num">' + n0(value) + "</b></div>";
    }

    box.innerHTML =
        '<div class="wl-head">'
      +   "<div><b>คลังหลัก</b><span>" + esc(brand.short || "") + "</span></div>"
      +   '<span class="wl-live" data-state="' + (st.conn === "on" ? "on" : "off") + '">'
      +     (st.conn === "on" ? "ข้อมูลสด" : "ขาดการเชื่อมต่อ") + "</span>"
      +   '<div class="wl-clock"><b class="num">' + hhmm() + "</b><span>" + esc(d.date) + "</span></div>"
      + "</div>"

      + '<div class="wl-body">'
      +   '<div class="wl-alerts">'
      +     '<h3>ต้องสั่งเพิ่มวันนี้ <em>เรียงจากที่จะหมดก่อน</em></h3>'
      +     (alerts.length
              ? alerts.map(function (a) {
                  var tone = a.level === "out" ? "out" : "low";
                  var sub = a.level === "out" ? "ขายไม่ได้แล้ว"
                          : a.daysLeft != null ? "พอขายอีกประมาณ " + a.daysLeft + " วัน"
                          : "ต่ำกว่าจุดสั่งซื้อ " + n0(a.reorderPoint);
                  return '<div class="wl-row" data-tone="' + tone + '">'
                    + "<div><b>" + esc(a.name) + "</b><em>" + sub + "</em></div>"
                    + '<div class="wl-n"><b class="num">' + n0(a.available) + "</b><em>พร้อมขาย</em></div>"
                    + "</div>";
                }).join("")
              : '<p class="wl-none">ไม่มีตัวไหนต่ำกว่าจุดสั่งซื้อ</p>')
      +   "</div>"
      +   '<div class="wl-side">'
      +     "<h3>วันนี้</h3>"
      +     big("รับเข้า", t.received, "in")
      +     big("แพ็คส่ง", t.issued, "outq")
      +     big("ของตีกลับ", t.returned, "ret")
      +     big("รอแพ็ค (ออเดอร์)", (d.waitingPack || {}).orders, "wait")
      +   "</div>"
      + "</div>"

      + '<div class="wl-foot">'
      +   '<div class="wl-f" data-tone="' + ((d.negative || []).length ? "out" : "") + '">'
      +     "<span>ยอดติดลบ ต้องไปนับ</span><b class=\"num\">" + n0((d.negative || []).length) + "</b></div>"
      +   '<div class="wl-f" data-tone="' + (d.pendingBarcodes ? "low" : "") + '">'
      +     "<span>รอผูกบาร์โค้ด</span><b class=\"num\">" + n0(d.pendingBarcodes) + "</b></div>"
      +   '<div class="wl-f"><span>ของที่ถูกจองไว้</span><b class="num">'
      +     n0((d.waitingPack || {}).qty) + "</b></div>"
      + "</div>";
  }

  function hhmm() {
    var d = new Date(), p = function (x) { return (x < 10 ? "0" : "") + x; };
    return p(d.getHours()) + ":" + p(d.getMinutes());
  }

  /* ================= นับสต็อก ================= */

  function loadCounts() {
    return A.api("/stock/counts").then(function (d) {
      st.counts = d.counts || [];
      st.adjReasons = d.reasons || {};
      var open = st.counts.filter(function (c) { return c.status === "open"; })[0];
      if (open) return loadCount(open.id);
      st.count = null;
      renderCount();
    }).catch(A.handleErr);
  }

  function loadCount(id) {
    return A.api("/stock/count?id=" + encodeURIComponent(id)).then(function (d) {
      st.count = d;
      renderCount();
    }).catch(A.handleErr);
  }

  function renderCount() {
    var head = $("sCountHead"), body = $("sCountBody");
    if (!head) return;

    if (!st.count || st.count.count.status !== "open") {
      head.innerHTML = "";
      body.innerHTML =
          '<div class="cols">'
        + '<div class="card form-col"><h2>เปิดรอบนับใหม่</h2><div class="body">'
        +   '<div class="field" style="margin-top:0"><label class="lbl" for="scoLoc">คลังที่จะนับ</label>'
        +     '<select id="scoLoc">' + st.locations.map(function (l) {
                return '<option value="' + esc(l.id) + '">' + esc(l.name) + "</option>";
              }).join("") + "</select></div>"
        +   '<button type="button" class="btn btn-main" id="scoOpen">เปิดรอบนับ</button>'
        +   '<p class="note" style="margin-top:11px">เปิดรอบแล้วระบบจะ<b>แช่ยอดคาดหมาย</b>ของทุกสินค้าไว้ '
        +     "ระหว่างนับยังยิงงานปกติได้ การเคลื่อนไหวระหว่างนับถูกคิดแยกให้แล้ว</p>"
        + "</div></div>"
        + '<div class="card"><h2>รอบนับที่ผ่านมา</h2>' + pastCounts() + "</div></div>";
      return;
    }

    var c = st.count.count, t = st.count.totals;
    var pct = function (n) { return t.lines ? (n / t.lines * 100).toFixed(1) : 0; };
    var mine = st.count.counters.indexOf((A.me() && A.me().username) || "") >= 0;

    head.innerHTML =
        '<div class="smode" data-mode="count">'
      +   '<div class="sm-l"><b class="display">นับสต็อก</b>'
      +     "<span>" + esc(locName(c.locationId)) + ' · รอบ <span class="num">' + esc(c.id) + "</span>"
      +     " · เปิดโดย " + esc(c.startedBy) + "</span></div>"
      +   '<div class="sm-tally"><b class="num">' + n0(t.countedLines) + " / " + n0(t.lines) + "</b>"
      +     "<span>นับแล้ว</span></div>"
      + "</div>";

    body.innerHTML =
        '<div class="chain">'
      +   kpi("นับแล้วตรง", t.match, "income") + kpi("นับได้ขาด", t.short, "opex")
      +   kpi("นับได้เกิน", t.over, "gross") + kpiDash("ยังไม่นับ", t.uncounted)
      +   kpi("มูลค่าผลต่าง", A.baht(t.diffValue), "net", true)
      + "</div>"

      + '<div class="cols">'
      + '<div class="card form-col"><h2>ยิงนับ</h2><div class="body">'
      +   '<div class="field" style="margin-top:0"><label class="lbl" for="scBar">บาร์โค้ด</label>'
      +     '<input type="text" id="scBar" class="num scan-in" autocomplete="off" placeholder="ยิงได้เลย ยิงซ้ำตัวเดิมระบบบวกให้">'
      +     '<button type="button" class="btn btn-ghost cam-btn" id="scCamBtn" hidden>ยิงด้วยกล้องมือถือ</button></div>'
      +   '<div class="field"><label class="lbl" for="scUnits">ยิงครั้งละ</label>'
      +     '<input type="number" id="scUnits" class="num" min="1" step="1" value="1"></div>'
      +   '<div class="calc"><span>ยิงนับไปแล้ว</span><b class="num">' + n0(t.countedLines) + " ตัว</b></div>"
      +   '<div class="bucket" style="margin-top:16px">'
      +     '<div class="bopt" data-on="' + (st.countFilter === "all") + '" data-f="all">'
      +       '<span><span class="t">ทั้งหมด</span><span class="d">' + n0(t.lines) + " รายการ</span></span></div>"
      +     '<div class="bopt" data-on="' + (st.countFilter === "diff") + '" data-f="diff">'
      +       '<span><span class="t">เฉพาะที่มีผลต่าง</span><span class="d">' + n0(t.short + t.over) + " รายการ</span></span></div>"
      +     '<div class="bopt" data-on="' + (st.countFilter === "un") + '" data-f="un">'
      +       '<span><span class="t">เฉพาะที่ยังไม่นับ</span><span class="d">' + n0(t.uncounted) + " รายการ</span></span></div>"
      +   "</div>"
      +   '<div class="banner" style="margin-top:16px">"ยังไม่นับ" ต่างจาก "นับได้ 0" — ปิดรอบแล้วระบบ'
      +     "<b>ไม่แตะ</b>ตัวเลขของ " + n0(t.uncounted) + " รายการที่ยังไม่ได้ยิงนับ</div>"

      +   (canManage()
          ? (mine
             ? '<div class="banner" data-tone="err" style="margin-top:13px">คุณเป็นคนยิงนับในรอบนี้ '
               + "— คนนับกับคนปิดรอบต้องเป็นคนละคน ให้หัวหน้าคนอื่นหรือเจ้าของยืนยันผลต่าง</div>"
             : '<button type="button" class="btn btn-main" id="scClose">ปิดรอบและปรับยอดให้ตรงของจริง</button>')
          : '<p class="note" style="margin-top:13px">ปิดรอบได้เฉพาะหัวหน้าคลังขึ้นไป</p>')
      +   (canManage() ? '<button type="button" class="btn btn-ghost" id="scCancel" style="width:100%;margin-top:9px">ยกเลิกรอบนับ</button>' : "")
      + "</div></div>"

      + '<div class="card"><h2>รายงานผลต่าง</h2><div class="tablewrap">' + varianceTable() + "</div></div>"
      + "</div>";

    var bar = $("scBar");
    if (bar) bar.focus();
    paintCam();
  }

  function kpi(label, val, tone, raw) {
    return '<div class="kpi" style="--tint:var(--' + tone + '-bg);--c:var(--' + tone + ')">'
      + '<div class="k-lab">' + label + '</div><div class="k-val num">'
      + (raw ? val : n0(val)) + "</div></div>";
  }

  /* ยังไม่นับใช้กรอบประ ไม่ใช่สีของผลต่าง เพราะมันไม่ใช่ผลต่าง มันคือ "ไม่รู้" */
  function kpiDash(label, val) {
    return '<div class="kpi kpi-dash"><div class="k-lab">' + label + "</div>"
      + '<div class="k-val num">' + n0(val) + '</div><div class="k-sub">ไม่ใช่นับได้ศูนย์</div></div>';
  }

  function locName(id) {
    var l = st.locations.filter(function (x) { return x.id === id; })[0];
    return l ? l.name : id;
  }

  function pastCounts() {
    if (!st.counts.length) return '<p class="empty">ยังไม่เคยนับสต็อก</p>';
    return "<table><thead><tr><th>รอบ</th><th>คลัง</th><th>สถานะ</th>"
      + '<th class="r">นับแล้ว</th><th>ปิดโดย</th></tr></thead><tbody>'
      + st.counts.map(function (c) {
          var lab = { open: "เปิดอยู่", closed: "ปิดแล้ว", cancelled: "ยกเลิก" }[c.status] || c.status;
          var cls = c.status === "open" ? "p-cost" : c.status === "closed" ? "p-income" : "p-opex";
          return '<tr><td class="num">' + esc(c.id) + '<span class="sub">' + esc(when(c.startedAt))
            + " · " + esc(c.startedBy) + "</span></td>"
            + "<td>" + esc(locName(c.locationId)) + "</td>"
            + '<td><span class="pill ' + cls + '"><i class="dot"></i>' + lab + "</span></td>"
            + '<td class="r num">' + n0(c.countedLines) + " / " + n0(c.lines) + "</td>"
            + "<td>" + esc(c.closedBy || "—") + "</td></tr>";
        }).join("") + "</tbody></table>";
  }

  function varianceTable() {
    var lines = (st.count.lines || []).filter(function (l) {
      if (st.countFilter === "diff") return l.state === "short" || l.state === "over";
      if (st.countFilter === "un") return l.state === "uncounted";
      return true;
    });
    if (!lines.length) return '<p class="empty">ไม่มีรายการในตัวกรองนี้</p>';

    return "<table><thead><tr><th>สินค้า</th><th class=\"r\">คาดหมาย</th><th class=\"r\">นับได้</th>"
      + '<th class="r">ผลต่าง</th><th class="r">มูลค่า</th><th class="r">ขยับระหว่างนับ</th>'
      + "</tr></thead><tbody>"
      + lines.slice(0, 300).map(function (l) {
          var tint = l.state === "short" ? "background:var(--opex-bg)"
                   : l.state === "over" ? "background:var(--gross-bg)"
                   : l.state === "uncounted" ? "background:var(--surface-2)" : "";
          var counted = l.state === "uncounted"
            ? '<span class="pill p-un">ยังไม่นับ</span>'
            : '<b class="num">' + n0(l.counted) + "</b>";
          var diff = l.diff == null ? '<span class="num" style="color:var(--muted)">—</span>'
            : l.diff === 0 ? '<span class="pill p-income"><i class="dot"></i>ตรง</span>'
            : '<b class="num" style="color:var(--' + (l.diff < 0 ? "opex" : "gross") + ')">'
              + (l.diff > 0 ? "+" : "") + n0(l.diff) + "</b>";
          return '<tr style="' + tint + '">'
            + "<td><b>" + esc(l.name) + '</b><span class="sub num">' + esc(l.sku) + "</span></td>"
            + '<td class="r num">' + n0(l.expected) + "</td>"
            + '<td class="r">' + counted + "</td>"
            + '<td class="r">' + diff + "</td>"
            + '<td class="r num">' + (l.diffValue == null ? "—" : A.baht(l.diffValue)) + "</td>"
            + '<td class="r num" style="color:var(--muted)">' + (l.movedDuringCount ? (l.movedDuringCount > 0 ? "+" : "") + n0(l.movedDuringCount) : "—") + "</td>"
            + "</tr>";
        }).join("") + "</tbody></table>";
  }

  function countScan(raw, opts) {
    var quietOk = !!(opts && opts.quietOk);
    var code = String(raw || "").trim();
    if (!code || !st.count) return;
    var units = Math.max(1, Math.trunc(Number($("scUnits").value) || 1));
    var payload = { countId: st.count.count.id, barcode: code, units: units, scanId: uuid() };

    if (navigator.onLine === false) {
      queueAdd("count", payload).then(function () { if (!quietOk) beep("ok"); });
      return;
    }

    A.api("/stock/count/scan", "POST", payload).then(function (r) {
      if (r.unknownBarcode) { beep("unknown"); openBarcodeDialog(code, units); return; }
      if (r.duplicate) beep("dup"); else if (!quietOk) beep("ok");
      return loadCount(st.count.count.id);
    }).catch(function (err) {
      if (isNetworkErr(err)) { queueAdd("count", payload).then(function () { beep("ok"); }); return; }
      beep("bad");
      A.handleErr(err);
    });
  }

  /* ================= ต้นทุนและมูลค่า ================= */

  function loadCost() {
    return Promise.all([
      A.api("/stock/value"),
      A.api("/stock/receipts?pending=0"),
      A.api("/stock/adjustments?days=7")
    ]).then(function (r) {
      st.value = r[0];
      st.receipts = r[1].receipts || [];
      st.adjustments = r[2].adjustments || [];
      renderCost();
    }).catch(A.handleErr);
  }

  function renderCost() {
    if (!st.value) return;
    var v = st.value;
    var pending = st.receipts.filter(function (b) { return b.missingCost > 0; });
    var costed = st.receipts.filter(function (b) { return b.missingCost === 0; });
    var neg = st.products.filter(function (p) { return p.onHand < 0; });

    $("svKpi").innerHTML =
        kpi("มูลค่าสต็อก", A.baht(v.total), "net", true)
      + kpi("บิลรอใส่ต้นทุน", pending.length, "cost")
      + kpi("บิลใส่ต้นทุนครบ", costed.length, "income")
      + kpi("ยอดติดลบ", neg.length, "opex");

    var segs = (v.byLocation || []).map(function (l, i) {
      var pc = v.total > 0 ? (l.value / v.total * 100) : 0;
      return '<i style="width:' + pc.toFixed(1) + '%;background:'
        + (i === 0 ? "#fff" : i === 1 ? "rgba(255,255,255,.5)" : "rgba(255,255,255,.26)") + '"></i>';
    }).join("");

    $("svHero").innerHTML =
        '<div class="c-main"><div class="c-lab">มูลค่าสต็อกคงเหลือ</div>'
      +   '<div class="c-val num">' + A.baht(v.total) + "</div>"
      +   '<div class="c-note">ต้นทุนถัวเฉลี่ย × ของในคลัง'
      +     (v.withoutCost ? " · ยังมี " + v.withoutCost + " รายการที่ไม่มีต้นทุน จึงยังไม่ถูกนับ" : "")
      +   "</div></div>"
      + '<div class="c-split"><div class="split-bar">' + segs + "</div>"
      +   '<div class="split-nums" style="grid-template-columns:repeat(' + Math.max(1, (v.byLocation || []).length) + ',1fr)">'
      +   (v.byLocation || []).map(function (l, i) {
            return '<div class="sn"><div class="sn-top"><span class="dot" style="background:'
              + (i === 0 ? "#fff" : i === 1 ? "rgba(255,255,255,.5)" : "rgba(255,255,255,.26)") + '"></span>'
              + esc(l.name) + '</div><span class="sn-v num">' + A.baht(l.value) + "</span></div>";
          }).join("")
      +   "</div>"
      +   '<div class="c-buy">เงินจมในของไม่ขยับเกิน 60 วัน <b>' + A.baht(v.deadValue) + "</b> บาท "
      +     "จาก " + n0((v.dead || []).length) + " รายการ</div>"
      + "</div>";

    $("sRcNote").textContent = pending.length
      ? pending.length + " บิลรอใส่ต้นทุน · ใส่ครบแล้ว " + costed.length + " บิล"
      : costed.length + " บิล ใส่ต้นทุนครบทุกบิล";

    $("sRcTable").innerHTML = !st.receipts.length
      ? '<p class="empty">ยังไม่มีบิลรับเข้า</p>'
      : "<table><thead><tr><th>บิล</th><th class=\"r\">จำนวน</th><th class=\"r\">ยอดเงิน</th>"
        + "<th>สถานะ</th><th></th></tr></thead><tbody>"
        + st.receipts.slice(0, 60).map(function (b) {
            var stt = b.missingCost > 0
              ? '<span class="pill p-cost"><i class="dot"></i>รอใส่ต้นทุน ' + b.missingCost + "</span>"
              : '<span class="pill p-income"><i class="dot"></i>ต้นทุนครบ</span>';
            return '<tr><td class="num"><b>' + esc(b.refId) + "</b>"
              + '<span class="sub">' + esc(when(b.firstAt)) + " · " + esc(b.users) + "</span></td>"
              + '<td class="r num">' + n0(b.qty) + '<span class="sub">' + n0(b.skus) + " ตัว</span></td>"
              + '<td class="r num">' + (b.amount ? A.baht(b.amount) : "—") + "</td>"
              + "<td>" + stt + "</td>"
              + '<td class="r"><button type="button" class="btn btn-ghost" data-rc="' + esc(b.refId) + '">เปิด</button></td>'
              + "</tr>";
          }).join("") + "</tbody></table>";

    $("sDeadNote").textContent = A.baht(v.deadValue) + " บาท";
    $("sDeadTable").innerHTML = !(v.dead || []).length
      ? '<p class="empty">ไม่มีของที่ค้างเกิน 60 วัน</p>'
      : "<table><thead><tr><th>สินค้า</th><th class=\"r\">คงเหลือ</th><th class=\"r\">มูลค่า</th>"
        + '<th class="r">ขยับล่าสุด</th></tr></thead><tbody>'
        + v.dead.map(function (x) {
            return "<tr><td>" + esc(x.name) + '<span class="sub num">' + esc(x.sku) + "</span></td>"
              + '<td class="r num">' + n0(x.qty) + "</td>"
              + '<td class="r num">' + A.baht(x.value) + "</td>"
              + '<td class="r">' + (x.idleDays == null ? "ไม่เคยขาย" : n0(x.idleDays) + " วัน") + "</td></tr>";
          }).join("") + "</tbody></table>";

    $("sAdjTable").innerHTML = !st.adjustments.length
      ? '<p class="empty">ไม่มีการปรับยอดใน 7 วันที่ผ่านมา</p>'
      : "<table><thead><tr><th>สินค้า</th><th class=\"r\">ผลต่าง</th><th>เหตุผล</th><th>คนทำ</th></tr></thead><tbody>"
        + st.adjustments.map(function (a) {
            return "<tr><td>" + esc(a.name || a.sku)
              + '<span class="sub">' + esc(when(a.ts)) + "</span></td>"
              + '<td class="r num" style="font-weight:600;color:var(--'
              + (a.qty < 0 ? "opex" : "income") + ')">' + (a.qty > 0 ? "+" : "") + n0(a.qty) + "</td>"
              + '<td style="font-size:13px">' + esc(st.adjReasons[a.reason] || a.reason)
              + (a.note ? '<span class="sub">' + esc(a.note) + "</span>" : "") + "</td>"
              + '<td style="font-size:13px">' + esc(a.userId) + "</td></tr>";
          }).join("") + "</tbody></table>";

    fillAdjustForm();
  }

  function fillAdjustForm() {
    var sel = $("sajLoc");
    if (sel && !sel.options.length) {
      sel.innerHTML = st.locations.map(function (l) {
        return '<option value="' + esc(l.id) + '">' + esc(l.name) + "</option>";
      }).join("");
    }
    var rs = $("sajReason");
    if (rs && !rs.options.length) {
      rs.innerHTML = Object.keys(st.adjReasons).map(function (k) {
        return '<option value="' + esc(k) + '">' + esc(st.adjReasons[k]) + "</option>";
      }).join("");
    }
  }

  /* ---------- กล่องบิลรับเข้า ---------- */

  function openReceipt(refId) {
    A.api("/stock/receipt?refId=" + encodeURIComponent(refId)).then(function (d) {
      st.rc = d;
      $("sRcRef").textContent = d.refId;
      $("sRcLines").innerHTML = "<table><thead><tr><th>สินค้า</th><th class=\"r\">จำนวน</th>"
        + '<th class="r">ต้นทุน/หน่วย</th><th class="r">รวม</th></tr></thead><tbody>'
        + d.lines.map(function (l) {
            return "<tr><td><b>" + esc(l.name) + '</b><span class="sub num">' + esc(l.sku) + "</span></td>"
              + '<td class="r num">' + n0(l.qty) + " " + esc(l.unit) + "</td>"
              + '<td class="r"><input type="number" class="num rc-cost" data-sku="' + esc(l.sku)
              + '" min="0" step="0.01" style="max-width:110px;text-align:right" value="'
              + (l.costPerUnit == null ? "" : l.costPerUnit) + '"></td>'
              + '<td class="r num rc-sum" data-sku="' + esc(l.sku) + '">'
              + (l.costPerUnit == null ? "—" : A.baht(l.costPerUnit * l.qty)) + "</td></tr>";
          }).join("") + "</tbody></table>";

      rcSum();
      $("sRcDlg").showModal();
    }).catch(A.handleErr);
  }

  function rcSum() {
    if (!st.rc) return;
    var total = 0;
    st.rc.lines.forEach(function (l) {
      var inp = $("sRcLines").querySelector('.rc-cost[data-sku="' + cssEsc(l.sku) + '"]');
      var c = inp ? Number(inp.value) : NaN;
      var cell = $("sRcLines").querySelector('.rc-sum[data-sku="' + cssEsc(l.sku) + '"]');
      if (isFinite(c) && inp.value !== "") {
        total += c * l.qty;
        if (cell) cell.textContent = A.baht(c * l.qty);
      } else if (cell) cell.textContent = "—";
    });
    $("sRcAmt").textContent = A.baht(total);
  }

  function saveCost() {
    if (!st.rc) return;
    var lines = [];
    st.rc.lines.forEach(function (l) {
      var inp = $("sRcLines").querySelector('.rc-cost[data-sku="' + cssEsc(l.sku) + '"]');
      if (inp && inp.value !== "" && isFinite(Number(inp.value))) {
        lines.push({ sku: l.sku, costPerUnit: Number(inp.value) });
      }
    });
    if (!lines.length) { A.toast("ยังไม่ได้ใส่ต้นทุนเลย"); return; }
    A.api("/stock/receipt/cost", "POST", { refId: st.rc.refId, lines: lines }).then(function () {
      A.toast("บันทึกต้นทุนแล้ว ระบบคิดต้นทุนถัวเฉลี่ยใหม่ให้เรียบร้อย");
      return Promise.all([openReceipt(st.rc.refId), loadCost()]);
    }).catch(A.handleErr);
  }

  function doAdjust() {
    var sku = $("sajSku").value.trim().toUpperCase();
    var target = $("sajTarget").value;
    if (!sku) { A.toast("เลือกสินค้าก่อน"); return; }
    if (target === "") { A.toast("ใส่ยอดที่ถูกต้อง"); return; }
    A.setBusy(true, $("sajSave"), "กำลังปรับ…");
    A.api("/stock/adjust", "POST", {
      sku: sku, locationId: $("sajLoc").value,
      targetOnHand: Number(target),
      reason: $("sajReason").value, note: $("sajNote").value.trim()
    }).then(function (r) {
      if (r.row) mergeRows([r.row]);
      A.toast("ปรับยอด " + r.name + " จาก " + n0(r.before) + " เป็น " + n0(r.after));
      $("sajTarget").value = "";
      $("sajNote").value = "";
      renderBrowse();
      return loadCost();
    }).catch(A.handleErr).then(function () {
      A.setBusy(false, $("sajSave"), "ปรับยอด");
    });
  }

  /* ================= คลังหลายที่และย้ายคลัง ================= */

  function sellableLocs() {
    return st.locations.filter(function (l) { return l.type === "sellable"; });
  }

  function locOptions(sel, skip) {
    if (!sel) return;
    sel.innerHTML = st.locations.filter(function (l) { return l.id !== skip; })
      .map(function (l) {
        return '<option value="' + esc(l.id) + '">' + esc(l.name)
          + (l.type === "sellable" ? "" : " (ขายไม่ได้)") + "</option>";
      }).join("");
  }

  function paintTransfer() {
    var card = $("sTfCard");
    if (!card) return;
    // มีคลังเดียวก็ไม่มีอะไรให้ย้าย ซ่อนไว้จะได้ไม่รบกวนคนแพ็คของ
    card.hidden = st.locations.length < 2;
    if (card.hidden) return;
    locOptions($("stfFrom"));
    locOptions($("stfTo"));
    if ($("stfTo").options.length > 1) $("stfTo").selectedIndex = 1;
  }

  function doTransfer() {
    var sku = $("stfSku").value.trim().toUpperCase();
    var bc = st.byBarcode[$("stfSku").value.trim()];
    if (bc) sku = bc.sku;
    if (!st.bySku[sku]) { A.toast("เลือกสินค้าก่อน"); return; }
    var from = $("stfFrom").value, to = $("stfTo").value;
    if (from === to) { A.toast("คลังต้นทางกับปลายทางเป็นที่เดียวกัน"); return; }
    var qty = Math.max(1, Math.trunc(Number($("stfQty").value) || 1));

    A.setBusy(true, $("stfGo"), "กำลังย้าย…");
    A.api("/stock/transfer", "POST", {
      scanId: uuid(), sku: sku, fromLocationId: from, toLocationId: to, qty: qty
    }).then(function (r) {
      if (r.row) { mergeRows([r.row]); st.version = r.version || st.version; st.lastSync = Date.now(); }
      beep(r.negativeAtSource || r.reservedAtRisk ? "bad" : "ok");
      A.toast("ย้าย " + r.name + " " + n0(r.qty) + " " + (r.unit || "ชิ้น")
        + " จาก " + r.from + " ไป " + r.to
        + (r.availableChanged ? " · พร้อมขายเปลี่ยนด้วย" : ""));
      var warn = [];
      if (r.negativeAtSource) warn.push("คลังต้นทางติดลบแล้ว ต้องไปนับ");
      if (r.reservedAtRisk) warn.push("มีคนจองของที่ไม่อยู่ในกองต้นทางแล้ว");
      $("stfNow").innerHTML = warn.length
        ? '<b style="color:var(--opex)">' + warn.map(esc).join(" · ") + "</b>"
        : "ย้ายเรียบร้อย";
      renderBrowse();
      return loadWhere(sku);
    }).catch(A.handleErr).then(function () {
      A.setBusy(false, $("stfGo"), "ย้ายคลัง");
    });
  }

  function loadWhere(sku) {
    if (sellableLocs().length < 2) { st.where = null; return Promise.resolve(); }
    return A.api("/stock/where?sku=" + encodeURIComponent(sku)).then(function (d) {
      st.where = d;
      var box = document.getElementById("sWhere");
      if (box && st.selected === sku) box.innerHTML = whereTable();
    }).catch(function () { /* ตารางเสริม ล้มแล้วไม่ควรทำให้ตัวเลขหลักหาย */ });
  }

  function whereTable() {
    if (!st.where || !st.where.rows) return "";
    return "<table><thead><tr><th>คลัง</th><th class=\"r\">ของในคลัง</th>"
      + '<th class="r">จองไว้</th><th>นับเป็นพร้อมขาย</th></tr></thead><tbody>'
      + st.where.rows.map(function (r) {
          return "<tr><td>" + esc(r.name) + "</td>"
            + '<td class="r num">' + n0(r.onHand) + "</td>"
            + '<td class="r num">' + n0(r.reserved) + "</td>"
            + "<td>" + (r.type === "sellable"
                ? '<span class="pill p-income"><i class="dot"></i>ใช่</span>'
                : '<span class="pill p-opex"><i class="dot"></i>ไม่</span>') + "</td></tr>";
        }).join("") + "</tbody></table>";
  }

  function loadLocations() {
    if (!canScan()) return Promise.resolve();
    return A.api("/stock/locations").then(function (d) {
      var locs = d.locations || [];
      $("sLocNote").textContent = locs.length + " คลัง · การจองเก็บยอดไว้ที่ " + (d.reserveLocation || "-");
      var t = $("sLocTable");
      if (!t) return;
      t.innerHTML = "<table><thead><tr><th>คลัง</th><th>ประเภท</th>"
        + '<th class="r">ของในคลัง</th><th class="r">สินค้า</th><th></th></tr></thead><tbody>'
        + locs.map(function (l) {
            return "<tr><td><b>" + esc(l.name) + '</b><span class="sub num">' + esc(l.id)
              + (l.active ? "" : " · ปิดใช้งาน") + "</span></td>"
              + "<td>" + (l.type === "sellable"
                  ? '<span class="pill p-income"><i class="dot"></i>ขายได้</span>'
                  : '<span class="pill p-opex"><i class="dot"></i>ขายไม่ได้</span>') + "</td>"
              + '<td class="r num">' + n0(l.onHand) + "</td>"
              + '<td class="r num">' + n0(l.skus) + "</td>"
              + '<td class="r">' + (canManage()
                  ? '<button type="button" class="btn btn-ghost" data-loc="' + esc(l.id) + '">แก้</button>'
                  : "") + "</td></tr>";
          }).join("") + "</tbody></table>";
    }).catch(function () { /* ไม่ใช่ข้อมูลหลัก */ });
  }

  function saveLocation(confirmType) {
    var body = {
      id: $("slcId").value.trim().toLowerCase(),
      name: $("slcName").value.trim(),
      type: (document.querySelector('input[name="slcType"]:checked') || {}).value || "sellable",
      confirmType: !!confirmType
    };
    if (!body.id || !body.name) { A.toast("ต้องใส่รหัสและชื่อคลัง"); return; }
    A.api("/stock/locations", "POST", body).then(function (r) {
      A.toast(r.created ? "เพิ่มคลังแล้ว" : "แก้ไขคลังแล้ว");
      $("slcId").value = "";
      $("slcName").value = "";
      $("slcNote").textContent = "";
      return Promise.all([fetchSnapshot(), loadLocations()]);
    }).catch(function (err) {
      if (err && err.code === "CONFIRM_TYPE") {
        $("slcNote").innerHTML = '<b style="color:var(--cost)">' + esc(err.message) + "</b>";
        if (window.confirm(err.message + "\n\nยืนยันเปลี่ยนประเภทคลัง?")) saveLocation(true);
        return;
      }
      $("slcNote").innerHTML = '<b style="color:var(--opex)">' + esc(err.message) + "</b>";
    });
  }

  /* ================= พิมพ์ฉลากบาร์โค้ด ================= */

  function loadLabel() {
    var need = st.master ? Promise.resolve() : loadMaster();
    return need.then(function () {
      var sel = $("slLayout");
      if (sel && !sel.options.length) {
        sel.innerHTML = window.LedgerLabel.layouts.map(function (l) {
          return '<option value="' + esc(l.id) + '">' + esc(l.name) + "</option>";
        }).join("");
      }
      renderLabelTable();
    });
  }

  function bcOf(sku) {
    var hit = st.masterBarcodes.filter(function (b) { return b.sku === sku; });
    // ถ้าผูกไว้หลายอัน ใช้อันที่ยิงได้หนึ่งชิ้น (packQty 1) ก่อน ไม่งั้นฉลากจะกลายเป็นฉลากลัง
    var one = hit.filter(function (b) { return Number(b.packQty) === 1; })[0];
    return (one || hit[0] || null);
  }

  function labelItems() {
    var useSku = (document.querySelector('input[name="slSrc"]:checked') || {}).value === "sku";
    var copies = Math.max(1, Math.min(Number($("slCopies").value) || 1, 500));
    return (st.master || []).filter(function (m) { return st.labelPick[m.sku]; }).map(function (m) {
      var b = bcOf(m.sku);
      return {
        code: useSku || !b ? m.sku : b.barcode,
        name: m.name,
        sub: (useSku || !b) ? "" : m.sku,
        copies: copies
      };
    });
  }

  function renderLabelTable() {
    if (!st.master) return;
    var picked = Object.keys(st.labelPick).filter(function (k) { return st.labelPick[k]; });
    $("slPick").textContent = picked.length
      ? "เลือกไว้ " + picked.length + " ตัว"
      : st.master.length + " ตัว";

    $("slTable").innerHTML = "<table><thead><tr><th></th><th>สินค้า</th><th>บาร์โค้ดที่จะพิมพ์</th>"
      + '<th class="r">คงเหลือ</th></tr></thead><tbody>'
      + st.master.map(function (m) {
          var b = bcOf(m.sku);
          var live = st.bySku[m.sku];
          return "<tr>"
            + '<td><input type="checkbox" data-pick="' + esc(m.sku) + '"'
            + (st.labelPick[m.sku] ? " checked" : "") + "></td>"
            + "<td><b>" + esc(m.name) + '</b><span class="sub num">' + esc(m.sku) + "</span></td>"
            + '<td class="num">' + (b ? esc(b.barcode)
                + (Number(b.packQty) !== 1 ? '<span class="sub">ผูกไว้เป็นลัง ' + b.packQty + " ชิ้น</span>" : "")
                : '<span style="color:var(--cost)">ยังไม่มี — จะพิมพ์รหัส SKU</span>') + "</td>"
            + '<td class="r num">' + (live ? n0(live.onHand) : "0") + "</td>"
            + "</tr>";
        }).join("") + "</tbody></table>";

    renderSheet();
  }

  function renderSheet() {
    var items = labelItems();
    var total = items.reduce(function (a, x) { return a + x.copies; }, 0);
    var chk = window.LedgerLabel.check(items, $("slLayout").value);
    $("slNote").innerHTML = total
      ? "จะพิมพ์ " + n0(total) + " ดวง"
        + (chk.thin.length
          ? ' · <b style="color:var(--opex)">' + chk.thin.length
            + " รหัสแท่งบางกว่า " + chk.minMm + " มม. อาจยิงไม่ติด</b>"
          : ' · <b style="color:var(--income)">ความกว้างแท่งผ่านเกณฑ์</b>')
      : "เลือกสินค้าที่จะพิมพ์ก่อน";
    $("slSheet").innerHTML = window.LedgerLabel.sheet(items, $("slLayout").value);
  }

  /* ================= สลับหน้าจอย่อย ================= */

  function panes() {
    return PANES.filter(function (x) {
      if (x.needManager) return canManage();
      if (x.needScan) return canScan();
      return true;
    });
  }

  function renderPaneSel() {
    var list = panes();
    $("sSel").innerHTML = list.map(function (x) {
      return '<button type="button" data-pane="' + x.id + '" aria-pressed="'
        + (x.id === st.pane) + '">' + x.name + "</button>";
    }).join("");
  }

  function setPane(id) {
    if (!panes().some(function (x) { return x.id === id; })) id = "browse";
    // ย้ายแท็บแล้วกล้องต้องดับ ไม่ใช่ค้างถ่ายอยู่เบื้องหลังกินแบตทิ้ง
    if (window.StockCam && window.StockCam.isOpen()) window.StockCam.close();
    st.pane = id;
    $("sBrowse").hidden = id !== "browse";
    $("sScan").hidden = id !== "scan";
    $("sCount").hidden = id !== "count";
    $("sWall").hidden = id !== "wall";
    $("sCost").hidden = id !== "cost";
    $("sProducts").hidden = id !== "products";
    $("sLabel").hidden = id !== "label";
    document.body.classList.toggle("printing-labels", id === "label");
    renderPaneSel();

    clearInterval(st.boardTimer);
    st.boardTimer = null;

    paintCam();
    if (id === "browse") { renderBrowse(); loadAlerts(true); loadMine(); }
    if (id === "scan") { setMode(st.mode || lastMode()); loadPending(); paintTransfer(); }
    if (id === "wall") {
      loadBoard();
      // จอผนังไม่มีใครกด ตัวเลขยอดรวมของวันจึงต้องดึงเองเป็นระยะ
      // (ยอดคงเหลือมาทาง WebSocket อยู่แล้ว ที่ดึงคือยอดรวมของวันกับค่าเฉลี่ย)
      st.boardTimer = setInterval(function () { if (isActive() && st.pane === "wall") loadBoard(); }, 60000);
    }
    if (id === "count") loadCounts();
    if (id === "cost") loadCost();
    if (id === "products" && !st.master) loadMaster();
    if (id === "products") { renderMaster(); loadLocations(); }
    if (id === "label") loadLabel();
  }

  /* ================= เริ่มทำงาน ================= */

  function load() {
    var me = A && A.me && A.me();
    if (me && me.stockRole) st.role = me.stockRole;
    if (!st.loaded) {
      st.loaded = true;
      renderPaneSel();
      setPane(canScan() && !canManage() ? "scan" : "browse");
    }
    connect();
    refreshQueue();
    if (!st.tickTimer) st.tickTimer = setInterval(paintConn, 1000);
    return fetchSnapshot().then(function () {
      if (st.pane === "browse") { loadAlerts(true); loadMine(); }
      if (st.pane === "wall") loadBoard();
    });
  }

  document.addEventListener("app:ready", function (ev) {
    A = window.StockApp;
    st.role = (ev.detail.me && ev.detail.me.stockRole) || "readonly";
    // ถ้าเจ้าของเปลี่ยนสิทธิ์ให้ใคร หน้าจอต้องกรองแท็บใหม่ทันที
    // ไม่ใช่ค้างอยู่หน้าที่เขาไม่มีสิทธิ์แล้วจนกว่าจะรีเฟรช
    if (st.loaded) { setPane(st.pane); paintCostField(); }
    // ระบบนี้มีหน้าจอเดียว เข้าระบบได้แล้วก็เริ่มทำงานเลย
    // ไม่มีแท็บอื่นให้รอใครกดเหมือนตอนที่สต็อกยังอยู่ในแอปบัญชี
    load();
  });

  $("sSel").addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-pane]");
    if (b) setPane(b.getAttribute("data-pane"));
  });

  /* ---------- ดูสต็อก ---------- */
  $("sQ").addEventListener("input", function () { st.q = this.value; renderBrowse(); });
  $("sQ").addEventListener("keydown", function (ev) {
    // ยิงบาร์โค้ดในช่องค้นหา = เปิดตัวนั้นทันที ฝ่ายขายจึงยิงของในมือลูกค้าดูได้
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    var code = this.value.trim();
    var bc = st.byBarcode[code];
    if (bc && st.bySku[bc.sku]) {
      st.selected = bc.sku;
      st.q = "";
      this.value = "";
      renderBrowse();
    }
  });

  $("sList").addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-sku]");
    if (!b) return;
    st.selected = b.getAttribute("data-sku");
    renderBrowse();
  });

  /* ---------- จอง ---------- */
  $("sDetail").addEventListener("click", function (ev) {
    if (ev.target.closest("#srBtn")) doReserve();
  });
  $("sDetail").addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && ev.target.closest("#srRef, #srQty")) { ev.preventDefault(); doReserve(); }
  });

  $("sMine").addEventListener("click", function (ev) {
    var ext = ev.target.closest("button[data-ext]");
    if (ext) { extendRes(ext.getAttribute("data-ext")); return; }
    var rel = ev.target.closest("button[data-rel]");
    if (rel) releaseRes(rel.getAttribute("data-rel"));
  });

  /* ---------- เหตุผลการคืน ---------- */
  $("sReasons").addEventListener("change", function (ev) {
    var r = ev.target.closest('input[name="sReason"]');
    if (!r) return;
    st.reason = r.value;
    renderReasons();
    focusCode();
  });

  /* ---------- ค่าตั้งอายุการจอง ---------- */
  $("sResSave").addEventListener("click", function () {
    var h = Math.max(1, Math.trunc(Number($("sResHours").value) || 24));
    A.api("/stock/config", "POST", {
      reserveHours: h, skuPrefix: $("sResPrefix").value.trim()
    }).then(function (r) {
      st.reserveHours = r.reserveHours;
      takeCodes(r);
      $("sToolNote").textContent = "การจองหมดอายุใน " + r.reserveHours + " ชั่วโมง"
        + " · รหัสถัดไป " + (r.nextSku || "—");
      A.toast("บันทึกค่าตั้งแล้ว");
    }).catch(A.handleErr);
  });

  $("sSweep").addEventListener("click", function () {
    A.api("/stock/reserve/sweep", "POST", {}).then(function (r) {
      $("sToolNote").textContent = r.expired.length
        ? "ปล่อยของคืนจาก " + r.expired.length + " การจองที่หมดอายุ"
        : "ไม่มีการจองที่หมดอายุค้างอยู่";
      return fetchSnapshot();
    }).catch(A.handleErr);
  });

  /* ---------- ยิงสต็อก ---------- */
  $("sModeBar").addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-mode]");
    if (b) setMode(b.getAttribute("data-mode"));
  });

  // การ์ดเลือกโหมดครั้งแรก ปุ่มใหญ่ ๆ ที่มีคำอธิบายกำกับ
  $("sPickMode").addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-mode]");
    if (b) setMode(b.getAttribute("data-mode"));
  });

  $("sCamBtn").addEventListener("click", function () {
    camOpen(function (code) { submitScan(code, { quietOk: true }); }, "sRecent");
  });

  $("sQCam").addEventListener("click", function () {
    // ฝ่ายขายส่องของในมือลูกค้า — เปิดตัวนั้นให้ดูเลย ไม่ใช่แค่เติมช่องค้นหา
    camOpen(function (code) {
      var bc = st.byBarcode[code];
      if (bc && st.bySku[bc.sku]) {
        st.selected = bc.sku;
        st.q = "";
        $("sQ").value = "";
        renderBrowse();
      } else {
        // ไม่รู้จักก็ยังบอกรหัสไว้ในช่อง ให้หัวหน้าเอาไปผูกต่อได้
        st.q = code;
        $("sQ").value = code;
        renderBrowse();
        beep("unknown");
      }
    }, "sDetail");
  });

  $("sCountBody").addEventListener("click", function (ev) {
    if (ev.target.closest("#scCamBtn")) {
      camOpen(function (code) { countScan(code, { quietOk: true }); }, "sCountBody");
    }
  });

  $("sCode").addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    var v = this.value;
    this.value = "";
    submitScan(v);
  });

  // เครื่องยิงบาร์โค้ดทำตัวเป็นคีย์บอร์ด ถ้าโฟกัสหลุดไปที่อื่นจะยิงไม่เข้า
  $("sScan").addEventListener("click", function (ev) {
    if (ev.target.closest("input, select, button, a, details, summary")) return;
    focusCode();
  });

  $("sPend").addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-bc]");
    if (!b) return;
    openBarcodeDialog(b.getAttribute("data-bc"), 1);
  });

  /* ---------- กล่องบาร์โค้ดใหม่ ---------- */
  $("sBcSku").addEventListener("input", bcHits);
  $("sBcHits").addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-sku]");
    if (!b) return;
    $("sBcSku").value = b.getAttribute("data-sku");
    $("sBcHits").innerHTML = "";
  });
  $("sBcSave").addEventListener("click", bindBarcode);
  $("sBcSkip").addEventListener("click", skipBarcode);
  $("sBcClose").addEventListener("click", function () { $("sBcDlg").close(); focusCode(); });

  /* ---------- ทะเบียนสินค้า ---------- */
  $("sfSave").addEventListener("click", saveProduct);
  $("sfCancel").addEventListener("click", function () { fillProductForm(null); });
  $("sbSave").addEventListener("click", saveBarcode);
  /**
     คัดลอกเลขบาร์โค้ด — ไว้เอาไปพิมพ์ในช่องยิงตอนยังไม่มีฉลากติดของ
     clipboard API ใช้ได้เฉพาะ https และต้องมีการแตะจอ ซึ่งการกดปุ่มนี้เข้าเงื่อนไขทั้งคู่
     แต่ยังพลาดได้ (เบราว์เซอร์เก่า สิทธิ์ถูกปิด) จึงมีทางถอยเป็นเลือกข้อความให้
   */
  function copyCode(text, btn) {
    var done = function () { A.toast("คัดลอก " + text + " แล้ว"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { selectText(btn, text); });
    } else {
      selectText(btn, text);
    }
  }

  function selectText(btn, text) {
    try {
      var r = document.createRange();
      r.selectNodeContents(btn);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      A.toast("คัดลอกเองไม่ได้ — เลือกข้อความไว้ให้แล้ว กดคัดลอกอีกที");
    } catch (e) {
      A.toast("เลขบาร์โค้ดคือ " + text);
    }
  }

  $("sPTable").addEventListener("click", function (ev) {
    var c = ev.target.closest("button[data-copy]");
    if (c) { copyCode(c.getAttribute("data-copy"), c); return; }
    var b = ev.target.closest("button[data-edit]");
    if (!b) return;
    var sku = b.getAttribute("data-edit");
    fillProductForm((st.master || []).filter(function (m) { return m.sku === sku; })[0] || null);
  });
  $("sImportFile").addEventListener("change", function () {
    if (this.files && this.files[0]) importCsv(this.files[0]);
    this.value = "";
  });

  $("sRebuild").addEventListener("click", function () {
    if (!window.confirm("สร้างยอดใหม่จากประวัติการเคลื่อนไหวทั้งหมด? ตัวเลขที่ใช้อยู่จะถูกคิดใหม่")) return;
    A.api("/stock/rebuild", "POST", {}).then(function (r) {
      $("sToolNote").textContent = "คิดใหม่จาก " + n0(r.fromMovements) + " รายการแล้ว";
      return fetchSnapshot();
    }).catch(A.handleErr);
  });

  $("sArchive").addEventListener("click", function () {
    $("sToolNote").textContent = "กำลังเก็บ…";
    A.api("/stock/archive", "POST", {}).then(function (r) {
      $("sToolNote").textContent = "เก็บลงรีโปแล้ว " + r.date + " · การเคลื่อนไหว "
        + n0(r.movements) + " · ยอดคงเหลือ " + n0(r.balance) + " แถว";
    }).catch(function (err) {
      $("sToolNote").textContent = (err && err.message) || "เก็บไม่สำเร็จ";
    });
  });


  /* ---------- นับสต็อก ---------- */
  $("sCountBody").addEventListener("click", function (ev) {
    if (ev.target.closest("#scoOpen")) {
      A.api("/stock/count/open", "POST", { locationId: $("scoLoc").value }).then(function (r) {
        A.toast("เปิดรอบนับ " + r.id + " แล้ว แช่ยอดคาดหมาย " + r.lines + " รายการ");
        return loadCount(r.id);
      }).catch(A.handleErr);
      return;
    }
    if (ev.target.closest("#scClose")) {
      if (!st.count) return;
      var t = st.count.totals;
      if (!window.confirm("ปิดรอบนับ?\n\nจะลงรายการปรับยอด " + (t.short + t.over) + " รายการ\n"
          + "และไม่แตะตัวเลขของ " + t.uncounted + " รายการที่ยังไม่ได้ยิงนับ")) return;
      A.api("/stock/count/close", "POST", { countId: st.count.count.id }).then(function (r) {
        A.toast("ปิดรอบแล้ว ปรับยอด " + r.posted + " รายการ · ไม่แตะ " + r.untouched + " รายการที่ยังไม่นับ");
        return Promise.all([fetchSnapshot(), loadCounts()]);
      }).catch(A.handleErr);
      return;
    }
    if (ev.target.closest("#scCancel")) {
      if (!st.count) return;
      if (!window.confirm("ยกเลิกรอบนับ? ผลที่ยิงนับไว้ยังอยู่ในประวัติ แต่จะไม่ถูกเอาไปปรับยอด")) return;
      A.api("/stock/count/cancel", "POST", { countId: st.count.count.id })
        .then(loadCounts).catch(A.handleErr);
      return;
    }
    var f = ev.target.closest("[data-f]");
    if (f) { st.countFilter = f.getAttribute("data-f"); renderCount(); }
  });

  $("sCountBody").addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter" || !ev.target.closest("#scBar")) return;
    ev.preventDefault();
    var v = ev.target.value;
    ev.target.value = "";
    countScan(v);
  });

  /* ---------- ต้นทุนและมูลค่า ---------- */
  $("sRcTable").addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-rc]");
    if (b) openReceipt(b.getAttribute("data-rc"));
  });
  $("sRcLines").addEventListener("input", rcSum);
  $("sRcSaveCost").addEventListener("click", saveCost);
  $("sRcClose").addEventListener("click", function () { $("sRcDlg").close(); });

  $("sajSku").addEventListener("input", function () {
    var q = this.value.trim().toLowerCase();
    var box = $("sajHits");
    if (!q) { box.innerHTML = ""; $("sajNow").textContent = ""; return; }
    box.innerHTML = st.products.filter(function (p) {
      return p.sku.toLowerCase().indexOf(q) >= 0 || (p.name || "").toLowerCase().indexOf(q) >= 0;
    }).slice(0, 6).map(function (p) {
      return '<button type="button" data-sku="' + esc(p.sku) + '">' + esc(p.name)
        + ' <em class="num">' + esc(p.sku) + "</em></button>";
    }).join("");
    showCurrent();
  });
  $("sajHits").addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-sku]");
    if (!b) return;
    $("sajSku").value = b.getAttribute("data-sku");
    $("sajHits").innerHTML = "";
    showCurrent();
  });
  $("sajSave").addEventListener("click", doAdjust);

  function showCurrent() {
    var p = st.bySku[$("sajSku").value.trim().toUpperCase()];
    $("sajNow").textContent = p
      ? "ยอดในระบบตอนนี้ " + n0(p.onHand) + " " + (p.unit || "ชิ้น")
        + (p.blocked ? " (ของเสียหายอีก " + n0(p.blocked) + ")" : "")
      : "";
  }


  /* ---------- ย้ายคลังและจัดการคลัง ---------- */
  $("stfSku").addEventListener("input", function () {
    var q = this.value.trim().toLowerCase();
    var box = $("stfHits");
    if (!q) { box.innerHTML = ""; $("stfNow").textContent = ""; return; }
    box.innerHTML = st.products.filter(function (p) {
      return p.sku.toLowerCase().indexOf(q) >= 0 || (p.name || "").toLowerCase().indexOf(q) >= 0;
    }).slice(0, 6).map(function (p) {
      return '<button type="button" data-sku="' + esc(p.sku) + '">' + esc(p.name)
        + ' <em class="num">' + esc(p.sku) + "</em></button>";
    }).join("");
  });
  $("stfSku").addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    var bc = st.byBarcode[this.value.trim()];
    if (bc) { this.value = bc.sku; $("stfHits").innerHTML = ""; }
  });
  $("stfHits").addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-sku]");
    if (!b) return;
    $("stfSku").value = b.getAttribute("data-sku");
    $("stfHits").innerHTML = "";
  });
  $("stfGo").addEventListener("click", doTransfer);

  $("slcSave").addEventListener("click", function () { saveLocation(false); });
  $("sLocTable").addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-loc]");
    if (!b) return;
    var id = b.getAttribute("data-loc");
    var l = st.locations.filter(function (x) { return x.id === id; })[0];
    $("slcId").value = id;
    $("slcName").value = l ? l.name : "";
    var r = document.querySelector('input[name="slcType"][value="' + (l && l.type === "blocked" ? "blocked" : "sellable") + '"]');
    if (r) r.checked = true;
  });

  /* ---------- พิมพ์ฉลาก ---------- */
  $("slTable").addEventListener("change", function (ev) {
    var c = ev.target.closest("input[data-pick]");
    if (!c) return;
    st.labelPick[c.getAttribute("data-pick")] = c.checked;
    renderLabelTable();
  });
  $("slLayout").addEventListener("change", renderSheet);
  $("slCopies").addEventListener("input", renderSheet);
  document.getElementsByName("slSrc").forEach
    ? Array.prototype.forEach.call(document.getElementsByName("slSrc"), function (r) {
        r.addEventListener("change", renderLabelTable);
      })
    : null;
  $("slAll").addEventListener("click", function () {
    (st.master || []).forEach(function (m) { st.labelPick[m.sku] = true; });
    renderLabelTable();
  });
  $("slNone").addEventListener("click", function () {
    st.labelPick = {};
    renderLabelTable();
  });
  $("slNoBc").addEventListener("click", function () {
    st.labelPick = {};
    (st.master || []).forEach(function (m) { if (!bcOf(m.sku)) st.labelPick[m.sku] = true; });
    renderLabelTable();
  });
  $("slPrint").addEventListener("click", function () {
    if (!labelItems().length) { A.toast("เลือกสินค้าที่จะพิมพ์ก่อน"); return; }
    window.print();
  });

  /* ---------- ออฟไลน์ ---------- */
  window.addEventListener("online", function () {
    st.retry = 0;
    connect();
    flushQueue();
  });
  window.addEventListener("offline", function () {
    setConn("off");
    paintOfflineWarn();
  });

  // กลับมาที่แท็บแล้วสายอาจหลุดไปแล้ว ต่อใหม่ทันทีไม่ต้องรอ backoff
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && isActive()) { st.retry = 0; connect(); fetchSnapshot(); }
  });

})();
