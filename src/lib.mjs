import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { makeJot, stamp, toTxt, parseJrnl, uniqueTags, tombstone, mergeJots } from "./core.js";
import { continueAccount, pullBlob, pushBlob } from "./sync.js";
import { deriveEncBits, encryptWithBits, decryptWithBits, bytesToB64, b64ToBytes } from "./crypto.js";
import { parseDate, dayBounds, isoDay } from "./dates.mjs";
import { setSecret, getSecret, deleteSecret, keychainAccount } from "./keychain.mjs";

export const DEFAULT_SYNC = "https://sync.jotspeed.com";

export function configDir(env = process.env) {
  const xdg = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(xdg, "jotspeed");
}

export function configPath(env = process.env) {
  return join(configDir(env), "config.json");
}

export function dataDir(env = process.env) {
  const xdg = env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share");
  return join(xdg, "jotspeed");
}

function cachePath(env = process.env) {
  return join(dataDir(env), "cache.bin");
}

const VALUE_FLAGS = new Set([
  "-n", "--limit",
  "-from", "-to", "-until", "-on", "-contains", "-not",
  "-month", "-day", "-year",
  "--format", "--export", "--file", "-o", "-i",
  "--change-time",
]);

function takeValue(args, i) {
  const next = args[i + 1];
  if (next == null || next.startsWith("-")) return { value: null, next: i };
  return { value: next, next: i + 1 };
}

export function parseArgv(argv) {
  const raw = argv.slice(2);
  const args = [];
  for (const a of raw) {
    const n = a.match(/^-(\d+)$/);
    if (n) {
      args.push("-n", n[1]);
      continue;
    }
    args.push(a);
  }

  const out = {
    cmd: "compose",
    body: "",
    stdin: false,
    filters: {
      limit: null,
      from: null,
      to: null,
      on: null,
      contains: [],
      tags: [],
      matchAll: false,
      starred: false,
      tagged: false,
      excludeTags: [],
      excludeStarred: false,
      excludeTagged: false,
      month: null,
      day: null,
      year: null,
      todayInHistory: false,
    },
    display: { short: false, tags: false, format: "text", file: null },
    action: { edit: false, delete: false, changeTime: null, import: false },
  };

  if (args.includes("-h") || args.includes("--help")) return { ...out, cmd: "help" };
  if (args.includes("-v") || args.includes("--version")) return { ...out, cmd: "version" };

  const tokens = [];
  let viewing = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "login" && i === 0 && args.length === 1) return { ...out, cmd: "login" };
    if (a === "logout" && i === 0 && args.length === 1) return { ...out, cmd: "logout" };
    if (a === "--import") {
      out.action.import = true;
      viewing = true;
      continue;
    }
    if (a === "--edit") {
      out.action.edit = true;
      viewing = true;
      continue;
    }
    if (a === "--delete") {
      out.action.delete = true;
      viewing = true;
      continue;
    }
    if (a === "--tags") {
      out.display.tags = true;
      viewing = true;
      continue;
    }
    if (a === "--short" || a === "-s") {
      out.display.short = true;
      viewing = true;
      continue;
    }
    if (a === "-starred") {
      out.filters.starred = true;
      viewing = true;
      continue;
    }
    if (a === "-tagged") {
      out.filters.tagged = true;
      viewing = true;
      continue;
    }
    if (a === "-and") {
      out.filters.matchAll = true;
      viewing = true;
      continue;
    }
    if (a === "-today-in-history") {
      out.filters.todayInHistory = true;
      viewing = true;
      continue;
    }
    if (a === "-not") {
      viewing = true;
      const peek = args[i + 1];
      if (peek === "-starred") {
        out.filters.excludeStarred = true;
        i++;
        continue;
      }
      if (peek === "-tagged") {
        out.filters.excludeTagged = true;
        i++;
        continue;
      }
      const { value, next } = takeValue(args, i);
      if (value) out.filters.excludeTags.push(value.startsWith("@") ? value.toLowerCase() : "@" + value.toLowerCase());
      i = next;
      continue;
    }
    if (a === "-n" || a === "--limit") {
      viewing = true;
      const { value, next } = takeValue(args, i);
      if (value != null) out.filters.limit = Number(value);
      i = next;
      continue;
    }
    if (a === "-from") {
      viewing = true;
      const { value, next } = takeValue(args, i);
      out.filters.from = value;
      i = next;
      continue;
    }
    if (a === "-to" || a === "-until") {
      viewing = true;
      const { value, next } = takeValue(args, i);
      out.filters.to = value;
      i = next;
      continue;
    }
    if (a === "-on") {
      viewing = true;
      const { value, next } = takeValue(args, i);
      out.filters.on = value;
      i = next;
      continue;
    }
    if (a === "-contains") {
      viewing = true;
      const { value, next } = takeValue(args, i);
      if (value) out.filters.contains.push(value);
      i = next;
      continue;
    }
    if (a === "-month") {
      viewing = true;
      const { value, next } = takeValue(args, i);
      out.filters.month = value;
      i = next;
      continue;
    }
    if (a === "-day") {
      viewing = true;
      const { value, next } = takeValue(args, i);
      out.filters.day = value;
      i = next;
      continue;
    }
    if (a === "-year") {
      viewing = true;
      const { value, next } = takeValue(args, i);
      out.filters.year = value;
      i = next;
      continue;
    }
    if (a === "--format" || a === "--export") {
      viewing = true;
      const { value, next } = takeValue(args, i);
      out.display.format = (value || "text").toLowerCase();
      i = next;
      continue;
    }
    if (a === "--file" || a === "-o" || a === "-i") {
      const { value, next } = takeValue(args, i);
      out.display.file = value;
      i = next;
      continue;
    }
    if (a === "--change-time") {
      viewing = true;
      const { value, next } = takeValue(args, i);
      out.action.changeTime = value || "now";
      i = next;
      continue;
    }
    if (a === "-") {
      out.stdin = true;
      continue;
    }
    if (a.startsWith("-")) {
      viewing = true;
      continue;
    }
    tokens.push(a);
  }

  const tags = tokens.filter((t) => t.startsWith("@"));
  const words = tokens.filter((t) => !t.startsWith("@"));
  out.filters.tags = tags.map((t) => t.toLowerCase());
  if (tags.length) viewing = true;
  out.body = words.join(" ").trim();

  if (!args.length) {
    out.cmd = "compose";
    out.stdin = true;
    return out;
  }
  if (out.action.import) {
    out.cmd = "import";
    return out;
  }
  if (viewing) {
    out.cmd = "view";
    if (out.body) out.filters.contains.push(out.body);
    out.body = "";
    return out;
  }
  if (out.stdin || out.body) {
    out.cmd = "compose";
    return out;
  }
  out.cmd = "compose";
  out.stdin = true;
  return out;
}

