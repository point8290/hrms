import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  scrypt as scryptCb,
  timingSafeEqual,
  createHash,
} from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.ts';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

// Deliberately expensive. Tuned so a single hash costs ~100ms on a modern CPU.
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEY_LENGTH = 32;

/**
 * scrypt from node:crypto rather than a native argon2 binding: memory-hard, available
 * everywhere Node runs, and it removes a compiled dependency from the deploy path.
 * The parameters are encoded in the stored string so they can be raised later without
 * invalidating existing hashes.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || expected.length === 0) {
    return false;
  }

  const derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
    N,
    r,
    p,
    maxmem: 256 * 1024 * 1024,
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * Constant-cost rejection for unknown accounts.
 *
 * Without this, "user not found" returns far faster than "wrong password", which lets an
 * attacker enumerate registered email addresses by timing alone.
 */
export async function burnPasswordTime(): Promise<void> {
  await scrypt('timing-equalizer', randomBytes(16), KEY_LENGTH, SCRYPT);
}

const AAD = Buffer.from('hrms.field.v1');

/**
 * AES-256-GCM field encryption for values that must not be readable in a database dump
 * (currently bank account numbers).
 *
 * The ciphertext carries its own random IV and auth tag, so two employees with the same
 * account number produce different ciphertext and tampering is detected on read.
 */
export function encryptField(plaintext: string): string {
  const key = Buffer.from(config().FIELD_ENCRYPTION_KEY, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

export function decryptField(ciphertext: string): string {
  const [version, ivB64, tagB64, dataB64] = ciphertext.split('.');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('Unrecognised encrypted field format');
  }
  const key = Buffer.from(config().FIELD_ENCRYPTION_KEY, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/** Refresh tokens are stored hashed: a database leak must not yield usable sessions. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export { randomUUID };
