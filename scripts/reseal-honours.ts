/**
 * Re-sealing honours whose seal this server cannot read.
 *
 * Every PALMA honour carries two things beside it: an HMAC signature over its
 * identity fields, and a keyless SHA-256 digest of the same fields. The
 * signature proves the honour was issued by PALMA; the digest, needing no key,
 * says whether the fields are still the ones that were sealed. Between them
 * the verify page can tell an altered record from a server holding the wrong
 * key, which matters enormously — one is a forgery and the other is a typo in
 * an environment variable, and a public page must never call the second the
 * first.
 *
 * Two things break a seal without anybody touching a record.
 *
 * AUTH_SECRET changed. Rotating it, or moving a database to an installation
 * that was generated its own, invalidates every signature at once. The digests
 * still match, so the verify page already says so, and this script re-signs.
 *
 * The seed wrote a bad digest. Until the seed stopped carrying its own drifted
 * copy of the crypto, it wrote `payloadDigest` as an HMAC keyed with the
 * literal string 'digest' where the application computes a plain SHA-256. Any
 * database seeded before that fix has digests that can never match, so the
 * verify page falls through to its last branch and tells a visitor that an
 * intact honour does not match its contents. That is the failure this script
 * mostly exists to clear.
 *
 *   npx tsx scripts/reseal-honours.ts            # report, change nothing
 *   npx tsx scripts/reseal-honours.ts --apply    # re-seal what it can explain
 *
 * It reports by default and never writes without --apply. What it will not do
 * on its own is re-seal a record it cannot explain: when the signature and the
 * digest both fail, the contents may genuinely have been altered, and re-
 * sealing would bless whatever is in the row and destroy the only evidence
 * that anything happened. Those need --force as well, and they are listed
 * individually first so somebody can look before deciding.
 *
 * Every write lands in the audit log, named as what it is.
 */
import { loadEnvConfig } from '@next/env';
import { PrismaClient } from '@prisma/client';

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();

const apply = process.argv.includes('--apply');
const force = process.argv.includes('--force');

type Verdict = 'sealed' | 'wrong-key' | 'stale-digest' | 'unexplained';

async function main() {
  // Imported inside main, after loadEnvConfig has run: signingSecret() reads
  // AUTH_SECRET at call time but env.ts validates at module scope, and ES
  // imports hoist above everything including the env load.
  const { signingSecret } = await import('../src/lib/env');
  const { digestStanding, payloadDigest, signAchievement, verifyAchievement } =
    await import('../src/lib/verification');

  const secret = signingSecret();

  const records = await prisma.verificationRecord.findMany({
    include: { achievement: true },
    orderBy: { issuedAt: 'asc' },
  });

  if (records.length === 0) {
    console.log('\n  No honours in this database. Nothing to check.\n');
    return;
  }

  const findings = records.map((row) => {
    const a = row.achievement;
    const payload = {
      code: a.code,
      // The frozen slug, not the live one: see the schema comment on the
      // column. Reading it live is what broke these seals in the first place.
      creatorSlug: a.creatorSlug,
      creatorName: a.creatorName,
      categoryName: a.categoryName,
      year: a.year,
      kind: a.kind,
      issuedAt: a.issuedAt.toISOString(),
    };

    const signatureValid = verifyAchievement(secret, payload, row.signature);

    // `intact` and `intact-legacy` both mean the contents are the ones that
    // were sealed; they differ only in which formula wrote the digest. Only
    // `unrecognised` says nothing, and that is the one that needs a person.
    const standing = digestStanding(payload, row.payloadDigest);
    const digestValid = standing === 'intact';
    const contentsIntact = standing !== 'unrecognised';

    // Four states, and the two checks separate them cleanly.
    //
    // A good signature over a stale digest is the old seed's bug and nothing
    // else: this very key signed these very contents, so the fields are the
    // ones that were sealed and only the digest column is behind.
    //
    // A bad signature over intact contents is a key that changed. The digest
    // needs no key, so it still vouches for the fields.
    //
    // Neither says anything at all, which is why it is handled separately.
    const verdict: Verdict = signatureValid
      ? digestValid
        ? 'sealed'
        : 'stale-digest'
      : contentsIntact
        ? 'wrong-key'
        : 'unexplained';

    return { row, payload, verdict, signatureValid, digestValid };
  });

  const by = (verdict: Verdict) => findings.filter((f) => f.verdict === verdict);

  console.log(`\n  ${records.length} honours, sealed with a ${secret.length}-character key.\n`);
  report('Verify correctly', by('sealed'));
  report('Signed with a different key, contents provably unchanged', by('wrong-key'));
  report('Correctly signed, digest in the old format', by('stale-digest'));
  report('Neither the signature nor the digest can be explained', by('unexplained'));

  const explainable = [...by('wrong-key'), ...by('stale-digest')];
  const unexplained = by('unexplained');

  if (unexplained.length > 0) {
    console.log('\n  The unexplained ones, in full:\n');
    for (const finding of unexplained) {
      console.log(
        `    ${finding.row.code}  ${finding.payload.creatorName} · ${finding.payload.categoryName} ${finding.payload.year}`,
      );
    }
    console.log(
      '\n  Either these were altered after they were sealed, or they were sealed by an\n' +
        '  installation whose key this server has never held. Re-sealing them writes the\n' +
        '  current contents in as authentic, whatever they are. Look at them first.\n',
    );
  }

  if (explainable.length === 0 && unexplained.length === 0) {
    console.log('\n  Every honour verifies. Nothing to do.\n');
    return;
  }

  if (!apply) {
    console.log(
      `\n  Nothing was written. Run again with --apply to re-seal the ${explainable.length} ` +
        `explainable ${explainable.length === 1 ? 'record' : 'records'}` +
        (unexplained.length > 0 ? ', and --force as well to include the unexplained ones.' : '.') +
        '\n',
    );
    return;
  }

  const targets = force ? [...explainable, ...unexplained] : explainable;

  if (targets.length === 0) {
    console.log('\n  Nothing to re-seal without --force.\n');
    return;
  }

  for (const finding of targets) {
    await prisma.$transaction(async (tx) => {
      await tx.verificationRecord.update({
        where: { id: finding.row.id },
        data: {
          signature: signAchievement(secret, finding.payload),
          payloadDigest: payloadDigest(finding.payload),
        },
      });

      await tx.auditLog.create({
        data: {
          actorRole: 'super_admin',
          actorLabel: 'scripts/reseal-honours.ts',
          action: 'honour.resealed',
          entityType: 'Achievement',
          entityId: finding.row.achievementId,
          summary: `${finding.row.code} re-sealed from the command line (${finding.verdict})`,
          before: { verdict: finding.verdict },
          after: { verdict: 'sealed' },
        },
      });
    });
  }

  console.log(`\n  Re-sealed ${targets.length}. Every one is in the audit log.\n`);
}

function report(label: string, findings: unknown[]) {
  if (findings.length === 0) return;
  console.log(`    ${String(findings.length).padStart(4)}  ${label}`);
}

main()
  .catch((error) => {
    console.error('\n  Failed:', error instanceof Error ? error.message : error);
    console.error('  If this is a connection error against Supabase, check that DIRECT_URL');
    console.error('  is set to the direct connection on port 5432.\n');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