export function usage() {
  return `jot — Jotspeed on the command line (Pro)

Install:  npm install -g github:jotspeed/jotspeed-cli
Sign in:  jot login

Write
  jot "shipped the mixer fix @work"
  jot yesterday: Called in sick.
  jot *Best day of the year.
  echo "from a pipe" | jot

Read
  jot -1                 last entry
  jot -n 10              last 10
  jot -on yesterday
  jot -from "last month" -to today
  jot @work
  jot @work @home -and
  jot -contains invoice
  jot -starred
  jot -today-in-history

Format
  jot -n 20 --short
  jot --tags
  jot --format json
  jot --format markdown --file notes.md

Edit
  jot --edit -1
  jot --delete -1
  jot --change-time yesterday --edit -1

Import a text export
  jot --import --file journal.txt

Other
  jot logout
  jot --version
`;
}

function publicConfig(cfg) {
  const { password, keyBits, ...rest } = cfg || {};
  return rest;
}

export async function loadConfig(env = process.env) {
  let cfg;
  try {
    cfg = JSON.parse(await readFile(configPath(env), "utf8"));
  } catch {
    return null;
  }
  if (cfg.password && cfg.email) {
    await setSecret(keychainAccount(cfg.email, "password"), cfg.password);
    if (cfg.encSalt) {
      const bits = await deriveEncBits(cfg.password, cfg.encSalt);
      await setSecret(keychainAccount(cfg.email, "enc"), bytesToB64(bits));
    }
    delete cfg.password;
    await saveConfig(cfg, env);
  }
  return cfg;
}

export async function saveConfig(cfg, env = process.env) {
  const dir = configDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = configPath(env);
  await writeFile(path, JSON.stringify(publicConfig(cfg), null, 2) + "\n", { mode: 0o600 });
  return path;
}

export async function clearConfig(env = process.env) {
  const cfg = await loadConfig(env).catch(() => null);
  if (cfg?.email) {
    await deleteSecret(keychainAccount(cfg.email, "password"));
    await deleteSecret(keychainAccount(cfg.email, "enc"));
  }
  await rm(configPath(env), { force: true });
  await rm(cachePath(env), { force: true });
}

async function sessionPassword(cfg) {
  if (cfg.password) return cfg.password;
  if (process.env.JOTSPEED_PASSWORD) return process.env.JOTSPEED_PASSWORD;
  if (!cfg.email) return null;
  return getSecret(keychainAccount(cfg.email, "password"));
}

