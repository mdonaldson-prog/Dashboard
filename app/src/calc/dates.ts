// Calendar helpers. All dates are ISO "YYYY-MM-DD" strings; arithmetic is done in UTC
// so results never shift with the viewer's timezone.

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Parse the date formats seen in inFlow and freight-portal exports. Returns "" if unparseable. */
export function parseDate(v: unknown): string {
  if (v == null || v === "") return "";
  if (v instanceof Date && !isNaN(v.getTime())) {
    return iso(v.getFullYear(), v.getMonth() + 1, v.getDate());
  }
  const s = String(v).replace(/ /g, " ").trim();
  if (!s) return "";
  // 2026-08-10 or 2026-08-10 15:00:00
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  // 2/3/2026 12:00:00 AM +00:00  (M/D/YYYY)
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return iso(+m[3], +m[1], +m[2]);
  // Mar 10, 2026
  m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && MONTHS[m[1].toLowerCase()]) return iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  // Excel serial number
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(+s) * 86400000);
    return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  return "";
}

const toUTC = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const fromUTC = (t: number) => {
  const d = new Date(t);
  return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
};

export const addDays = (d: string, n: number) => fromUTC(toUTC(d) + n * 86400000);
export const daysBetween = (a: string, b: string) => Math.round((toUTC(b) - toUTC(a)) / 86400000);
/** 0 = Sunday … 6 = Saturday */
export const dayOfWeek = (d: string) => new Date(toUTC(d)).getUTCDay();
export const mondayOf = (d: string) => addDays(d, -((dayOfWeek(d) + 6) % 7));
export const monthOf = (d: string) => d.slice(0, 7) + "-01";

export function todayISO(): string {
  const n = new Date();
  return iso(n.getFullYear(), n.getMonth() + 1, n.getDate());
}

/** Business days in [from, to): weekdays that are not holidays. Same as numpy.busday_count. */
export function businessDays(from: string, to: string, holidays: Set<string>): number {
  if (!from || !to) return NaN;
  if (to < from) return -businessDays(to, from, holidays);
  let n = 0;
  for (let d = from; d < to; d = addDays(d, 1)) {
    const w = dayOfWeek(d);
    if (w !== 0 && w !== 6 && !holidays.has(d)) n++;
  }
  return n;
}

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const shortDate = (d: string) => (d ? `${SHORT[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}` : "");
export const longDate = (d: string) => (d ? `${shortDate(d)}, ${d.slice(0, 4)}` : "");
export const weekLabel = (monday: string) => `${shortDate(monday)} – ${shortDate(addDays(monday, 6))}`;
export const monthLabel = (first: string) => `${SHORT[+first.slice(5, 7) - 1]} ${first.slice(0, 4)}`;
export const dowName = (d: string) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dayOfWeek(d)];

/** US holidays observed by default; editable later in settings. */
export const DEFAULT_HOLIDAYS = [
  "2026-01-01", "2026-05-25", "2026-07-03", "2026-09-07", "2026-11-26", "2026-11-27", "2026-12-24", "2026-12-25",
  "2027-01-01", "2027-05-31", "2027-07-05", "2027-09-06", "2027-11-25", "2027-11-26", "2027-12-24",
];

// ---------- Periods (the global date filter) ----------

export type PeriodKind = "day" | "week" | "month" | "year" | "custom";
export interface Period { kind: PeriodKind; from: string; to: string }

export const yearOf = (d: string) => d.slice(0, 4) + "-01-01";
const monthEnd = (first: string) => addDays(monthOf(addDays(first, 32)), -1);

/** The day / week / month / year containing `d`. */
export function periodAt(kind: Exclude<PeriodKind, "custom">, d: string): Period {
  if (kind === "day") return { kind, from: d, to: d };
  if (kind === "week") { const m = mondayOf(d); return { kind, from: m, to: addDays(m, 6) }; }
  if (kind === "month") { const m = monthOf(d); return { kind, from: m, to: monthEnd(m) }; }
  return { kind, from: yearOf(d), to: d.slice(0, 4) + "-12-31" };
}

/** The period `n` steps before (negative) or after (positive). Custom ranges move by their own length. */
export function shiftPeriod(p: Period, n: number): Period {
  if (p.kind === "custom") { const len = daysBetween(p.from, p.to) + 1; return { kind: "custom", from: addDays(p.from, n * len), to: addDays(p.to, n * len) }; }
  if (p.kind === "day") return periodAt("day", addDays(p.from, n));
  if (p.kind === "week") return periodAt("week", addDays(p.from, 7 * n));
  if (p.kind === "month") {
    const y = +p.from.slice(0, 4), m = +p.from.slice(5, 7) - 1 + n;
    return periodAt("month", iso(y + Math.floor(m / 12), ((m % 12) + 12) % 12 + 1, 1));
  }
  return periodAt("year", iso(+p.from.slice(0, 4) + n, 1, 1));
}

export function periodLabel(p: Period): string {
  if (p.kind === "day") return `${dowName(p.from)} ${longDate(p.from)}`;
  if (p.kind === "week") return `Week of ${weekLabel(p.from)}`;
  if (p.kind === "month") return monthLabel(p.from);
  if (p.kind === "year") return p.from.slice(0, 4);
  return p.from.slice(0, 4) === p.to.slice(0, 4) ? `${shortDate(p.from)} – ${longDate(p.to)}` : `${longDate(p.from)} – ${longDate(p.to)}`;
}

/** Short noun for comparisons: "vs prior week". */
export const PERIOD_NOUN: Record<PeriodKind, string> = { day: "day", week: "week", month: "month", year: "year", custom: "period" };

/** Weekdays (Mon–Fri, not holidays) in the period, inclusive. Used to scale per-week targets. */
export const workingDaysIn = (p: { from: string; to: string }, holidays: Set<string>) => businessDays(p.from, addDays(p.to, 1), holidays);
