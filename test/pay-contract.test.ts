import { describe, expect, it } from 'vitest';
import {
  BankIpnAdapter, WalletAdapter, assessAttempt, clampFraudConfig, clampMatchConfig, defaultWalletConfig, hmacHex, matchBatch, matchSignal, orderProviders, qrPlan, readLink, redeemLink,
  reportCsv, reportPdfLatin, rollup, rollupTable, signLink, toMinor, fromMinor, walletConfigFromEnv, walletReadiness, wilsonLower, PayNotSupportedError, DEFAULT_FRAUD_CONFIG, FRAUD_BOUNDS,
  type BankIpnConfig, type MatchTarget, type PayAdapter, type PayAttempt, type RouteCandidate,
} from '../src';

const cfg: BankIpnConfig = { columns: { bankRef: 'txn', amount: 'amount', currency: 'ccy', reference: 'note', paidAt: 'date', payer: 'from', status: 'status', kind: 'type' }, amountUnit: 'major', successStatuses: ['OK'], reversalKinds: ['REVERSAL'], referencePattern: '^PAY-[A-Z0-9]{6}$', signature: { header: 'x-sig', algo: 'sha256', mode: 'ts.body', timestampHeader: 'x-ts', toleranceSec: 300 }, defaultCurrency: 'EGP' };

describe('money', () => {
  it('converts without floats and refuses lossy input', () => { expect(toMinor('12.5')).toBe(1250); expect(toMinor('1,200.05')).toBe(120005); expect(toMinor('1.234')).toBeNull(); expect(toMinor('1.230')).toBe(123); expect(toMinor('x')).toBeNull(); expect(fromMinor(120005)).toBe('1200.05'); expect(fromMinor(-5)).toBe('-0.05'); });
});

describe('bank IPN adapter', () => {
  const a = new BankIpnAdapter(cfg, 's3cret');
  const csv = 'txn,amount,ccy,note,date,from,status,type\nB1,250.00,EGP,PAY-ABC123,2026-11-25T10:00:00Z,Ahmed Hassan,OK,CREDIT\nB1,250.00,EGP,PAY-ABC123,2026-11-25T10:00:00Z,Ahmed Hassan,OK,CREDIT\nB2,abc,EGP,x,2026-11-25,x,OK,CREDIT\nB3,10,EGP,foo,2026-11-25,Sara,PENDING,CREDIT\nB4,50,EGP,PAY-ZZZ999,2026-11-26T09:00:00Z,Sara,OK,REVERSAL\nB5,75.50,,oddnote,2026-11-26T09:00:00Z,Mona Ali,OK,CREDIT';
  it('ingests a file: dedupes, refuses bad rows, maps reversals, masks payer, never keeps a full account', () => {
    const r = a.ingestFile(csv);
    expect(r.events.map((e) => [e.pspRef, e.type, e.amountMinor, e.paymentId])).toEqual([['B1', 'payment.captured', 25000, 'PAY-ABC123'], ['B4', 'refund.settled', 5000, 'PAY-ZZZ999'], ['B5', 'payment.captured', 7550, undefined]]);
    expect(r.rejected.map((x) => x.reason)).toEqual(['DUPLICATE_IN_FILE', 'BAD_AMOUNT', 'STATUS_NOT_SUCCESS:pending']);
    expect(r.events[0]!.payerMasked).toMatch(/^Ah\*+ an$|^Ah\*+an$/);
    expect(r.events[0]!.payerMasked).not.toContain('Ahmed');
    expect(r.events[2]!.currency).toBe('EGP');
    expect(r.events.every((e) => e.rail === 'bank_ipn')).toBe(true);
  });
  it('JSON files and unparseable files', () => {
    expect(a.ingestFile(JSON.stringify([{ txn: 'J1', amount: '5', date: '2026-11-25', note: 'PAY-ABC123', status: 'OK' }])).events).toHaveLength(1);
    expect(a.ingestFile('{{{', { format: 'json' }).rejected[0]!.reason).toBe('UNPARSEABLE_FILE');
  });
  it('webhook: signature, replay window, tamper, unsigned config', () => {
    const body = JSON.stringify({ txn: 'W1', amount: '10', date: '2026-11-25', note: 'PAY-ABC123', status: 'OK' });
    const now = new Date('2026-11-25T10:00:00Z'); const ts = String(Math.floor(now.getTime() / 1000));
    const sig = hmacHex('s3cret', `${ts}.${body}`);
    expect(a.verifyWebhook(body, { 'X-Sig': sig, 'X-Ts': ts }, undefined, now)?.pspRef).toBe('W1');
    expect(a.verifyWebhook(body + ' ', { 'x-sig': sig, 'x-ts': ts }, undefined, now)).toBeNull();
    expect(a.verifyWebhook(body, { 'x-sig': sig, 'x-ts': ts }, undefined, new Date(now.getTime() + 10 * 60_000))).toBeNull();
    expect(a.verifyWebhook(body, {}, undefined, now)).toBeNull();
    expect(new BankIpnAdapter({ ...cfg, signature: undefined }, 's').verifyWebhook(body, {}, undefined, now)).toBeNull();
    expect(new BankIpnAdapter(cfg, '').verifyWebhook(body, { 'x-sig': sig, 'x-ts': ts }, undefined, now)).toBeNull();
  });
  it('checkout gives reference instructions, refund is not supported', async () => {
    const c = await a.createCheckout({ paymentId: 'PAY-ABC123', amountMinor: 25000, currency: 'EGP' });
    expect(c.instructions!.en).toContain('250.00'); expect(c.instructions!.ar).toContain('PAY-ABC123'); expect(c.checkoutUrl).toBeUndefined();
    await expect(a.refund()).rejects.toBeInstanceOf(PayNotSupportedError);
  });
});

