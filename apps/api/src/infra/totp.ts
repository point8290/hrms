import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) over HMAC-SHA1, written against `node:crypto`.
 *
 * Implemented here rather than pulled in as a dependency: it is forty lines of well-specified
 * arithmetic, and an authentication primitive is the last place to accept an unaudited
 * transitive dependency tree. TOTP was chosen over SMS because an SMS code is delivered over
 * a channel the account holder does not control — SIM swap is a routine attack on payroll
 * systems, which is exactly what this protects.
 *
 * SHA-1, 6 digits and a 30-second step are not choices: they are what every authenticator
 * app implements. Deviating means the codes do not work.
 */

const DIGITS = 6;
const STEP_SECONDS = 30;

/**
 * How many steps either side of now are accepted.
 *
 * One step (±30s) absorbs ordinary clock drift between a phone and the server. Widening it
 * lengthens the window in which an observed code is replayable, so it stays at one.
 */
const DRIFT_STEPS = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** A 160-bit secret, base32-encoded — the size RFC 4226 recommends for HMAC-SHA1. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(encoded: string): Buffer {
  const clean = encoded.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('secret is not valid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code for one time step. Exported so a test can pin a counter instead of the clock. */
export function totpAt(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const message = Buffer.alloc(8);
  // 64-bit big-endian counter. Written as two 32-bit halves because a JS number cannot
  // hold the full range exactly, and BigInt here would buy nothing until the year 10,000.
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  message.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function currentCounter(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000 / STEP_SECONDS);
}

/**
 * Whether `code` is valid for `secret` right now.
 *
 * Returns the matching counter so the caller can record it and refuse a replay: without
 * that, a code observed over someone's shoulder stays usable for the rest of its window.
 * Comparison is constant-time, because a timing oracle on a six-digit code is a real one.
 */
export function verifyTotp(
  secret: string,
  code: string,
  options: { now?: Date; lastUsedCounter?: number | null } = {},
): { valid: boolean; counter?: number } {
  const candidate = code.replace(/\D/g, '');
  if (candidate.length !== DIGITS) return { valid: false };

  const current = currentCounter(options.now);
  for (let offset = -DRIFT_STEPS; offset <= DRIFT_STEPS; offset += 1) {
    const counter = current + offset;
    if (options.lastUsedCounter != null && counter <= options.lastUsedCounter) continue;
    if (constantTimeEquals(totpAt(secret, counter), candidate)) {
      return { valid: true, counter };
    }
  }
  return { valid: false };
}

/**
 * The `otpauth://` URI an authenticator app scans.
 *
 * The issuer and label are what the user sees in their app; getting them wrong means six
 * identical "HRMS" entries and no way to tell which account each belongs to.
 */
export function otpauthUri(input: { secret: string; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`);
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
