/**
 * อ่าน/เขียนไฟล์ในรีโป GitHub
 *
 * ใช้ token ตัวเดียวที่เก็บเป็น secret ของ Worker ผู้ใช้ไม่เคยเห็น token นี้
 * แต่ commit ยังระบุชื่อคนที่กดจริงผ่านฟิลด์ author ประวัติจึงยังตามตัวได้
 */

const API = "https://api.github.com";

function repo(env) { return env.REPO_OWNER + "/" + env.REPO_NAME; }

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || null;
  }
}

async function gh(env, path, opts = {}) {
  const res = await fetch(API + path, {
    method: opts.method || "GET",
    headers: {
      "Authorization": "Bearer " + env.GITHUB_TOKEN,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mintra-stock",
      ...(opts.body ? { "Content-Type": "application/json" } : {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });

  if (res.status === 404 && opts.allow404) return null;
  if (res.status === 409) throw new HttpError(409, "มีคนบันทึกแซงพอดี", "CONFLICT");

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg = (body && body.message) || "เชื่อมต่อฐานข้อมูลไม่สำเร็จ";
    if (res.status === 401 || res.status === 403) {
      throw new HttpError(500, "ระบบเข้าถึงฐานข้อมูลไม่ได้ — ให้เจ้าของตรวจ GITHUB_TOKEN", "STORE_AUTH");
    }
    throw new HttpError(502, msg, "STORE_ERROR");
  }

  if (res.status === 204) return null;
  return res.json();
}

function toB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromB64(b64) {
  const bin = atob(String(b64).replace(/\n/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export async function readFile(env, path) {
  const res = await gh(env, `/repos/${repo(env)}/contents/${path}?ref=HEAD`, { allow404: true });
  if (!res) return { sha: null, json: null };
  let json = null;
  try { json = JSON.parse(fromB64(res.content)); } catch { json = null; }
  return { sha: res.sha, json };
}

export async function listDir(env, path) {
  const res = await gh(env, `/repos/${repo(env)}/contents/${path}`, { allow404: true });
  return Array.isArray(res) ? res : [];
}

async function putFile(env, path, obj, sha, message, actor) {
  const body = {
    message,
    content: toB64(JSON.stringify(obj, null, 2) + "\n"),
    author: {
      name: actor || "mintra-stock",
      email: (actor || "system") + "@stock.local"
    }
  };
  if (sha) body.sha = sha;
  return gh(env, `/repos/${repo(env)}/contents/${path}`, { method: "PUT", body });
}

/**
 * อ่าน–แก้–เขียน พร้อมลองใหม่เมื่อชนกัน
 * mutate คืน null แปลว่าไม่มีอะไรต้องเขียน
 */
export async function update(env, path, mutate, message, actor, fallback) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const cur = await readFile(env, path);
    const doc = cur.json || (typeof fallback === "function" ? fallback() : { });
    const next = await mutate(JSON.parse(JSON.stringify(doc)));
    if (!next) return null;

    try {
      await putFile(env, path, next, cur.sha, message, actor);
      return next;
    } catch (err) {
      if (err.code === "CONFLICT" && attempt < 4) {
        await new Promise(r => setTimeout(r, 180 * attempt));
        continue;
      }
      throw err;
    }
  }
  throw new HttpError(409, "มีคนบันทึกพร้อมกันหลายคน ลองใหม่อีกครั้ง", "CONFLICT");
}

export const PATHS = {
  users: "data/users.json"
};
