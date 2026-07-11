import fs from "fs";
import path from "path";

import {
  buildFrequencyMap,
  scoreArticlePair,
  ENTITY_MAX_RATIO,
  SCORE_FOLLOWUP,
  SCORE_RELATED,
  type ArticleForScoring,
} from "./lib/relate-scoring.js";

// ── types ──────────────────────────────────────────────────────────────────

interface Settings {
  data_dir?: string;
}

interface DispatchRaw extends ArticleForScoring {
  relatedArticles?: RelatedArticleRef[];
}

interface RelatedArticleRef {
  slug: string;
  title: string;
  publishedAt: string;
  relation: "follow-up" | "related";
  sharedHashtags: string[];
}

// ── constants ──────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const PIPELINE_DATA_DIR = path.join(ROOT, "data");
const MAX_RELATED = 5;

// ── helpers ────────────────────────────────────────────────────────────────

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function readSettings(): Settings {
  return readJson<Settings>(path.join(ROOT, "config", "settings.json"), {});
}

function resolveWebDataDir(dataDirSetting?: string): string {
  if (dataDirSetting) return path.resolve(ROOT, dataDirSetting);
  return PIPELINE_DATA_DIR;
}

// ── main ───────────────────────────────────────────────────────────────────

function main(): void {
  const settings = readSettings();
  const webDataDir = resolveWebDataDir(settings.data_dir);
  const DISPATCH_DIR = path.join(webDataDir, "dispatch");

  if (!fs.existsSync(DISPATCH_DIR)) {
    console.log("[relate] dispatch dir not found, nothing to do.");
    return;
  }

  // Load all dispatch articles
  const files = fs
    .readdirSync(DISPATCH_DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."));

  const all: { file: string; raw: DispatchRaw }[] = [];
  for (const file of files) {
    const filePath = path.join(DISPATCH_DIR, file);
    const raw = readJson<DispatchRaw>(filePath, {} as DispatchRaw);
    if (raw.slug) all.push({ file: filePath, raw });
  }

  // Only score active (non-unpublished) articles
  const active = all.filter((a) => a.raw.status !== "unpublished");
  const N = active.length;
  console.log(`[relate] ${N} active articles (${all.length - N} unpublished skipped)`);

  if (N < 2) {
    console.log("[relate] not enough articles to compute relations.");
    return;
  }

  const entityMax = Math.max(1, Math.floor(N * ENTITY_MAX_RATIO));
  const freq = buildFrequencyMap(active.map((a) => a.raw));
  console.log(`[relate] entity hashtag threshold: freq 2..${entityMax} (${ENTITY_MAX_RATIO * 100}% of ${N})`);

  // Build relations for each active article
  const relations = new Map<string, RelatedArticleRef[]>();
  for (const { raw: a } of active) {
    relations.set(a.slug, []);
  }

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i].raw;
      const b = active[j].raw;
      const { score, sharedHashtags } = scoreArticlePair(a, b, freq, entityMax);
      if (score < SCORE_RELATED) continue;
      const relation: "follow-up" | "related" = score >= SCORE_FOLLOWUP ? "follow-up" : "related";
      relations.get(a.slug)!.push({ slug: b.slug, title: b.title, publishedAt: b.publishedAt, relation, sharedHashtags });
      relations.get(b.slug)!.push({ slug: a.slug, title: a.title, publishedAt: a.publishedAt, relation, sharedHashtags });
    }
  }

  // Write relatedArticles back to each dispatch JSON (active + unpublished)
  let updated = 0;
  for (const { file, raw } of all) {
    const related = relations.get(raw.slug) ?? [];
    // Sort by publishedAt desc, cap at MAX_RELATED
    const sorted = related
      .sort((x, y) => new Date(y.publishedAt).getTime() - new Date(x.publishedAt).getTime())
      .slice(0, MAX_RELATED);

    const hadBefore = raw.relatedArticles?.length ?? 0;
    const hasNow = sorted.length;
    if (hadBefore === 0 && hasNow === 0) continue;

    const updated_ = { ...raw, relatedArticles: sorted.length > 0 ? sorted : undefined };
    if (sorted.length === 0) delete updated_.relatedArticles;
    fs.writeFileSync(file, JSON.stringify(updated_, null, 2) + "\n", "utf-8");
    updated++;

    if (sorted.length > 0) {
      const labels = sorted.map((r) => `${r.relation === "follow-up" ? "↑" : "→"} ${r.slug.slice(0, 30)}`);
      console.log(`  ${raw.slug.slice(0, 35)}: ${labels.join(", ")}`);
    }
  }

  console.log(`[relate] done — ${updated} files updated`);
}

main();
