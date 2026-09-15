/**
 * พิมพ์ฉลากบาร์โค้ด Code 128 ชุด B
 *
 * สินค้าที่ซัพพลายเออร์ไม่ติดบาร์โค้ดมา ต้องติดของเราเองครั้งเดียวจบ
 * ไม่ต้องรอใคร และไม่ต้องพึ่งไลบรารีจาก CDN เพราะระบบนี้ต้องใช้งานได้ตอนออฟไลน์
 *
 * ตารางรหัสด้านล่างไม่ได้เขียนจากความจำ — ถอดมาจากไลบรารี python-barcode
 * แล้วตรวจสองชั้น ชั้นแรกคือโครงสร้าง (ทุก pattern ต้องกว้าง 11 โมดูล มี 6 ช่วง
 * เริ่มด้วยแท่งดำจบด้วยช่องขาว) ชั้นที่สองคือเทียบผลลัพธ์กับไลบรารีนั้นทีละตัวอักษร
 *
 * ชุด B รองรับอักขระ ASCII 32–126 ซึ่งคลุมรหัสสินค้าทุกแบบที่ระบบยอมรับอยู่แล้ว
 * (A-Z 0-9 จุด ขีดล่าง ขีดกลาง) ชื่อสินค้าภาษาไทยพิมพ์เป็นข้อความอ่านได้ ไม่เข้าบาร์โค้ด
 */
