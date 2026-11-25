/**
 * Automated invoice matching: pair what the money side says (IPN rows, vendor settlement lines, receipts) with what the books say (Clinic invoices, SaaS invoices, Kiorex ledger lines).
 * Pure scoring; hosts persist results and run the human review queue. A match is applied automatically ONLY when it is exact and unambiguous; everything else goes to a person.
 */
export type MatchTargetKind = 'CLINIC_INVOICE' | 'SAAS_INVOICE' | 'KIOREX_LEDGER' | 'HOME_VISIT' | 'FRONT_DESK';
export interface MatchTarget { id: string; kind: MatchTargetKind; reference: string; amountMinor: number; currency: string; /** Already paid in full (or fully matched): never offered again. */ settled?: boolean; dueAt?: string; issuedAt?: string; payerName?: string; branchId?: string; organisationId?: string; /** Amount already matched against it (partial payments). */ matchedMinor?: number }
export type MatchSource = 'IPN' | 'SETTLEMENT' | 'RECEIPT' | 'WEBHOOK';
export interface MatchSignal { id: string; source: MatchSource; reference?: string; amountMinor: number; currency: string; occurredAt: string; payerName?: string; pspRef?: string; organisationId?: string }
export type MatchDecision = 'AUTO' | 'REVIEW' | 'UNMATCHED';
export interface MatchCandidate { targetId: string; confidence: number; reasons: string[] }
export interface MatchResult { signalId: string; decision: MatchDecision; targetId?: string; confidence: number; reasons: string[]; candidates: MatchCandidate[] }

export interface MatchConfig {
  /** Confidence needed for AUTO (also needs exact reference, exact remaining amount and a clear margin). Clamped to the floor. */
  autoThreshold: number;
  /** Confidence needed to enter the review queue at all. */
  reviewThreshold: number;
  /** AUTO needs the best candidate to beat the runner-up by this much. */
  autoMargin: number;
  /** Days between invoice date and payment that still score as plausible. */
  dateWindowDays: number;
}
/** Safety floors: no configuration can make auto-apply laxer than this. */
export const MATCH_FLOORS = { autoThresholdMin: 0.9, autoMarginMin: 0.1, reviewThresholdMin: 0.3 } as const;
export const DEFAULT_MATCH_CONFIG: MatchConfig = { autoThreshold: 0.95, reviewThreshold: 0.5, autoMargin: 0.2, dateWindowDays: 45 };
export function clampMatchConfig(c: Partial<MatchConfig> = {}): { config: MatchConfig; clamped: string[] } {
  const clamped: string[] = []; const d = { ...DEFAULT_MATCH_CONFIG, ...c };
  const num = (k: keyof MatchConfig, v: unknown, lo: number, hi: number) => { const n = typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_MATCH_CONFIG[k]; const r = Math.min(hi, Math.max(lo, n)); if (r !== v) clamped.push(String(k)); return r; };
  const config: MatchConfig = {
    autoThreshold: num('autoThreshold', d.autoThreshold, MATCH_FLOORS.autoThresholdMin, 1),
    reviewThreshold: num('reviewThreshold', d.reviewThreshold, MATCH_FLOORS.reviewThresholdMin, 0.9),
    autoMargin: num('autoMargin', d.autoMargin, MATCH_FLOORS.autoMarginMin, 1),
    dateWindowDays: num('dateWindowDays', d.dateWindowDays, 1, 365),
  };
  if (config.reviewThreshold > config.autoThreshold) { config.reviewThreshold = config.autoThreshold; clamped.push('reviewThreshold'); }
  return { config, clamped };
}

export const normRef = (s: string | undefined): string => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normName = (s: string | undefined): string[] => (s ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 1);
export function nameSimilarity(a: string | undefined, b: string | undefined): number {
  const x = normName(a); const y = normName(b); if (!x.length || !y.length) return 0;
  const sy = new Set(y); const hit = x.filter((w) => sy.has(w)).length; return hit / Math.max(x.length, y.length);
}

/** Reference score: 1 exact, 0.7 one contains the other (>=6 chars), 0 otherwise. */
export function referenceScore(a: string | undefined, b: string | undefined): number {
  const x = normRef(a); const y = normRef(b); if (!x || !y) return 0;
  if (x === y) return 1;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  return s.length >= 6 && l.includes(s) ? 0.7 : 0;
}

