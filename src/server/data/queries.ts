import 'server-only';
import { cache } from 'react';
import { prisma } from '@/server/db';
import type { SeasonStage } from '@/domain/season';
import { finalistsArePublic, winnersArePublic } from '@/domain/season';
import {
  honourCategoryName,
  honourCategorySlug,
  HONOUR_STANDING,
  matchesAchievementSlug,
} from '@/domain/honours';
import type {
  AchievementRecord,
  ArticleDetail,
  ArticleSummary,
  CategoryOutcome,
  PalmaLaureate,
  CategoryView,
  CreatorProfile,
  CreatorSummary,
  FinalistView,
  HonourEntry,
  JudgeView,
  RollOfHonourYear,
  SeasonStats,
  SeasonView,
  SponsorView,
} from './types';

/**
 * The read surface of PALMA.
 *
 * Every public page reads through this module, and every one of these queries
 * goes to PostgreSQL. There is no second source: a name on this site is there
 * because it is in the database, and nowhere else. The seed dataset exists
 * only to populate that database — it is never read at runtime.
 */

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);

// ── Seasons ──────────────────────────────────────────────────────────────────

export const listSeasons = cache(async (): Promise<SeasonView[]> => {
  const rows = await prisma.awardYear.findMany({
    orderBy: { year: 'desc' },
    include: { _count: { select: { categories: true } } },
  });

  return rows.map((row) => ({
    id: row.id,
    year: row.year,
    title: row.title,
    stage: row.stage as SeasonStage,
    tagline: row.tagline,
    summary: row.summary,
    nominationsOpenAt: iso(row.nominationsOpenAt),
    nominationsCloseAt: iso(row.nominationsCloseAt),
    shortlistAt: iso(row.shortlistAt),
    finalistsAt: iso(row.finalistsAt),
    ceremonyAt: iso(row.ceremonyAt),
    isCurrent: row.isCurrent,
    categoryCount: row._count.categories,
  }));
});

export const getSeason = cache(async (year: number): Promise<SeasonView | null> => {
  const all = await listSeasons();
  return all.find((season) => season.year === year) ?? null;
});

export const getCurrentSeason = cache(async (): Promise<SeasonView> => {
  const all = await listSeasons();
  return all.find((season) => season.isCurrent) ?? all[0]!;
});

// ── Categories ───────────────────────────────────────────────────────────────