describe('wallet skeleton', () => {
  const inner: PayAdapter = { name: 'paymob', capabilities: { rails: ['card'], capture: true, void: true, status: true, partialRefund: true, hostedCheckout: true, cardFacts: true, fileIngest: false, qr: 'NONE' }, createCheckout: async (i) => ({ pspRef: `p_${i.method}`, checkoutUrl: 'https://x/y' }), verifyWebhook: () => ({ eventId: 'e', type: 'payment.captured', pspRef: 'r', amountMinor: 1, occurredAt: 'x' }), refund: async () => ({ pspRefundRef: 'r' }) };
  it('is disabled until a wallet integration id exists', async () => {
    const c = defaultWalletConfig();
    expect(walletReadiness(c).every((r) => r.state === 'DISABLED')).toBe(true);
    await expect(new WalletAdapter(inner, c).createCheckout({ paymentId: 'p', amountMinor: 100, currency: 'EGP', method: 'vodafone_cash' })).rejects.toBeInstanceOf(PayNotSupportedError);
  });
  it('env config enables the method and the checkout runs through the wrapped adapter', async () => {
    const c = walletConfigFromEnv({ PAYMOB_WALLET_INTEGRATION_IDS: 'vodafone_cash:123,bogus:9,orange_cash:x' });
    expect(walletReadiness(c).map((r) => r.state)).toEqual(['READY', 'DISABLED', 'DISABLED']);
    const w = new WalletAdapter(inner, c);
    expect((await w.createCheckout({ paymentId: 'p', amountMinor: 100, currency: 'EGP', method: 'vodafone_cash' })).pspRef).toBe('p_vodafone_cash');
    expect(w.capabilities.rails).toEqual(['wallet']); expect(w.verifyWebhook('{}', {})!.rail).toBe('wallet');
  });
});

