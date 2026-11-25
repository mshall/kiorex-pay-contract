/**
 * Kiorly Pay: the shared payment adapter contract (one definition for kiorex-platform Pay and the Clinic billing).
 *
 * Principle: Kiorly provides software (orchestration, routing, matching, reporting). Licensed payment partners process and settle funds.
 * Nothing in this package moves, holds or settles money, and nothing here opens a network connection: adapters receive an injected `fetch`
 * and the host application decides, through its own real-mode guard (INTEGRATION_MODES), whether a real call may happen at all.
 * Funds-flow, licensing and settlement-account questions are NEEDS_HUMAN (counsel, CBE rules); this package decides none of them.
 */

/** Amounts are integer minor units of the currency (EGP 2 decimals). */
export type Minor = number;

/** How the payer pays. `wallet` = mobile wallets (Vodafone Cash and similar) reached as payment methods of a licensed gateway, never a direct Kiorly wallet. */
export type PayRail = 'card' | 'wallet' | 'bank_ipn' | 'instapay' | 'fawry_code' | 'cash_desk' | 'bank_transfer';
export const PAY_RAILS: readonly PayRail[] = ['card', 'wallet', 'bank_ipn', 'instapay', 'fawry_code', 'cash_desk', 'bank_transfer'];

/** What the payment is for. The same contract carries every collection surface. */
export type PayContext = 'DEPOSIT' | 'CLINIC_INVOICE' | 'HOME_VISIT' | 'FRONT_DESK' | 'SAAS_INVOICE' | 'ORDER' | 'OTHER';
export const PAY_CONTEXTS: readonly PayContext[] = ['DEPOSIT', 'CLINIC_INVOICE', 'HOME_VISIT', 'FRONT_DESK', 'SAAS_INVOICE', 'ORDER', 'OTHER'];

export type PayEventType =
  | 'payment.captured' | 'payment.failed' | 'refund.settled'
  | 'payment.authorized' | 'payment.voided' | 'refund.failed'
  | 'dispute.opened' | 'dispute.won' | 'dispute.lost';
export const PAY_EVENT_TYPES: readonly PayEventType[] = ['payment.captured', 'payment.failed', 'refund.settled', 'payment.authorized', 'payment.voided', 'refund.failed', 'dispute.opened', 'dispute.won', 'dispute.lost'];

export interface PayCardFacts {
  /** HMAC-hashed card fingerprint (never the raw vendor value, never a PAN). */
  fingerprint?: string;
  fingerprintStrength?: 'STRONG' | 'WEAK';
  brand?: string;
  last4?: string;
  threeDs?: 'NONE' | 'CHALLENGED' | 'PASSED' | 'FAILED';
}

/**
 * The vendor-neutral event every adapter produces from a VERIFIED webhook, IPN row or status poll.
 * Wire-compatible with kiorex-platform `PspEvent`. `eventId` is unique per vendor event AND per state change (hosts dedupe on it).
 */
export interface PayEvent {
  eventId: string;
  type: PayEventType;
  pspRef: string;
  paymentId?: string;
  orderRef?: string;
  amountMinor: Minor;
  feeMinor?: Minor;
  currency?: string;
  occurredAt: string;
  card?: PayCardFacts;
  refundRef?: string;
  dispute?: { ref: string; reasonCode?: string; evidenceDueAt?: string };
  /** Bank IPN and wallet: the payer's own reference text (what they typed in the transfer note) and a masked payer label. Never a full account number. */
  reference?: string;
  payerMasked?: string;
  rail?: PayRail;
}

export type PayPaymentState = 'PENDING' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED' | 'VOIDED' | 'REFUNDED' | 'PARTIALLY_REFUNDED' | 'UNKNOWN';
export interface PayStatus { state: PayPaymentState; amountMinor?: Minor; refundedMinor?: Minor; currency?: string; feeMinor?: Minor; pspRef?: string; occurredAt?: string; card?: PayCardFacts }