(function () {
  "use strict";

  var CODES = ["11011001100","11001101100","11001100110","10010011000","10010001100","10001001100","10011001000","10011000100","10001100100","11001001000","11001000100","11000100100","10110011100","10011011100","10011001110","10111001100","10011101100","10011100110","11001110010","11001011100","11001001110","11011100100","11001110100","11101101110","11101001100","11100101100","11100100110","11101100100","11100110100","11100110010","11011011000","11011000110","11000110110","10100011000","10001011000","10001000110","10110001000","10001101000","10001100010","11010001000","11000101000","11000100010","10110111000","10110001110","10001101110","10111011000","10111000110","10001110110","11101110110","11010001110","11000101110","11011101000","11011100010","11011101110","11101011000","11101000110","11100010110","11101101000","11101100010","11100011010","11101111010","11001000010","11110001010","10100110000","10100001100","10010110000","10010000110","10000101100","10000100110","10110010000","10110000100","10011010000","10011000010","10000110100","10000110010","11000010010","11001010000","11110111010","11000010100","10001111010","10100111100","10010111100","10010011110","10111100100","10011110100","10011110010","11110100100","11110010100","11110010010","11011011110","11011110110","11110110110","10101111000","10100011110","10001011110","10111101000","10111100010","11110101000","11110100010","10111011110","10111101110","11101011110","11110101110","11010000100","11010010000","11010011100"];
  var STOP = "11000111010";
  var START_B = 104;
  var TERM = "11";            // แท่งปิดท้ายสองโมดูล ต่อจาก stop pattern

  /** ข้อความ -> สตริงบิต 0/1 โดยหนึ่งบิตคือหนึ่งโมดูล */
  function encode(text) {
    var s = String(text == null ? "" : text);
    var vals = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 32 || c > 126) {
        throw new Error('ตัวอักษร "' + s[i] + '" ใส่ในบาร์โค้ด Code 128 ชุด B ไม่ได้');
      }
      vals.push(c - 32);
    }
    if (!vals.length) throw new Error("ไม่มีข้อความที่จะเข้ารหัส");

    // ตัวตรวจ = (ค่าเริ่ม + ผลรวมของ ลำดับ x ค่า) หาร 103 เอาเศษ
    var sum = START_B;
    for (var k = 0; k < vals.length; k++) sum += (k + 1) * vals[k];
    var check = sum % 103;

    var bits = CODES[START_B];
    for (var m = 0; m < vals.length; m++) bits += CODES[vals[m]];
    return bits + CODES[check] + STOP + TERM;
  }

  /**
   * วาดเป็น SVG — ใช้ shape-rendering crispEdges เพื่อให้ขอบแท่งคมตอนพิมพ์
   * แท่งเบลอคือสาเหตุอันดับหนึ่งที่เครื่องยิงอ่านฉลากที่พิมพ์เองไม่ได้
   */
  function svg(text, opts) {
    var o = opts || {};
    var bits = encode(text);
    var mod = o.module || 1.4;          // ความกว้างแท่งบางสุด (หน่วย px ที่ 96dpi)
    var h = o.height || 38;
    var quiet = o.quiet == null ? 10 : o.quiet;   // ขอบขาวสองข้าง ห้ามตัดออก
    var w = bits.length * mod + quiet * 2 * mod;

    var bars = "", i = 0;
    while (i < bits.length) {
      if (bits[i] === "1") {
        var run = 1;
        while (i + run < bits.length && bits[i + run] === "1") run++;
        bars += '<rect x="' + ((quiet + i) * mod).toFixed(3) + '" y="0" width="'
              + (run * mod).toFixed(3) + '" height="' + h + '" fill="#000"></rect>';
        i += run;
      } else i++;
    }

    return '<svg class="bc" viewBox="0 0 ' + w.toFixed(2) + " " + h
      + '" width="' + w.toFixed(2) + '" height="' + h
      + '" shape-rendering="crispEdges" preserveAspectRatio="xMidYMid meet"'
      + ' role="img" aria-label="บาร์โค้ด ' + text + '">' + bars + "</svg>";
  }

  var PX_PER_MM = 96 / 25.4;

  /**
   * ความกว้างแท่งบางสุดที่ยอมรับได้ 0.25 มม. (ค่าที่เครื่องยิงทั่วไปอ่านได้แน่)
   * ต่ำกว่านี้ฉลากจะพิมพ์ออกมาแล้วยิงไม่ติด ซึ่งรู้ตอนติดสติกเกอร์ไปแล้วก็สายไป
   * จึงต้องเตือนก่อนพิมพ์ ไม่ใช่ย่อให้พอดีช่องแบบเงียบ ๆ
   */
  var MIN_MODULE_MM = 0.25;

  /** จำนวนโมดูลทั้งหมดของข้อความหนึ่ง รวมขอบขาวสองข้าง */
  function moduleCount(text, quiet) {
    // เริ่ม + ข้อมูล + ตัวตรวจ = (n+2) สัญลักษณ์ x 11 โมดูล แล้วบวก stop 13 โมดูล
    return (String(text).length + 2) * 11 + 13 + quiet * 2;
  }

  /* รูปแบบกระดาษสติกเกอร์ที่หาซื้อได้ทั่วไป หน่วยเป็นมิลลิเมตร */
  var LAYOUTS = [
    { id: "a4-3x8", name: "A4 · 3 × 8 (70 × 37 มม.)", cols: 3, rows: 8, w: 70, h: 37, module: 1.5, bh: 40 },
    { id: "a4-4x12", name: "A4 · 4 × 12 (48 × 25 มม.)", cols: 4, rows: 12, w: 48, h: 25, module: 1.1, bh: 26 },
    { id: "a4-2x5", name: "A4 · 2 × 5 (99 × 57 มม.)", cols: 2, rows: 5, w: 99, h: 57, module: 2.0, bh: 62 }
  ];

  function layout(id) {
    return LAYOUTS.filter(function (l) { return l.id === id; })[0] || LAYOUTS[0];
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /**
   * items = [{ code, name, sub, copies }]
   * code คือข้อความที่เข้าบาร์โค้ด (บาร์โค้ดที่ผูกไว้แล้ว หรือรหัส SKU)
   */
  /**
   * แท่งจะกว้างเท่าไรถ้าพิมพ์ข้อความนี้บนกระดาษแบบนี้
   * ย่อลงได้ถ้าที่ไม่พอ แต่ห้ามต่ำกว่าเกณฑ์โดยไม่บอก
   */
  function fit(text, L, quiet) {
    var usableMm = L.w - 5;                       // หัก padding ซ้ายขวา 2.5 มม.
    var mods = moduleCount(text, quiet);
    var maxMm = usableMm / mods;
    var mm = Math.min(L.module / PX_PER_MM, maxMm);
    return { mm: mm, px: mm * PX_PER_MM, thin: mm < MIN_MODULE_MM, modules: mods };
  }

  function sheet(items, layoutId) {
    var L = layout(layoutId);
    var cells = [];

    (items || []).forEach(function (it) {
      var n = Math.max(1, Math.min(Number(it.copies) || 1, 500));
      for (var i = 0; i < n; i++) cells.push(it);
    });

    if (!cells.length) return '<p class="empty">ยังไม่ได้เลือกสินค้าที่จะพิมพ์</p>';

    var perPage = L.cols * L.rows;
    var pages = [];
    for (var p = 0; p < cells.length; p += perPage) pages.push(cells.slice(p, p + perPage));

    var thin = {};
    return pages.map(function (page, pi) {
      var body = page.map(function (it) {
        var bc, f = fit(it.code, L, 10), warn = "";
        try {
          bc = svg(it.code, { module: f.px, height: L.bh, quiet: 10 });
          if (f.thin) {
            thin[it.code] = f.mm;
            warn = '<div class="lb-thin">แท่งบาง ' + f.mm.toFixed(2) + " มม. — อาจยิงไม่ติด</div>";
          }
        } catch (e) { bc = '<span class="bc-err">' + esc(e.message) + "</span>"; }
        return '<div class="lb-cell"' + (f.thin ? ' data-thin="true"' : "") + ">"
          + '<div class="lb-name">' + esc(it.name) + "</div>"
          + '<div class="lb-bc">' + bc + "</div>"
          + '<div class="lb-code">' + esc(it.code) + "</div>"
          + (it.sub ? '<div class="lb-sub">' + esc(it.sub) + "</div>" : "")
          + warn
          + "</div>";
      }).join("");

      return '<div class="lb-page" style="--cols:' + L.cols + ";--rows:" + L.rows
        + ";--cw:" + L.w + "mm;--ch:" + L.h + 'mm">'
        + body
        + '<div class="lb-pageno">หน้า ' + (pi + 1) + " / " + pages.length + "</div>"
        + "</div>";
    }).join("")
      + (Object.keys(thin).length
        ? '<div class="banner" data-tone="err" style="margin-top:14px">'
          + "<b>" + Object.keys(thin).length + " รหัสมีแท่งบางกว่า " + MIN_MODULE_MM
          + " มม.</b> — เปลี่ยนไปใช้กระดาษดวงใหญ่ขึ้น หรือใช้รหัสที่สั้นกว่า "
          + "ไม่งั้นพิมพ์ออกมาแล้วเครื่องยิงอาจอ่านไม่ได้ · "
          + Object.keys(thin).slice(0, 6).map(esc).join(" · ")
          + "</div>"
        : "");
  }

  /** ให้หน้าจอถามได้ว่าชุดที่เลือกไว้มีดวงไหนแท่งบางเกินเกณฑ์ */
  function check(items, layoutId) {
    var L = layout(layoutId);
    var thin = [];
    (items || []).forEach(function (it) {
      var f = fit(it.code, L, 10);
      if (f.thin) thin.push({ code: it.code, mm: Math.round(f.mm * 100) / 100 });
    });
    return { thin: thin, minMm: MIN_MODULE_MM };
  }

  window.LedgerLabel = {
    encode: encode,
    svg: svg,
    sheet: sheet,
    check: check,
    layouts: LAYOUTS
  };
})();
