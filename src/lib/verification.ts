import type { HonourKind } from '@/domain/honours';
import { createHmac } from 'node:crypto';
import { constantTimeEquals, hmac, sha256 } from '@/lib/crypto';

/**
 * PALMA verification codes.
 *
 * Shape: PM-<year>-<6 chars>, e.g. PM-2027-K4T9RD.
 * Crockford base32 alphabet, minus the letters that read as digits, so a code
 * can be read aloud from a trophy or typed from a certificate without error.
 */
/**
 * Crockford base32, minus the letters that read as digits.
 *
 * No I, L, O or U: the first three are misread as 1, 1 and 0 when a code is
 * copied off a screen or read down a phone, and U is dropped so a random six
 * characters cannot spell anything a recipient would rather not be sent.
 *
 * Exported because two separate things draw on it now, an honour's permanent
 * verification code and a nominator's one-time code, and two alphabets that
 * were meant to be the same alphabet is exactly the drift this file exists to
 * prevent.
 *
 * 32 characters is also what makes a uniform draw cheap: 256 divides by 32
 * exactly, so a random byte modulo the length is unbiased with no rejection
 * sampling.
 */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const ALPHABET = CODE_ALPHABET;
const CODE_LENGTH = 6;

export const VERIFICATION_CODE_PATTERN = /^PM-(\d{4})-[0-9A-HJKMNP-TV-Z]{6}$/;

export type AchievementPayload = {
  code: string;
  creatorSlug: string;
  creatorName: string;
  categoryName: string;
  year: number;
  kind: HonourKind;
  issuedAt: string;
};

export function normaliseCode(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/^PM[-_]?/, 'PM-')
    .replace(/^PM-(\d{4})[-_]?/, 'PM-$1-');
}

export function isValidCodeFormat(input: string): boolean {
  return VERIFICATION_CODE_PATTERN.test(normaliseCode(input));
}

/**
 * Codes are derived, not sequential: they reveal nothing about how many
 * honours exist, and two honours can never collide on the same input.
 */
export function deriveCode(secret: string, year: number, honourId: string): string {
  const digest = hmac(secret, `palma:code:v1:${year}:${honourId}`);
  const bytes = Buffer.from(digest, 'base64url');
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += ALPHABET[(bytes[i] ?? 0) % ALPHABET.length];
  }
  return `PM-${year}-${out}`;
}

export function canonicalPayload(payload: AchievementPayload): string {
  return [
    'palma:achievement:v1',
    payload.code,
    payload.creatorSlug,
    payload.creatorName,
    payload.categoryName,
    String(payload.year),
    payload.kind,
    payload.issuedAt,
  ].join('|');
}

export function payloadDigest(payload: AchievementPayload): string {
  return sha256(canonicalPayload(payload));
}

/**
 * The digest PALMA used to write, before the seed stopped carrying its own
 * drifted copy of this file.
 *
 * It computed an HMAC keyed with the literal string 'digest' where the
 * application computes a plain SHA-256 of the same canonical string, so no
 * record written by it could ever match what the verify page recomputed.
 *
 * This is kept, and deliberately, because it is a *proof*. The digest exists
 * for one job: to say, without needing a key, whether an honour's contents are
 * still the ones that were sealed. A stale digest broke that job and left the
 * page unable to tell a misconfigured server from a forgery — so it said
 * forgery, about honours that were perfectly intact.
 *
 * Recognising the old formula restores the answer. If a stored digest equals
 * this, then these exact contents passed through the old seed and have not
 * changed since; the row is legacy, not altered. That is a fact about the
 * data, not a guess, and it is the difference between telling a creator their
 * record is unverifiable and telling them nothing is wrong with it.
 *
 * It is never written. Only ever recognised, and then replaced.
 */
export function legacyPayloadDigest(payload: AchievementPayload): string {
  return createHmac('sha256', 'digest').update(canonicalPayload(payload)).digest('hex');
}

/** What a stored digest proves about the contents beside it. */
export type DigestStanding =
  /** Current format, and it matches: the contents are the sealed ones. */
  | 'intact'
  /** The old seed's format, and it matches: also the sealed ones, just stale. */
  | 'intact-legacy'
  /** Matches neither. Says nothing either way, which is the point. */
  | 'unrecognised';

export function digestStanding(payload: AchievementPayload, stored: string): DigestStanding {
  if (stored === payloadDigest(payload)) return 'intact';
  if (stored === legacyPayloadDigest(payload)) return 'intact-legacy';
  return 'unrecognised';
}

/** Binds every identity field of an honour — editing any of them breaks it. */
export function signAchievement(secret: string, payload: AchievementPayload): string {
  return hmac(secret, canonicalPayload(payload));
}

export function verifyAchievement(
  secret: string,
  payload: AchievementPayload,
  signature: string,
): boolean {
  return constantTimeEquals(signAchievement(secret, payload), signature);
}

export function verificationPath(code: string): string {
  return `/verify/${normaliseCode(code)}`;
}
