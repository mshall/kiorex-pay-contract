/** Decimal-string <-> integer minor helpers (the Clinic carries amounts as decimal strings, Kiorex as integer minor units). No floating point on the value path. */
export function toMinor(amount: string | number, decimals = 2): number | null {
  const s = String(amount).trim().replace(/,/g, '');
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const frac = (m[3] ?? '');
  if (frac.length > decimals && /[1-9]/.test(frac.slice(decimals))) return null; // would lose precision: refuse, never round money silently
  const whole = Number(m[2]) * 10 ** decimals + Number((frac + '0'.repeat(decimals)).slice(0, decimals));
  if (!Number.isSafeInteger(whole)) return null;
  return m[1] ? -whole : whole;
}
export function fromMinor(minor: number, decimals = 2): string {
  const neg = minor < 0; const a = Math.abs(Math.trunc(minor)); const d = 10 ** decimals;
  const s = `${Math.floor(a / d)}${decimals ? `.${String(a % d).padStart(decimals, '0')}` : ''}`;
  return neg ? `-${s}` : s;
}
