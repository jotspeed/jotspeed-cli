process.env.JOTSPEED_KEYCHAIN = "memory";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgv, usage, saveConfig, loadConfig, configPath, addJot, selectJots, formatJots, splitWhen } from "../src/lib.mjs";
import { parseDate } from "../src/dates.mjs";
import { encryptPayload, newSalt } from "../src/crypto.js";
import { makeJot } from "../src/core.js";

test("parseArgv treats quoted and bare words as a jot", () => {
  assert.equal(parseArgv(["node", "jot", "hello", "world"]).cmd, "compose");
  assert.equal(parseArgv(["node", "jot", "hello", "world"]).body, "hello world");
  assert.equal(parseArgv(["node", "jot", "login"]).cmd, "login");
  assert.equal(parseArgv(["node", "jot", "logout"]).cmd, "logout");
  assert.equal(parseArgv(["node", "jot", "--help"]).cmd, "help");
});

test("parseArgv -1 is the last entry", () => {
  const p = parseArgv(["node", "jot", "-1"]);
  assert.equal(p.cmd, "view");
  assert.equal(p.filters.limit, 1);
});

test("parseArgv combines tags, dates, and --short", () => {
  const p = parseArgv(["node", "jot", "-n", "10", "@work", "-from", "yesterday", "--short"]);
  assert.equal(p.cmd, "view");
  assert.equal(p.filters.limit, 10);
  assert.deepEqual(p.filters.tags, ["@work"]);
  assert.equal(p.filters.from, "yesterday");
  assert.equal(p.display.short, true);
});

test("usage mentions jot login and -1", () => {
  const text = usage();
  assert.match(text, /jot login/);
  assert.match(text, /jot -1/);
  assert.match(text, /jotspeed-cli/);
});

test("parseDate understands yesterday and ISO days", () => {
  const y = parseDate("yesterday");
  const t = parseDate("today");
  assert.ok(y && t && y.getTime() < t.getTime());
  const iso = parseDate("2026-01-15");
  assert.equal(iso.getFullYear(), 2026);
  assert.equal(iso.getMonth(), 0);
  assert.equal(iso.getDate(), 15);
  assert.equal(parseDate("not a date"), null);
});

test("splitWhen pulls a date prefix off a new entry", () => {
  const s = splitWhen("yesterday: Called in sick.");
  assert.ok(s.when);
  assert.equal(s.body, "Called in sick.");
  assert.equal(splitWhen("*Nice.").starred, true);
});

test("selectJots applies -n and @tags", () => {
  const jots = [
    makeJot("one @work", { createdAt: 1, id: "a" }),
    makeJot("two @home", { createdAt: 2, id: "b" }),
    makeJot("three @work", { createdAt: 3, id: "c" }),
  ];
  const last = selectJots(jots, { limit: 1 });
  assert.equal(last.length, 1);
  assert.equal(last[0].body, "three @work");
  const work = selectJots(jots, { tags: ["@work"] });
  assert.equal(work.length, 2);
});

test("formatJots --short is one line per entry", () => {
  const jots = [makeJot("hello\nworld", { createdAt: Date.parse("2026-01-02T15:04:00") })];
  const text = formatJots(jots, { short: true });
  assert.match(text, /hello/);
  assert.doesNotMatch(text, /world/);
});

test("config writes 600 under XDG_CONFIG_HOME", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jot-"));
  const env = { XDG_CONFIG_HOME: dir, HOME: dir };
  await saveConfig({ email: "a@b.com", token: "t" }, env);
  const path = configPath(env);
  const raw = await readFile(path, "utf8");
  assert.match(raw, /a@b.com/);
  const loaded = await loadConfig(env);
  assert.equal(loaded.token, "t");
  await rm(dir, { recursive: true, force: true });
});

test("addJot refuses to run without a session", async () => {
  await assert.rejects(() => addJot("hi", null), /jot login/);
});

test("addJot merges a new entry onto the remote journal", async () => {
  const salt = newSalt();
  const existing = [makeJot("already here", { id: "old", createdAt: 1, updatedAt: 1 })];
  const payload = await encryptPayload("password12", salt, { jots: existing });
  const prev = globalThis.fetch;
  let put;
  globalThis.fetch = async (_url, opts) => {
    if (opts?.method === "PUT") {
      put = JSON.parse(opts.body);
      return new Response(JSON.stringify({ rev: 2 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ rev: 1, payload }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const dir = await mkdtemp(join(tmpdir(), "jot-"));
  try {
    process.env.XDG_CONFIG_HOME = dir;
    process.env.HOME = dir;
    const cfg = {
      syncUrl: "https://sync.test",
      email: "a@b.com",
      token: "tok",
      encSalt: salt,
      entitled: true,
      password: "password12",
      rev: 0,
    };
    const { datetime, jot } = await addJot("from the terminal @work", cfg);
    assert.match(jot.body, /from the terminal/);
    assert.match(datetime, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.ok(put);
    const disk = JSON.parse(await readFile(configPath({ XDG_CONFIG_HOME: dir, HOME: dir }), "utf8"));
    assert.equal(disk.password, undefined);
  } finally {
    globalThis.fetch = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
