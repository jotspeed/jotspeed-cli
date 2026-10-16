process.env.JOTSPEED_KEYCHAIN = "memory";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadJournal } from "../src/lib.mjs";
import { encryptPayload, newSalt } from "../src/crypto.js";
import { makeJot } from "../src/core.js";

test("loadJournal refetches when the cache cannot be read", async () => {
  const salt = newSalt();
  const existing = [makeJot("still here", { id: "old", createdAt: 1, updatedAt: 1 })];
  const payload = await encryptPayload("password12", salt, { jots: existing });
  const prev = globalThis.fetch;
  let pulls = 0;
  globalThis.fetch = async (_url, opts) => {
    pulls += 1;
    const headers = opts?.headers || {};
    if (headers["if-none-match"]) return new Response(null, { status: 304 });
    return new Response(JSON.stringify({ rev: 4, payload }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const dir = await mkdtemp(join(tmpdir(), "jot-"));
  try {
    const env = { XDG_CONFIG_HOME: dir, HOME: dir, JOTSPEED_KEYCHAIN: "memory", JOTSPEED_NO_INBOX: "1" };
    const loaded = await loadJournal(
      {
        syncUrl: "https://sync.test",
        email: "a@b.com",
        token: "tok",
        encSalt: salt,
        entitled: true,
        password: "password12",
        rev: 4,
      },
      env,
    );
    assert.equal(pulls, 2);
    assert.equal(loaded.jots.length, 1);
    assert.equal(loaded.jots[0].body, "still here");
  } finally {
    globalThis.fetch = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
