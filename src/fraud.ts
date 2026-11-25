/**
 * Payment fraud scorer. SHADOW first: it scores and records, it never blocks, bans or changes the outcome of a payment.
 * The only actions that exist are `NONE` (shadow) and `REVIEW` (an item in the human review queue). There is no "block" and no "ban" in this contract by design.
 * Thresholds are configuration (maker-checker config kinds in the host) and are clamped to safety bounds: a config cannot switch the scorer off or make a rule blind.
 */
export type AttemptOutcome = 'SUCCESS' | 'FAILED' | 'DECLINED' | 'THREEDS_FAILED';
export interface PayAttempt { id: string; at: string; outcome: AttemptOutcome; amountMinor: number; currency: string; accountId: string; orgId?: string; /** HMAC-hashed card fingerprint (never a PAN). */ fingerprint?: string; deviceId?: string; ipHash?: string; pspRef?: string }
export type FraudRule = 'VELOCITY' | 'CARD_TESTING' | 'AMOUNT_ANOMALY' | 'REPEATED_FAILURES' | 'FINGERPRINT_REUSE';
export const FRAUD_RULES: readonly FraudRule[] = ['VELOCITY', 'CARD_TESTING', 'AMOUNT_ANOMALY', 'REPEATED_FAILURES', 'FINGERPRINT_REUSE'];
export type FraudMode = 'SHADOW' | 'FLAG';
export type FraudBand = 'LOW' | 'MEDIUM' | 'HIGH';

export interface FraudConfig {
  mode: FraudMode;
  velocity: { windowSec: number; maxAttempts: number };
  cardTesting: { windowSec: number; minFailures: number; smallAmountMinor: number; minDistinctFingerprints: number };
  amountAnomaly: { ratio: number; minHistory: number; minAmountMinor: number };
  repeatedFailures: { consecutive: number };
  fingerprintReuse: { windowSec: number; maxAccounts: number };
  /** Score at or above which FLAG mode queues a review item. */
  reviewScore: number;
  /** Rules switched off by name. A config can never switch off more than `MAX_DISABLED_RULES`. */
  disabledRules: FraudRule[];
}
export const DEFAULT_FRAUD_CONFIG: FraudConfig = {
  mode: 'SHADOW',
  velocity: { windowSec: 600, maxAttempts: 8 },
  cardTesting: { windowSec: 900, minFailures: 4, smallAmountMinor: 5000, minDistinctFingerprints: 3 },
  amountAnomaly: { ratio: 6, minHistory: 3, minAmountMinor: 50000 },
  repeatedFailures: { consecutive: 4 },
  fingerprintReuse: { windowSec: 30 * 86400, maxAccounts: 3 },
  reviewScore: 60,
  disabledRules: [],
};
/** Safety floors: [lowest, highest] value a threshold may take. The highest bound is the laxest allowed; nothing can be made blind. */
export const FRAUD_BOUNDS = {
  'velocity.windowSec': [60, 3600], 'velocity.maxAttempts': [3, 30],
  'cardTesting.windowSec': [60, 3600], 'cardTesting.minFailures': [2, 10], 'cardTesting.smallAmountMinor': [100, 20000], 'cardTesting.minDistinctFingerprints': [2, 6],
  'amountAnomaly.ratio': [3, 20], 'amountAnomaly.minHistory': [2, 20], 'amountAnomaly.minAmountMinor': [10000, 5_000_000],
  'repeatedFailures.consecutive': [3, 10],
  'fingerprintReuse.windowSec': [86400, 90 * 86400], 'fingerprintReuse.maxAccounts': [2, 6],
  reviewScore: [30, 90],
} as const satisfies Record<string, readonly [number, number]>;
export const MAX_DISABLED_RULES = 1;
/** A shadow-mode scorer never produces an enforcement. Kept as a constant so a test can pin it. */
export const FRAUD_NEVER_AUTOBANS = true;

export function clampFraudConfig(raw: unknown): { config: FraudConfig; clamped: string[] } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>; const clamped: string[] = [];
  const pick = (path: keyof typeof FRAUD_BOUNDS, dflt: number): number => {
    const parts = path.split('.'); let v: any = r; for (const p of parts) v = v?.[p];
    const [lo, hi] = FRAUD_BOUNDS[path]; const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : dflt;
    const c = Math.min(hi, Math.max(lo, n)); if (v !== undefined && c !== v) clamped.push(path); return c;
  };
  const d = DEFAULT_FRAUD_CONFIG;
  const disabled = Array.isArray(r.disabledRules) ? (r.disabledRules as unknown[]).filter((x): x is FraudRule => FRAUD_RULES.includes(x as FraudRule)) : [];
  if (disabled.length > MAX_DISABLED_RULES) clamped.push('disabledRules');
  const config: FraudConfig = {
    mode: r.mode === 'FLAG' ? 'FLAG' : 'SHADOW',
    velocity: { windowSec: pick('velocity.windowSec', d.velocity.windowSec), maxAttempts: pick('velocity.maxAttempts', d.velocity.maxAttempts) },
    cardTesting: { windowSec: pick('cardTesting.windowSec', d.cardTesting.windowSec), minFailures: pick('cardTesting.minFailures', d.cardTesting.minFailures), smallAmountMinor: pick('cardTesting.smallAmountMinor', d.cardTesting.smallAmountMinor), minDistinctFingerprints: pick('cardTesting.minDistinctFingerprints', d.cardTesting.minDistinctFingerprints) },
    amountAnomaly: { ratio: pick('amountAnomaly.ratio', d.amountAnomaly.ratio), minHistory: pick('amountAnomaly.minHistory', d.amountAnomaly.minHistory), minAmountMinor: pick('amountAnomaly.minAmountMinor', d.amountAnomaly.minAmountMinor) },
    repeatedFailures: { consecutive: pick('repeatedFailures.consecutive', d.repeatedFailures.consecutive) },
    fingerprintReuse: { windowSec: pick('fingerprintReuse.windowSec', d.fingerprintReuse.windowSec), maxAccounts: pick('fingerprintReuse.maxAccounts', d.fingerprintReuse.maxAccounts) },
    reviewScore: pick('reviewScore', d.reviewScore),
    disabledRules: disabled.slice(0, MAX_DISABLED_RULES),
  };
  return { config, clamped };
}

