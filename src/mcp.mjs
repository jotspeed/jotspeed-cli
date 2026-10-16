#!/usr/bin/env node
/**
 * Local MCP server for the signed-in Jotspeed journal.
 * Stdio, newline-delimited JSON-RPC. The key stays in the OS keychain.
 */
import { createInterface } from "node:readline";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stdin, stdout, stderr } from "node:process";
import { stamp, normalizeTag, parseTags } from "./core.js";
import { parseDate } from "./dates.mjs";
import { loadConfig, addJot, loadJournal, selectJots, refreshEntitlement, DEFAULT_SYNC } from "./lib.mjs";
import { VERSION } from "./version.mjs";

export const PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
export const DEFAULT_PROTOCOL = "2025-03-26";
const MAX_BODY = 100_000;
const SEARCH_BODY = 2_000;
const ID_RE = /^[\w-]{8,80}$/;

export const INSTRUCTIONS = `Jotspeed is the user's private journal. Entries are end-to-end encrypted and sync to the same Pro backup as the app.

Post only when the user asks you to jot, log, or save something in Jotspeed. Write one short entry in plain text. Put @tags in the body when they fit. Do not post chat logs, passwords, or anything they did not ask to record.

Search when they ask what they wrote, or before posting if a duplicate is likely. status checks sign-in and does not return entries.

This server cannot edit or delete. If signedIn is false, tell them to run jot login. Never ask them to paste a password into chat.`;

const stringProp = (description) => ({ type: "string", description });

