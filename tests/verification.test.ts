import { describe, expect, it } from 'vitest';
import {
  canonicalPayload,
  deriveCode,
  digestStanding,
  legacyPayloadDigest,
  payloadDigest,
  isValidCodeFormat,
  normaliseCode,
  signAchievement,
  verifyAchievement,
  type AchievementPayload,
} from '@/lib/verification';

const SECRET = 'test-secret-test-secret-test-secret-0123';

const payload: AchievementPayload = {
  code: 'PM-2027-K4T9RD',
  creatorSlug: 'maya-rivers',
  creatorName: 'Maya Rivers',
  categoryName: 'Best Independent Creator',
  year: 2027,
  kind: 'winner',
  issuedAt: '2027-09-23T18:00:00.000Z',
};

describe('verification codes', () => {
  it('produces a well-formed, stable code for an honour', () => {
    const code = deriveCode(SECRET, 2027, 'honour-abc');
    expect(code).toMatch(/^PM-2027-[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(deriveCode(SECRET, 2027, 'honour-abc')).toBe(code);
  });

  it('gives different honours different codes', () => {
    expect(deriveCode(SECRET, 2027, 'honour-a')).not.toBe(deriveCode(SECRET, 2027, 'honour-b'));
    expect(deriveCode(SECRET, 2027, 'honour-a')).not.toBe(deriveCode(SECRET, 2028, 'honour-a'));
  });

  it('normalises codes as a person would type them', () => {
    expect(normaliseCode(' pm-2027-k4t9rd ')).toBe('PM-2027-K4T9RD');
    expect(normaliseCode('PM2027K4T9RD')).toBe('PM-2027-K4T9RD');
    expect(isValidCodeFormat('pm-2027-k4t9rd')).toBe(true);
    expect(isValidCodeFormat('PM-27-K4T9RD')).toBe(false);
    expect(isValidCodeFormat('NOT-A-CODE')).toBe(false);
  });
});

describe('achievement signatures', () => {
  it('verifies an untouched record', () => {
    const signature = signAchievement(SECRET, payload);
    expect(verifyAchievement(SECRET, payload, signature)).toBe(true);
  });

  it('fails if any identity field is altered', () => {
    const signature = signAchievement(SECRET, payload);

    const tampered: Partial<AchievementPayload>[] = [
      { creatorName: 'Someone Else' },
      { creatorSlug: 'someone-else' },
      { categoryName: 'Creator of the Year' },
      { year: 2028 },
      { kind: 'finalist' },
      { code: 'PM-2027-AAAAAA' },
      { issuedAt: '2028-01-01T00:00:00.000Z' },
    ];

    for (const patch of tampered) {
      expect(
        verifyAchievement(SECRET, { ...payload, ...patch }, signature),
        JSON.stringify(patch),
      ).toBe(false);
    }
  });

  it('fails under a different signing key', () => {
    const signature = signAchievement(SECRET, payload);
    expect(verifyAchievement('a-different-secret-entirely-0123456789', payload, signature)).toBe(
      false,
    );
  });

  it('rejects a forged signature of the right shape', () => {
    expect(verifyAchievement(SECRET, payload, 'x'.repeat(43))).toBe(false);
  });

  it('binds every field into the canonical payload', () => {
    const canonical = canonicalPayload(payload);
    for (const value of [
      payload.code,
      payload.creatorSlug,
      payload.creatorName,
      payload.categoryName,
      String(payload.year),
      payload.kind,
      payload.issuedAt,
    ]) {
      expect(canonical).toContain(value);
    }
  });
});

/**
 * What a seal is allowed to depend on.
 *
 * Every field the signature covers has to be frozen at the moment the honour
 * is issued. One of them was not: the creator's slug was read live off the
 * Creator row each time the verify page recomputed the payload, so a slug that
 * changed for any reason broke the signature *and* the keyless digest — and a
 * broken digest is exactly what that page reads as an altered record. An
 * honour that survived being renamed would have been reported as a forgery.
 *
 * These tests are about that rule rather than about slugs. Any field allowed
 * to drift after sealing does the same damage; the schema now freezes all
 * seven onto the Achievement row, and this is the arithmetic that says why it
 * has to.
 */
describe('a seal covers a moment, not a moving target', () => {
  it('a changed slug invalidates a signature, which is why it must be frozen', () => {
    const signature = signAchievement(SECRET, payload);

    // Exactly what the verify page used to do: rebuild with the live slug.
    const renamed = { ...payload, creatorSlug: 'maya-rivers-2' };

    expect(verifyAchievement(SECRET, renamed, signature)).toBe(false);
    expect(verifyAchievement(SECRET, payload, signature)).toBe(true);
  });

  it('and invalidates the keyless digest too, which is what made it look like forgery', () => {
    // The digest is the only thing that can say "the contents are the ones
    // that were sealed" without a key. When a live field drifts it fails
    // alongside the signature, and the page loses its ability to tell a
    // misconfigured server from an altered record.
    const renamed = { ...payload, creatorSlug: 'maya-rivers-2' };
    expect(canonicalPayload(renamed)).not.toBe(canonicalPayload(payload));
  });

  it('every field in the canonical payload is one the Achievement row freezes', () => {
    // If a field is added to the payload, it has to be added to the row too,
    // or it will be read live and this whole failure returns.
    const frozen = [
      'code',
      'creatorSlug',
      'creatorName',
      'categoryName',
      'year',
      'kind',
      'issuedAt',
    ] as const;

    expect(Object.keys(payload).sort()).toEqual([...frozen].sort());

    // And each one genuinely changes the signature, so none is decorative.
    for (const field of frozen) {
      const altered = { ...payload } as Record<string, unknown>;
      altered[field] = typeof payload[field] === 'number' ? 9999 : 'something-else';
      expect(
        canonicalPayload(altered as AchievementPayload),
        `${field} does not affect the signature`,
      ).not.toBe(canonicalPayload(payload));
    }
  });
});

/**
 * Reading a database written by older code.
 *
 * The seed once wrote `payloadDigest` as an HMAC keyed with the literal string
 * 'digest' where the application computes a plain SHA-256. Every honour in
 * every database seeded before that was fixed carries the old format, and the
 * verify page could not tell those apart from contents that had been altered —
 * so on a server whose AUTH_SECRET had also changed, it called intact honours
 * forgeries.
 *
 * Recognising the old formula is a proof, not a guess: if a stored digest
 * equals it, those exact contents passed through the old seed and have not
 * moved since.
 */
describe('a digest written by the old seed still proves what it proved', () => {
  it('recognises the current format', () => {
    expect(digestStanding(payload, payloadDigest(payload))).toBe('intact');
  });

  it('recognises the old seed’s format as intact, not as tampering', () => {
    expect(digestStanding(payload, legacyPayloadDigest(payload))).toBe('intact-legacy');
  });

  it('the two formats are genuinely different, so this is not a tautology', () => {
    expect(legacyPayloadDigest(payload)).not.toBe(payloadDigest(payload));
  });

  it('a digest over different contents is recognised in neither format', () => {
    const altered = { ...payload, creatorName: 'Someone Else' };
    expect(digestStanding(altered, payloadDigest(payload))).toBe('unrecognised');
    expect(digestStanding(altered, legacyPayloadDigest(payload))).toBe('unrecognised');
  });

  it('garbage is unrecognised rather than quietly accepted', () => {
    for (const rubbish of ['', 'not-a-digest', '0'.repeat(64)]) {
      expect(digestStanding(payload, rubbish)).toBe('unrecognised');
    }
  });

  it('neither format is affected by the signing key, which is the whole point', () => {
    // The digest is what answers "are these the sealed contents?" when the key
    // is the thing in doubt. If it depended on the key it could not.
    const before = [payloadDigest(payload), legacyPayloadDigest(payload)];
    expect([payloadDigest(payload), legacyPayloadDigest(payload)]).toEqual(before);
  });
});
