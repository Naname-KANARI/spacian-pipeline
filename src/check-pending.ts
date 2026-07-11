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

interface ArchiveMatch {
  slug: string;
  title: string;
  publishedAt: string;
  score: number;
  relation: "potential-duplicate" | "related";
  sharedHashtags: string[];
  isUnpublished?: boolean;
}

// Max "related" entries to show (potential-duplicate shows all)
const MAX_RELATED_MATCHES = 3;

// ── helpers ────────────────────────────────────────────────────────────────

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function readSettings(): Settings {
  const ROOT = process.cwd();
  return readJson<Settings>(path.join(ROOT, "config", "settings.json"), {});
}

function resolveWebDataDir(dataDirSetting?: string): string {
  const ROOT = process.cwd();
  if (dataDirSetting) return path.resolve(ROOT, dataDirSetting);
  return path.join(ROOT, "data");
}

// ── main ───────────────────────────────────────────────────────────────────

function main(): void {
  const settings = readSettings();
  const webDataDir = resolveWebDataDir(settings.data_dir);
  const DISPATCH_DIR = path.join(webDataDir, "dispatch");
  const PENDING_DIR = path.join(webDataDir, "pending");

  if (!fs.existsSync(DISPATCH_DIR)) {
    console.log("[check-pending] dispatch dir not found, nothing to do.");
    return;
  }
  if (!fs.existsSync(PENDING_DIR)) {
    console.log("[check-pending] pending dir not found, nothing to do.");
    return;
  }

  // Load all dispatch articles
  const dispatchFiles = fs
    .readdirSync(DISPATCH_DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."));

  const allDispatch: ArticleForScoring[] = [];
  for (const file of dispatchFiles) {
    const raw = readJson<ArticleForScoring>(path.join(DISPATCH_DIR, file), {} as ArticleForScoring);
    if (raw.slug) allDispatch.push(raw);
  }

  // Active articles for frequency map (exclude unpublished so entityMax reflects live corpus)
  const activeDispatch = allDispatch.filter((a) => a.status !== "unpublished");
  const N = activeDispatch.length;
  console.log(`[check-pending] ${N} active dispatch articles (${allDispatch.length - N} unpublished included in matching)`);

  const entityMax = N > 0 ? Math.max(1, Math.floor(N * ENTITY_MAX_RATIO)) : 1;
  const freq = buildFrequencyMap(activeDispatch);

  // Load pending articles
  const pendingFiles = fs
    .readdirSync(PENDING_DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."));

  let updated = 0;

  for (const file of pendingFiles) {
    const filePath = path.join(PENDING_DIR, file);
    const pending = readJson<ArticleForScoring & { archiveMatches?: ArchiveMatch[]; status?: string }>(
      filePath,
      {} as ArticleForScoring
    );

    if (!pending.slug || pending.status === "REJECTED") continue;

    const duplicates: ArchiveMatch[] = [];
    const related: ArchiveMatch[] = [];

    for (const dispatch of allDispatch) {
      const { score, sharedHashtags } = scoreArticlePair(pending, dispatch, freq, entityMax);
      if (score < SCORE_RELATED) continue;

      const isUnpublished = dispatch.status === "unpublished";
      const relation: "potential-duplicate" | "related" =
        score >= SCORE_FOLLOWUP ? "potential-duplicate" : "related";

      const match: ArchiveMatch = {
        slug: dispatch.slug,
        title: dispatch.title,
        publishedAt: dispatch.publishedAt,
        score,
        relation,
        sharedHashtags,
        ...(isUnpublished ? { isUnpublished: true } : {}),
      };

      if (relation === "potential-duplicate") {
        duplicates.push(match);
      } else {
        related.push(match);
      }
    }

    // Sort by score desc within each bucket
    duplicates.sort((a, b) => b.score - a.score);
    related.sort((a, b) => b.score - a.score);

    const archiveMatches: ArchiveMatch[] = [
      ...duplicates,
      ...related.slice(0, MAX_RELATED_MATCHES),
    ];

    const hadBefore = pending.archiveMatches?.length ?? 0;
    const hasNow = archiveMatches.length;

    if (hadBefore === 0 && hasNow === 0) continue;

    const updatedPending = {
      ...pending,
      ...(archiveMatches.length > 0 ? { archiveMatches } : { archiveMatches: undefined }),
    };
    if (archiveMatches.length === 0) delete updatedPending.archiveMatches;

    fs.writeFileSync(filePath, JSON.stringify(updatedPending, null, 2) + "\n", "utf-8");
    updated++;

    if (archiveMatches.length > 0) {
      const summary = archiveMatches.map(
        (m) => `${m.relation === "potential-duplicate" ? "⚠" : "→"} ${m.slug.slice(0, 30)} (${m.score})`
      );
      console.log(`  ${pending.slug.slice(0, 40)}: ${summary.join(", ")}`);
    } else {
      console.log(`  ${pending.slug.slice(0, 40)}: cleared`);
    }
  }

  console.log(`[check-pending] done — ${updated} pending files updated`);
}

main();
