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
