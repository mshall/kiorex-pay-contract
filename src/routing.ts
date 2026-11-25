/**
 * Provider ordering: an organisation's own preference wins (it is explicit), except that a provider whose observed success is clearly worse than the best is demoted (an organisation-pinned one only when its lower-bound success is below 50%), then the market's configured order. Fees are config and NEEDS_HUMAN: they are never assumed,
 * and a provider with no configured fee is never ranked as cheap. Failover (an open circuit) is the caller's `available` flag.
 */
export interface RouteCandidate {
  psp: string;
  /** Market-level enabled and not disabled by the platform. */
  enabled: boolean;
  /** Circuit closed / not in an outage window. */
  available?: boolean;
  /** Rank in the market's configured order (0 = most preferred). */
  marketRank: number;
  /** Organisation preference rank (0 = most preferred), undefined = no opinion. */
  orgRank?: number;
  /** An organisation may block a provider outright. */
  orgBlocked?: boolean;
  stats?: { attempts: number; successes: number };
  /** Percentage in basis points; null until finance sets it. */
  feeBps?: number | null;
  /** Rails this provider supports (so wallet / bank_ipn / card can be selected). */
  rails?: string[];
}
export interface RoutingConfig {
  strategy: 'preference' | 'success' | 'cost';
  /** Attempts below which a provider's observed success rate is not trusted (it keeps its configured order). */
  minAttempts: number;
  /** A provider whose lower-bound success rate is this much below the best is ranked below it. */
  successMargin: number;
}
export const DEFAULT_ROUTING: RoutingConfig = { strategy: 'success', minAttempts: 30, successMargin: 0.05 };
export const ROUTING_FLOORS = { minAttemptsMin: 10, successMarginMin: 0.01 } as const;
export const clampRouting = (c: Partial<RoutingConfig> = {}): RoutingConfig => ({
  strategy: c.strategy === 'preference' || c.strategy === 'cost' || c.strategy === 'success' ? c.strategy : DEFAULT_ROUTING.strategy,
  minAttempts: Math.max(ROUTING_FLOORS.minAttemptsMin, Math.floor(Number.isFinite(c.minAttempts) ? (c.minAttempts as number) : DEFAULT_ROUTING.minAttempts)),
  successMargin: Math.min(0.5, Math.max(ROUTING_FLOORS.successMarginMin, Number.isFinite(c.successMargin) ? (c.successMargin as number) : DEFAULT_ROUTING.successMargin)),
});

/** Wilson lower bound (95%): a small sample cannot look better than a large one. */
export function wilsonLower(successes: number, attempts: number, z = 1.96): number {
  if (attempts <= 0) return 0;
  const p = successes / attempts; const n = attempts; const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}
export interface RouteDecision { order: string[]; excluded: { psp: string; reason: string }[]; explain: { psp: string; why: string[] }[] }

export function orderProviders(cands: RouteCandidate[], cfgIn: Partial<RoutingConfig> = {}, opts: { rail?: string } = {}): RouteDecision {
  const cfg = clampRouting(cfgIn); const excluded: RouteDecision['excluded'] = [];
  const live = cands.filter((c) => {
    if (!c.enabled) { excluded.push({ psp: c.psp, reason: 'DISABLED' }); return false; }
    if (c.orgBlocked) { excluded.push({ psp: c.psp, reason: 'ORG_BLOCKED' }); return false; }
    if (c.available === false) { excluded.push({ psp: c.psp, reason: 'UNAVAILABLE' }); return false; }
    if (opts.rail && c.rails && !c.rails.includes(opts.rail)) { excluded.push({ psp: c.psp, reason: 'RAIL_NOT_SUPPORTED' }); return false; }
    return true;
  });
  const trusted = (c: RouteCandidate) => (c.stats?.attempts ?? 0) >= cfg.minAttempts;
  const lb = (c: RouteCandidate) => (trusted(c) ? wilsonLower(c.stats!.successes, c.stats!.attempts) : null);
  const bestLb = Math.max(0, ...live.map((c) => lb(c) ?? 0));
  const why = new Map<string, string[]>(live.map((c) => [c.psp, []]));
  const score = (c: RouteCandidate): number[] => {
    const w = why.get(c.psp)!;
    const org = c.orgRank !== undefined ? c.orgRank : 1000; if (c.orgRank !== undefined) w.push(`ORG_PREFERENCE#${c.orgRank}`);
    let tier = 0;
    if (cfg.strategy === 'success') { const l = lb(c); if (l !== null && bestLb - l > cfg.successMargin && (c.orgRank === undefined || l < 0.5)) { tier = 1; w.push(`SUCCESS_LOW(${l.toFixed(2)} vs ${bestLb.toFixed(2)})`); } else if (l !== null) w.push(`SUCCESS_OK(${l.toFixed(2)})`); else w.push('SUCCESS_UNKNOWN(config order)'); }
    const fee = cfg.strategy === 'cost' ? (typeof c.feeBps === 'number' ? c.feeBps : 1e9) : 0; // unset fee sorts last, never "free"
    if (cfg.strategy === 'cost') w.push(typeof c.feeBps === 'number' ? `FEE_BPS=${c.feeBps}` : 'FEE_UNSET(NEEDS_HUMAN)');
    return cfg.strategy === 'preference' ? [org, c.marketRank] : cfg.strategy === 'cost' ? [org, fee, c.marketRank] : [tier, org, c.marketRank];
  };
  const keyed = live.map((c) => ({ c, k: score(c) }));
  keyed.sort((a, b) => { for (let i = 0; i < a.k.length; i++) if (a.k[i] !== b.k[i]) return a.k[i]! - b.k[i]!; return a.c.psp.localeCompare(b.c.psp); });
  return { order: keyed.map((x) => x.c.psp), excluded, explain: keyed.map((x) => ({ psp: x.c.psp, why: why.get(x.c.psp)! })) };
}
