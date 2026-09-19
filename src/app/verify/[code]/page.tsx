import Link from 'next/link';
import { notFound } from 'next/navigation';
import { after } from 'next/server';
import { BadgeCheck, ShieldAlert } from 'lucide-react';
import { Container, Section } from '@/components/palma/layout';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/feedback';
import { CopyLink, CopyMark } from '@/components/palma/CopyLink';
import { PalmaSeal } from '@/components/brand/PalmaSeal';
import { Wordmark } from '@/components/brand/Wordmark';
import { JsonLd, absoluteUrl, awardJsonLd, buildMetadata } from '@/lib/seo';
import { countryName, formatDate } from '@/lib/format';
import { signingSecret } from '@/lib/env';
import {
  isValidCodeFormat,
  normaliseCode,
  digestStanding,
  payloadDigest,
  verifyAchievement,
} from '@/lib/verification';
import { HONOUR_LABEL } from '@/components/palma/badges';
import { isThePalma } from '@/domain/honours';
import { getAchievementByCode, healDigest } from '@/server/data/queries';

export const revalidate = 300;

type Params = { params: Promise<{ code: string }> };

export async function generateMetadata({ params }: Params) {
  const { code } = await params;
  const normalised = normaliseCode(decodeURIComponent(code));
  const record = isValidCodeFormat(normalised) ? await getAchievementByCode(normalised) : null;

  if (!record) {
    return buildMetadata({
      title: 'Verification',
      description: 'Check a PALMA honour.',
      path: `/verify/${normalised}`,
      noIndex: true,
    });
  }

  return buildMetadata({
    title: `${record.creatorName}, PALMA ${record.year}`,
    // THE PALMA's honour and "category" are the same words, so naming both
    // produced "THE PALMA, THE PALMA". The category is dropped where it is not
    // a category.
    description: isThePalma(record.kind)
      ? `Verified PALMA record: ${record.creatorName}, THE PALMA, PALMA ${record.year}.`
      : `Verified PALMA record: ${record.creatorName}, ${HONOUR_LABEL[record.kind]}, ${record.categoryName}, PALMA ${record.year}.`,
    path: `/verify/${record.code}`,
    image: `/verify/${record.code}/opengraph-image`,
  });
}

