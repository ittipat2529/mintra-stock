/**
 * ยิงบาร์โค้ดด้วยกล้องมือถือ
 *
 * ใช้ BarcodeDetector ที่ติดมากับเบราว์เซอร์ ไม่โหลดไลบรารีจากที่ไหน
 * เพราะระบบนี้ต้องใช้งานได้ตอนเน็ตหลุด และของที่โหลดจาก CDN
 * คือของที่อ่านไม่ได้ว่ามันทำอะไร — ทั้งสองอย่างรับไม่ได้ในงานคลัง
 *
 * กฎที่สำคัญที่สุดของไฟล์นี้ — **กล้องเห็นบาร์โค้ดใบเดิมหลายสิบครั้งต่อวินาที**
 * ถ้าปล่อยให้ยิงทุกเฟรม ของหนึ่งชิ้นจะถูกตัดสต็อกหลายสิบครั้ง
 * และ scanId กันไม่ได้ เพราะแต่ละเฟรมได้ scanId ใหม่ของตัวเอง
 * จึงต้องกันซ้ำที่นี่ ไม่ใช่ไปหวังให้เซิร์ฟเวอร์กัน
 *
 * **อ่านติดครั้งเดียวแล้วปิดกล้องทันที** หนึ่งครั้งกดปุ่ม = หนึ่งการยิง ไม่มีทางเป็นสอง
 * จะยิงชิ้นถัดไปก็กดปุ่มใหม่ — เหมือนเครื่องยิง USB ที่กดไกหนึ่งครั้งได้หนึ่งครั้ง
 *
 * ที่ไม่เปิดกล้องค้างไว้ให้ยิงรัว เพราะเวลาที่คนถือกล้องค้างไม่ใช่จำนวนของ
 * คนเล็งไม่ตรงอยู่สี่วินาทีจะกลายเป็นตัดสต็อกสองสามชิ้นโดยไม่รู้ตัว
 * และเมื่อกล้องปิดเอง คนก็ได้เห็นผลที่เพิ่งยิงทันทีว่าเข้าตัวไหนไปเท่าไร
 *
 * ยังเก็บกฎ "รหัสเดิมที่ค้างในภาพไม่นับซ้ำ" ไว้เป็นชั้นกันพลาด
 * เผื่อกรณีที่เฟรมค้างท่ออยู่ตอนสั่งปิด
 */
