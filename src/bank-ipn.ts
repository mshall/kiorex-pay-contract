import { createHash } from 'node:crypto';
import { hmacHex, safeEqual } from './crypto';
import { csvObjects } from './csv';
import { toMinor } from './money';
import { NO_CAPABILITIES, PayNotSupportedError, type PayAdapter, type PayCapabilities, type PayCheckoutInput, type PayCheckoutResult, type PayEvent } from './types';

/**
 * Bank / IPN (instant payment notification) adapter: the bank (or its aggregator) tells us that a transfer arrived, by signed webhook or by a daily file.
 * Kiorly never holds the money: the payer transfers to the merchant's / licensed partner's account; this adapter only reads the notification.
 * The bank's exact file layout and signature are NEEDS_HUMAN (LG-INT-PAY-12): everything that varies is configuration below, nothing is assumed.
 */
export interface BankIpnConfig {
  /** Adapter key used in routing and the ledger (`bank_ipn` by default). */
  name?: string;
  /** Header names (CSV) or JSON keys (webhook / json file) holding each field. */
  columns: { bankRef: string; amount: string; currency?: string; reference: string; paidAt: string; payer?: string; status?: string; kind?: string };
  amountUnit: 'major' | 'minor';
  decimals?: number;
  defaultCurrency?: string;
  /** Values of the `status` column that mean the money arrived (case-insensitive). Empty = every row counts. */
  successStatuses?: string[];
  /** Values of the `kind` column that mean a reversal (case-insensitive); such a row becomes `refund.settled`. */
  reversalKinds?: string[];
  /** The payer's reference must match this (a Kiorly payment reference). Rows that do not match are still returned, with no `paymentId`, for the matcher to review. */
  referencePattern?: string;
  signature?: { header: string; algo: 'sha256' | 'sha512'; /** `body` signs the raw body, `ts.body` signs "<timestamp>.<body>" with the timestamp header. */ mode: 'body' | 'ts.body'; timestampHeader?: string; toleranceSec?: number; prefix?: string };
  beneficiaryLabel?: string;
  accountMasked?: string;
}

const maskPayer = (v: string): string => { const s = v.trim(); if (!s) return ''; return s.length <= 4 ? '****' : `${s.slice(0, 2)}${'*'.repeat(Math.min(6, s.length - 4))}${s.slice(-2)}`; };
const get = (o: Record<string, unknown>, k: string | undefined): string => (k ? String(o[k] ?? '').trim() : '');

/** Row to neutral event. Returns a reason string when the row must be refused. */
export function ipnRowToEvent(row: Record<string, unknown>, cfg: BankIpnConfig): PayEvent | string {
  const bankRef = get(row, cfg.columns.bankRef); if (!bankRef) return 'MISSING_BANK_REF';
  const decimals = cfg.decimals ?? 2;
  const raw = get(row, cfg.columns.amount);
  const minor = cfg.amountUnit === 'minor' ? (/^\d+$/.test(raw) ? Number(raw) : null) : toMinor(raw, decimals);
  if (minor === null || minor <= 0) return 'BAD_AMOUNT';
  const paidAt = get(row, cfg.columns.paidAt); const t = Date.parse(paidAt); if (!paidAt || Number.isNaN(t)) return 'BAD_DATE';
  const currency = (get(row, cfg.columns.currency) || cfg.defaultCurrency || '').toUpperCase(); if (!currency) return 'MISSING_CURRENCY';
  const status = get(row, cfg.columns.status).toLowerCase();
  if (cfg.successStatuses?.length && !cfg.successStatuses.map((s) => s.toLowerCase()).includes(status)) return `STATUS_NOT_SUCCESS:${status || 'empty'}`;
  const kind = get(row, cfg.columns.kind).toLowerCase();
  const reversal = !!kind && !!cfg.reversalKinds?.map((s) => s.toLowerCase()).includes(kind);
  const reference = get(row, cfg.columns.reference);
  let paymentId: string | undefined;
  if (cfg.referencePattern && reference) { try { if (new RegExp(cfg.referencePattern).test(reference)) paymentId = reference; } catch { /* bad pattern: refuse nothing, leave unmatched */ } }
  return {
    eventId: `ipn:${cfg.name ?? 'bank_ipn'}:${bankRef}${reversal ? ':rev' : ''}`,
    type: reversal ? 'refund.settled' : 'payment.captured',
    pspRef: bankRef, ...(paymentId ? { paymentId } : {}), ...(reference ? { reference } : {}), amountMinor: minor, currency,
    occurredAt: new Date(t).toISOString(), payerMasked: maskPayer(get(row, cfg.columns.payer)) || undefined, rail: 'bank_ipn',
    ...(reversal ? { refundRef: bankRef } : {}),
  };
}