const T = (o: Partial<MatchTarget> & { id: string }): MatchTarget => ({ kind: 'CLINIC_INVOICE', reference: o.id, amountMinor: 25000, currency: 'EGP', issuedAt: '2026-11-20T00:00:00Z', ...o });
describe('invoice matching', () => {
  const sig = { id: 's1', source: 'IPN' as const, reference: 'INV-0042', amountMinor: 25000, currency: 'EGP', occurredAt: '2026-11-25T10:00:00Z' };
  it('exact reference + amount + clear margin is AUTO', () => { const r = matchSignal(sig, [T({ id: 'a', reference: 'INV-0042' }), T({ id: 'b', reference: 'INV-0043' })]); expect(r.decision).toBe('AUTO'); expect(r.targetId).toBe('a'); expect(r.confidence).toBeGreaterThanOrEqual(0.95); });
  it('amount alone never auto-matches (no reference)', () => { const r = matchSignal({ ...sig, reference: undefined }, [T({ id: 'a' })]); expect(r.decision).not.toBe('AUTO'); expect(r.confidence).toBeLessThanOrEqual(0.6); });
  it('two identical candidates are ambiguous, not auto', () => { const r = matchSignal(sig, [T({ id: 'a', reference: 'INV-0042' }), T({ id: 'b', reference: 'INV-0042' })]); expect(r.decision).toBe('REVIEW'); expect(r.reasons).toContain('AMBIGUOUS_RUNNER_UP'); });
  it('partial payment and overpayment go to review; settled and wrong currency are excluded', () => {
    expect(matchSignal({ ...sig, amountMinor: 10000 }, [T({ id: 'a', reference: 'INV-0042' })]).decision).toBe('REVIEW');
    expect(matchSignal({ ...sig, amountMinor: 30000 }, [T({ id: 'a', reference: 'INV-0042' })]).decision).toBe('REVIEW');
    expect(matchSignal(sig, [T({ id: 'a', reference: 'INV-0042', settled: true })]).decision).toBe('UNMATCHED');
    expect(matchSignal(sig, [T({ id: 'a', reference: 'INV-0042', currency: 'USD' })]).decision).toBe('UNMATCHED');
    expect(matchSignal({ ...sig, organisationId: 'o1' }, [T({ id: 'a', reference: 'INV-0042', organisationId: 'o2' })]).decision).toBe('UNMATCHED');
  });
  it('a partially matched invoice compares against what remains', () => { expect(matchSignal({ ...sig, amountMinor: 15000 }, [T({ id: 'a', reference: 'INV-0042', matchedMinor: 10000 })]).decision).toBe('AUTO'); });
  it('a target is consumed by one AUTO match in a batch (duplicate IPN cannot double-apply)', () => {
    const out = matchBatch([sig, { ...sig, id: 's2', occurredAt: '2026-11-25T10:01:00Z' }], [T({ id: 'a', reference: 'INV-0042' })]);
    expect(out.map((o) => o.decision)).toEqual(['AUTO', 'UNMATCHED']);
  });
  it('config cannot make auto laxer than the floor', () => { const { config, clamped } = clampMatchConfig({ autoThreshold: 0.2, autoMargin: 0, reviewThreshold: 5 }); expect(config.autoThreshold).toBe(0.9); expect(config.autoMargin).toBe(0.1); expect(config.reviewThreshold).toBeLessThanOrEqual(config.autoThreshold); expect(clamped.length).toBeGreaterThan(0); });
  it('property: confidence is within 0..1 and AUTO always has exact reference and amount', () => {
    for (let i = 0; i < 300; i++) {
      const amt = [25000, 24999, 100, 99999][i % 4]!; const ref = ['INV-0042', 'inv0042', 'INV-9', '', 'X'][i % 5]!;
      const r = matchSignal({ ...sig, amountMinor: amt, reference: ref }, [T({ id: 'a', reference: 'INV-0042' }), T({ id: 'b', reference: ['INV-0042', 'OTHER'][i % 2]! })]);
      expect(r.confidence).toBeGreaterThanOrEqual(0); expect(r.confidence).toBeLessThanOrEqual(1);
      if (r.decision === 'AUTO') { expect(r.reasons).toContain('REFERENCE_EXACT'); expect(r.reasons).toContain('AMOUNT_EXACT'); }
    }
  });
});