export default async function VerifyPage({ params }: Params) {
  const { code } = await params;
  const normalised = normaliseCode(decodeURIComponent(code));
  if (!isValidCodeFormat(normalised)) notFound();

  const record = await getAchievementByCode(normalised);
  if (!record) notFound();

  const payload = {
    code: record.code,
    creatorSlug: record.creatorSlug,
    creatorName: record.creatorName,
    categoryName: record.categoryName,
    year: record.year,
    kind: record.kind,
    issuedAt: record.issuedAt,
  };

  // The signature binds every identity field of the record. A record whose
  // fields have been altered fails here and is never presented as verified.
  const signatureValid = verifyAchievement(signingSecret(), payload, record.signature);

  /**
   * Why it failed, and the difference matters enormously.
   *
   * The digest is a keyless hash of the same fields the signature covers, so
   * it answers a question the signature cannot on its own: are the contents
   * the ones that were sealed? If they are, and the signature still does not
   * match, then nothing was altered — this server is holding a different
   * `AUTH_SECRET` than the one the record was signed with.
   *
   * Telling a visitor that an intact record "does not match its contents" is
   * accusing a creator of forgery to cover a configuration mistake. PALMA says
   * which of the two it is.
   *
   * `digestStanding` recognises the old seed's digest format as well as the
   * current one, which is what stops a database written before that bug was
   * fixed from being read as a forgery. Both formats are proof of the same
   * thing — these contents went in and have not changed — and a proof does
   * not expire because the code that wrote it did.
   */
  const standing = digestStanding(payload, record.payloadDigest);
  const contentsIntact = standing !== 'unrecognised';
  const misconfigured = !signatureValid && contentsIntact;

  /**
   * Healing a stale digest, once, on the way past.
   *
   * A valid signature over a legacy digest is the one case where the right
   * answer is provable rather than judged: this server's key signed these
   * exact contents, so the fields are beyond question and the digest column is
   * simply holding an old format. Rewriting it asserts nothing new and
   * destroys no evidence — the signature already said everything the digest is
   * being asked to confirm.
   *
   * Doing it here rather than in a script is the point. The old seed's bug
   * needed an operator to notice, read a runbook and run a command, which is
   * three things that do not happen. Now the first time anybody looks at an
   * honour, it fixes itself, and a database nobody maintains converges on
   * correct instead of drifting.
   *
   * Only ever this case. An invalid signature is never healed by anything
   * automatic: that is the case where rewriting would bless whatever is in the
   * row, and it stays a decision a person makes at a command line.
   */
  if (signatureValid && standing === 'intact-legacy') {
    after(() => healDigest(record.code, payloadDigest(payload)));
  }

  const revoked = record.state === 'revoked';
  const verified = signatureValid && !revoked;

  return (
    <>
      <section className="on-ink bg-ink text-ivory">
        <Container className="flex flex-col items-center gap-12 py-20 text-center sm:py-28">
          <Wordmark size="md" href={null} />

          <span className="palma-label text-champagne">
            {verified
              ? 'Verified achievement'
              : revoked
                ? 'Revoked honour'
                : misconfigured
                  ? 'Verification unavailable'
                  : 'Verification failed'}
          </span>

          {verified ? (
            <>
              <h1 className="text-5xl leading-[0.95] sm:text-7xl">{record.creatorName}</h1>
              <div className="flex flex-col items-center gap-3">
                <span className="font-display text-ivory/80 text-2xl sm:text-3xl">
                  {HONOUR_LABEL[record.kind]}
                </span>
                <span className="palma-label text-ivory/55">
                  {isThePalma(record.kind)
                    ? `PALMA ${record.year}`
                    : `${record.categoryName} · PALMA ${record.year}`}
                </span>
              </div>

              <PalmaSeal
                legend={`PALMA ${record.year}`}
                sublegend="THE CREATOR HONOURS"
                centre={
                  isThePalma(record.kind)
                    ? 'Laureate'
                    : record.kind === 'winner'
                      ? 'Winner'
                      : 'Finalist'
                }
                className="text-champagne/90 h-44 w-44"
              />

              <p className="palma-label text-champagne inline-flex items-center gap-2">
                <BadgeCheck className="size-4" aria-hidden="true" />
                Verified by PALMA
              </p>
            </>
          ) : (
            <>
              <ShieldAlert className="text-ivory/60 size-12" aria-hidden="true" />
              <h1 className="max-w-160 text-4xl leading-tight sm:text-5xl">
                {revoked
                  ? 'This honour has been revoked'
                  : misconfigured
                    ? 'PALMA cannot check this record right now'
                    : 'This record could not be verified'}
              </h1>
              <p className="text-ivory/65 max-w-120">
                {revoked
                  ? 'The honour recorded against this code was revoked by PALMA. It must not be presented as a current PALMA.'
                  : misconfigured
                    ? 'The record is intact and unaltered, but this server cannot confirm its seal, a PALMA signing key is misconfigured. This is a fault at our end, not a problem with the honour or the person holding it. Please try again shortly.'
                    : 'PALMA cannot confirm the seal on this record, and does not present an honour it cannot confirm. Either the record was altered after it was sealed, or this server does not hold the key it was sealed with.'}
              </p>
            </>
          )}
        </Container>
      </section>

      <Section className="py-16 sm:py-20">
        <Container size="narrow">
          <dl className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
            <div className="border-stone-deep flex flex-col gap-2 border-t pt-5">
              <dt className="palma-label text-taupe-deep">Recipient</dt>
              <dd className="font-display text-xl">
                {verified ? (
                  <Link
                    href={`/creators/${record.creatorProfileSlug}`}
                    className="hover:text-olive"
                  >
                    {record.creatorName}
                  </Link>
                ) : (
                  record.creatorName
                )}
              </dd>
            </div>
            <div className="border-stone-deep flex flex-col gap-2 border-t pt-5">
              <dt className="palma-label text-taupe-deep">Country</dt>
              <dd className="font-display text-xl">{countryName(record.creatorCountry)}</dd>
            </div>
            <div className="border-stone-deep flex flex-col gap-2 border-t pt-5">
              <dt className="palma-label text-taupe-deep">Honour</dt>
              <dd className="font-display text-xl">{HONOUR_LABEL[record.kind]}</dd>
            </div>
            <div className="border-stone-deep flex flex-col gap-2 border-t pt-5">
              <dt className="palma-label text-taupe-deep">Category</dt>
              <dd className="font-display text-xl">
                {isThePalma(record.kind) ? (
                  // Not a category. This used to link into the category
                  // section under its own slug, which is a page that does not
                  // exist and never will, so it points at THE PALMA instead.
                  <Link href="/the-palma" className="hover:text-olive">
                    Conferred on a career
                  </Link>
                ) : (
                  <Link
                    href={`/categories/${record.categorySlug}?year=${record.year}`}
                    className="hover:text-olive"
                  >
                    {record.categoryName}
                  </Link>
                )}
              </dd>
            </div>
            <div className="border-stone-deep flex flex-col gap-2 border-t pt-5">
              <dt className="palma-label text-taupe-deep">Season</dt>
              <dd className="font-display text-xl">PALMA {record.year}</dd>
            </div>
            <div className="border-stone-deep flex flex-col gap-2 border-t pt-5">
              <dt className="palma-label text-taupe-deep">Issued</dt>
              <dd className="font-display text-xl">{formatDate(record.issuedAt)}</dd>
            </div>
            <div className="border-stone-deep flex flex-col gap-2 border-t pt-5 sm:col-span-2">
              <dt className="palma-label text-taupe-deep">Verification code</dt>
              <dd className="flex items-center gap-1.5 font-mono text-lg tracking-[0.16em]">
                {record.code}
                <CopyMark value={record.code} label="Copy the verification code" />
              </dd>
            </div>
          </dl>

          {record.citation && verified ? (
            <blockquote className="border-champagne-deep font-display mt-12 border-l-2 pl-6 text-2xl leading-snug">
              “{record.citation}”
            </blockquote>
          ) : null}

          <div className="mt-12 flex flex-wrap items-center gap-3">
            <CopyLink value={absoluteUrl(`/verify/${record.code}`)} />
            <Button asChild variant="outline" size="sm">
              <Link href="/verify">Verify another honour</Link>
            </Button>
            {verified ? (
              <Button asChild variant="ghost" size="sm">
                <Link href={`/creators/${record.creatorProfileSlug}`}>View the full record</Link>
              </Button>
            ) : null}
          </div>

          {misconfigured ? (
            // Never the fraud warning here. Nothing about this record is in
            // doubt; PALMA simply cannot complete the check, and saying
            // otherwise would put a creator under suspicion for our fault.
            <Notice tone="warning" className="mt-10" title="This is a fault at PALMA's end">
              Nothing is wrong with the honour or with the person showing it to you. PALMA holds the
              record intact and unaltered. This server just cannot confirm its seal at the moment.
              Try again shortly, or{' '}
              <Link href="/contact" className="palma-link">
                tell us
              </Link>{' '}
              if it persists.
            </Notice>
          ) : !verified ? (
            // Short of calling it a forgery, because it may not be one.
            // A failed signature over contents whose digest also fails is
            // either an altered record or a database sealed by an
            // installation this server has never shared a key with. Both
            // must stop the honour being presented as verified, and only
            // one of them is anybody's fault, so this page declines to
            // confirm without deciding which.
            <Notice tone="error" className="mt-10" title="If you were shown this code as proof">
              Treat it as unverified, whatever the reason turns out to be. If you believe someone is
              presenting a PALMA they do not hold,{' '}
              <Link href="/report" className="palma-link">
                report it to PALMA
              </Link>
              . If this is your own honour,{' '}
              <Link href="/contact" className="palma-link">
                tell PALMA
              </Link>{' '}
              rather than assuming it is lost, a seal can be checked and reissued.
            </Notice>
          ) : (
            <Notice className="mt-10" title="How this page is produced">
              This record was signed when the honour was conferred and is checked on every request.
              PALMA does not publish judging scores, panel deliberations or nomination evidence.
            </Notice>
          )}
        </Container>
      </Section>

      {verified ? (
        <JsonLd
          data={awardJsonLd({
            creatorName: record.creatorName,
            creatorUrl: absoluteUrl(`/creators/${record.creatorProfileSlug}`),
            categoryName: record.categoryName,
            year: record.year,
            kind: HONOUR_LABEL[record.kind],
            code: record.code,
          })}
        />
      ) : null}
    </>
  );
}