export const TOOLS = [
  {
    name: "post",
    title: "Post a jot",
    description:
      "Post one timestamped entry to the signed-in Jotspeed journal. Call only when the user asked to jot, log, or save something in Jotspeed. Do not post chat dumps or secrets. Pass a stable id if you may retry; the same id will not post twice.",
    inputSchema: {
      type: "object",
      properties: {
        body: stringProp("Entry text. @tags in the text become tags. Keep it short."),
        when: stringProp("Optional time, same phrases as the CLI: yesterday, today, 2026-01-15, 3pm. Omit for now."),
        starred: { type: "boolean", description: "Star the entry. Default false." },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Extra tags, with or without @. Tags already in the body are not repeated.",
        },
        id: stringProp("Optional stable id (8–80 letters, numbers, _ or -) so a retry does not post twice."),
      },
      required: ["body"],
      additionalProperties: false,
    },
    annotations: {
      title: "Post a jot",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "search",
    title: "Search jots",
    description:
      "Read entries from the signed-in Jotspeed journal, newest first. Use when the user asks what they wrote, or to avoid posting a duplicate. Long bodies are truncated; call get for the full entry.",
    inputSchema: {
      type: "object",
      properties: {
        contains: stringProp("Substring match in the body."),
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags, with or without @. Matches any unless matchAll is true.",
        },
        matchAll: { type: "boolean", description: "Require every tag and every contains needle. Default false." },
        from: stringProp("Start of a range. Same date phrases as the CLI."),
        to: stringProp("End of a range, inclusive."),
        on: stringProp("A single day, such as yesterday or 2026-01-15."),
        starred: { type: "boolean", description: "Only starred entries when true." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "How many to return. Default 10. Max 50." },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Search jots",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "get",
    title: "Read one jot",
    description: "Read one entry by id, including the full body. Use after search when a body was truncated.",
    inputSchema: {
      type: "object",
      properties: {
        id: stringProp("Entry id from search or post."),
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: {
      title: "Read one jot",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "status",
    title: "Jotspeed sign-in",
    description: "Check whether jot is signed in and Pro sync is on. Does not return journal entries.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: {
      title: "Jotspeed sign-in",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
];

export function composeEntry({ body, when, starred, tags } = {}) {
  if (typeof body !== "string") throw new Error("body must be text.");
  let text = body.trim();
  if (!text) throw new Error("Empty entry.");
  if (text.length > MAX_BODY) throw new Error("Entry is too long.");
  if (starred != null && typeof starred !== "boolean") throw new Error("starred must be true or false.");
  text = appendTags(text, tags);
  if (when != null && when !== "") {
    if (typeof when !== "string" || !parseDate(when)) throw new Error(`Couldn’t read date: ${when}`);
    text = `${when}: ${text}`;
  }
  if (starred && !/^\*\s/.test(text)) text = `* ${text}`;
  return text;
}

function appendTags(body, tags) {
  if (tags == null) return body;
  if (!Array.isArray(tags)) throw new Error("tags must be a list.");
  const have = new Set(parseTags(body));
  const extra = [];
  for (const raw of tags) {
    if (typeof raw !== "string") throw new Error("tags must be strings.");
    const tag = normalizeTag(raw);
    if (!tag || tag === "@") continue;
    if (!/^@[\p{L}\p{N}_-]{1,40}$/u.test(tag)) throw new Error(`Couldn’t read tag: ${raw}`);
    if (have.has(tag)) continue;
    have.add(tag);
    extra.push(tag);
  }
  if (!extra.length) return body;
  return `${body}${body.endsWith("\n") ? "" : " "}${extra.join(" ")}`;
}

function checkId(id) {
  if (id == null || id === "") return undefined;
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Error("id must be 8–80 letters, numbers, _ or -.");
  return id;
}

export function publicEntry(entry, { truncate = false } = {}) {
  let body = entry.body || "";
  let truncated = false;
  if (truncate && body.length > SEARCH_BODY) {
    body = body.slice(0, SEARCH_BODY);
    truncated = true;
  }
  const { datetime } = stamp(entry.createdAt);
  const out = {
    id: entry.id,
    datetime,
    createdAt: new Date(entry.createdAt).toISOString(),
    body,
    tags: entry.tags || [],
    starred: Boolean(entry.starred),
  };
  if (truncated) out.truncated = true;
  return out;
}

function searchFilters(args = {}) {
  const limit = args.limit == null ? 10 : args.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("limit must be an integer from 1 to 50.");
  let contains = [];
  if (args.contains != null) {
    if (typeof args.contains !== "string") throw new Error("contains must be text.");
    if (args.contains) contains = [args.contains];
  }
  let tags = [];
  if (args.tags != null) {
    if (!Array.isArray(args.tags)) throw new Error("tags must be a list.");
    tags = args.tags.map((t) => {
      if (typeof t !== "string") throw new Error("tags must be strings.");
      return t;
    });
  }
  for (const key of ["from", "to", "on"]) {
    if (args[key] != null && typeof args[key] !== "string") throw new Error(`${key} must be text.`);
  }
  if (args.starred != null && typeof args.starred !== "boolean") throw new Error("starred must be true or false.");
  if (args.matchAll != null && typeof args.matchAll !== "boolean") throw new Error("matchAll must be true or false.");
  return {
    limit,
    from: args.from || null,
    to: args.to || null,
    on: args.on || null,
    contains,
    tags,
    matchAll: Boolean(args.matchAll),
    starred: Boolean(args.starred),
  };
}

async function requireCfg(deps) {
  const cfg = await deps.loadConfig();
  if (!cfg?.token) throw new Error("Not signed in. Run: jot login");
  if (!cfg.entitled) throw new Error("The CLI is a Pro feature. Subscribe in the app, then jot login.");
  return cfg;
}

export async function callTool(name, args = {}, deps = defaultDeps) {
  if (name === "status") return status(deps);
  if (name === "post") return post(args, deps);
  if (name === "search") return search(args, deps);
  if (name === "get") return getEntry(args, deps);
  throw new Error(`Unknown tool: ${name}`);
}

async function status(deps) {
  const cfg = await deps.loadConfig();
  if (!cfg?.token) return { signedIn: false, entitled: false, hint: "Run: jot login" };
  if (deps.refreshEntitlement) await deps.refreshEntitlement(cfg);
  const out = {
    signedIn: true,
    email: cfg.email || null,
    entitled: Boolean(cfg.entitled),
    syncUrl: cfg.syncUrl || DEFAULT_SYNC,
  };
  if (!out.entitled) out.hint = "Subscribe in the app, then jot login.";
  return out;
}

async function post(args, deps) {
  const id = checkId(args.id);
  const text = composeEntry(args);
  const cfg = await requireCfg(deps);
  const { jot, datetime, duplicate } = await deps.addJot(text, cfg, { id });
  return {
    posted: !duplicate,
    duplicate: Boolean(duplicate),
    ...publicEntry(jot),
    datetime,
  };
}

async function search(args, deps) {
  const filters = searchFilters(args);
  const cfg = await requireCfg(deps);
  const { jots } = await deps.loadJournal(cfg);
  const matched = selectJots(jots, { ...filters, limit: null });
  const rows = matched.slice(0, filters.limit);
  return {
    count: rows.length,
    total: matched.length,
    entries: rows.map((e) => publicEntry(e, { truncate: true })),
  };
}

async function getEntry(args, deps) {
  const id = checkId(args.id);
  if (!id) throw new Error("id is required.");
  const cfg = await requireCfg(deps);
  const { jots } = await deps.loadJournal(cfg);
  const found = jots.find((e) => e.id === id && !e.deletedAt);
  if (!found) throw new Error("No entry with that id.");
  return publicEntry(found);
}

export const defaultDeps = { loadConfig, addJot, loadJournal, refreshEntitlement };

function negotiate(clientVersion) {
  return PROTOCOL_VERSIONS.includes(clientVersion) ? clientVersion : DEFAULT_PROTOCOL;
}

function toolResult(data, isError = false) {
  const result = {
    content: [{ type: "text", text: isError ? String(data) : JSON.stringify(data, null, 2) }],
  };
  if (isError) result.isError = true;
  return result;
}

export function createServer(deps = defaultDeps) {
  let chain = Promise.resolve();
  const exclusive = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => {},
      () => {}
    );
    return run;
  };

  async function handle(msg) {
    if (Array.isArray(msg)) {
      const out = [];
      for (const item of msg) {
        const r = await handle(item);
        if (r) out.push(r);
      }
      return out.length ? out : null;
    }
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return { jsonrpc: "2.0", id: msg && msg.id != null ? msg.id : null, error: { code: -32600, message: "Invalid request" } };
    }
    const notify = !Object.hasOwn(msg, "id");
    const id = msg.id;
    const fail = (code, message) => (notify ? null : { jsonrpc: "2.0", id, error: { code, message } });

    if (msg.method === "initialize") {
      if (notify) return null;
      const params = msg.params || {};
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: negotiate(params.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "jotspeed", version: VERSION },
          instructions: INSTRUCTIONS,
        },
      };
    }
    if (msg.method === "notifications/initialized" || msg.method === "initialized") return notify ? null : { jsonrpc: "2.0", id, result: {} };
    if (msg.method === "ping") return notify ? null : { jsonrpc: "2.0", id, result: {} };
    if (msg.method === "tools/list") {
      if (notify) return null;
      if (msg.params?.cursor) return fail(-32602, "Invalid cursor");
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    }
    if (msg.method === "tools/call") {
      if (notify) return null;
      const name = msg.params?.name;
      const args = msg.params?.arguments || {};
      if (typeof name !== "string" || !name) return fail(-32602, "Missing tool name");
      if (args != null && typeof args !== "object") return fail(-32602, "arguments must be an object");
      try {
        const data = await exclusive(() => callTool(name, args, deps));
        return { jsonrpc: "2.0", id, result: toolResult(data) };
      } catch (err) {
        return { jsonrpc: "2.0", id, result: toolResult(err && err.message ? err.message : "Failed.", true) };
      }
    }
    if (msg.method.startsWith("notifications/")) return null;
    return fail(-32601, `Method not found: ${msg.method}`);
  }

  return { handle };
}

function writeMessage(msg) {
  stdout.write(JSON.stringify(msg) + "\n");
}

export async function serve(deps = defaultDeps) {
  const server = createServer(deps);
  const rl = createInterface({ input: stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    try {
      const response = await server.handle(msg);
      if (response) writeMessage(response);
    } catch (err) {
      const id = msg && !Array.isArray(msg) && msg.id != null ? msg.id : null;
      writeMessage({ jsonrpc: "2.0", id, error: { code: -32603, message: err && err.message ? err.message : "Internal error" } });
    }
  }
}

function invokedDirectly() {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(arg) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  serve().catch((err) => {
    stderr.write((err && err.message ? err.message : String(err)) + "\n");
    process.exitCode = 1;
  });
}