export interface FraudSignal { rule: FraudRule; weight: number; detail: string }
export interface FraudAssessment { attemptId: string; score: number; band: FraudBand; signals: FraudSignal[]; mode: FraudMode; /** SHADOW: always NONE. FLAG: REVIEW when the score reaches the review score. Never a block or a ban. */ action: 'NONE' | 'REVIEW' }

const isFail = (o: AttemptOutcome) => o !== 'SUCCESS';
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

/** `history`: attempts BEFORE `cur` (any account; the caller bounds the lookback). Order does not matter. */
export function assessAttempt(cur: PayAttempt, history: PayAttempt[], cfgIn: Partial<FraudConfig> | unknown = {}): FraudAssessment {
  const cfg = clampFraudConfig(cfgIn).config; const t = Date.parse(cur.at);
  const off = new Set(cfg.disabledRules);
  const prior = history.filter((h) => h.id !== cur.id && Date.parse(h.at) <= t);
  const mine = prior.filter((h) => h.accountId === cur.accountId);
  const within = (xs: PayAttempt[], sec: number) => xs.filter((h) => t - Date.parse(h.at) <= sec * 1000);
  const signals: FraudSignal[] = [];

  if (!off.has('VELOCITY')) {
    const n = within(mine, cfg.velocity.windowSec).length + 1;
    if (n > cfg.velocity.maxAttempts) signals.push({ rule: 'VELOCITY', weight: Math.min(40, 20 + (n - cfg.velocity.maxAttempts) * 4), detail: `${n} attempts in ${cfg.velocity.windowSec}s (limit ${cfg.velocity.maxAttempts})` });
  }
  if (!off.has('CARD_TESTING')) {
    const win = [...within(mine, cfg.cardTesting.windowSec), cur];
    const small = win.filter((h) => h.amountMinor <= cfg.cardTesting.smallAmountMinor);
    const fails = small.filter((h) => isFail(h.outcome)).length;
    const fps = new Set(small.map((h) => h.fingerprint).filter(Boolean)).size;
    if (fails >= cfg.cardTesting.minFailures && (fps >= cfg.cardTesting.minDistinctFingerprints || small.length >= cfg.cardTesting.minFailures * 2)) signals.push({ rule: 'CARD_TESTING', weight: 45, detail: `${fails} failed small attempts, ${fps} distinct cards, in ${cfg.cardTesting.windowSec}s` });
  }
  if (!off.has('AMOUNT_ANOMALY')) {
    const ok = mine.filter((h) => h.outcome === 'SUCCESS' && h.currency === cur.currency).map((h) => h.amountMinor);
    if (ok.length >= cfg.amountAnomaly.minHistory && cur.amountMinor >= cfg.amountAnomaly.minAmountMinor) {
      const m = median(ok); if (m > 0 && cur.amountMinor / m >= cfg.amountAnomaly.ratio) signals.push({ rule: 'AMOUNT_ANOMALY', weight: 25, detail: `${(cur.amountMinor / m).toFixed(1)}x this account's median (ratio limit ${cfg.amountAnomaly.ratio})` });
    }
  }
  if (!off.has('REPEATED_FAILURES') && isFail(cur.outcome)) {
    let run = 1; for (const h of [...mine].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))) { if (isFail(h.outcome)) run++; else break; }
    if (run >= cfg.repeatedFailures.consecutive) signals.push({ rule: 'REPEATED_FAILURES', weight: Math.min(35, 15 + (run - cfg.repeatedFailures.consecutive) * 5), detail: `${run} failures in a row` });
  }
  if (!off.has('FINGERPRINT_REUSE') && cur.fingerprint) {
    const accounts = new Set(prior.filter((h) => h.fingerprint === cur.fingerprint && t - Date.parse(h.at) <= cfg.fingerprintReuse.windowSec * 1000).map((h) => h.accountId)); accounts.add(cur.accountId);
    if (accounts.size > cfg.fingerprintReuse.maxAccounts) signals.push({ rule: 'FINGERPRINT_REUSE', weight: Math.min(50, 30 + (accounts.size - cfg.fingerprintReuse.maxAccounts) * 5), detail: `one card used by ${accounts.size} accounts (limit ${cfg.fingerprintReuse.maxAccounts})` });
  }
  const score = Math.min(100, signals.reduce((s, x) => s + x.weight, 0));
  const band: FraudBand = score >= cfg.reviewScore ? 'HIGH' : score >= Math.floor(cfg.reviewScore / 2) ? 'MEDIUM' : 'LOW';
  return { attemptId: cur.id, score, band, signals, mode: cfg.mode, action: cfg.mode === 'FLAG' && score >= cfg.reviewScore ? 'REVIEW' : 'NONE' };
}
