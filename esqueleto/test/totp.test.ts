import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, verifyTotp } from '../src/auth/totp';

// vetores da RFC 6238 (SHA1, segredo ASCII "12345678901234567890"), 6 últimos dígitos
const SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('totp', () => {
  it('base32 ida e volta', () => {
    expect(SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(SECRET).toString()).toBe('12345678901234567890');
  });
  it('bate com a RFC 6238', () => {
    expect(hotp(SECRET, Math.floor(59 / 30))).toBe('287082');
    expect(hotp(SECRET, Math.floor(1111111109 / 30))).toBe('081804');
    expect(hotp(SECRET, Math.floor(1234567890 / 30))).toBe('005924');
  });
  it('aceita ±30s e recusa código errado/formato inválido', () => {
    const t = 1234567890_000;
    const code = hotp(SECRET, Math.floor(1234567890 / 30));
    expect(verifyTotp(SECRET, code, t)).toBe(Math.floor(1234567890 / 30));
    expect(verifyTotp(SECRET, code, t + 30_000)).not.toBeNull();
    expect(verifyTotp(SECRET, code, t + 90_000)).toBeNull();
    expect(verifyTotp(SECRET, '000000', t)).toBeNull();
    expect(verifyTotp(SECRET, '12ab56', t)).toBeNull();
  });
});