export async function sessionBits(cfg) {
  if (cfg.keyBits) return cfg.keyBits instanceof Uint8Array ? cfg.keyBits : b64ToBytes(cfg.keyBits);
  if (cfg.email) {
    const stored = await getSecret(keychainAccount(cfg.email, "enc"));
    if (stored) return b64ToBytes(stored);
  }
  const password = await sessionPassword(cfg);
  if (!password || !cfg.encSalt) throw new Error("Not signed in. Run: jot login");
  const bits = await deriveEncBits(password, cfg.encSalt);
  if (cfg.email) await setSecret(keychainAccount(cfg.email, "enc"), bytesToB64(bits));
  return bits;
}

function requireSession(cfg) {
  if (!cfg?.token) throw new Error("Not signed in. Run: jot login");
  if (!cfg.entitled) throw new Error("The CLI is a Pro feature. Subscribe in the app, then jot login.");
}

export async function login({ email, password, syncUrl = DEFAULT_SYNC }) {
  const data = await continueAccount(syncUrl, email, password);
  if (!data.token) throw new Error(data.error || "Sign in failed.");
  const bits = await deriveEncBits(password, data.encSalt);
  await setSecret(keychainAccount(data.email, "password"), password);
  await setSecret(keychainAccount(data.email, "enc"), bytesToB64(bits));
  const cfg = {
    syncUrl,
    email: data.email,
    token: data.token,
    encSalt: data.encSalt,
    entitled: Boolean(data.entitled),
    rev: 0,
  };
  await saveConfig(cfg);
  cfg.keyBits = bits;
  return cfg;
}

async function readCache(bits, env) {
  try {
    const packed = JSON.parse(await readFile(cachePath(env), "utf8"));
    return await decryptWithBits(bits, packed);
  } catch {
    return null;
  }
}

async function writeCache(bits, payload, env) {
  await mkdir(dataDir(env), { recursive: true, mode: 0o700 });
  const packed = await encryptWithBits(bits, payload);
  await writeFile(cachePath(env), JSON.stringify(packed), { mode: 0o600 });
}

export async function loadJournal(cfg, env = process.env) {
  requireSession(cfg);
  const bits = await sessionBits(cfg);
  const cached = await readCache(bits, env);
  try {
    const remote = await pullBlob(cfg.syncUrl || DEFAULT_SYNC, cfg.token, cfg.rev || 0);
    if (!remote.payload) {
      if (cached?.jots) return { jots: cached.jots, rev: cached.rev || cfg.rev || 0, bits };
      return { jots: [], rev: remote.rev || 0, bits };
    }
    const decoded = await decryptWithBits(bits, remote.payload);
    const jots = decoded.jots || [];
    const rev = remote.rev || 0;
    await writeCache(bits, { jots, rev }, env);
    cfg.rev = rev;
    await saveConfig(cfg, env);
    return { jots, rev, bits };
  } catch (err) {
    if (err.status === 304 && cached?.jots) return { jots: cached.jots, rev: cached.rev || cfg.rev || 0, bits };
    if (err.status === 304) {
      const remote = await pullBlob(cfg.syncUrl || DEFAULT_SYNC, cfg.token);
      const decoded = await decryptWithBits(bits, remote.payload);
      const jots = decoded.jots || [];
      const rev = remote.rev || 0;
      await writeCache(bits, { jots, rev }, env);
      return { jots, rev, bits };
    }
    throw err;
  }
}

export async function saveJournal(cfg, jots, rev, bits, env = process.env) {
  requireSession(cfg);
  const key = bits || (await sessionBits(cfg));
  const payload = await encryptWithBits(key, { jots });
  const saved = await pushBlob(cfg.syncUrl || DEFAULT_SYNC, cfg.token, rev, payload);
  cfg.rev = saved.rev;
  await saveConfig(cfg, env);
  await writeCache(key, { jots, rev: saved.rev }, env);
  return saved.rev;
}

export function splitWhen(text) {
  const src = String(text || "").trim();
  const m = src.match(/^(\*[ \t]+)?(.+?):\s+([\s\S]+)$/);
  if (!m) {
    let body = src;
    let starred = false;
    if (body.startsWith("*")) {
      starred = true;
      body = body.replace(/^\*\s*/, "");
    }
    return { when: null, body, starred };
  }
  const when = parseDate(m[2]);
  if (!when) {
    let body = src;
    let starred = false;
    if (body.startsWith("*")) {
      starred = true;
      body = body.replace(/^\*\s*/, "");
    }
    return { when: null, body, starred };
  }
  return { when, body: m[3].trim(), starred: Boolean(m[1]) };
}

export async function addJot(text, cfg) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Empty entry.");
  requireSession(cfg);
  const { when, body, starred } = splitWhen(raw);
  const jot = makeJot(body, { createdAt: when ? when.getTime() : undefined, starred });
  const { jots, rev, bits } = await loadJournal(cfg);
  const merged = mergeJots([jot], jots);
  await saveJournal(cfg, merged, rev, bits);
  const { datetime } = stamp(jot.createdAt);
  return { jot, datetime };
}

