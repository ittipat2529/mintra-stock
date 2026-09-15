/**
 * เปลือกของแอปสต็อก — เข้าสู่ระบบ ชื่อบริษัท และจัดการทีม
 *
 * ไฟล์นี้ไม่รู้เรื่องสต็อกเลย หน้าที่มีแค่พาคนเข้ามาให้ถึงในระบบ
 * แล้วส่งสัญญาณ app:ready ให้ stock.js เริ่มทำงาน
 *
 * หน้านี้ไม่มีสิทธิ์อะไรในตัวเอง ทุกคำสั่งวิ่งไปที่ /api/ ของ Worker
 * ซึ่งตรวจ session แล้วตรวจกฎสิทธิ์ก่อนแตะข้อมูลเสมอ
 * การซ่อนปุ่มในหน้านี้เป็นเรื่องความสะดวก กำแพงจริงอยู่ฝั่ง Worker
 *
 * session อยู่ใน cookie แบบ httpOnly จาวาสคริปต์อ่านไม่ได้
 */
(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }

  var ROLE_LABEL = {
    owner: "เจ้าของ",
    manager: "หัวหน้าคลัง",
    warehouse: "คลัง",
    sales: "ฝ่ายขาย",
    readonly: "ดูอย่างเดียว"
  };

  // สิทธิ์ที่แตะข้อมูลไม่ได้เลย ใช้ปิดปุ่มทั้งหน้าด้วย CSS
  var READONLY_ROLES = { readonly: true };

  var state = { me: null, users: [] };
  var brand = { name: "", short: "", logo: "", theme: "" };
  var busy = false;

  /* ================= ตัวช่วย ================= */

  function baht(n) {
    return Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function todayISO() {
    var d = new Date(), m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.setAttribute("data-show", "true");
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.setAttribute("data-show", "false"); }, 3600);
  }

  function banner(msg, tone) {
    var b = $("banner");
    if (!msg) { b.hidden = true; return; }
    b.textContent = msg;
    b.setAttribute("data-tone", tone || "warn");
    b.hidden = false;
  }

  /* ================= คุยกับ Worker ================= */

  function api(path, method, body) {
    return fetch("/api" + path, {
      method: method || "GET",
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.ok) return data;
        var e = new Error(data.error || "เชื่อมต่อไม่สำเร็จ");
        e.status = r.status;
        e.code = data.code;
        throw e;
      });
    });
  }

  function handleErr(err) {
    if (err && err.status === 401) { showGate("หมดเวลาใช้งาน กรุณาเข้าสู่ระบบใหม่"); return; }
    toast((err && err.message) || "เชื่อมต่อไม่สำเร็จ");
  }

  function setBusy(on, btn, label) {
    busy = on;
    if (btn) { btn.disabled = on; btn.textContent = label; }
  }

  /* ================= เข้าสู่ระบบ ================= */

  function gateMsg(msg, isErr) {
    var el = $("gateMsg");
    el.textContent = msg || "";
    el.setAttribute("data-err", isErr ? "true" : "false");
  }

  function showGate(msg) {
    state.me = null;
    state.users = [];
    $("app").hidden = true;
    $("gate").hidden = false;
    document.body.classList.remove("readonly");
    $("liPass").value = "";
    gateMsg(msg || "", !!msg);
  }

  /** ชื่อและโลโก้มาจากค่าตั้งของ Worker แต่ละบริษัทจึงใช้โค้ดชุดเดียวกันได้ */
  function applyBrand(c) {
    if (!c) return;
    brand = c;
    document.title = "สต็อกสินค้า — " + c.short;
    document.querySelectorAll("[data-company]").forEach(function (el) { el.textContent = c.name; });
    // ปกติ Worker ติดให้แล้วตั้งแต่ตอนเสิร์ฟ ตรงนี้เผื่อกรณีเปิดไฟล์ตรง ๆ
    if (c.theme && !document.body.dataset.brand) document.body.dataset.brand = c.theme;
    if (c.logo) {
      document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]')
        .forEach(function (el) { el.href = c.logo; });
    }
    document.querySelectorAll("[data-logo]").forEach(function (el) {
      el.alt = "โลโก้ " + c.short;
      if (c.logo) el.src = c.logo;
    });
  }

  function boot() {
    api("/setup").then(function (r) {
      applyBrand(r.company);

      if (r.storeError) {
        $("setupForm").hidden = true;
        $("loginForm").hidden = true;
        gateMsg(r.storeError, true);
        return;
      }

      $("setupForm").hidden = !r.needsSetup;
      $("loginForm").hidden = !!r.needsSetup;
      gateMsg("");
      if (!r.needsSetup) return loadState().catch(function () { /* ยังไม่ล็อกอิน ปกติ */ });
    }).catch(function () {
      gateMsg("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ลองรีเฟรชหน้าอีกครั้ง", true);
    });
  }

  function loadState() {
    return api("/state").then(function (data) {
      state.me = data.me;
      state.users = data.users || [];
      enterApp();
    });
  }

  function doSetup(ev) {
    ev.preventDefault();
    var pass = $("suPass").value;
    if (pass !== $("suPass2").value) { gateMsg("รหัสผ่านสองช่องไม่ตรงกัน", true); return; }
    if (pass.length < 8) { gateMsg("รหัสผ่านต้องยาวอย่างน้อย 8 ตัว", true); return; }

    var username = $("suUser").value.trim().toLowerCase();
    setBusy(true, $("suBtn"), "กำลังสร้าง…");
    StockCrypto.deriveKey(username, pass).then(function (key) {
      return api("/setup", "POST", {
        username: username, name: $("suName").value, password: key
      });
    }).then(loadState)
      .catch(function (err) { gateMsg(err.message, true); })
      .then(function () { setBusy(false, $("suBtn"), "สร้างบัญชีเจ้าของ"); });
  }

  function doLogin(ev) {
    ev.preventDefault();
    var username = $("liUser").value.trim().toLowerCase();
    gateMsg("กำลังตรวจสอบ…");
    setBusy(true, $("liBtn"), "กำลังเข้าสู่ระบบ…");
    StockCrypto.deriveKey(username, $("liPass").value)
      .then(function (key) { return api("/login", "POST", { username: username, password: key }); })
      .then(function () { return loadState(); })
      .catch(function (err) { gateMsg(err.message, true); })
      .then(function () { setBusy(false, $("liBtn"), "เข้าสู่ระบบ"); });
  }

  function doLogout() {
    api("/logout", "POST").catch(function () {}).then(function () { showGate("ออกจากระบบแล้ว"); });
  }

  /* ================= เข้าสู่แอป ================= */

  function enterApp() {
    $("gate").hidden = true;
    $("app").hidden = false;

    var me = state.me;
    $("whoName").textContent = me.name;
    $("whoRole").textContent = ROLE_LABEL[me.role] || me.role;
    $("whoRole").className = "badge r-" + me.role;
    $("whoPic").hidden = true;

    document.body.classList.toggle("readonly", !!READONLY_ROLES[me.stockRole]);
    $("teamBtn").hidden = me.role !== "owner";
    if (me.role !== "owner") $("teamCard").hidden = true;
    renderUsers();

    if (me.mustChangePassword) openPassword(true);

    // stock.js รอสัญญาณนี้ ไม่ได้เริ่มเองตอนโหลดไฟล์
    // สิทธิ์จึงมาถึงก่อนที่จะมีปุ่มอะไรขึ้นหน้าจอ
    document.dispatchEvent(new CustomEvent("app:ready", { detail: { me: me } }));
  }

  /* ================= เปลี่ยนรหัสผ่าน ================= */

  function openPassword(forced) {
    $("pwNote").textContent = forced
      ? "เข้าใช้ครั้งแรกด้วยรหัสชั่วคราว กรุณาตั้งรหัสผ่านของตัวเองก่อน"
      : "";
    $("pwCancel").hidden = !!forced;
    $("pwCur").value = ""; $("pwNew").value = ""; $("pwNew2").value = "";
    $("pwDlg").showModal();
  }

  function savePassword() {
    var next = $("pwNew").value;
    if (next !== $("pwNew2").value) { toast("รหัสผ่านใหม่สองช่องไม่ตรงกัน"); return; }
    if (next.length < 8) { toast("รหัสผ่านต้องยาวอย่างน้อย 8 ตัว"); return; }

    var u = state.me.username;
    setBusy(true, $("pwSave"), "กำลังบันทึก…");
    Promise.all([
      StockCrypto.deriveKey(u, $("pwCur").value),
      StockCrypto.deriveKey(u, next)
    ]).then(function (keys) {
      return api("/password", "POST", { current: keys[0], next: keys[1] });
    }).then(function () {
        state.me.mustChangePassword = false;
        $("pwDlg").close();
        toast("เปลี่ยนรหัสผ่านแล้ว");
      }).catch(function (err) { toast(err.message); })
      .then(function () { setBusy(false, $("pwSave"), "บันทึกรหัสใหม่"); });
  }

  /* ================= จัดการทีม (เจ้าของเท่านั้น) ================= */

  function renderUsers() {
    if (!state.me || state.me.role !== "owner") return;
    var html = "";
    state.users.forEach(function (u) {
      var isMe = u.username === state.me.username;
      html += '<div class="mrow">'
        + '<span class="badge r-' + esc(u.role) + '">' + esc(ROLE_LABEL[u.role] || u.role) + "</span>"
        + '<span class="mt"><span class="mn">' + esc(u.name || u.username) + "</span>"
        + '<span class="me">' + esc(u.username) + "</span></span>"
        + '<div class="rowact">'
        +   '<button type="button" class="iact uedit" data-edit="' + esc(u.username) + '">แก้</button>'
        +   (isMe ? "" : '<button type="button" class="iact del" data-user="' + esc(u.username)
              + '" aria-label="ถอด ' + esc(u.username) + '">×</button>')
        + "</div></div>";
    });
    $("members").innerHTML = html || '<div class="mrow"><span class="me">ยังไม่มีผู้ใช้อื่น</span></div>';
  }

  function existingUser(username) {
    return state.users.filter(function (u) { return u.username === username; })[0];
  }

  /** กดแก้ที่แถวไหน ก็เติมค่าคนนั้นลงฟอร์มให้ เปลี่ยนแค่ระดับแล้วกดบันทึกได้เลย */
  function fillUserForm(username) {
    var u = existingUser(username);
    if (!u) return;
    $("mUser").value = u.username;
    $("mName").value = u.name || "";
    $("mRole").value = u.role;
    $("mPass").value = "";
    updateUserHint();
    $("mClear").hidden = false;
    $("mUser").focus();
  }

  function clearUserForm() {
    $("mUser").value = ""; $("mName").value = ""; $("mPass").value = "";
    $("mRole").value = "warehouse";
    $("mClear").hidden = true;
    updateUserHint();
  }

  /** บอกให้ชัดว่ากำลังเพิ่มคนใหม่ หรือกำลังแก้คนเดิม และรหัสจำเป็นไหม */
  function updateUserHint() {
    var username = $("mUser").value.trim().toLowerCase();
    var u = existingUser(username);
    var hint = $("mHint");
    var pass = $("mPass");

    if (u) {
      pass.placeholder = "เว้นว่างไว้ถ้าไม่ต้องการเปลี่ยนรหัส";
      hint.textContent = "กำลังแก้ " + (u.name || u.username)
        + " · เปลี่ยนแค่ระดับได้โดยไม่ต้องแตะรหัสของเขา"
        + " — ใส่รหัสใหม่เฉพาะตอนที่เขาลืมรหัส";
      $("mAddBtn").textContent = "บันทึกการแก้ไข";
    } else {
      pass.placeholder = "รหัสผ่านชั่วคราว อย่างน้อย 8 ตัว";
      hint.textContent = "บอกรหัสชั่วคราวให้เขา ระบบจะบังคับให้ตั้งรหัสใหม่ตอนเข้าครั้งแรก";
      $("mAddBtn").textContent = "บันทึกผู้ใช้";
    }
  }

  function addUser() {
    var username = $("mUser").value.trim().toLowerCase();
    var pass = $("mPass").value;
    var u = existingUser(username);

    if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
      toast("ชื่อผู้ใช้ใช้ได้เฉพาะ a-z 0-9 . _ - ยาว 3 ถึง 30 ตัว");
      return;
    }
    if (!u && pass.length < 8) { toast("ผู้ใช้ใหม่ต้องตั้งรหัสผ่านชั่วคราวอย่างน้อย 8 ตัว"); return; }
    if (pass && pass.length < 8) { toast("รหัสผ่านต้องยาวอย่างน้อย 8 ตัว"); return; }

    var body = { username: username, name: $("mName").value.trim(), role: $("mRole").value };

    setBusy(true, $("mAddBtn"), "กำลังบันทึก…");
    Promise.resolve(pass ? StockCrypto.deriveKey(username, pass) : null)
      .then(function (key) {
        if (key) body.password = key;
        return api("/users", "POST", body);
      })
      .then(function (data) {
        state.users = data.users || [];
        clearUserForm();
        renderUsers();
        toast(data.changedPassword
          ? "ตั้งรหัสใหม่ให้ " + username + " แล้ว — บอกรหัสชั่วคราวให้เขาไปเปลี่ยนเอง"
          : (u ? "แก้ไข " + username + " แล้ว รหัสเดิมยังใช้ได้ตามปกติ"
               : "เพิ่มผู้ใช้ " + username + " แล้ว"));

        // เปลี่ยนสิทธิ์ตัวเองแล้วหน้าจอต้องกรองแท็บใหม่ทันที ไม่ใช่รอรีเฟรช
        if (username === state.me.username) return loadState();
      })
      .catch(function (err) { toast(err.message); })
      .then(function () {
        setBusy(false, $("mAddBtn"), "บันทึกผู้ใช้");
        updateUserHint();
      });
  }

  function dropUser(username) {
    if (!confirm("ถอด " + username + " ออกจากระบบใช่ไหม\n\nประวัติการยิงของเขาจะยังอยู่ครบ")) return;
    api("/users/" + encodeURIComponent(username), "DELETE")
      .then(function (data) { state.users = data.users || []; renderUsers(); toast("ถอด " + username + " แล้ว"); })
      .catch(handleErr);
  }

  function archiveNow() {
    setBusy(true, $("arcBtn"), "กำลังเก็บ…");
    api("/stock/archive", "POST").then(function (r) {
      toast("เก็บประวัติวันที่ " + r.date + " แล้ว — " + r.movements
        + " การเคลื่อนไหว · " + r.balance + " รายการคงเหลือ");
    }).catch(handleErr).then(function () {
      setBusy(false, $("arcBtn"), "เก็บประวัติของวันนี้");
    });
  }

  /* ================= ต่อสาย ================= */

  $("setupForm").addEventListener("submit", doSetup);
  $("loginForm").addEventListener("submit", doLogin);
  $("signOutBtn").addEventListener("click", doLogout);

  $("pwBtn").addEventListener("click", function () { openPassword(false); });
  $("pwSave").addEventListener("click", savePassword);
  $("pwCancel").addEventListener("click", function () { $("pwDlg").close(); });

  $("teamBtn").addEventListener("click", function () {
    var c = $("teamCard");
    c.hidden = !c.hidden;
    if (!c.hidden) c.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  $("mAddBtn").addEventListener("click", addUser);
  $("mClear").addEventListener("click", clearUserForm);
  $("mUser").addEventListener("input", updateUserHint);
  $("arcBtn").addEventListener("click", archiveNow);

  $("members").addEventListener("click", function (ev) {
    var e = ev.target.closest("button[data-edit]");
    if (e) { fillUserForm(e.getAttribute("data-edit")); return; }
    var d = ev.target.closest("button[data-user]");
    if (d) dropUser(d.getAttribute("data-user"));
  });

  /**
   * สิ่งที่ stock.js ขอใช้ — เท่านี้พอ ไม่มีอะไรของสมุดบัญชีอยู่ในนี้
   * ตั้งไว้ก่อนเรียก boot() เพราะ stock.js อ่านตัวนี้ตอนไฟล์ถูกโหลด
   */
  window.StockApp = {
    api: api,
    baht: baht,
    esc: esc,
    toast: toast,
    banner: banner,
    todayISO: todayISO,
    setBusy: setBusy,
    handleErr: handleErr,
    me: function () { return state.me; },
    brand: function () { return brand; }
  };

  boot();
})();