export class BankIpnAdapter implements PayAdapter {
  readonly name: string;
  readonly capabilities: PayCapabilities = { ...NO_CAPABILITIES, rails: ['bank_ipn', 'bank_transfer'], status: false, hostedCheckout: false, fileIngest: true, qr: 'NONE' };
  constructor(private readonly cfg: BankIpnConfig, private readonly secret: string = '') { this.name = cfg.name ?? 'bank_ipn'; }

  /** No hosted page: the payer gets the reference and the beneficiary to transfer to. The reference is the payment id (matching key). */
  async createCheckout(i: PayCheckoutInput): Promise<PayCheckoutResult> {
    const ref = i.paymentId;
    const who = this.cfg.beneficiaryLabel ?? '';
    return {
      pspRef: `ipn:${ref}`,
      instructions: {
        reference: ref, beneficiaryLabel: who || undefined, accountMasked: this.cfg.accountMasked,
        en: `Transfer ${(i.amountMinor / 10 ** (i.decimals ?? 2)).toFixed(i.decimals ?? 2)} ${i.currency} to ${who || 'the beneficiary account shown'} and write ${ref} as the transfer reference.`,
        ar: `حوّل ${(i.amountMinor / 10 ** (i.decimals ?? 2)).toFixed(i.decimals ?? 2)} ${i.currency} إلى ${who || 'حساب المستفيد الظاهر'} واكتب ${ref} كمرجع للتحويل.`,
      },
    };
  }

  /** Signed webhook (one IPN per call, or `{ items: [...] }`; only the first event is returned, use `verifyBatch` for several). */
  verifyWebhook(raw: string, headers: Record<string, unknown>, _q?: Record<string, unknown>, now: Date = new Date()): PayEvent | null {
    return this.verifyBatch(raw, headers, now)[0] ?? null;
  }
  verifyBatch(raw: string, headers: Record<string, unknown>, now: Date = new Date()): PayEvent[] {
    if (!this.signatureOk(raw, headers, now)) return [];
    let j: unknown; try { j = JSON.parse(raw); } catch { return []; }
    const rows = Array.isArray(j) ? j : Array.isArray((j as { items?: unknown }).items) ? (j as { items: unknown[] }).items : [j];
    return rows.map((r) => (r && typeof r === 'object' ? ipnRowToEvent(r as Record<string, unknown>, this.cfg) : 'BAD_ROW')).filter((e): e is PayEvent => typeof e !== 'string');
  }
  signatureOk(raw: string, headers: Record<string, unknown>, now: Date = new Date()): boolean {
    const s = this.cfg.signature; if (!s || !this.secret) return false; // unsigned IPN is never trusted
    const h = (k: string) => String(Object.entries(headers).find(([n]) => n.toLowerCase() === k.toLowerCase())?.[1] ?? '');
    const got = h(s.header).replace(s.prefix ?? '', '');
    if (!got) return false;
    let data = raw;
    if (s.mode === 'ts.body') {
      const ts = h(s.timestampHeader ?? 'x-webhook-timestamp'); const n = Number(ts);
      if (!ts || !Number.isFinite(n)) return false;
      const ms = n > 1e12 ? n : n * 1000;
      if (Math.abs(now.getTime() - ms) > (s.toleranceSec ?? 300) * 1000) return false; // replay window
      data = `${ts}.${raw}`;
    }
    return safeEqual(got, hmacHex(this.secret, data, s.algo));
  }

  /** Daily IPN file (CSV or JSON array). Every row is verified structurally; duplicates inside the file collapse to one event. */
  ingestFile(content: string, opts: { format?: 'csv' | 'json'; now?: Date } = {}): { events: PayEvent[]; rejected: { row: number; reason: string }[] } {
    const format = opts.format ?? (content.trimStart().startsWith('[') || content.trimStart().startsWith('{') ? 'json' : 'csv');
    let rows: Record<string, unknown>[] = [];
    try {
      if (format === 'csv') rows = csvObjects(content);
      else { const j = JSON.parse(content); rows = Array.isArray(j) ? j : Array.isArray(j?.items) ? j.items : [j]; }
    } catch { return { events: [], rejected: [{ row: 0, reason: 'UNPARSEABLE_FILE' }] }; }
    const events: PayEvent[] = []; const rejected: { row: number; reason: string }[] = []; const seen = new Set<string>();
    rows.forEach((r, i) => {
      const e = r && typeof r === 'object' ? ipnRowToEvent(r, this.cfg) : 'BAD_ROW';
      if (typeof e === 'string') { rejected.push({ row: i + 1, reason: e }); return; }
      if (seen.has(e.eventId)) { rejected.push({ row: i + 1, reason: 'DUPLICATE_IN_FILE' }); return; }
      seen.add(e.eventId); events.push(e);
    });
    return { events, rejected };
  }
  /** Stable fingerprint of a file (hosts store it to refuse a re-upload of the same file). */
  static fileDigest(content: string): string { return createHash('sha256').update(content).digest('hex'); }

  async refund(): Promise<never> { throw new PayNotSupportedError(this.name, 'refund (a bank transfer is returned by the bank / finance, then confirmed by an IPN reversal row)'); }
}
