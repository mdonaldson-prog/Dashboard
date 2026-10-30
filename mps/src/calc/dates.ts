// Date helpers on "YYYY-MM-DD" strings (no time zones), plus the holiday calendar.

const pad = (n: number) => String(n).padStart(2, "0");
const toDate = (d: string) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)));
const fromDate = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

export const addDays = (d: string, n: number) => {
  const x = toDate(d);
  x.setUTCDate(x.getUTCDate() + n);
  return fromDate(x);
};
/** 0 = Sunday … 6 = Saturday */
export const dayOfWeek = (d: string) => toDate(d).getUTCDay();
export const today = () => {
  const n = new Date();
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
};

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Mon Nov 2" */
export const shortDate = (d: string) => `${DOW[dayOfWeek(d)]} ${MON[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}`;
/** "Nov 2, 2026" */
export const longDate = (d: string) => `${MON[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}, ${d.slice(0, 4)}`;

/** inFlow MO date stamp as used in your MO names: YYDDMM (Oct 29 2026 → 262910). */
export const moStamp = (d: string) => d.slice(2, 4) + d.slice(8, 10) + d.slice(5, 7);

// ---------- Holidays ----------

export const HOLIDAY_RULES = [
  { id: "newYear", label: "New Year's Day" },
  { id: "memorial", label: "Memorial Day" },
  { id: "july4", label: "Independence Day" },
  { id: "labor", label: "Labor Day" },
  { id: "thanksgiving", label: "Thanksgiving" },
  { id: "dayAfterThanksgiving", label: "Day after Thanksgiving" },
  { id: "christmasEve", label: "Christmas Eve" },
  { id: "christmas", label: "Christmas Day" },
] as const;
export type HolidayRule = (typeof HOLIDAY_RULES)[number]["id"];

/** n-th weekday (0=Sun) of a month; n = -1 for the last one. */
function nthWeekday(year: number, month: number, dow: number, n: number): string {
  if (n > 0) {
    const first = `${year}-${pad(month)}-01`;
    return addDays(first, ((dow - dayOfWeek(first) + 7) % 7) + (n - 1) * 7);
  }
  const last = addDays(month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`, -1);
  return addDays(last, -((dayOfWeek(last) - dow + 7) % 7));
}
/** Fixed-date holidays on a weekend are taken the Friday before or the Monday after. */
const observed = (d: string) => (dayOfWeek(d) === 6 ? addDays(d, -1) : dayOfWeek(d) === 0 ? addDays(d, 1) : d);

export function holidaysForYear(year: number, rules: Record<string, boolean>): { date: string; name: string }[] {
  const out: { date: string; name: string }[] = [];
  const add = (id: HolidayRule, date: string) => {
    if (rules[id] !== false) out.push({ date, name: HOLIDAY_RULES.find((r) => r.id === id)!.label });
  };
  add("newYear", observed(`${year}-01-01`));
  add("memorial", nthWeekday(year, 5, 1, -1));
  add("july4", observed(`${year}-07-04`));
  add("labor", nthWeekday(year, 9, 1, 1));
  const tg = nthWeekday(year, 11, 4, 4);
  add("thanksgiving", tg);
  add("dayAfterThanksgiving", addDays(tg, 1));
  const xmas = observed(`${year}-12-25`);
  // When Christmas is observed on Friday the 24th, Christmas Eve moves to Thursday the 23rd.
  const eve = xmas === `${year}-12-24` ? `${year}-12-23` : `${year}-12-24`;
  if (dayOfWeek(eve) !== 0 && dayOfWeek(eve) !== 6) add("christmasEve", eve);
  add("christmas", xmas);
  return out;
}

export function holidayMap(years: number[], rules: Record<string, boolean>, extra: { date: string; name: string }[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const y of years) for (const h of holidaysForYear(y, rules)) m.set(h.date, h.name);
  for (const h of extra) if (h.date) m.set(h.date, h.name || "Closed");
  return m;
}

export const isWorkday = (d: string, holidays: Map<string, string>) => dayOfWeek(d) !== 0 && dayOfWeek(d) !== 6 && !holidays.has(d);

/** The next `n` workdays starting on `from` (inclusive). */
export function workdays(from: string, n: number, holidays: Map<string, string>): string[] {
  const out: string[] = [];
  for (let d = from; out.length < n; d = addDays(d, 1)) if (isWorkday(d, holidays)) out.push(d);
  return out;
}

/** Workdays strictly after `d`. */
export const nextWorkday = (d: string, holidays: Map<string, string>) => workdays(addDays(d, 1), 1, holidays)[0];

/** Number of workdays in [from, to]. */
export function countWorkdays(from: string, to: string, holidays: Map<string, string>): number {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (isWorkday(d, holidays)) n++;
  return n;
}
