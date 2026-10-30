const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
/** 1,234.5 */
export const fmt = (n: number | null | undefined) => (n == null || !isFinite(n) ? "—" : nf.format(n));
/** 1,235 */
export const fmt0 = (n: number | null | undefined) => (n == null || !isFinite(n) ? "—" : nf0.format(n));
export const plural = (n: number, one: string, many = one + "s") => `${fmt0(n)} ${n === 1 ? one : many}`;
