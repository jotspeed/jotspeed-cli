process.env.JOTSPEED_KEYCHAIN = "memory";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeInbox } from "../src/lib.mjs";
import { seal, openBox, generateInboxKeypair } from "../src/inbox.js";
import { deriveEncBits, decryptWithBits, newSalt } from "../src/crypto.js";

test("jsbox seal/open round trip", async () => {
  const kp = await generateInboxKeypair();
  const box = await seal(kp.pub, { jid: "a", text: "x" });
  assert.equal((await openBox(kp.priv, kp.pub, box)).text, "x");
});

test("mergeInbox: creates key, decrypts sealed agent post, pushes blob, acks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jot-inbox-"));
  const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, JOTSPEED_KEYCHAIN: "memory" };
  const bits = await deriveEncBits("password1", newSalt());
  const srv = { key: null, items: [], blob: { rev: 3, payload: null }, acked: [] };
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : {};
    const m = init.method || "GET";
    const r = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
    if (u.pathname === "/v1/inbox/key" && m === "GET") return r(srv.key || { pub: null });
    if (u.pathname === "/v1/inbox/key" && m === "PUT") { srv.key = { pub: body.pub, wrap: body.wrap }; return r({ ok: true }); }
    if (u.pathname === "/v1/inbox" && m === "GET") return r({ items: srv.items });
    if (u.pathname === "/v1/inbox/ack") { srv.acked.push(...body.ids); srv.items = []; return r({ ok: true }); }
    if (u.pathname === "/v1/blob" && m === "PUT") { srv.blob = { rev: srv.blob.rev + 1, payload: body.payload }; return r(srv.blob); }
    return r({ error: "nf" }, 404);
  };
  try {
    const cfg = { token: "tok_x", syncUrl: "http://sync.test", email: "a@b.co", entitled: true };
    // first run creates the key, nothing to merge
    let j = await mergeInbox(cfg, { jots: [], rev: 3, bits }, env);
    assert.equal(j.inboxMerged, 0);
    assert.ok(srv.key?.pub);
    // agent seals with only the public key
    srv.items.push({ id: "mcp-1234567890", box: await seal(srv.key.pub, { v: 1, jid: "mcp-1234567890", text: "agent note", tags: ["grok"], at: 42 }) });
    j = await mergeInbox(cfg, { jots: [], rev: 3, bits }, env);
    assert.equal(j.inboxMerged, 1);
    assert.deepEqual(srv.acked, ["mcp-1234567890"]);
    const saved = await decryptWithBits(bits, srv.blob.payload);
    assert.equal(saved.jots[0].body, "agent note @grok");
    assert.equal(saved.jots[0].id, "mcp-1234567890");
  } finally {
    globalThis.fetch = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
