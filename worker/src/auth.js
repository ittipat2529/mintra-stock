/**
 * รหัสผ่านและ session ของระบบสต็อก
 *
 * รหัสผ่านเก็บเป็น PBKDF2-SHA256 ไม่เคยเก็บตัวจริง
 * session เป็นข้อความที่เซ็นด้วย HMAC เก็บใน cookie แบบ httpOnly
 * จาวาสคริปต์ในหน้าเว็บอ่าน cookie นี้ไม่ได้ ต่อให้โดน XSS ก็ขโมยไปใช้ต่อไม่ได้
 */

/**
 * งานหนักของ PBKDF2 ถูกย้ายไปทำในเบราว์เซอร์ (250,000 รอบ ดู docs/crypto.js)
 * สิ่งที่ส่งมาถึงที่นี่คือคีย์ที่ผ่านการยืดแล้ว ไม่ใช่รหัสผ่านตัวจริง
 * ฝั่งนี้จึงยืดซ้ำอีกชั้นแบบเบา ๆ พอให้ไฟล์ที่หลุดออกไปยังถอดไม่ได้
 *
 * เหตุผลที่ต้องแบ่ง — Workers แผนฟรีจำกัด CPU 10 มิลลิวินาทีต่อคำขอ
 * ส่วน 210,000 รอบกินไป 31 มิลลิวินาที ทำทั้งหมดที่เซิร์ฟเวอร์ไม่ได้
 * รวมสองชั้นแล้วผู้โจมตีที่ได้ไฟล์ไปยังต้องออกแรงเท่าเดิม
 */
const ITERATIONS = 20000;       // ~4.6 ms CPU อยู่ในงบของแผนฟรี
const KEY_BITS = 256;
const SESSION_HOURS = 12;

const enc = new TextEncoder();

function b64url(bytes) {
  let s = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** เทียบแบบใช้เวลาคงที่ กันการเดาทีละไบต์จากเวลาตอบกลับ */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hashPassword(password, saltB64) {
  const salt = saltB64 ? unb64url(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    key,
    KEY_BITS
  );
  return { salt: b64url(salt), hash: b64url(bits), iterations: ITERATIONS };
}

export async function verifyPassword(password, user) {
  if (!user || !user.salt || !user.hash) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: unb64url(user.salt), iterations: user.iterations || ITERATIONS, hash: "SHA-256" },
    key,
    KEY_BITS
  );
  return timingSafeEqual(b64url(bits), user.hash);
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function createSession(secret, username, role) {
  const payload = b64url(enc.encode(JSON.stringify({
    u: username,
    r: role,
    exp: Date.now() + SESSION_HOURS * 3600 * 1000
  })));
  const sig = b64url(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload)));
  return payload + "." + sig;
}

export async function readSession(secret, cookieValue) {
  if (!cookieValue || cookieValue.indexOf(".") === -1) return null;
  const [payload, sig] = cookieValue.split(".");
  const expect = b64url(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload)));
  if (!timingSafeEqual(sig, expect)) return null;

  let data;
  try { data = JSON.parse(new TextDecoder().decode(unb64url(payload))); }
  catch { return null; }

  if (!data || typeof data.exp !== "number" || data.exp < Date.now()) return null;
  return data;
}

/**
 * ชื่อ cookie เป็นของระบบสต็อกโดยเฉพาะ
 * ระบบบัญชีใช้ชื่ออื่น เข้าระบบหนึ่งจึงไม่ได้สิทธิ์ในอีกระบบ
 * แม้จะเผลอเอาขึ้นโดเมนเดียวกันก็ยังไม่ปนกัน
 */
export function sessionCookie(value, maxAgeSeconds) {
  return SESSION_COOKIE + "=" + value
    + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=" + maxAgeSeconds;
}

export const SESSION_COOKIE = "mintra_stock_session";

export function readCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export const SESSION_MAX_AGE = SESSION_HOURS * 3600;