export function selectJots(jots, filters = {}) {
  let rows = (jots || []).filter((e) => !e.deletedAt).sort((a, b) => b.createdAt - a.createdAt);
  const f = filters;

  if (f.starred) rows = rows.filter((e) => e.starred);
  if (f.excludeStarred) rows = rows.filter((e) => !e.starred);
  if (f.tagged) rows = rows.filter((e) => (e.tags || []).length);
  if (f.excludeTagged) rows = rows.filter((e) => !(e.tags || []).length);

  if (f.on) {
    const d = parseDate(f.on);
    if (!d) throw new Error(`Couldn’t read date: ${f.on}`);
    const b = dayBounds(d);
    rows = rows.filter((e) => e.createdAt >= b.from && e.createdAt <= b.to);
  }
  if (f.from) {
    const d = parseDate(f.from);
    if (!d) throw new Error(`Couldn’t read date: ${f.from}`);
    rows = rows.filter((e) => e.createdAt >= d.getTime());
  }
  if (f.to) {
    const d = parseDate(f.to, { end: true });
    if (!d) throw new Error(`Couldn’t read date: ${f.to}`);
    rows = rows.filter((e) => e.createdAt <= d.getTime());
  }
  if (f.todayInHistory) {
    const now = new Date();
    rows = rows.filter((e) => {
      const d = new Date(e.createdAt);
      return d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    });
  }
  if (f.month != null) {
    const n = Number(f.month);
    const idx = Number.isFinite(n) ? n - 1 : parseDate(`1 ${f.month} 2000`)?.getMonth();
    if (idx == null || idx < 0) throw new Error(`Couldn’t read month: ${f.month}`);
    rows = rows.filter((e) => new Date(e.createdAt).getMonth() === idx);
  }
  if (f.day != null) {
    const n = Number(f.day);
    rows = rows.filter((e) => new Date(e.createdAt).getDate() === n);
  }
  if (f.year != null) {
    const n = Number(f.year);
    rows = rows.filter((e) => new Date(e.createdAt).getFullYear() === n);
  }

  const wanted = (f.tags || []).map((t) => (t.startsWith("@") ? t : "@" + t).toLowerCase());
  if (wanted.length) {
    rows = rows.filter((e) => {
      const have = new Set(e.tags || []);
      return f.matchAll ? wanted.every((t) => have.has(t)) : wanted.some((t) => have.has(t));
    });
  }
  if (f.excludeTags?.length) {
    const no = f.excludeTags.map((t) => t.toLowerCase());
    rows = rows.filter((e) => {
      const have = new Set(e.tags || []);
      return !no.some((t) => have.has(t));
    });
  }

  const needles = (f.contains || []).map((s) => String(s).toLowerCase()).filter(Boolean);
  if (needles.length) {
    rows = rows.filter((e) => {
      const body = (e.body || "").toLowerCase();
      return f.matchAll ? needles.every((n) => body.includes(n)) : needles.some((n) => body.includes(n));
    });
  }

  if (f.limit != null && Number.isFinite(f.limit)) rows = rows.slice(0, Math.max(0, f.limit));
  return rows;
}

export function formatJots(jots, display = {}) {
  const rows = [...jots].sort((a, b) => a.createdAt - b.createdAt);
  if (display.tags) {
    return uniqueTags(rows).map(({ tag, count }) => `${tag}: ${count}`).join("\n") + (rows.length ? "\n" : "");
  }
  const fmt = display.format || "text";
  if (fmt === "json") {
    return JSON.stringify(
      rows.map((e) => ({
        id: e.id,
        createdAt: new Date(e.createdAt).toISOString(),
        body: e.body,
        tags: e.tags,
        starred: Boolean(e.starred),
      })),
      null,
      2
    ) + "\n";
  }
  if (fmt === "markdown" || fmt === "md") {
    return rows
      .map((e) => {
        const { datetime } = stamp(e.createdAt);
        const star = e.starred ? " ★" : "";
        return `## ${datetime}${star}\n\n${e.body}\n`;
      })
      .join("\n");
  }
  if (display.short) {
    return rows
      .map((e) => {
        const { datetime } = stamp(e.createdAt);
        const star = e.starred ? "* " : "";
        const line = (e.body || "").split("\n")[0];
        return `[${datetime}] ${star}${line}`;
      })
      .join("\n") + (rows.length ? "\n" : "");
  }
  return toTxt(rows);
}

export async function importText(text, cfg) {
  requireSession(cfg);
  const incoming = parseJrnl(text);
  if (!incoming.length) throw new Error("No entries found in that file.");
  const { jots, rev } = await loadJournal(cfg);
  const merged = mergeJots(jots, incoming);
  await saveJournal(cfg, merged, rev);
  return incoming.length;
}