describe('payment links and QR', () => {
  const store = () => { const used = new Set<string>(); return { markUsed: async (id: string) => (used.has(id) ? false : (used.add(id), true)) }; };
  const now = new Date('2026-11-25T10:00:00Z');
  const mk = () => signLink('k', { id: 'L1', ctx: 'CLINIC_INVOICE', subject: 'inv_1', amountMinor: 25000, currency: 'EGP', ttlSec: 3600, now, rail: 'card' });
  it('single use, amount locked, expiring', async () => {
    const { token } = mk(); const s = store();
    expect((await redeemLink('k', token, { amountMinor: 24999, currency: 'EGP', now }, s)).ok).toBe(false);
    expect(await redeemLink('k', token, { amountMinor: 25000, currency: 'USD', now }, s)).toEqual({ ok: false, reason: 'CURRENCY_MISMATCH' });
    expect(await redeemLink('k', token, { amountMinor: 25000, currency: 'EGP', subject: 'inv_2', now }, s)).toEqual({ ok: false, reason: 'SUBJECT_MISMATCH' });
    expect(await redeemLink('k', token, { amountMinor: 25000, currency: 'EGP', rail: 'wallet', now }, s)).toEqual({ ok: false, reason: 'RAIL_MISMATCH' });
    expect((await redeemLink('k', token, { amountMinor: 25000, currency: 'EGP', now }, s)).ok).toBe(true); // refused attempts did not consume it
    expect(await redeemLink('k', token, { amountMinor: 25000, currency: 'EGP', now }, s)).toEqual({ ok: false, reason: 'ALREADY_USED' });
    expect(await redeemLink('k', mk().token, { amountMinor: 25000, currency: 'EGP', now: new Date(now.getTime() + 3601_000) }, store())).toEqual({ ok: false, reason: 'EXPIRED' });
  });
  it('concurrent redemption: exactly one wins', async () => { const { token } = mk(); const s = store(); const r = await Promise.all(Array.from({ length: 10 }, () => redeemLink('k', token, { amountMinor: 25000, currency: 'EGP', now }, s))); expect(r.filter((x) => x.ok)).toHaveLength(1); });
  it('forged, truncated, wrong key and bad ttl', () => {
    const { token } = mk(); const [h, b, s] = token.split('.');
    expect(readLink('other', token)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(b!, 'base64url').toString()), amountMinor: 1 })).toString('base64url');
    expect(readLink('k', `${h}.${forged}.${s}`)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(readLink('k', 'nope')).toEqual({ ok: false, reason: 'MALFORMED' });
    expect(() => signLink('k', { id: 'x', ctx: 'FRONT_DESK', subject: 's', amountMinor: 0, currency: 'EGP' })).toThrow();
    expect(signLink('k', { id: 'x', ctx: 'FRONT_DESK', subject: 's', amountMinor: 5, currency: 'EGP', ttlSec: 9e9, now }).claim.exp - Math.floor(now.getTime() / 1000)).toBe(7 * 86400);
    expect(JSON.stringify(readLink('k', token))).not.toMatch(/iban|holder|patientName|pan/i);
  });
  it('QR: provider payload only when the vendor supports it, otherwise a link QR, never a fake provider QR', () => {
    const cap = (qr: 'PROVIDER' | 'LINK' | 'NONE') => ({ capabilities: { rails: [], capture: false, void: false, status: false, partialRefund: false, hostedCheckout: true, cardFacts: false, fileIngest: false, qr } });
    expect(qrPlan(cap('PROVIDER'), { qrPayload: 'EMV...', checkoutUrl: 'https://u' })).toEqual({ kind: 'PROVIDER', content: 'EMV...' });
    expect(qrPlan(cap('NONE'), { qrPayload: 'EMV...', checkoutUrl: 'https://u' })).toEqual({ kind: 'LINK', content: 'https://u' });
    expect(qrPlan(cap('PROVIDER'), {})).toEqual({ kind: 'NONE', content: null });
  });
});

