import { mergeJots, defaultSyncUrl, PRO_CODE } from "./core.js";
import { encryptPayload, decryptPayload } from "./crypto.js";

export function sessionGet(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function sessionSet(key, value) {
  try {
    if (value == null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

export async function api(base, path, { method = "GET", token, body, etag } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (etag != null && etag !== "") headers["if-none-match"] = `"${etag}"`;
  const res = await fetch(String(base).replace(/\/$/, "") + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 304) {
    const err = new Error("not modified");
    err.status = 304;
    throw err;
  }
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

export async function health(base) {
  return api(base, "/v1/health");
}

export async function continueAccount(base, email, password, founder) {
  return api(base, "/v1/continue", { method: "POST", body: { email, password, founder } });
}

export async function register(base, email, password, founder) {
  return api(base, "/v1/register", { method: "POST", body: { email, password, founder } });
}

export async function login(base, email, password) {
  return api(base, "/v1/login", { method: "POST", body: { email, password } });
}

export async function me(base, token) {
  return api(base, "/v1/me", { token });
}

export async function applyFounder(base, token, code) {
  return api(base, "/v1/founder", { method: "POST", token, body: { code } });
}

export async function startCheckout(base, token, interval) {
  return api(base, "/v1/billing/checkout", { method: "POST", token, body: { interval } });
}

export async function billingPortal(base, token) {
  return api(base, "/v1/billing/portal", { method: "POST", token });
}

export async function changePassword(base, token, oldPassword, newPassword, extra = {}) {
  return api(base, "/v1/password", { method: "POST", token, body: { oldPassword, newPassword, ...extra } });
}

export async function saveRecovery(base, token, items) {
  return api(base, "/v1/recovery", { method: "POST", token, body: { items } });
}

export async function unlockRecovery(base, email, code) {
  return api(base, "/v1/recovery/unlock", { method: "POST", body: { email, code } });
}

export async function passkeyRegisterBegin(base, token) {
  return api(base, "/v1/passkey/register/begin", { method: "POST", token, body: {} });
}

export async function passkeyRegisterFinish(base, token, challenge, response, extra = {}) {
  return api(base, "/v1/passkey/register/finish", { method: "POST", token, body: { challenge, response, ...extra } });
}

export async function passkeyLoginBegin(base, email) {
  return api(base, "/v1/passkey/login/begin", { method: "POST", body: { email } });
}

export async function passkeyLoginFinish(base, challenge, response) {
  return api(base, "/v1/passkey/login/finish", { method: "POST", body: { challenge, response } });
}

export async function passkeyDelete(base, token, id) {
  return api(base, "/v1/passkey/delete", { method: "POST", token, body: { id } });
}

export async function passkeyWrap(base, token, id, wrap) {
  return api(base, "/v1/passkey/wrap", { method: "POST", token, body: { id, wrap } });
}

export async function pullBlob(base, token, rev) {
  const etag = Number(rev) > 0 ? rev : undefined;
  try {
    return await api(base, "/v1/blob", { token, etag });
  } catch (err) {
    if (err.status === 304) return { notModified: true, rev };
    throw err;
  }
}

export async function pushBlob(base, token, rev, payload) {
  return api(base, "/v1/blob", { method: "PUT", token, body: { rev, payload } });
}

export function jotsFingerprint(jots) {
  return jots
    .map((j) => `${j.id}:${j.updatedAt}:${j.deletedAt || 0}`)
    .sort()
    .join("|");
}

export async function runSync({ base, token, password, encSalt, localJots, localRev = 0, dirty = true }) {
  const neverSynced = !Number(localRev);
  const remote = await pullBlob(base, token, localRev);
  if (remote.notModified && !dirty && !neverSynced) {
    return { jots: localJots, rev: localRev, skipped: true };
  }
  let remoteJots = [];
  let rev = remote.rev || 0;
  if (remote.payload) {
    try {
      const decoded = await decryptPayload(password, encSalt, remote.payload);
      remoteJots = decoded.jots || [];
    } catch {
      const err = new Error("Couldn’t decrypt the backup. Sign in with the current password.");
      err.status = 401;
      throw err;
    }
  }
  const merged = mergeJots(localJots, remoteJots);
  if (!dirty && !neverSynced && jotsFingerprint(merged) === jotsFingerprint(localJots)) {
    return { jots: merged, rev, skipped: true };
  }
  const payload = await encryptPayload(password, encSalt, { jots: merged });
  try {
    const saved = await pushBlob(base, token, rev, payload);
    return { jots: merged, rev: saved.rev };
  } catch (err) {
    if (err.status !== 409) throw err;
    const again = err.data || {};
    let againJots = [];
    if (again.payload) {
      try {
        const decoded = await decryptPayload(password, encSalt, again.payload);
        againJots = decoded.jots || [];
      } catch {
        const fail = new Error("Couldn’t decrypt the backup. Sign in with the current password.");
        fail.status = 401;
        throw fail;
      }
    }
    const merged2 = mergeJots(merged, againJots);
    const payload2 = await encryptPayload(password, encSalt, { jots: merged2 });
    const saved = await pushBlob(base, token, again.rev || 0, payload2);
    return { jots: merged2, rev: saved.rev };
  }
}

export async function resolveSyncUrl(fallback) {
  const seed = fallback || defaultSyncUrl();
  try {
    const h = await health(seed);
    if (h.advertise) return h.advertise;
  } catch {
    /* seed unreachable */
  }
  return seed;
}

export { defaultSyncUrl, PRO_CODE };
