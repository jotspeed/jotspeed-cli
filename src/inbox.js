/**
 * Sealed inbox ("jsbox v1") — lets a post-only agent append entries it cannot read back.
 *
 * Scheme (WebCrypto only, no deps):
 *   recipient keypair: X25519. Public key (raw, 32 bytes) is uploaded to the sync server.
 *   Private key (PKCS#8) is encrypted with the journal key (same AES-GCM key as the blob)
 *   and stored server-side as an opaque `wrap`.
 *   seal(pub, obj):
 *     eph  = X25519 ephemeral keypair
 *     ss   = X25519(eph.priv, pub)                              (32 bytes)
 *     k    = HKDF-SHA256(ikm=ss, salt=eph.pub || pub, info="jotspeed-inbox-v1") -> AES-256-GCM
 *     ct   = AES-GCM(k, iv=random 12, aad="jotspeed-inbox-v1", JSON(obj))
 *     box  = { v:1, epk: b64(eph.pub), iv: b64(iv), ct: b64(ct) }
 *   Equivalent in spirit to libsodium crypto_box_seal (anonymous sender, ephemeral key).
 *
 * Inner payload: { v:1, jid, text, at, tags:[], starred, source }
 */
import { bytesToB64, b64ToBytes, randomBytes } from "./crypto.js";
import { makeJot, normalizeTag, parseTags } from "./core.js";

const te = new TextEncoder();
const td = new TextDecoder();
const LABEL = te.encode("jotspeed-inbox-v1");
const X = { name: "X25519" };

export async function inboxSupported() {
  try {
    await crypto.subtle.generateKey(X, true, ["deriveBits"]);
    return true;
  } catch {
    return false;
  }
}

export async function generateInboxKeypair() {
  const kp = await crypto.subtle.generateKey(X, true, ["deriveBits"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const priv = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  return { pub: bytesToB64(pub), priv: bytesToB64(priv) };
}

async function aesFrom(shared, salt) {
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: LABEL },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function cat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export async function seal(pubB64, obj) {
  const pubRaw = b64ToBytes(pubB64);
  if (pubRaw.length !== 32) throw new Error("Bad inbox public key.");
  const pub = await crypto.subtle.importKey("raw", pubRaw, X, false, []);
  const eph = await crypto.subtle.generateKey(X, true, ["deriveBits"]);
  const epk = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: pub }, eph.privateKey, 256));
  const key = await aesFrom(shared, cat(epk, pubRaw));
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: LABEL }, key, te.encode(JSON.stringify(obj)));
  return { v: 1, epk: bytesToB64(epk), iv: bytesToB64(iv), ct: bytesToB64(ct) };
}

export async function openBox(privB64, pubB64, box) {
  if (!box || box.v !== 1) throw new Error("Unknown box version.");
  const priv = await crypto.subtle.importKey("pkcs8", b64ToBytes(privB64), X, false, ["deriveBits"]);
  const epkRaw = b64ToBytes(box.epk);
  const epk = await crypto.subtle.importKey("raw", epkRaw, X, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: epk }, priv, 256));
  const key = await aesFrom(shared, cat(epkRaw, b64ToBytes(pubB64)));
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(box.iv), additionalData: LABEL },
    key,
    b64ToBytes(box.ct)
  );
  return JSON.parse(td.decode(pt));
}

/** Turn a decrypted inbox payload into a jot. Tags not already in the text are appended as @tags. */
export function inboxToJot(p) {
  let text = String(p.text || "").trim();
  const have = new Set(parseTags(text));
  const extra = (Array.isArray(p.tags) ? p.tags : [])
    .map(normalizeTag)
    .filter((t) => t && t.length > 1 && !have.has(t));
  if (extra.length) text = `${text} ${[...new Set(extra)].join(" ")}`.trim();
  const at = Number(p.at) || Date.now();
  return makeJot(text, { id: String(p.jid), createdAt: at, updatedAt: at, starred: Boolean(p.starred) });
}

async function call(base, path, { method = "GET", token, body } = {}) {
  const res = await fetch(String(base).replace(/\/$/, "") + path, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * Make sure this account has an inbox keypair; returns {pub, priv} or null if unsupported.
 * wrapFn(obj) -> packed / unwrapFn(packed) -> obj use the journal key.
 */
export async function ensureInboxKey({ base, token, wrapFn, unwrapFn }) {
  if (!(await inboxSupported())) return null;
  const cur = await call(base, "/v1/inbox/key", { token });
  if (cur.pub && cur.wrap) {
    try {
      const inner = await unwrapFn(cur.wrap);
      if (inner?.priv && inner.pub === cur.pub) return { pub: cur.pub, priv: inner.priv };
    } catch {
      /* journal key changed (e.g. password reset) — rotate below */
    }
  }
  const kp = await generateInboxKeypair();
  const wrap = await wrapFn({ pub: kp.pub, priv: kp.priv });
  try {
    await call(base, "/v1/inbox/key", { method: "PUT", token, body: { pub: kp.pub, wrap, replace: Boolean(cur.pub) } });
  } catch (err) {
    if (err.status === 409 && err.data?.wrap) {
      // Another device won the race; use theirs.
      const inner = await unwrapFn(err.data.wrap);
      return { pub: err.data.pub, priv: inner.priv };
    }
    throw err;
  }
  return kp;
}

/** Pull and decrypt pending inbox items. Returns {jots, ids}. Undecryptable items are left (and reported). */
export async function drainInbox({ base, token, key }) {
  const { items = [] } = await call(base, "/v1/inbox", { token });
  const jots = [];
  const ids = [];
  const failed = [];
  for (const it of items) {
    try {
      const p = await openBox(key.priv, key.pub, it.box);
      if (!p.jid) p.jid = it.id;
      jots.push(inboxToJot(p));
      ids.push(it.id);
    } catch {
      failed.push(it.id);
    }
  }
  return { jots, ids, failed };
}

export async function ackInbox({ base, token, ids }) {
  if (!ids?.length) return { removed: 0 };
  return call(base, "/v1/inbox/ack", { method: "POST", token, body: { ids } });
}

export async function listAgents(base, token) {
  return call(base, "/v1/agents", { token });
}

export async function revokeAgent(base, token, id) {
  return call(base, "/v1/agents/revoke", { method: "POST", token, body: { id } });
}