describe('routing', () => {
  const c = (psp: string, rank: number, o: Partial<RouteCandidate> = {}): RouteCandidate => ({ psp, enabled: true, marketRank: rank, ...o });
  it('market order by default, disabled / blocked / unavailable / wrong rail excluded', () => {
    const r = orderProviders([c('paymob', 0, { rails: ['card'] }), c('fawry', 1, { enabled: false }), c('instapay', 2, { orgBlocked: true }), c('card', 3, { available: false }), c('bank_ipn', 4, { rails: ['bank_ipn'] })], { strategy: 'preference' }, { rail: 'bank_ipn' });
    expect(r.order).toEqual(['bank_ipn']); expect(r.excluded.map((e) => e.reason).sort()).toEqual(['DISABLED', 'ORG_BLOCKED', 'RAIL_NOT_SUPPORTED', 'UNAVAILABLE']);
  });
  it('organisation preference beats market order', () => { expect(orderProviders([c('paymob', 0), c('fawry', 1, { orgRank: 0 })], { strategy: 'preference' }).order).toEqual(['fawry', 'paymob']); });
  it('success-rate ordering demotes a clearly worse provider, ignores tiny samples', () => {
    expect(orderProviders([c('paymob', 0, { stats: { attempts: 200, successes: 120 } }), c('fawry', 1, { stats: { attempts: 200, successes: 190 } })]).order).toEqual(['fawry', 'paymob']);
    expect(orderProviders([c('paymob', 0, { stats: { attempts: 3, successes: 0 } }), c('fawry', 1, { stats: { attempts: 3, successes: 3 } })]).order).toEqual(['paymob', 'fawry']);
  });
  it('org pin survives a mild dip but not a collapse', () => {
    const mild = orderProviders([c('paymob', 0, { orgRank: 0, stats: { attempts: 200, successes: 160 } }), c('fawry', 1, { stats: { attempts: 200, successes: 190 } })]).order; expect(mild).toEqual(['paymob', 'fawry']);
    const bad = orderProviders([c('paymob', 0, { orgRank: 0, stats: { attempts: 200, successes: 60 } }), c('fawry', 1, { stats: { attempts: 200, successes: 190 } })]).order; expect(bad).toEqual(['fawry', 'paymob']);
  });
  it('cost strategy never treats an unset fee as cheap', () => { expect(orderProviders([c('paymob', 0, { feeBps: null }), c('fawry', 1, { feeBps: 250 })], { strategy: 'cost' }).order).toEqual(['fawry', 'paymob']); });
  it('wilson lower bound grows with sample size', () => { expect(wilsonLower(9, 10)).toBeLessThan(wilsonLower(900, 1000)); expect(wilsonLower(0, 0)).toBe(0); });
  it('is deterministic and a permutation of the live set', () => { const cs = ['a', 'b', 'c', 'd'].map((p, i) => c(p, i % 2)); const o1 = orderProviders(cs).order; expect(orderProviders([...cs].reverse()).order).toEqual(o1); expect([...o1].sort()).toEqual(['a', 'b', 'c', 'd']); });
});

const A = (id: string, minAgo: number, o: Partial<PayAttempt> = {}): PayAttempt => ({ id, at: new Date(Date.parse('2026-11-25T12:00:00Z') - minAgo * 60_000).toISOString(), outcome: 'SUCCESS', amountMinor: 20000, currency: 'EGP', accountId: 'acc1', ...o });
describe('fraud scorer', () => {
  it('default mode is SHADOW and never acts', () => {
    const hist = Array.from({ length: 12 }, (_, i) => A(`h${i}`, 1 + i * 0.1, { outcome: 'FAILED', fingerprint: `fp${i}`, amountMinor: 1000 }));
    const r = assessAttempt(A('cur', 0, { outcome: 'FAILED', fingerprint: 'fpX', amountMinor: 1000 }), hist);
    expect(r.mode).toBe('SHADOW'); expect(r.action).toBe('NONE'); expect(r.signals.map((s) => s.rule)).toEqual(expect.arrayContaining(['VELOCITY', 'CARD_TESTING', 'REPEATED_FAILURES'])); expect(r.band).toBe('HIGH');
    expect(assessAttempt(A('cur', 0, { outcome: 'FAILED', fingerprint: 'fpX', amountMinor: 1000 }), hist, { mode: 'FLAG' }).action).toBe('REVIEW');
  });
  it('quiet account scores zero', () => { const r = assessAttempt(A('c', 0), [A('h', 60 * 24)]); expect(r.score).toBe(0); expect(r.band).toBe('LOW'); });
  it('amount anomaly vs the account median', () => { const hist = [A('a', 1000), A('b', 2000), A('c', 3000)]; expect(assessAttempt(A('x', 0, { amountMinor: 400000 }), hist).signals.map((s) => s.rule)).toContain('AMOUNT_ANOMALY'); expect(assessAttempt(A('x', 0, { amountMinor: 30000 }), hist).signals).toHaveLength(0); });
  it('fingerprint reuse across accounts', () => {
    const hist = ['a1', 'a2', 'a3'].map((a, i) => A(`h${i}`, 100 + i, { accountId: a, fingerprint: 'shared' }));
    expect(assessAttempt(A('x', 0, { accountId: 'a4', fingerprint: 'shared' }), hist).signals.map((s) => s.rule)).toContain('FINGERPRINT_REUSE');
    expect(assessAttempt(A('x', 0, { accountId: 'a3', fingerprint: 'shared' }), hist).signals).toHaveLength(0);
  });
  it('config is clamped to safety bounds and cannot blind the scorer', () => {
    const { config, clamped } = clampFraudConfig({ mode: 'ENFORCE', velocity: { maxAttempts: 9999, windowSec: 1 }, reviewScore: 100, disabledRules: ['VELOCITY', 'CARD_TESTING', 'AMOUNT_ANOMALY'] });
    expect(config.mode).toBe('SHADOW'); expect(config.velocity.maxAttempts).toBe(FRAUD_BOUNDS['velocity.maxAttempts'][1]); expect(config.velocity.windowSec).toBe(FRAUD_BOUNDS['velocity.windowSec'][0]); expect(config.reviewScore).toBe(90); expect(config.disabledRules).toHaveLength(1); expect(clamped).toEqual(expect.arrayContaining(['velocity.maxAttempts', 'disabledRules']));
    expect(clampFraudConfig(DEFAULT_FRAUD_CONFIG).clamped).toEqual([]); expect(clampFraudConfig(null).config).toEqual(DEFAULT_FRAUD_CONFIG); expect(clampFraudConfig('x').config.mode).toBe('SHADOW');
  });
  it('property: score within 0..100, action is only NONE or REVIEW, deterministic', () => {
    for (let i = 0; i < 200; i++) {
      const hist = Array.from({ length: i % 25 }, (_, k) => A(`h${k}`, (k * 7 + i) % 90, { outcome: k % 3 ? 'FAILED' : 'SUCCESS', accountId: `a${k % 4}`, fingerprint: `f${k % 5}`, amountMinor: 500 + k * 1000 }));
      const cur = A('cur', 0, { accountId: `a${i % 4}`, fingerprint: `f${i % 5}`, outcome: i % 2 ? 'FAILED' : 'SUCCESS' });
      const r = assessAttempt(cur, hist, { mode: i % 2 ? 'FLAG' : 'SHADOW' }); expect(r.score).toBeGreaterThanOrEqual(0); expect(r.score).toBeLessThanOrEqual(100); expect(['NONE', 'REVIEW']).toContain(r.action);
      expect(assessAttempt(cur, [...hist].reverse(), { mode: i % 2 ? 'FLAG' : 'SHADOW' })).toEqual(r);
    }
  });
});

