#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdin, stdout, stderr } from "node:process";
import { parseJrnl, tombstone } from "./core.js";
import { VERSION } from "./version.mjs";
import {
  parseArgv,
  usage,
  loadConfig,
  login,
  addJot,
  clearConfig,
  loadJournal,
  saveJournal,
  selectJots,
  formatJots,
  importText,
} from "./lib.mjs";

async function readStdin() {
  const chunks = [];
  for await (const c of stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function prompt(question) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function promptPassword(question) {
  stdout.write(question);
  return new Promise((resolve, reject) => {
    const buf = [];
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (value) => {
      stdin.removeListener("data", onData);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      resolve(value);
    };
    const onData = (ch) => {
      if (ch === "\n" || ch === "\r") return done(buf.join(""));
      if (ch === "\u0003") {
        stdout.write("\n");
        reject(new Error("Cancelled."));
        return;
      }
      if (ch === "\u007f" || ch === "\b") {
        buf.pop();
        return;
      }
      buf.push(ch);
    };
    stdin.on("data", onData);
  });
}

async function cmdLogin() {
  const email = await prompt("Email: ");
  const password = await promptPassword("Password: ");
  if (!email.includes("@") || password.length < 8) {
    throw new Error("Email and a password of at least 8 characters.");
  }
  const cfg = await login({ email, password });
  stdout.write(
    cfg.entitled
      ? `Signed in as ${cfg.email}. Sync is on.\n`
      : `Signed in as ${cfg.email}. The CLI needs Pro — subscribe in the app.\n`
  );
}

async function cmdCompose(parsed) {
  let body = parsed.body || "";
  if (parsed.stdin && !body) {
    if (stdin.isTTY) {
      const editor = process.env.EDITOR || process.env.VISUAL;
      if (editor) {
        body = (await editFile("")).trim();
      } else {
        stderr.write(usage());
        process.exitCode = 1;
        return;
      }
    } else {
      body = (await readStdin()).trim();
    }
  }
  const cfg = await loadConfig();
  const { datetime, jot } = await addJot(body, cfg);
  stdout.write(`[${datetime}] ${jot.body}\n`);
}

async function editFile(initial) {
  const dir = await mkdtemp(join(tmpdir(), "jot-"));
  const path = join(dir, "entry.txt");
  await writeFile(path, initial, "utf8");
  const editor = process.env.EDITOR || process.env.VISUAL || "nano";
  const parts = editor.split(/\s+/);
  const r = spawnSync(parts[0], [...parts.slice(1), path], { stdio: "inherit" });
  if (r.status) throw new Error("Editor exited without saving.");
  const text = await readFile(path, "utf8");
  await rm(dir, { recursive: true, force: true });
  return text;
}

async function cmdView(parsed) {
  const cfg = await loadConfig();
  const { jots, rev } = await loadJournal(cfg);
  let rows = selectJots(jots, parsed.filters);

  if (parsed.action.changeTime) {
    const when = (await import("./dates.mjs")).parseDate(parsed.action.changeTime);
    if (!when) throw new Error(`Couldn’t read date: ${parsed.action.changeTime}`);
    const ids = new Set(rows.map((e) => e.id));
    const next = jots.map((e) => {
      if (!ids.has(e.id)) return e;
      return { ...e, createdAt: when.getTime(), updatedAt: Date.now() };
    });
    await saveJournal(cfg, next, rev);
    rows = selectJots(next, parsed.filters);
  }

  if (parsed.action.edit) {
    const blob = formatJots(rows, { format: "text" });
    const edited = await editFile(blob);
    const parsedBack = parseJrnl(edited);
    if (!parsedBack.length) throw new Error("Nothing left to save.");
    const ids = rows.map((e) => e.id);
    let next = jots.slice();
    for (let i = 0; i < Math.max(ids.length, parsedBack.length); i++) {
      if (i < ids.length && i < parsedBack.length) {
        next = next.map((e) =>
          e.id === ids[i]
            ? { ...e, body: parsedBack[i].body, tags: parsedBack[i].tags, starred: parsedBack[i].starred, createdAt: parsedBack[i].createdAt, updatedAt: Date.now() }
            : e
        );
      } else if (i < ids.length) {
        next = next.map((e) => (e.id === ids[i] ? tombstone(e) : e));
      } else {
        next = [...next, parsedBack[i]];
      }
    }
    await saveJournal(cfg, next, rev);
    stdout.write(`Saved ${parsedBack.length} ${parsedBack.length === 1 ? "entry" : "entries"}.\n`);
    return;
  }

  if (parsed.action.delete) {
    if (!rows.length) {
      stdout.write("No matching entries.\n");
      return;
    }
    if (stdin.isTTY) {
      const ok = await prompt(`Delete ${rows.length} ${rows.length === 1 ? "entry" : "entries"}? [y/N] `);
      if (!/^y(es)?$/i.test(ok)) {
        stdout.write("Cancelled.\n");
        return;
      }
    }
    const ids = new Set(rows.map((e) => e.id));
    const next = jots.map((e) => (ids.has(e.id) ? tombstone(e) : e));
    await saveJournal(cfg, next, rev);
    stdout.write(`Deleted ${rows.length}.\n`);
    return;
  }

  const text = formatJots(rows, parsed.display);
  if (parsed.display.file) {
    await writeFile(parsed.display.file, text);
    stdout.write(`Wrote ${parsed.display.file}\n`);
    return;
  }
  stdout.write(text);
}

async function cmdImport(parsed) {
  const cfg = await loadConfig();
  let text = "";
  if (parsed.display.file) text = await readFile(parsed.display.file, "utf8");
  else text = await readStdin();
  const n = await importText(text, cfg);
  stdout.write(`Imported ${n} ${n === 1 ? "entry" : "entries"}.\n`);
}

async function main() {
  const parsed = parseArgv(process.argv);
  if (parsed.cmd === "help") {
    stdout.write(usage());
    return;
  }
  if (parsed.cmd === "version") {
    stdout.write(`${VERSION}\n`);
    return;
  }
  if (parsed.cmd === "login") {
    await cmdLogin();
    return;
  }
  if (parsed.cmd === "logout") {
    await clearConfig();
    stdout.write("Signed out.\n");
    return;
  }
  if (parsed.cmd === "import") {
    await cmdImport(parsed);
    return;
  }
  if (parsed.cmd === "view") {
    await cmdView(parsed);
    return;
  }
  await cmdCompose(parsed);
}

main().catch((err) => {
  stderr.write((err && err.message ? err.message : String(err)) + "\n");
  process.exitCode = 1;
});