export const listCategories = cache(async (year: number): Promise<CategoryView[]> => {
  const rows = await prisma.category.findMany({
    where: { awardYear: { year } },
    orderBy: { position: 'asc' },
    include: {
      awardYear: true,
      // Only an approved association, with a live sponsor, and only a category
      // placement. An unapproved sponsorship is a conversation, and a logo on
      // the strength of one is a claim PALMA cannot support.
      sponsorships: {
        where: {
          isApproved: true,
          placement: 'category',
          sponsor: { status: 'active', isActive: true },
        },
        include: { sponsor: true },
        take: 1,
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    strapline: row.strapline,
    description: row.description,
    eligibility: row.eligibility,
    judgingCriteria: row.judgingCriteria,
    isOpen: row.isOpen,
    position: row.position,
    year: row.awardYear.year,
    stage: row.awardYear.stage as SeasonStage,
    partner: row.sponsorships[0]
      ? { name: row.sponsorships[0].sponsor.name, slug: row.sponsorships[0].sponsor.slug }
      : null,
  }));
});

export const getCategory = cache(
  async (year: number, slug: string): Promise<CategoryView | null> => {
    const all = await listCategories(year);
    return all.find((category) => category.slug === slug) ?? null;
  },
);

/** The canonical, season-independent list of category slugs and names. */
export const listCategoryIndex = cache(
  async (): Promise<{ slug: string; name: string; strapline: string | null }[]> => {
    const season = await getCurrentSeason();
    const all = await listCategories(season.year);
    return all.map((category) => ({
      slug: category.slug,
      name: category.name,
      strapline: category.strapline,
    }));
  },
);

// ── Creators ─────────────────────────────────────────────────────────────────

export type CreatorFilter = {
  query?: string;
  country?: string;
  honoursOnly?: boolean;
  limit?: number;
};

export const listCreators = cache(async (filter: CreatorFilter = {}): Promise<CreatorSummary[]> => {
  const rows = await prisma.creator.findMany({
    where: {
      isPublished: true,
      isSuspended: false,
      ...(filter.country ? { countryCode: filter.country.toUpperCase() } : {}),
      ...(filter.query
        ? {
            OR: [
              { displayName: { contains: filter.query, mode: 'insensitive' } },
              { headline: { contains: filter.query, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(filter.honoursOnly ? { honours: { some: { state: 'active' } } } : {}),
    },
    take: filter.limit ?? 60,
    include: {
      verification: true,
      honours: { where: { state: 'active' }, select: { kind: true } },
    },
    orderBy: { displayName: 'asc' },
  });

  return rows
    .map((row) => ({
      id: row.id,
      slug: row.slug,
      displayName: row.displayName,
      countryCode: row.countryCode,
      headline: row.headline,
      portraitUrl: row.portraitUrl,
      portraitAlt: row.portraitAlt,
      verificationStatus: (row.verification?.status ??
        'unverified') as CreatorSummary['verificationStatus'],
      honourCount: row.honours.length,
      winCount: row.honours.filter((honour) => honour.kind === 'winner').length,
    }))
    .sort((a, b) =>
      b.winCount !== a.winCount ? b.winCount - a.winCount : b.honourCount - a.honourCount,
    );
});

/**
 * One honour, addressed by its quotable slug.
 *
 * Built on `getCreator` rather than its own query, so the credential page and
 * the creator's record can never disagree about what somebody holds: they read
 * the same rows through the same cache.
 *
 * Revoked honours resolve deliberately. A link a creator has already put in a
 * press kit must not 404 the day an honour is withdrawn — the page has to be
 * able to say it was revoked, which is the whole reason the record keeps
 * revoked rows rather than deleting them.
 */
export const getCreatorAchievement = cache(
  async (
    creatorSlug: string,
    honourSlug: string,
  ): Promise<{ creator: CreatorProfile; honour: HonourEntry } | null> => {
    const creator = await getCreator(creatorSlug);
    if (!creator) return null;

    const matches = creator.record.filter((honour) =>
      matchesAchievementSlug(
        { kind: honour.kind, categorySlug: honour.categorySlug, year: honour.year },
        honourSlug,
      ),
    );
    if (matches.length === 0) return null;

    // Highest standing wins where a creator holds more than one honour in the
    // same contest: pointing somebody at a finalist record when they won it is
    // the worse of the two mistakes.
    const honour = [...matches].sort(
      (a, b) => HONOUR_STANDING[b.kind] - HONOUR_STANDING[a.kind],
    )[0]!;

    return { creator, honour };
  },
);

export const getCreator = cache(async (slug: string): Promise<CreatorProfile | null> => {
  const row = await prisma.creator.findUnique({
    where: { slug },
    include: {
      verification: true,
      links: { orderBy: { position: 'asc' } },
      honours: {
        include: {
          category: true,
          awardYear: true,
          achievement: true,
        },
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  if (!row || !row.isPublished) return null;

  const record: HonourEntry[] = row.honours
    .filter(
      (honour) =>
        winnersArePublic(honour.awardYear.stage as SeasonStage) || honour.kind !== 'winner',
    )
    .map((honour) => ({
      id: honour.id,
      kind: honour.kind as HonourEntry['kind'],
      state: honour.state as HonourEntry['state'],
      year: honour.awardYear.year,
      categoryName: honourCategoryName(honour.kind, honour.category?.name ?? null),
      categorySlug: honourCategorySlug(honour.kind, honour.category?.slug ?? null),
      citation: honour.citation,
      announcedAt: iso(honour.announcedAt),
      code: honour.achievement?.code ?? null,
      position: honour.position,
    }))
    .sort((a, b) => b.year - a.year);

  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    countryCode: row.countryCode,
    city: row.city,
    pronouns: row.pronouns,
    headline: row.headline,
    biography: row.biography,
    portraitUrl: row.portraitUrl,
    portraitAlt: row.portraitAlt,
    websiteUrl: row.websiteUrl,
    links: row.links.map((link) => ({ label: link.label, url: link.url })),
    verificationStatus: (row.verification?.status ??
      'unverified') as CreatorSummary['verificationStatus'],
    // `userId` is the truth about who holds a record. The `isClaimed` column is
    // a denormalised convenience written on approval, and a boolean that can
    // drift from the relation it summarises is not a source of truth.
    isClaimed: row.userId !== null,
    record,
    honourCount: record.filter((entry) => entry.state === 'active').length,
    winCount: record.filter((entry) => entry.kind === 'winner' && entry.state === 'active').length,
  };
});

// ── Honours ──────────────────────────────────────────────────────────────────

type HonourRow = {
  kind: HonourEntry['kind'];
  year: number;
  categorySlug: string;
  categoryName: string;
  creatorSlug: string;
  citation: string | null;
  code: string | null;
  position: number;
  announcedAt: string | null;
};

async function honourRows(year?: number, kind?: HonourEntry['kind']): Promise<HonourRow[]> {
  const rows = await prisma.honour.findMany({
    where: {
      state: 'active',
      ...(kind ? { kind } : {}),
      awardYear: { ...(year ? { year } : {}) },
    },
    include: { category: true, awardYear: true, creator: true, achievement: true },
    orderBy: [{ position: 'asc' }],
  });

  return rows
    .filter((row) =>
      row.kind === 'winner'
        ? winnersArePublic(row.awardYear.stage as SeasonStage)
        : finalistsArePublic(row.awardYear.stage as SeasonStage),
    )
    .map((row) => ({
      kind: row.kind as HonourEntry['kind'],
      year: row.awardYear.year,
      categorySlug: honourCategorySlug(row.kind, row.category?.slug ?? null),
      categoryName: honourCategoryName(row.kind, row.category?.name ?? null),
      creatorSlug: row.creator.slug,
      citation: row.citation,
      code: row.achievement?.code ?? null,
      position: row.position,
      announcedAt: iso(row.announcedAt),
    }));
}

async function creatorIndex(): Promise<Map<string, CreatorSummary>> {
  const all = await listCreators({ limit: 500 });
  return new Map(all.map((creator) => [creator.slug, creator]));
}

/**
 * THE PALMA of a season, if it has been conferred.
 *
 * Deliberately not part of `listSeasonOutcomes`. That function returns the
 * categories of a season, and THE PALMA is not one of them: a surface that
 * wants it has to ask for it, which is what stops it being rendered through
 * the same loop as the twelve and coming out looking like the thirteenth.
 */
export const getThePalma = cache(async (year: number): Promise<PalmaLaureate | null> => {
  const row = (await honourRows(year)).find((entry) => entry.kind === 'the_palma');
  if (!row) return null;

  const creator = (await creatorIndex()).get(row.creatorSlug);
  if (!creator) return null;

  return {
    year,
    creator,
    citation: row.citation ?? '',
    code: row.code,
    announcedAt: row.announcedAt,
  };
});

export const getCategoryOutcome = cache(
  async (year: number, categorySlug: string): Promise<CategoryOutcome | null> => {
    const category = await getCategory(year, categorySlug);
    if (!category) return null;

    const rows = (await honourRows(year)).filter((row) => row.categorySlug === categorySlug);
    const index = await creatorIndex();

    const finalists: FinalistView[] = rows
      .filter((row) => row.kind === 'finalist')
      .sort((a, b) => a.position - b.position)
      .map((row, i) => ({
        position: i + 1,
        creator: index.get(row.creatorSlug)!,
        citation: row.citation,
      }))
      .filter((entry) => Boolean(entry.creator));

    const winnerRow = rows.find((row) => row.kind === 'winner');
    const winner =
      winnerRow && index.get(winnerRow.creatorSlug)
        ? {
            position: 1,
            creator: index.get(winnerRow.creatorSlug)!,
            citation: winnerRow.citation,
            code: winnerRow.code,
          }
        : null;

    return { category, finalists, winner };
  },
);

export const listSeasonOutcomes = cache(async (year: number): Promise<CategoryOutcome[]> => {
  const categories = await listCategories(year);
  const outcomes = await Promise.all(
    categories.map((category) => getCategoryOutcome(year, category.slug)),
  );
  return outcomes.filter((outcome): outcome is CategoryOutcome => outcome !== null);
});

export type RollFilter = { year?: number; category?: string; country?: string; query?: string };

export const getRollOfHonour = cache(
  async (filter: RollFilter = {}): Promise<RollOfHonourYear[]> => {
    const rows = await honourRows(filter.year, 'winner');
    const index = await creatorIndex();
    const seasons = await listSeasons();

    const filtered = rows.filter((row) => {
      const creator = index.get(row.creatorSlug);
      if (!creator) return false;
      if (filter.category && row.categorySlug !== filter.category) return false;
      if (filter.country && creator.countryCode !== filter.country.toUpperCase()) return false;
      if (filter.query) {
        const needle = filter.query.toLowerCase();
        if (
          !creator.displayName.toLowerCase().includes(needle) &&
          !row.categoryName.toLowerCase().includes(needle)
        ) {
          return false;
        }
      }
      return true;
    });

    const byYear = new Map<number, RollOfHonourYear>();
    for (const row of filtered) {
      const creator = index.get(row.creatorSlug)!;
      const season = seasons.find((entry) => entry.year === row.year);
      const bucket = byYear.get(row.year) ?? {
        year: row.year,
        title: season?.title ?? `PALMA ${row.year}`,
        laureate: null,
        entries: [],
      };
      bucket.entries.push({
        year: row.year,
        categoryName: row.categoryName,
        categorySlug: row.categorySlug,
        creator,
        code: row.code,
        citation: row.citation,
      });
      byYear.set(row.year, bucket);
    }

    // THE PALMA is attached to its year rather than pushed into `entries`.
    // The PaROH is the permanent record and it belongs there, but a laureate
    // listed among the category winners is exactly the flattening this honour
    // is not supposed to suffer: the page renders it above them, not among
    // them. Filters that narrow to a category or a search term drop it, because
    // it is in no category and a filtered list should not carry a row that does
    // not match.
    const unfiltered = !filter.category && !filter.query && !filter.country;

    const years = [...byYear.values()];
    if (unfiltered) {
      await Promise.all(
        years.map(async (entry) => {
          entry.laureate = await getThePalma(entry.year);
        }),
      );
    }

    return years
      .map((entry) => ({
        ...entry,
        entries: entry.entries.sort((a, b) => a.categoryName.localeCompare(b.categoryName)),
      }))
      .sort((a, b) => b.year - a.year);
  },
);

export const listRecentHonours = cache(async (limit = 6) => {
  const rows = await honourRows();
  const index = await creatorIndex();
  return rows
    .filter((row) => index.has(row.creatorSlug))
    .sort((a, b) => {
      if (b.year !== a.year) return b.year - a.year;
      if (a.kind !== b.kind) return a.kind === 'winner' ? -1 : 1;
      return a.categoryName.localeCompare(b.categoryName);
    })
    .slice(0, limit)
    .map((row) => ({
      kind: row.kind,
      year: row.year,
      categoryName: row.categoryName,
      categorySlug: row.categorySlug,
      code: row.code,
      creator: index.get(row.creatorSlug)!,
    }));
});

// ── Verification ─────────────────────────────────────────────────────────────

export const getAchievementByCode = cache(
  async (code: string): Promise<AchievementRecord | null> => {
    const row = await prisma.verificationRecord.findUnique({
      where: { code },
      include: {
        achievement: {
          include: {
            creator: true,
            honour: { include: { category: true, awardYear: true } },
          },
        },
      },
    });

    if (!row) return null;
    const achievement = row.achievement;

    return {
      code: achievement.code,
      kind: achievement.kind as AchievementRecord['kind'],
      state: achievement.state as AchievementRecord['state'],
      year: achievement.year,
      categoryName: achievement.categoryName,
      categorySlug: honourCategorySlug(
        achievement.honour.kind,
        achievement.honour.category?.slug ?? null,
      ),
      creatorName: achievement.creatorName,
      // What was sealed, not where the person lives now. These are the same
      // string today and must not be assumed to be tomorrow: one is part of
      // the signature and the other is a link.
      creatorSlug: achievement.creatorSlug,
      creatorProfileSlug: achievement.creator.slug,
      creatorCountry: achievement.creator.countryCode,
      citation: achievement.honour.citation,
      issuedAt: achievement.issuedAt.toISOString(),
      revokedAt: iso(achievement.revokedAt),
      signature: row.signature,
      payloadDigest: row.payloadDigest,
    };
  },
);

/**
 * Rewrite a verification record's digest, and nothing else.
 *
 * Called only from the verify page, and only when the signature over the same
 * contents has already checked out against this server's key — which makes the
 * correct digest a matter of arithmetic rather than judgement. See the comment
 * at the call site for why that distinction is the whole safety argument.
 *
 * Deliberately narrow: it takes the value to write rather than recomputing
 * one, touches a single column, and matches on the digest it expects to
 * replace so two concurrent readers cannot fight over it. It cannot change a
 * signature, a code, or anything an honour says about anybody.
 *
 * Failure is silence. This runs after the response has been sent, on a page
 * that has already rendered correctly without it; a reader waiting on their
 * honour must never see an error because a housekeeping write lost a race.
 */
export async function healDigest(code: string, digest: string): Promise<void> {
  try {
    await prisma.verificationRecord.updateMany({
      where: { code, payloadDigest: { not: digest } },
      data: { payloadDigest: digest },
    });
  } catch {
    // The page was right either way. It will be offered again next time.
  }
}

// ── Journal ──────────────────────────────────────────────────────────────────

export const listArticles = cache(
  async (options: { category?: string; limit?: number } = {}): Promise<ArticleSummary[]> => {
    const rows = await prisma.article.findMany({
      where: {
        status: 'published',
        publishedAt: { lte: new Date() },
        ...(options.category ? { category: { slug: options.category } } : {}),
      },
      orderBy: { publishedAt: 'desc' },
      take: options.limit ?? 24,
      include: { category: true },
    });

    return rows.map((row) => ({
      slug: row.slug,
      title: row.title,
      standfirst: row.standfirst,
      category: row.category?.name ?? null,
      categorySlug: row.category?.slug ?? null,
      authorName: row.authorName,
      publishedAt: iso(row.publishedAt),
      readingMinutes: row.readingMinutes,
      heroImageUrl: row.heroImageUrl,
      heroImageAlt: row.heroImageAlt,
    }));
  },
);

export const getArticle = cache(async (slug: string): Promise<ArticleDetail | null> => {
  const row = await prisma.article.findUnique({ where: { slug }, include: { category: true } });
  if (!row || row.status !== 'published') return null;

  return {
    slug: row.slug,
    title: row.title,
    standfirst: row.standfirst,
    body: row.body,
    category: row.category?.name ?? null,
    categorySlug: row.category?.slug ?? null,
    authorName: row.authorName,
    publishedAt: iso(row.publishedAt),
    readingMinutes: row.readingMinutes,
    heroImageUrl: row.heroImageUrl,
    heroImageAlt: row.heroImageAlt,
  };
});

export const listArticleCategories = cache(async () => {
  const rows = await prisma.articleCategory.findMany({ orderBy: { position: 'asc' } });
  return rows.map((row) => ({ slug: row.slug, name: row.name }));
});

// ── Sponsors & operational stats ─────────────────────────────────────────────

export const listSponsors = cache(async (): Promise<SponsorView[]> => {
  const rows = await prisma.sponsorship.findMany({
    include: { sponsor: true, category: true },
    orderBy: { createdAt: 'asc' },
  });

  return rows
    .filter((row) => row.sponsor.isActive)
    .map((row) => ({
      slug: row.sponsor.slug,
      name: row.sponsor.name,
      summary: row.sponsor.summary,
      websiteUrl: row.sponsor.websiteUrl,
      tier: row.tier as SponsorView['tier'],
      categoryName: row.category?.name ?? null,
    }));
});

/**
 * The panel, as the public sees it.
 *
 * Judges are published because a panel nobody can name is not independent, it
 * is merely anonymous. What is never published is anything a judge *did*: no
 * scores, no assignments, no conflict declarations. Who sat is public; how they
 * voted is not, permanently.
 */
export const listJudges = cache(async (): Promise<JudgeView[]> => {
  const rows = await prisma.judge.findMany({
    where: { isActive: true },
    include: { memberships: { include: { awardYear: true } } },
    orderBy: { displayName: 'asc' },
  });

  return rows.map((row) => {
    const seasons = row.memberships
      .map((membership) => ({
        year: membership.awardYear.year,
        isChair: membership.isChair,
      }))
      .sort((a, b) => b.year - a.year);

    return {
      id: row.id,
      displayName: row.displayName,
      title: row.title,
      organisation: row.organisation,
      biography: row.biography,
      countryCode: row.countryCode,
      seasons,
      isChair: seasons.some((season) => season.isChair),
    };
  });
});

export const getSeasonStats = cache(async (year: number): Promise<SeasonStats> => {
  const [nominations, underReview, eligible, judging, finalists, winners] = await Promise.all([
    prisma.nomination.count({ where: { candidacy: { awardYear: { year } }, status: 'counted' } }),
    prisma.candidacy.count({ where: { awardYear: { year }, status: 'under_review' } }),
    prisma.candidacy.count({ where: { awardYear: { year }, status: 'eligible' } }),
    prisma.judgingAssignment.count({
      where: { candidacy: { awardYear: { year } }, status: { in: ['assigned', 'in_progress'] } },
    }),
    prisma.honour.count({ where: { awardYear: { year }, kind: 'finalist', state: 'active' } }),
    prisma.honour.count({ where: { awardYear: { year }, kind: 'winner', state: 'active' } }),
  ]);

  return { nominations, underReview, eligible, judging, finalists, winners };
});

export const listCountries = cache(async (): Promise<string[]> => {
  const all = await listCreators({ limit: 500 });
  return [...new Set(all.map((creator) => creator.countryCode))].sort();
});
