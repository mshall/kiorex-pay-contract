import { toCsv } from './csv';

/** Payment rollups (branch / organisation / platform) and the shared report table the CSV and PDF exports render. Pure aggregation: no money moves here. */
export interface RollupRow { at: string; organisationId: string; branchId?: string; psp: string; rail?: string; context?: string; currency: string; state: 'CAPTURED' | 'FAILED' | 'REFUNDED' | 'PARTIALLY_REFUNDED' | 'PENDING' | 'DISPUTED' | 'VOIDED'; amountMinor: number; refundedMinor?: number; feeMinor?: number }
export type RollupLevel = 'branch' | 'organisation' | 'platform' | 'psp' | 'day';
export interface RollupLine { key: string; label?: string; count: number; capturedCount: number; failedCount: number; disputedCount: number; capturedMinor: number; refundedMinor: number; feesMinor: number; netMinor: number; successRate: number | null; currency: string }

const keyOf = (r: RollupRow, level: RollupLevel): string => level === 'branch' ? `${r.organisationId}/${r.branchId ?? '-'}` : level === 'organisation' ? r.organisationId : level === 'psp' ? r.psp : level === 'day' ? r.at.slice(0, 10) : 'platform';
export function rollup(rows: RollupRow[], level: RollupLevel): RollupLine[] {
  const map = new Map<string, RollupLine>();
  for (const r of rows) {
    const k = `${keyOf(r, level)}|${r.currency}`;
    const l = map.get(k) ?? { key: keyOf(r, level), count: 0, capturedCount: 0, failedCount: 0, disputedCount: 0, capturedMinor: 0, refundedMinor: 0, feesMinor: 0, netMinor: 0, successRate: null, currency: r.currency };
    l.count++;
    if (r.state === 'CAPTURED' || r.state === 'REFUNDED' || r.state === 'PARTIALLY_REFUNDED' || r.state === 'DISPUTED') { l.capturedCount++; l.capturedMinor += r.amountMinor; }
    if (r.state === 'FAILED') l.failedCount++;
    if (r.state === 'DISPUTED') l.disputedCount++;
    l.refundedMinor += r.refundedMinor ?? (r.state === 'REFUNDED' ? r.amountMinor : 0);
    l.feesMinor += r.feeMinor ?? 0;
    map.set(k, l);
  }
  return [...map.values()].map((l) => ({ ...l, netMinor: l.capturedMinor - l.refundedMinor - l.feesMinor, successRate: l.capturedCount + l.failedCount ? Math.round((l.capturedCount / (l.capturedCount + l.failedCount)) * 10000) / 10000 : null })).sort((a, b) => a.key.localeCompare(b.key) || a.currency.localeCompare(b.currency));
}

export type Lang = 'en' | 'ar';
export const ROLLUP_HEADERS: Record<Lang, string[]> = {
  en: ['Group', 'Currency', 'Payments', 'Captured', 'Failed', 'Disputed', 'Captured amount', 'Refunded', 'Fees', 'Net', 'Success rate'],
  ar: ['المجموعة', 'العملة', 'عدد المدفوعات', 'المحصّلة', 'الفاشلة', 'المتنازع عليها', 'المبلغ المحصّل', 'المردود', 'الرسوم', 'الصافي', 'نسبة النجاح'],
};
const major = (m: number) => (m / 100).toFixed(2);
export interface ReportTable { title: string; lang: Lang; header: string[]; rows: string[][]; generatedAt: string; note?: string }
export function rollupTable(lines: RollupLine[], lang: Lang, title: string, generatedAt: string): ReportTable {
  return { title, lang, header: ROLLUP_HEADERS[lang], generatedAt, rows: lines.map((l) => [l.label ?? l.key, l.currency, String(l.count), String(l.capturedCount), String(l.failedCount), String(l.disputedCount), major(l.capturedMinor), major(l.refundedMinor), major(l.feesMinor), major(l.netMinor), l.successRate === null ? '' : `${(l.successRate * 100).toFixed(1)}%`]) };
}
export const reportCsv = (t: ReportTable): string => '﻿' + toCsv(t.header, t.rows); // BOM so Excel reads Arabic as UTF-8

/** Latin-only single-font PDF (Helvetica). Arabic text needs an embedded font: hosts that have one (the Clinic bilingual PDF builder) render `ReportTable` themselves. Non-Latin characters are replaced with '?'. */
export function reportPdfLatin(t: ReportTable): Buffer {
  const esc = (s: string) => s.replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1');
  const lines = [t.title, `Generated ${t.generatedAt}`, '', t.header.join(' | '), ...t.rows.map((r) => r.join(' | '))].slice(0, 60);
  const content = ['BT', '/F1 9 Tf', '12 TL', '40 800 Td', ...lines.map((l) => `(${esc(l.slice(0, 120))}) Tj T*`), 'ET'].join('\n');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n'; const off: number[] = [];
  objs.forEach((o, i) => { off.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${off.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