describe('rollups and exports', () => {
  const rows = [
    { at: '2026-11-25T10:00:00Z', organisationId: 'o1', branchId: 'b1', psp: 'paymob', currency: 'EGP', state: 'CAPTURED' as const, amountMinor: 10000, feeMinor: 250 },
    { at: '2026-11-25T11:00:00Z', organisationId: 'o1', branchId: 'b2', psp: 'fawry', currency: 'EGP', state: 'FAILED' as const, amountMinor: 5000 },
    { at: '2026-11-26T11:00:00Z', organisationId: 'o2', psp: 'paymob', currency: 'EGP', state: 'REFUNDED' as const, amountMinor: 8000 },
  ];
  it('aggregates by branch, organisation, platform and psp', () => {
    expect(rollup(rows, 'branch').map((l) => l.key)).toEqual(['o1/b1', 'o1/b2', 'o2/-']);
    const org = rollup(rows, 'organisation'); expect(org[0]).toMatchObject({ key: 'o1', count: 2, capturedMinor: 10000, feesMinor: 250, netMinor: 9750, successRate: 0.5 });
    expect(rollup(rows, 'platform')[0]).toMatchObject({ count: 3, capturedMinor: 18000, refundedMinor: 8000 });
    expect(rollup(rows, 'platform')[0]!.netMinor).toBe(18000 - 8000 - 250);
  });
  it('csv has BOM, AR headers, formula neutralised; pdf is a valid single page', () => {
    const t = rollupTable(rollup(rows, 'organisation').map((l) => ({ ...l, label: l.key === 'o1' ? '=cmd()' : l.key })), 'ar', 'Rollup', '2026-11-25');
    const csv = reportCsv(t); expect(csv.charCodeAt(0)).toBe(0xfeff); expect(csv).toContain('المجموعة'); expect(csv).toContain("'=cmd()");
    const pdf = reportPdfLatin(rollupTable(rollup(rows, 'organisation'), 'en', 'Rollup (a) b', '2026-11-25')).toString('latin1'); expect(pdf.startsWith('%PDF-1.4')).toBe(true); expect(pdf).toContain('%%EOF'); expect(pdf).toContain('Rollup \\(a\\) b');
  });
});