/** What an adapter can do. `qr`: PROVIDER = the vendor returns a QR payload / page; LINK = only a hosted link exists (the QR encodes the link); NONE = no QR at all. */
export interface PayCapabilities {
  rails: PayRail[];
  capture: boolean;
  void: boolean;
  status: boolean;
  partialRefund: boolean;
  hostedCheckout: boolean;
  cardFacts: boolean;
  /** The adapter consumes vendor files (settlement / IPN files) in addition to or instead of webhooks. */
  fileIngest: boolean;
  qr: 'PROVIDER' | 'LINK' | 'NONE';
}
export const NO_CAPABILITIES: PayCapabilities = { rails: [], capture: false, void: false, status: false, partialRefund: false, hostedCheckout: true, cardFacts: false, fileIngest: false, qr: 'NONE' };

export interface PayCheckoutInput {
  paymentId: string;
  amountMinor: Minor;
  currency: string;
  context?: PayContext;
  /** The invoice / visit / collection this pays (lets the matcher and the reports join). */
  subjectId?: string;
  /** Tenant (Clinic) or organisation the money is for. */
  organisationId?: string;
  branchId?: string;
  rail?: PayRail;
  /** Wallet method key (e.g. `vodafone_cash`) when rail is wallet. */
  method?: string;
  captureMode?: 'AUTO' | 'MANUAL';
  threeDsMode?: 'REQUIRED' | 'PREFERRED' | 'OFF';
  decimals?: number;
}

/** What createCheckout returns. A hosted vendor gives a URL; a bank / IPN rail gives instructions (reference + beneficiary shown to the payer, funds go to the partner's account). */
export interface PayCheckoutResult {
  pspRef: string;
  checkoutUrl?: string;
  /** Vendor-provided QR payload when the adapter supports it (`capabilities.qr === 'PROVIDER'`). */
  qrPayload?: string;
  /** Payer instructions for reference-based rails (bank / IPN, cash desk, Fawry code). */
  instructions?: { reference: string; beneficiaryLabel?: string; accountMasked?: string; en: string; ar: string; expiresAt?: string };
}

export interface PayAdapter {
  /** Stable key (`paymob`, `fawry`, `instapay`, `card`, `bank_ipn`, `paymob_wallet`, ...). */
  readonly name: string;
  readonly capabilities: PayCapabilities;
  createCheckout(i: PayCheckoutInput): Promise<PayCheckoutResult>;
  /** Verifies the vendor signature and returns the neutral event, or null for anything forged, replayed, malformed or irrelevant. `query` carries signatures that travel in the URL. */
  verifyWebhook(rawBody: string, headers: Record<string, unknown>, query?: Record<string, unknown>): PayEvent | null;
  refund(i: { pspRef: string; refundId: string; amountMinor: Minor; priorRefundedMinor?: Minor }): Promise<{ pspRefundRef: string }>;
  capture?(i: { pspRef: string; paymentId: string; amountMinor: Minor }): Promise<{ pspCaptureRef: string }>;
  void?(i: { pspRef: string; paymentId: string }): Promise<{ pspVoidRef: string }>;
  status?(i: { pspRef: string; paymentId: string }): Promise<PayStatus>;
  /** File ingest (bank IPN files, settlement files): returns verified neutral events plus the rows that were refused and why. */
  ingestFile?(content: string, opts?: { format?: 'csv' | 'json'; now?: Date }): { events: PayEvent[]; rejected: { row: number; reason: string }[] };
}

/** Thrown by adapters for anything the rail cannot do (kept a plain Error subclass so hosts can map it to 501 / 422). */
export class PayNotSupportedError extends Error {
  readonly code = 'PAY_NOT_SUPPORTED';
  constructor(readonly adapter: string, readonly operation: string) { super(`${adapter} does not support ${operation}`); this.name = 'PayNotSupportedError'; }
}

/** Marks every funds-flow / licensing / fee question as a human decision. Use this text in NEEDS_HUMAN rows and error messages. */
export const NEEDS_HUMAN_FUNDS_FLOW = 'NEEDS_HUMAN: funds flow, licensing and settlement accounts are decided by counsel (CBE rules); Kiorly software never holds funds.';

/** An injected fetch, so adapters never reach for the network on their own. */
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;
