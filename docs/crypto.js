/**
 * ยืดรหัสผ่านในเบราว์เซอร์ก่อนส่งขึ้นเซิร์ฟเวอร์ (ระบบสต็อก)
 *
 * รหัสผ่านตัวจริงไม่เคยออกจากเครื่องนี้ สิ่งที่ส่งไปคือคีย์ที่ผ่าน
 * PBKDF2 250,000 รอบแล้ว เซิร์ฟเวอร์ยืดซ้ำอีกชั้นก่อนเก็บลงไฟล์
 *
 * เกลือผูกกับชื่อผู้ใช้ เพื่อให้คนละคนที่ตั้งรหัสเหมือนกันได้คีย์ต่างกัน
 * เกลือไม่ใช่ความลับอยู่แล้ว หน้าที่ของมันคือกันตารางสำเร็จรูป
 */
window.StockCrypto = (function () {
  "use strict";

  var CLIENT_ITERATIONS = 250000;
  var enc = new TextEncoder();

  function b64url(buf) {
    var arr = new Uint8Array(buf), s = "";
    for (var i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function deriveKey(username, password) {
    var u = String(username || "").trim().toLowerCase();
    // ⚠ ห้ามแก้ข้อความนี้เด็ดขาด มันคือเกลือที่ใช้ยืดรหัสผ่าน
    // เปลี่ยนเมื่อไร รหัสผ่านของทุกคนจะใช้ไม่ได้ทันที
    // ต้องให้เจ้าของตั้งรหัสใหม่ให้ทีละคน
    //
    // ข้อความนี้ต่างจากของสมุดบัญชีรายรับรายจ่าย โดยตั้งใจ
    // รหัสผ่านเดียวกันในสองระบบจึงได้คีย์ไม่เหมือนกัน
    // ไฟล์ผู้ใช้ของระบบหนึ่งหลุด ก็เอาไปเข้าอีกระบบไม่ได้
    return crypto.subtle.digest("SHA-256", enc.encode("mintra-stock:v1:" + u))
      .then(function (salt) {
        return crypto.subtle.importKey("raw", enc.encode(String(password)), "PBKDF2", false, ["deriveBits"])
          .then(function (key) {
            return crypto.subtle.deriveBits(
              { name: "PBKDF2", salt: new Uint8Array(salt), iterations: CLIENT_ITERATIONS, hash: "SHA-256" },
              key, 256
            );
          });
      })
      .then(b64url);
  }

  return { deriveKey: deriveKey, MIN_LENGTH: 8 };
})();
