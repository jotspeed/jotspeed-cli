/** Pure journal logic. No DOM. Safe to test in Node. */

export const VERSION = "52";

export const TAG_RE = /(?:^|[\s(])(@[\p{L}\p{N}_-]{1,40})/gu;

export const PRO_CODE = "JOTSPEED-FOUNDER";

export const FREE_FEATURES = ["jot", "tags", "search", "export-txt", "export-pdf", "import", "date-range", "match-all-tags"];
export const PRO_FEATURES = ["sync"];

export function uid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "jot-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

export function parseTags(text) {
  if (!text) return [];
  const tags = new Set();
  const re = new RegExp(TAG_RE.source, "gu");
  let m;
  while ((m = re.exec(text))) tags.add(m[1].toLowerCase());
  return [...tags];
}

export function normalizeTag(raw) {
  if (!raw) return "";
  let t = String(raw).trim();
  if (!t) return "";
  if (!t.startsWith("@")) t = "@" + t.replace(/^#/, "");
  return t.toLowerCase();
}

export function parseQuery(q) {
  const raw = (q || "").trim();
  const tags = parseTags(raw);
  const text = raw
    .replace(new RegExp(TAG_RE.source, "gu"), " ")
    .replace(/\s+/g, " ")
    .trim();
  return { text, tags };
}

export function uniqueTags(entries) {
  const counts = new Map();
  for (const e of entries) {
    if (e.deletedAt) continue;
    for (const t of e.tags || []) {
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => ({ tag, count }));
}

export function filterEntries(entries, opts = {}) {
  const {
    query = "",
    tags = [],
    matchAll = false,
    from = null,
    to = null,
    starred = false,
  } = opts;
  const parsed = parseQuery(query);
  const wanted = [...new Set([...tags.map(normalizeTag).filter(Boolean), ...parsed.tags])];
  const needle = parsed.text.toLowerCase();

  return entries.filter((e) => {
    if (e.deletedAt) return false;
    if (starred && !e.starred) return false;
    if (from != null && e.createdAt < from) return false;
    if (to != null && e.createdAt > to) return false;
    if (needle && !(e.body || "").toLowerCase().includes(needle)) return false;
    if (wanted.length) {
      const have = new Set(e.tags || []);
      if (matchAll) {
        if (!wanted.every((t) => have.has(t))) return false;
      } else if (!wanted.some((t) => have.has(t))) {
        return false;
      }
    }
    return true;
  });
}

export function pad(n) {
  return String(n).padStart(2, "0");
}

export function stamp(ms, { seconds = false } = {}) {
  const d = new Date(ms);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}${seconds ? ":" + pad(d.getSeconds()) : ""}`;
  return { date, time, datetime: `${date} ${time}` };
}

export function formatClock(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function dayLabel(ms, now = Date.now()) {
  const key = dayKey(ms);
  if (key === dayKey(now)) return "Today";
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (key === dayKey(y.getTime())) return "Yesterday";
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: new Date(ms).getFullYear() === new Date(now).getFullYear() ? undefined : "numeric",
  });
}

export function groupByDay(entries) {
  const groups = [];
  let current = null;
  for (const e of entries) {
    const key = dayKey(e.createdAt);
    if (!current || current.key !== key) {
      current = { key, label: dayLabel(e.createdAt), entries: [] };
      groups.push(current);
    }
    current.entries.push(e);
  }
  return groups;
}

export function makeJot(body, extra = {}) {
  const now = extra.createdAt || Date.now();
  const text = (body || "").trim();
  return {
    id: extra.id || uid(),
    createdAt: now,
    updatedAt: extra.updatedAt || now,
    body: text,
    tags: parseTags(text),
    starred: Boolean(extra.starred),
    deletedAt: extra.deletedAt || null,
  };
}

export function tombstone(entry, at = Date.now()) {
  return {
    ...entry,
    body: "",
    tags: [],
    deletedAt: at,
    updatedAt: at,
  };
}

export function mergeJots(local, remote) {
  const map = new Map();
  for (const j of [...local, ...remote]) {
    if (!j || !j.id) continue;
    const prev = map.get(j.id);
    if (!prev || (j.updatedAt || 0) > (prev.updatedAt || 0)) map.set(j.id, j);
  }
  return [...map.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function toTxt(entries) {
  const sorted = [...entries].filter((e) => !e.deletedAt).sort((a, b) => a.createdAt - b.createdAt);
  return sorted
    .map((e) => {
      const { datetime } = stamp(e.createdAt);
      const star = e.starred ? "* " : "";
      return `[${datetime}] ${star}${e.body}`;
    })
    .join("\n\n") + (sorted.length ? "\n" : "");
}

function pdfEscape(s) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function toWinAnsi(s) {
  const map = {
    "\u2018": "'",
    "\u2019": "'",
    "\u201c": '"',
    "\u201d": '"',
    "\u2013": "-",
    "\u2014": "--",
    "\u2026": "...",
    "\u00a0": " ",
  };
  return Array.from(s)
    .map((ch) => {
      if (map[ch]) return map[ch];
      const c = ch.codePointAt(0);
      if (c === 10 || c === 13) return ch;
      if (c >= 32 && c <= 126) return ch;
      return "?";
    })
    .join("");
}

function wrapLine(line, width = 86) {
  if (line.length <= width) return [line];
  const words = line.split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? cur + " " + w : w;
    if (next.length > width && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

export function toPdfBytes(entries, title = "Jotspeed journal") {
  const sorted = [...entries].filter((e) => !e.deletedAt).sort((a, b) => a.createdAt - b.createdAt);
  const header = toWinAnsi(title);
  const lines = [];
  for (const e of sorted) {
    const { datetime } = stamp(e.createdAt);
    lines.push(`[${datetime}]`);
    for (const raw of (e.body || "").split("\n")) {
      for (const w of wrapLine(toWinAnsi(raw))) lines.push(w);
    }
    lines.push("");
  }
  if (!lines.length) lines.push("(no jots)");

  const pageW = 612;
  const pageH = 792;
  const margin = 54;
  const fontSize = 11;
  const leading = 15;
  const usable = pageH - margin * 2 - 28;
  const perPage = Math.max(1, Math.floor(usable / leading));
  const chunks = [];
  for (let i = 0; i < lines.length; i += perPage) chunks.push(lines.slice(i, i + perPage));

  const objects = [];
  const add = (s) => {
    objects.push(s);
    return objects.length;
  };

  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>");
  const contentIds = [];
  const pageIds = [];

  chunks.forEach((chunk, idx) => {
    let y = pageH - margin - 12;
    const ops = [];
    ops.push("BT");
    ops.push("/F1 9 Tf");
    ops.push(`1 0 0 1 ${margin} ${y} Tm`);
    ops.push(`(${pdfEscape(header + "  ·  " + (idx + 1) + "/" + chunks.length)}) Tj`);
    y -= 22;
    ops.push("/F1 11 Tf");
    ops.push(`${leading} TL`);
    ops.push(`1 0 0 1 ${margin} ${y} Tm`);
    for (const line of chunk) {
      ops.push(`(${pdfEscape(line)}) Tj T*`);
    }
    ops.push("ET");
    const stream = ops.join("\n");
    const cid = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    contentIds.push(cid);
  });

  chunks.forEach((_, i) => {
    const pid = add(
      `<< /Type /Page /Parent 0 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Contents ${contentIds[i]} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`
    );
    pageIds.push(pid);
  });

  const pagesId = add(
    `<< /Type /Pages /Kids [${pageIds.map((id) => id + " 0 R").join(" ")}] /Count ${pageIds.length} >>`
  );
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  // Fix page parent refs now that pagesId is known
  pageIds.forEach((pid) => {
    objects[pid - 1] = objects[pid - 1].replace("/Parent 0 0 R", `/Parent ${pagesId} 0 R`);
  });

  const encoder = new TextEncoder();
  const chunksOut = [];
  let offset = 0;
  const write = (str) => {
    const bytes = encoder.encode(str);
    chunksOut.push(bytes);
    offset += bytes.length;
  };

  write("%PDF-1.4\n");
  const xref = [0];
  objects.forEach((body, i) => {
    xref.push(offset);
    write(`${i + 1} 0 obj\n${body}\nendobj\n`);
  });
  const xrefPos = offset;
  write(`xref\n0 ${objects.length + 1}\n`);
  write("0000000000 65535 f \n");
  for (let i = 1; i <= objects.length; i++) {
    write(`${String(xref[i]).padStart(10, "0")} 00000 n \n`);
  }
  write(`trailer << /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

  const total = chunksOut.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const b of chunksOut) {
    out.set(b, p);
    p += b.length;
  }
  return out;
}

export function parseJrnl(text) {
  const src = (text || "").replace(/\r\n/g, "\n");
  const re = /^\[(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\]\s*/gm;
  const matches = [...src.matchAll(re)];
  const jots = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : src.length;
    let body = src.slice(start, end).trim();
    const iso = `${m[1]}T${m[2].length === 5 ? m[2] + ":00" : m[2]}`;
    const createdAt = new Date(iso).getTime();
    let starred = false;
    if (body.startsWith("* ")) {
      starred = true;
      body = body.slice(2).trimStart();
    }
    if (!body || Number.isNaN(createdAt)) continue;
    jots.push(makeJot(body, { createdAt, updatedAt: createdAt, starred }));
  }
  return jots;
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const URL_RE =
  /\b(?:https?:\/\/|www\.)[^\s<]+|\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|dev|app|co|me|ai|im|info|edu|gov|us|uk|xyz|cloud|blog|shop|news)(?:\/[^\s<]*)?/gi;

function trimUrl(raw) {
  return String(raw).replace(/[),.;:!?]+$/g, "");
}

