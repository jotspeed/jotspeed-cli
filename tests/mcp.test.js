process.env.JOTSPEED_KEYCHAIN = "memory";

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgv, usage } from "../src/lib.mjs";
import { makeJot } from "../src/core.js";
import { composeEntry, createServer, publicEntry, INSTRUCTIONS } from "../src/mcp.mjs";

test("parseArgv jot mcp starts the server", () => {
  assert.equal(parseArgv(["node", "jot", "mcp"]).cmd, "mcp");
  assert.match(usage(), /jot mcp/);
});

test("composeEntry applies when, star, and tags", () => {
  const text = composeEntry({
    body: "shipped the mixer fix",
    when: "yesterday",
    starred: true,
    tags: ["work", "@work"],
  });
  assert.match(text, /^\* yesterday: shipped the mixer fix @work$/);
  assert.throws(() => composeEntry({ body: "  " }), /Empty entry/);
  assert.throws(() => composeEntry({ body: "hi", when: "not a date" }), /Couldn’t read date/);
});

test("initialize advertises tools and private-journal instructions", async () => {
  const server = createServer();
  const res = await server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25" },
  });
  assert.equal(res.result.protocolVersion, "2025-11-25");
  assert.equal(res.result.serverInfo.name, "jotspeed");
  assert.equal(res.result.capabilities.tools.listChanged, false);
  assert.match(res.result.instructions, /jot login/);
  assert.equal(res.result.instructions, INSTRUCTIONS);
  assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
});

test("tools/list names post, search, get, and status", async () => {
  const server = createServer();
  const res = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(
    res.result.tools.map((t) => t.name),
    ["post", "search", "get", "status"]
  );
});

test("post calls addJot and a repeated id does not post twice", async () => {
  const posted = [];
  const deps = {
    loadConfig: async () => ({ token: "t", entitled: true, email: "a@b.com" }),
    loadJournal: async () => ({ jots: [] }),
    addJot: async (text, _cfg, extra) => {
      const existing = posted.find((e) => e.id === extra.id);
      if (existing) return { jot: existing, datetime: "2026-10-16 09:00", duplicate: true };
      const jot = makeJot(text.replace(/^\*\s*/, "").replace(/^yesterday:\s*/, ""), {
        id: extra.id,
        createdAt: Date.parse("2026-10-15T09:00:00"),
        starred: text.startsWith("*"),
      });
      posted.push(jot);
      return { jot, datetime: "2026-10-15 09:00" };
    },
  };
  const server = createServer(deps);
  const first = await server.handle({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "post",
      arguments: { body: "Called in sick.", when: "yesterday", starred: true, id: "retry-id-1" },
    },
  });
  const data = JSON.parse(first.result.content[0].text);
  assert.equal(data.posted, true);
  assert.equal(data.duplicate, false);
  assert.equal(data.id, "retry-id-1");
  assert.match(data.body, /Called in sick/);
  assert.equal(data.starred, true);

  const second = await server.handle({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "post", arguments: { body: "Called in sick.", id: "retry-id-1" } },
  });
  const again = JSON.parse(second.result.content[0].text);
  assert.equal(again.posted, false);
  assert.equal(again.duplicate, true);
  assert.equal(posted.length, 1);
});

test("search returns newest first and truncates long bodies", async () => {
  const long = "x".repeat(2500);
  const jots = [
    makeJot("old @home", { id: "old-entry", createdAt: 1 }),
    makeJot(long + " @work", { id: "new-entry", createdAt: 2 }),
  ];
  const deps = {
    loadConfig: async () => ({ token: "t", entitled: true }),
    loadJournal: async () => ({ jots }),
    addJot: async () => {
      throw new Error("search must not write");
    },
  };
  const server = createServer(deps);
  const res = await server.handle({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "search", arguments: { tags: ["work"], limit: 10 } },
  });
  const data = JSON.parse(res.result.content[0].text);
  assert.equal(data.total, 1);
  assert.equal(data.entries[0].id, "new-entry");
  assert.equal(data.entries[0].truncated, true);
  assert.ok(data.entries[0].body.length < long.length);

  const full = await server.handle({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "get", arguments: { id: "new-entry" } },
  });
  const got = JSON.parse(full.result.content[0].text);
  assert.equal(got.truncated, undefined);
  assert.equal(got.body.length, (long + " @work").length);
});

test("tool errors stay in the result so the agent can read them", async () => {
  const server = createServer({
    loadConfig: async () => null,
    loadJournal: async () => ({ jots: [] }),
    addJot: async () => {
      throw new Error("should not post");
    },
  });
  const missing = await server.handle({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "nope", arguments: {} },
  });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /Unknown tool/);

  const unsigned = await server.handle({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: { name: "post", arguments: { body: "hi" } },
  });
  assert.equal(unsigned.result.isError, true);
  assert.match(unsigned.result.content[0].text, /jot login/);

  const status = await server.handle({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name: "status", arguments: {} },
  });
  assert.equal(JSON.parse(status.result.content[0].text).signedIn, false);
});

test("publicEntry keeps the CLI stamp", () => {
  const e = makeJot("hello", { id: "abcdefgh", createdAt: Date.parse("2026-01-02T15:04:00") });
  const pub = publicEntry(e);
  assert.equal(pub.datetime, "2026-01-02 15:04");
  assert.equal(pub.body, "hello");
});

test("stdio server speaks initialize and status without a journal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jot-mcp-"));
  const child = spawn(process.execPath, [new URL("../src/mcp.mjs", import.meta.url).pathname], {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: dir,
      XDG_DATA_HOME: dir,
      HOME: dir,
      JOTSPEED_KEYCHAIN: "memory",
    },
  });
  const lines = [];
  let err = "";
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => lines.push(JSON.parse(line)));
  child.stderr.on("data", (chunk) => {
    err += chunk;
  });
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {} } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "status", arguments: {} } });
  child.stdin.end();
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  await rm(dir, { recursive: true, force: true });
  assert.equal(code, 0, err);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].result.serverInfo.name, "jotspeed");
  assert.equal(lines[1].result.tools.length, 4);
  assert.equal(JSON.parse(lines[2].result.content[0].text).signedIn, false);
});
