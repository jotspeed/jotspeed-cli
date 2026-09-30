const MONTHS = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

function pad(n) {
  return String(n).padStart(2, "0");
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function parseTime(s) {
  const t = String(s || "").trim().toLowerCase();
  if (!t) return null;
  const ampm = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (ampm) {
    let h = Number(ampm[1]);
    const m = Number(ampm[2] || 0);
    if (ampm[3] === "pm" && h < 12) h += 12;
    if (ampm[3] === "am" && h === 12) h = 0;
    return { h, m };
  }
  const hm = t.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) return { h: Number(hm[1]), m: Number(hm[2]) };
  return null;
}

/** Parse a human date into a Date, or null if it is not a date. */
export function parseDate(input, { end = false } = {}) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const s = raw.toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ").trim();

  let base = new Date();
  let time = null;
  let rest = s;
  const at = s.match(/^(.*?)\s+at\s+(.+)$/);
  if (at) {
    rest = at[1].trim();
    time = parseTime(at[2]);
  }

  let d = null;
  if (rest === "now") d = new Date();
  else if (rest === "today") d = startOfDay(base);
  else if (rest === "yesterday") {
    d = startOfDay(base);
    d.setDate(d.getDate() - 1);
  } else if (rest === "tomorrow") {
    d = startOfDay(base);
    d.setDate(d.getDate() + 1);
  } else if (rest === "last week") {
    d = startOfDay(base);
    d.setDate(d.getDate() - 7);
  } else if (rest === "last month") {
    d = startOfDay(base);
    d.setMonth(d.getMonth() - 1);
  } else if (rest === "last year") {
    d = startOfDay(base);
    d.setFullYear(d.getFullYear() - 1);
  } else {
    const ago = rest.match(/^(\d+)\s+(day|days|week|weeks|month|months|year|years)\s+ago$/);
    if (ago) {
      d = startOfDay(base);
      const n = Number(ago[1]);
      const unit = ago[2];
      if (unit.startsWith("day")) d.setDate(d.getDate() - n);
      else if (unit.startsWith("week")) d.setDate(d.getDate() - n * 7);
      else if (unit.startsWith("month")) d.setMonth(d.getMonth() - n);
      else d.setFullYear(d.getFullYear() - n);
    }
  }

  if (!d) {
    const iso = rest.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (iso) {
      d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), Number(iso[4] || 0), Number(iso[5] || 0), Number(iso[6] || 0));
      if (!iso[4] && time) d.setHours(time.h, time.m, 0, 0);
      else if (!iso[4] && end) d = endOfDay(d);
      return Number.isNaN(d.getTime()) ? null : d;
    }
  }

  if (!d) {
    const mdy = rest.match(/^([a-z]+)\s+(\d{1,2})(?:\s+(\d{4}))?$/);
    if (mdy && MONTHS[mdy[1]] != null) {
      const year = mdy[3] ? Number(mdy[3]) : base.getFullYear();
      d = new Date(year, MONTHS[mdy[1]], Number(mdy[2]));
    }
  }

  if (!d) {
    const my = rest.match(/^([a-z]+)\s+(\d{4})$/);
    if (my && MONTHS[my[1]] != null) {
      d = end ? new Date(Number(my[2]), MONTHS[my[1]] + 1, 0, 23, 59, 59, 999) : new Date(Number(my[2]), MONTHS[my[1]], 1);
      return Number.isNaN(d.getTime()) ? null : d;
    }
  }

  if (!d) {
    const y = rest.match(/^(\d{4})$/);
    if (y) {
      d = end ? new Date(Number(y[1]), 11, 31, 23, 59, 59, 999) : new Date(Number(y[1]), 0, 1);
      return Number.isNaN(d.getTime()) ? null : d;
    }
  }

  if (!d || Number.isNaN(d.getTime())) return null;
  if (time) d.setHours(time.h, time.m, 0, 0);
  else if (end) d = endOfDay(d);
  return d;
}

export function dayBounds(d) {
  return { from: startOfDay(d).getTime(), to: endOfDay(d).getTime() };
}

export function isoDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