function hrefForUrl(raw) {
  const u = trimUrl(raw);
  if (/^https?:\/\//i.test(u)) return u;
  return "https://" + u;
}

const ZWSP = "\u200b";

/** Soft-wrap URLs and @tags without splitting HTML entities like `&amp;`. */
function insertSoftWraps(escaped) {
  return escaped
    .replace(/&amp;/g, `&amp;${ZWSP}`)
    .replace(/([/.?=_%#~+@:-])/g, `$1${ZWSP}`)
    .replace(/([A-Za-z0-9]{4})(?=[A-Za-z0-9])/g, `$1${ZWSP}`);
}

function linkTags(esc) {
  return esc.replace(/(^|[\s(])(@[\p{L}\p{N}_-]{1,40})/gu, (_, pre, tag) => {
    const canonical = tag.toLowerCase();
    const label = insertSoftWraps(escapeHtml(tag));
    return `${pre}<a class="tag-inline" href="?tag=${encodeURIComponent(canonical)}" data-tag="${escapeHtml(canonical)}">${label}</a>`;
  });
}

export function renderBodyHtml(body) {
  const raw = String(body || "");
  const re = new RegExp(URL_RE.source, "gi");
  const parts = [];
  let last = 0;
  let m;
  while ((m = re.exec(raw))) {
    const trimmed = trimUrl(m[0]);
    if (m.index > last) parts.push({ t: "text", v: raw.slice(last, m.index) });
    parts.push({ t: "url", v: trimmed });
    last = m.index + trimmed.length;
    re.lastIndex = last;
  }
  if (last < raw.length) parts.push({ t: "text", v: raw.slice(last) });
  if (!parts.length) parts.push({ t: "text", v: raw });
  return parts
    .map((p) => {
      if (p.t === "url") {
        const href = escapeHtml(hrefForUrl(p.v));
        const label = insertSoftWraps(escapeHtml(p.v));
        return `<a class="jot-link" href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      }
      return linkTags(escapeHtml(p.v))
        .replace(/\n/g, "<br>")
        .replace(/ {2,}/g, (run) => " " + "&nbsp;".repeat(run.length - 1));
    })
    .join("");
}

export function featureAllowed(feature, entitled) {
  if (!PRO_FEATURES.includes(feature)) return true;
  return Boolean(entitled);
}

export function isPrivateHost(host) {
  if (!host) return false;
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.endsWith(".local") ||
    /^192\.168\./.test(host) ||
    /^10\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    /^100\./.test(host)
  );
}

export function defaultSyncUrl() {
  if (typeof location === "undefined") return "http://127.0.0.1:8787";
  const host = location.hostname;
  if (isPrivateHost(host)) {
    const proto = location.protocol === "https:" ? "https:" : "http:";
    return `${proto}//${host}:8787`;
  }
  return "https://sync.jotspeed.com";
}

/** Bodies from the first-run sample set. Purged once on upgrade. */
export const LEGACY_DEMO_BODIES = [
  "Welcome to Jotspeed. This is a jot — a timestamped thought. Type above and hit Jot, or press Ctrl+Enter. Use @tags or #tags in the body.",
  "Welcome to Jotspeed. This is a jot — a timestamped thought. Type above and hit Jot, or press Ctrl+Enter. Prefix words with @ or # to tag them.",
  "Shipped the morning batch and walked the line. Mixer 2 sounded off — logged it for maintenance. @work #plant",
  "Idea: keep a running @idea list in here instead of a graveyard of phone notes. If it is not worth a sentence, it is not worth a file.",
  "Morning run, easy 3 miles. Knees fine. @health",
];
