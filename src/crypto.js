const enc = new TextEncoder();
const dec = new TextDecoder();

export function bytesToB64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

export function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomBytes(n) {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}

export async function authHash(password, saltB64) {
  const salt = b64ToBytes(saltB64);
  const bits = await pbkdf2(password, salt, 120000);
  return bytesToB64(bits);
}

const encKeyCache = new Map();

export async function deriveEncKey(password, saltB64) {
  const cacheKey = password + "\0" + saltB64;
  const hit = encKeyCache.get(cacheKey);
  if (hit) return hit;
  const salt = b64ToBytes(saltB64);
  const bits = await pbkdf2(password, salt, 150000);
  const key = await crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt", "decrypt"]);
  encKeyCache.set(cacheKey, key);
  return key;
}

export async function deriveEncBits(password, saltB64) {
  return pbkdf2(password, b64ToBytes(saltB64), 150000);
}

async function keyFromBits(bits) {
  const raw = bits instanceof Uint8Array ? bits : new Uint8Array(bits);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptWithBits(bits, obj) {
  const key = await keyFromBits(bits);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj)));
  return { v: 1, iv: bytesToB64(iv), ct: bytesToB64(ct) };
}

export async function decryptWithBits(bits, packed) {
  if (!packed || !packed.ct) return { jots: [], rev: 0 };
  const key = await keyFromBits(bits);
  const iv = b64ToBytes(packed.iv);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, b64ToBytes(packed.ct));
  return JSON.parse(dec.decode(pt));
}

export async function encryptPayload(password, encSaltB64, obj) {
  const key = await deriveEncKey(password, encSaltB64);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj)));
  return { v: 1, iv: bytesToB64(iv), ct: bytesToB64(ct) };
}

export async function decryptPayload(password, encSaltB64, packed) {
  if (!packed || !packed.ct) return { jots: [], rev: 0 };
  const key = await deriveEncKey(password, encSaltB64);
  const iv = b64ToBytes(packed.iv);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, b64ToBytes(packed.ct));
  return JSON.parse(dec.decode(pt));
}

export function newSalt() {
  return bytesToB64(randomBytes(16));
}

const RECOVERY_ALPH = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const RECOVERY_ITERS = 100000;

export function normalizeRecoveryCode(code) {
  return String(code || "")
    .toUpperCase()
    .replace(/[^2-9A-HJ-NP-Z]/g, "");
}

export function formatRecoveryCode(norm) {
  const s = normalizeRecoveryCode(norm);
  if (s.length <= 5) return s;
  return s.slice(0, 5) + "-" + s.slice(5, 10);
}

export function generateRecoveryCodes(n = 8) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const bytes = randomBytes(10);
    let s = "";
    for (let j = 0; j < 10; j++) s += RECOVERY_ALPH[bytes[j] & 31];
    codes.push(formatRecoveryCode(s));
  }
  return codes;
}

export async function recoveryHash(code, saltB64) {
  const salt = b64ToBytes(saltB64);
  const bits = await pbkdf2(normalizeRecoveryCode(code), salt, RECOVERY_ITERS);
  return bytesToB64(bits);
}

export async function wrapString(passphrase, plaintext) {
  const salt = newSalt();
  const key = await deriveEncKey(normalizeRecoveryCode(passphrase), salt);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
  return { salt, iv: bytesToB64(iv), ct: bytesToB64(ct) };
}

export async function unwrapString(passphrase, packed) {
  const key = await deriveEncKey(normalizeRecoveryCode(passphrase), packed.salt);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(packed.iv) }, key, b64ToBytes(packed.ct));
  return dec.decode(pt);
}

export async function prfToAesKey(raw) {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

export async function wrapWithRawKey(raw, plaintext) {
  const bytes = await prfToAesKey(raw);
  const key = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
  return { iv: bytesToB64(iv), ct: bytesToB64(ct) };
}

export async function unwrapWithRawKey(raw, packed) {
  const bytes = await prfToAesKey(raw);
  const key = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(packed.iv) }, key, b64ToBytes(packed.ct));
  return dec.decode(pt);
}

export async function packRecoveryItems(codes, password) {
  const items = [];
  for (const code of codes) {
    const salt = newSalt();
    items.push({
      salt,
      hash: await recoveryHash(code, salt),
      wrap: await wrapString(code, password),
    });
  }
  return items;
}
