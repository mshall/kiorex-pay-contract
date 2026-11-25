import { NO_CAPABILITIES, PayNotSupportedError, type PayAdapter, type PayCapabilities, type PayCheckoutInput, type PayCheckoutResult, type PayEvent } from './types';

/**
 * Wallet skeleton (config only). Vodafone Cash, Orange, Etisalat and bank wallets are PAYMENT METHODS of a licensed gateway (Paymob wallet integrations), not a Kiorly wallet and not a direct adapter.
 * This module decides nothing about the gateway: it reads which wallet methods an organisation has enabled (an integration id per method) and wraps an existing hosted-checkout adapter.
 * No network call, no stored balance, no wallet number is kept.
 */
export interface WalletMethodConfig {
  key: string;                       // 'vodafone_cash', 'orange_cash', 'etisalat_cash', 'bank_wallet'
  label: { en: string; ar: string };
  /** Gateway integration id of this wallet method (Paymob: the wallet integration id). Null until the merchant creates it: the method then reads as NOT_CONFIGURED. */
  integrationId: number | null;
  enabled: boolean;
}
export interface WalletConfig { gateway: string; methods: WalletMethodConfig[] }

export const DEFAULT_WALLET_METHODS: WalletMethodConfig[] = [
  { key: 'vodafone_cash', label: { en: 'Vodafone Cash', ar: 'فودافون كاش' }, integrationId: null, enabled: false },
  { key: 'orange_cash', label: { en: 'Orange Cash', ar: 'أورنج كاش' }, integrationId: null, enabled: false },
  { key: 'etisalat_cash', label: { en: 'Etisalat Cash', ar: 'اتصالات كاش' }, integrationId: null, enabled: false },
];
export const defaultWalletConfig = (gateway = 'paymob'): WalletConfig => ({ gateway, methods: DEFAULT_WALLET_METHODS.map((m) => ({ ...m, label: { ...m.label } })) });

export type WalletReadiness = { key: string; state: 'READY' | 'DISABLED' | 'NOT_CONFIGURED'; missing: string[] };
export function walletReadiness(c: WalletConfig): WalletReadiness[] {
  return c.methods.map((m) => ({ key: m.key, state: !m.enabled ? 'DISABLED' : m.integrationId && Number.isInteger(m.integrationId) && m.integrationId > 0 ? 'READY' : 'NOT_CONFIGURED', missing: m.enabled && !(m.integrationId && m.integrationId > 0) ? ['integrationId'] : [] }));
}
export const readyWalletMethods = (c: WalletConfig): WalletMethodConfig[] => c.methods.filter((m, i) => walletReadiness(c)[i]!.state === 'READY');

/** Parse `PAYMOB_WALLET_INTEGRATION_IDS="vodafone_cash:123,orange_cash:456"` style config (names only; ids are not secrets but stay in config). */
export function walletConfigFromEnv(env: Record<string, string | undefined>, gateway = 'paymob'): WalletConfig {
  const c = defaultWalletConfig(gateway);
  const raw = env[`${gateway.toUpperCase()}_WALLET_INTEGRATION_IDS`] ?? '';
  for (const part of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
    const [k, v] = part.split(':'); const id = Number(v); const m = c.methods.find((x) => x.key === k);
    if (m && Number.isInteger(id) && id > 0) { m.integrationId = id; m.enabled = true; }
  }
  return c;
}

/** Wraps a hosted-checkout adapter: the checkout is requested with rail `wallet` and a method key; the wrapped adapter owns the vendor call (and its real-mode guard). */
export class WalletAdapter implements PayAdapter {
  readonly name: string;
  readonly capabilities: PayCapabilities;
  constructor(private readonly inner: PayAdapter, private readonly cfg: WalletConfig) {
    this.name = `${inner.name}_wallet`;
    this.capabilities = { ...NO_CAPABILITIES, ...inner.capabilities, rails: ['wallet'], capture: false, void: false };
  }
  async createCheckout(i: PayCheckoutInput): Promise<PayCheckoutResult> {
    const ready = readyWalletMethods(this.cfg);
    const m = ready.find((x) => x.key === i.method) ?? (i.method ? undefined : ready[0]);
    if (!m) throw new PayNotSupportedError(this.name, `wallet method ${i.method ?? '(none)'} (not enabled or integration id missing: NEEDS_HUMAN, create the wallet integration at the gateway)`);
    return this.inner.createCheckout({ ...i, rail: 'wallet', method: m.key });
  }
  verifyWebhook(raw: string, headers: Record<string, unknown>, q?: Record<string, unknown>): PayEvent | null {
    const e = this.inner.verifyWebhook(raw, headers, q); return e ? { ...e, rail: 'wallet' } : null;
  }
  refund(i: Parameters<PayAdapter['refund']>[0]) { return this.inner.refund(i); }
  status(i: { pspRef: string; paymentId: string }) { if (!this.inner.status) throw new PayNotSupportedError(this.name, 'status'); return this.inner.status(i); }
}
