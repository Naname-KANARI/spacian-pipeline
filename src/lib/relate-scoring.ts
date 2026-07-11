// Shared scoring types and functions used by relate.ts and check-pending.ts

export interface SatelliteRef {
  name: string;
  noradId?: number;
}

export interface ArticleForScoring {
  slug: string;
  title: string;
  publishedAt: string;
  status?: string;
  hashtags?: string[];
  satellites?: SatelliteRef[];
  [key: string]: unknown;
}

export const ENTITY_MAX_RATIO = 0.15;
export const SCORE_FOLLOWUP = 4;
export const SCORE_RELATED = 2;

export function buildFrequencyMap(articles: ArticleForScoring[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const a of articles) {
    for (const tag of a.hashtags ?? []) {
      freq.set(tag, (freq.get(tag) ?? 0) + 1);
    }
  }
  return freq;
}

export function scoreArticlePair(
  a: ArticleForScoring,
  b: ArticleForScoring,
  freq: Map<string, number>,
  entityMax: number
): { score: number; sharedHashtags: string[] } {
  const aTags = new Set(a.hashtags ?? []);
  const bTags = new Set(b.hashtags ?? []);
  const aNorad = new Set(
    (a.satellites ?? []).map((s) => s.noradId).filter((id): id is number => id !== undefined)
  );
  const bNorad = new Set(
    (b.satellites ?? []).map((s) => s.noradId).filter((id): id is number => id !== undefined)
  );

  let score = 0;
  const sharedHashtags: string[] = [];

  for (const tag of aTags) {
    if (!bTags.has(tag)) continue;
    const f = freq.get(tag) ?? 0;
    if (f >= 2 && f <= entityMax) {
      score += 2;
    } else if (f > entityMax) {
      score += 0.5;
    }
    sharedHashtags.push(tag);
  }

  for (const id of aNorad) {
    if (bNorad.has(id)) score += 3;
  }

  return { score, sharedHashtags };
}
