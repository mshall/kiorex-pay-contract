import { b64url, hmacHex, safeEqual } from './crypto';
import type { PayAdapter, PayContext } from './types';

/**
 * Payment links and dynamic QR. A link token is a signed claim: WHAT it pays (context + subject), HOW MUCH (amount-locked), UNTIL WHEN (expiry), and it can be used ONCE.
 * The token never contains a card, an account number or a personal name. Single-use is enforced by the host's atomic store (`LinkUseStore`), not by the signature.
 */
export interface LinkClaim { id: string; ctx: PayContext; subject: string; amountMinor: number; currency: string; exp: number; org?: string; branch?: string; /** The adapter / rail key this link is bound to (a link for the wrong rail is refused). */ rail?: string }
export type LinkRefusal = 'MALFORMED' | 'BAD_SIGNATURE' | 'EXPIRED' | 'AMOUNT_MISMATCH' | 'CURRENCY_MISMATCH' | 'SUBJECT_MISMATCH' | 'ALREADY_USED' | 'RAIL_MISMATCH';
export const MAX_LINK_TTL_SEC = 7 * 24 * 3600;
export const DEFAULT_LINK_TTL_SEC = 24 * 3600;
export const MIN_LINK_TTL_SEC = 60;

export function signLink(secret: string, claim: Omit<LinkClaim, 'exp'> & { ttlSec?: number; now?: Date }): { token: string; claim: LinkClaim } {
  const now = claim.now ?? new Date();
  const ttl = Math.min(MAX_LINK_TTL_SEC, Math.max(MIN_LINK_TTL_SEC, Math.floor(claim.ttlSec ?? DEFAULT_LINK_TTL_SEC)));
  if (!Number.isSafeInteger(claim.amountMinor) || claim.amountMinor <= 0) throw new Error('amountMinor must be a positive integer');
  const { ttlSec: _t, now: _n, ...rest } = claim;
  const c: LinkClaim = { ...rest, exp: Math.floor(now.getTime() / 1000) + ttl };
  const body = b64url(JSON.stringify(c));
  return { token: `kpl1.${body}.${hmacHex(secret, `kpl1.${body}`).slice(0, 43)}`, claim: c };
}
export function readLink(secret: string, token: string): { ok: true; claim: LinkClaim } | { ok: false; reason: LinkRefusal } {
  const p = token.split('.'); if (p.length !== 3 || p[0] !== 'kpl1') return { ok: false, reason: 'MALFORMED' };
  if (!safeEqual(p[2]!, hmacHex(secret, `kpl1.${p[1]}`).slice(0, 43))) return { ok: false, reason: 'BAD_SIGNATURE' };
  try {
    const c = JSON.parse(Buffer.from(p[1]!, 'base64url').toString('utf8')) as LinkClaim;
    if (!c || typeof c.id !== 'string' || !Number.isSafeInteger(c.amountMinor) || typeof c.exp !== 'number') return { ok: false, reason: 'MALFORMED' };
    return { ok: true, claim: c };
  } catch { return { ok: false, reason: 'MALFORMED' }; }
}
/** The host implements this with one atomic statement (INSERT ... ON CONFLICT DO NOTHING / UPDATE ... WHERE usedAt IS NULL) and returns true only for the first caller. */
export interface LinkUseStore { markUsed(id: string): Promise<boolean> }
export interface LinkPresented { amountMinor: number; currency: string; subject?: string; rail?: string; now?: Date }

/** Validate (signature, expiry, amount lock, subject, rail) and CONSUME. A refused link is never consumed. */
export async function redeemLink(secret: string, token: string, presented: LinkPresented, store: LinkUseStore): Promise<{ ok: true; claim: LinkClaim } | { ok: false; reason: LinkRefusal }> {
  const r = readLink(secret, token); if (!r.ok) return r;
  const c = r.claim; const now = Math.floor((presented.now ?? new Date()).getTime() / 1000);
  if (now >= c.exp) return { ok: false, reason: 'EXPIRED' };
  if (presented.amountMinor !== c.amountMinor) return { ok: false, reason: 'AMOUNT_MISMATCH' };
  if (presented.currency.toUpperCase() !== c.currency.toUpperCase()) return { ok: false, reason: 'CURRENCY_MISMATCH' };
  if (presented.subject !== undefined && presented.subject !== c.subject) return { ok: false, reason: 'SUBJECT_MISMATCH' };
  if (c.rail && presented.rail !== undefined && presented.rail !== c.rail) return { ok: false, reason: 'RAIL_MISMATCH' };
  if (!(await store.markUsed(c.id))) return { ok: false, reason: 'ALREADY_USED' };
  return { ok: true, claim: c };
}

/**
 * What a QR encodes. PROVIDER: the vendor returned a QR payload (InstaPay / wallet QR) and it is used verbatim. LINK: the vendor has no QR API, the QR encodes our hosted link
 * (any phone camera opens it; it is a link QR, not a bank-app QR). NONE: no QR. The kind is returned so UIs never present a link QR as a bank-app QR.
 */
export type QrKind = 'PROVIDER' | 'LINK' | 'NONE';
export function qrPlan(adapter: Pick<PayAdapter, 'capabilities'>, r: { qrPayload?: string; checkoutUrl?: string }): { kind: QrKind; content: string | null } {
  if (adapter.capabilities.qr === 'PROVIDER' && r.qrPayload) return { kind: 'PROVIDER', content: r.qrPayload };
  if (adapter.capabilities.qr !== 'NONE' && r.checkoutUrl) return { kind: 'LINK', content: r.checkoutUrl };
  if (r.checkoutUrl) return { kind: 'LINK', content: r.checkoutUrl };
  return { kind: 'NONE', content: null };
}