window.StockCam = (function () {
  "use strict";

  // อ่านทุก 140 มิลลิวินาที ไม่ต้องทุกเฟรม — เร็วพอสำหรับคนเดินยิง และไม่กินแบตทิ้ง
  var READ_EVERY_MS = 140;

  /* บาร์โค้ดหายจากภาพนานเท่านี้ = ถือว่าออกจากเฟรมแล้ว ส่องกลับมาอีกครั้งนับเป็นการยิงใหม่
     ต้องนานกว่าจังหวะอ่านหลายเท่า เพราะภาพเบลอหรือมือสั่นทำให้อ่านไม่ติดหนึ่งสองเฟรมเป็นเรื่องปกติ
     ถ้าตั้งสั้นเกินไป มือสั่นจะกลายเป็นการยิงซ้ำ */
  var GONE_MS = 700;

  // เว้นจังหวะสั้น ๆ ระหว่างของสองชิ้น กันภาพที่มีบาร์โค้ดสองใบติดกันสลับกันเข้ามา
  var ANY_CODE_COOLDOWN_MS = 350;

  /* รูปแบบที่ใช้จริงในคลัง — 1D ทั้งหมดบวก QR เผื่อของที่ติด QR มา
     จำกัดไว้เพื่อลดการอ่านมั่ว ไม่ใช่เปิดทุกรูปแบบแล้วหวังว่าจะถูก */
  var WANT = [
    "ean_13", "ean_8", "upc_a", "upc_e",
    "code_128", "code_39", "code_93", "itf", "codabar", "qr_code"
  ];

  var st = {
    open: false, stream: null, track: null, detector: null,
    timer: null, onCode: null, torch: false,
    lastCode: "", seenAt: 0, anyAt: 0, hits: 0
  };

  function $(id) { return document.getElementById(id); }

  /**
     รองรับไหม — ต้องครบสามอย่าง ไม่ใช่แค่มี BarcodeDetector
     https ด้วย เพราะกล้องขอไม่ได้บนหน้าที่ไม่ปลอดภัย
   */
  function supported() {
    return !!(window.BarcodeDetector
      && navigator.mediaDevices
      && navigator.mediaDevices.getUserMedia
      && window.isSecureContext);
  }

  /** บอกตรง ๆ ว่าทำไมใช้ไม่ได้ ดีกว่าปุ่มที่กดแล้วเงียบ */
  function why() {
    if (!window.isSecureContext) return "กล้องใช้ได้เฉพาะหน้าเว็บแบบ https";
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return "เบราว์เซอร์นี้เปิดกล้องไม่ได้";
    if (!window.BarcodeDetector) {
      return "เบราว์เซอร์นี้อ่านบาร์โค้ดจากกล้องไม่ได้ — ใช้ Chrome บน Android ได้ "
        + "ส่วน iPhone ยังไม่รองรับ ให้ยิงด้วยเครื่องยิงหรือพิมพ์รหัสแทน";
    }
    return "";
  }

  function setMsg(text, tone) {
    var el = $("camMsg");
    if (!el) return;
    el.textContent = text || "";
    el.setAttribute("data-tone", tone || "");
  }

  function setHit(text) {
    var el = $("camHit");
    if (el) el.textContent = text || "";
  }

  /** เสียงยืนยันดัง ๆ ตอนอ่านติด — ดังที่นี่ ไม่ใช่รอผลจากเซิร์ฟเวอร์
      คนยิงต้องรู้ทันทีว่ากล้องอ่านได้แล้ว ไม่ใช่รอเน็ตก่อนจะได้ยินอะไร */
  function hitSound() {
    if (window.StockSound && window.StockSound.beep) window.StockSound.beep("ok");
  }

  async function buildDetector() {
    var ok = WANT;
    try {
      var avail = await window.BarcodeDetector.getSupportedFormats();
      var keep = WANT.filter(function (f) { return avail.indexOf(f) >= 0; });
      if (keep.length) ok = keep;
    } catch (e) { /* อ่านรายการไม่ได้ก็ลองใช้ชุดที่ขอไปทั้งชุด */ }
    return new window.BarcodeDetector({ formats: ok });
  }

  async function open(onCode) {
    if (st.open) return;
    if (!supported()) { setMsg(why(), "err"); return { ok: false, reason: why() }; }

    st.onCode = onCode;
    st.hits = 0;
    st.lastCode = "";
    st.seenAt = 0;
    st.anyAt = 0;

    $("camWrap").hidden = false;
    document.body.classList.add("cam-on");
    setHit("");
    setMsg("กำลังเปิดกล้อง…");

    try {
      st.detector = await buildDetector();
      st.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          // กล้องหลังเสมอ กล้องหน้าโฟกัสใกล้ไม่ได้และภาพกลับข้าง
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });
    } catch (err) {
      close();
      var msg = (err && err.name === "NotAllowedError")
        ? "ไม่ได้รับอนุญาตให้ใช้กล้อง — กดอนุญาตในหน้าตั้งค่าเบราว์เซอร์แล้วลองใหม่"
        : "เปิดกล้องไม่สำเร็จ" + (err && err.name ? " (" + err.name + ")" : "");
      A_toast(msg);
      return { ok: false, reason: msg };
    }

    var v = $("camVideo");
    v.srcObject = st.stream;
    v.setAttribute("playsinline", "");
    v.muted = true;
    try { await v.play(); } catch (e) { /* บางเบราว์เซอร์เล่นเองอยู่แล้ว */ }

    st.track = st.stream.getVideoTracks()[0] || null;
    st.open = true;

    // ไฟฉายมีเฉพาะบางเครื่อง ซ่อนปุ่มถ้าเครื่องนี้ไม่มี ไม่ใช่โชว์ปุ่มที่กดแล้วไม่เกิดอะไร
    var hasTorch = false;
    try {
      var caps = st.track && st.track.getCapabilities ? st.track.getCapabilities() : {};
      hasTorch = !!caps.torch;
    } catch (e) { hasTorch = false; }
    $("camTorch").hidden = !hasTorch;
    st.torch = false;
    $("camTorch").setAttribute("aria-pressed", "false");

    setMsg("เอากล้องส่องบาร์โค้ดให้อยู่ในกรอบ · อ่านติดแล้วกล้องจะปิดเอง");
    loop();
    return { ok: true };
  }

  function loop() {
    clearTimeout(st.timer);
    if (!st.open) return;
    st.timer = setTimeout(function () { read().then(loop, loop); }, READ_EVERY_MS);
  }

  async function read() {
    if (!st.open || !st.detector) return;
    var v = $("camVideo");
    if (!v || v.readyState < 2) return;

    var found;
    try { found = await st.detector.detect(v); }
    catch (e) { found = null; }        // เฟรมเสียหนึ่งเฟรมไม่ใช่เรื่องต้องแจ้งใคร

    var now = Date.now();
    var code = (found && found.length) ? String(found[0].rawValue || "").trim() : "";

    /* ปล่อยรหัสเดิมทิ้งเมื่อมันหายจากภาพนานพอ — ต้องเช็คทุกรอบรวมถึงรอบที่อ่านไม่เจออะไร
       ไม่งั้นเอากล้องออกแล้วส่องกลับมา ระบบจะยังจำว่าเป็นใบเดิมและไม่ยิงให้ */
    if (st.lastCode && now - st.seenAt > GONE_MS) st.lastCode = "";

    if (!code) return;

    // ใบเดิมที่ยังค้างอยู่ในภาพ — ต่ออายุว่า "ยังเห็นอยู่" แล้วจบ ไม่ยิงเพิ่ม
    if (code === st.lastCode) { st.seenAt = now; return; }

    if (now - st.anyAt < ANY_CODE_COOLDOWN_MS) return;

    // มาถึงตรงนี้แปลว่าอ่านติดแล้ว — ยิงหนึ่งครั้งแล้วปิด
    st.lastCode = code;
    st.seenAt = now;
    st.anyAt = now;
    st.hits++;

    setHit(code);
    setMsg("อ่านได้แล้ว", "ok");
    flash();
    hitSound();

    var cb = st.onCode;

    /* ปิดก่อนเรียกฝั่งที่รอรหัส ไม่ใช่ปิดทีหลัง
       เพราะบางเส้นทางเปิดกล่องผูกบาร์โค้ดซึ่งเป็น modal ที่ทับหน้ากล้องเสมอ
       ถ้ายังไม่ปิด คนจะเจอกล่องลอยอยู่บนภาพกล้องที่ยังถ่ายอยู่ */
    close();

    if (cb) {
      try { cb(code); } catch (e) { /* ให้ฝั่งที่เรียกจัดการเอง */ }
    }
  }

  function flash() {
    var f = $("camFlash");
    if (!f) return;
    f.setAttribute("data-on", "true");
    clearTimeout(f._h);
    f._h = setTimeout(function () { f.setAttribute("data-on", "false"); }, 160);
  }

  async function toggleTorch() {
    if (!st.track) return;
    st.torch = !st.torch;
    try {
      await st.track.applyConstraints({ advanced: [{ torch: st.torch }] });
      $("camTorch").setAttribute("aria-pressed", st.torch ? "true" : "false");
    } catch (e) {
      st.torch = false;
      $("camTorch").hidden = true;
    }
  }

  function close() {
    clearTimeout(st.timer);
    st.timer = null;
    st.open = false;

    // ปล่อยกล้องให้ครบทุกเส้น ไม่งั้นไฟกล้องค้างติดและแบตหมดเร็ว
    if (st.stream) {
      st.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    }
    st.stream = null;
    st.track = null;
    st.detector = null;
    st.onCode = null;

    var v = $("camVideo");
    if (v) v.srcObject = null;
    var w = $("camWrap");
    if (w) w.hidden = true;
    document.body.classList.remove("cam-on");
  }

  function A_toast(msg) {
    if (window.StockApp && window.StockApp.toast) window.StockApp.toast(msg);
  }

  /* ---------- ต่อสาย ---------- */

  document.addEventListener("DOMContentLoaded", function () {
    var c = $("camClose");
    if (c) c.addEventListener("click", close);
    var t = $("camTorch");
    if (t) t.addEventListener("click", toggleTorch);
  });

  // สลับแท็บหรือล็อกจอ = ปล่อยกล้องทิ้ง ไม่ถือไว้เฉย ๆ ให้แบตหมด
  document.addEventListener("visibilitychange", function () {
    if (document.hidden && st.open) close();
  });

  return {
    supported: supported,
    why: why,
    open: open,
    close: close,
    isOpen: function () { return st.open; }
  };
})();