export function scorePair(sig: MatchSignal, t: MatchTarget, cfg: MatchConfig = DEFAULT_MATCH_CONFIG): MatchCandidate {
  const reasons: string[] = [];
  if (t.settled) return { targetId: t.id, confidence: 0, reasons: ['TARGET_SETTLED'] };
  if (sig.currency.toUpperCase() !== t.currency.toUpperCase()) return { targetId: t.id, confidence: 0, reasons: ['CURRENCY_MISMATCH'] };
  if (sig.organisationId && t.organisationId && sig.organisationId !== t.organisationId) return { targetId: t.id, confidence: 0, reasons: ['ORGANISATION_MISMATCH'] };
  const remaining = t.amountMinor - (t.matchedMinor ?? 0);
  const ref = referenceScore(sig.reference, t.reference);
  let amount = 0;
  if (sig.amountMinor === remaining) { amount = 1; reasons.push('AMOUNT_EXACT'); }
  else if (sig.amountMinor < remaining) { amount = 0.3; reasons.push('AMOUNT_PARTIAL'); }
  else { amount = 0.2; reasons.push('AMOUNT_OVER'); }
  if (ref === 1) reasons.unshift('REFERENCE_EXACT'); else if (ref > 0) reasons.unshift('REFERENCE_PARTIAL');
  let date = 0.5; // unknown dates are neutral
  const when = Date.parse(sig.occurredAt); const base = Date.parse(t.issuedAt ?? t.dueAt ?? '');
  if (!Number.isNaN(when) && !Number.isNaN(base)) {
    const days = (when - base) / 86_400_000;
    if (days >= -1 && days <= cfg.dateWindowDays) { date = 1 - Math.max(0, days) / (cfg.dateWindowDays * 2); reasons.push('DATE_IN_WINDOW'); } else { date = 0; reasons.push('DATE_OUTSIDE_WINDOW'); }
  }
  const name = nameSimilarity(sig.payerName, t.payerName); if (name >= 0.5) reasons.push('PAYER_NAME_SIMILAR');
  // Reference is the strongest evidence; amount confirms; date and name only nudge.
  let confidence = 0.65 * ref + 0.3 * amount + 0.03 * date + 0.02 * name;
  if (ref === 0) confidence = Math.min(confidence, 0.6); // no reference evidence: amount + date can never reach auto
  return { targetId: t.id, confidence: Math.round(confidence * 1000) / 1000, reasons };
}

export function matchSignal(sig: MatchSignal, targets: MatchTarget[], cfgIn: Partial<MatchConfig> = {}): MatchResult {
  const cfg = clampMatchConfig(cfgIn).config;
  const scored = targets.map((t) => scorePair(sig, t, cfg)).filter((c) => c.confidence > 0).sort((a, b) => b.confidence - a.confidence || a.targetId.localeCompare(b.targetId));
  const best = scored[0]; const second = scored[1];
  if (!best || best.confidence < cfg.reviewThreshold) return { signalId: sig.id, decision: 'UNMATCHED', confidence: best?.confidence ?? 0, reasons: best?.reasons ?? ['NO_CANDIDATE'], candidates: scored.slice(0, 3) };
  const exact = best.reasons.includes('REFERENCE_EXACT') && best.reasons.includes('AMOUNT_EXACT');
  const clear = !second || best.confidence - second.confidence >= cfg.autoMargin;
  const auto = exact && clear && best.confidence >= cfg.autoThreshold;
  const reasons = [...best.reasons]; if (exact && !clear) reasons.push('AMBIGUOUS_RUNNER_UP'); if (second && !clear) reasons.push('NEEDS_HUMAN_REVIEW');
  return { signalId: sig.id, decision: auto ? 'AUTO' : 'REVIEW', targetId: best.targetId, confidence: best.confidence, reasons, candidates: scored.slice(0, 3) };
}

/** Matches a batch. A target that an AUTO match consumed (exactly) is not offered to later signals in the same batch, so two identical IPN rows can never both auto-apply. */
export function matchBatch(signals: MatchSignal[], targets: MatchTarget[], cfg: Partial<MatchConfig> = {}): MatchResult[] {
  const taken = new Set<string>(); const out: MatchResult[] = [];
  for (const s of [...signals].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id))) {
    const r = matchSignal(s, targets.filter((t) => !taken.has(t.id)), cfg);
    if (r.decision === 'AUTO' && r.targetId) taken.add(r.targetId);
    out.push(r);
  }
  const order = new Map(signals.map((s, i) => [s.id, i]));
  return out.sort((a, b) => order.get(a.signalId)! - order.get(b.signalId)!);
}
