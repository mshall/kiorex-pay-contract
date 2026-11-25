import { createHmac, timingSafeEqual } from 'node:crypto';

export const hmacHex = (secret: string, data: string, algo: 'sha256' | 'sha512' = 'sha256'): string => createHmac(algo, secret).update(data).digest('hex');
export const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url');
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
