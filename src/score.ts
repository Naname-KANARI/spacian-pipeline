import fs from "fs";
import path from "path";
import { generateJson } from "./lib/gemini.js";
import type { NormalizedItem } from "./lib/normalizer.js";
import { sendScoringNotification } from "./lib/mailer.js";

// ── types ──────────────────────────────────────────────────────────────────

type PersonaId = "aurora" | "comet" | "midnight" | "four" | "rook" | "scale";
type Credibility = "HIGH" | "MID" | "LOW";
type Lane = "HQ" | "Spotlight";
type Status = "PENDING" | "POTENTIAL_DUPLICATE";

interface PersonaScore {
  score: number;
  why: string;
  angle: string;
  needs: string;
}

interface GeminiScoreResponse {
  personas: Record<PersonaId, PersonaScore>;
  credibility: Credibility;
}

interface ScoresJson {
  personas: Record<PersonaId, PersonaScore>;
  main_pick: { id: PersonaId; score: number };
  co_pick: { id: PersonaId; score: number } | null;
  credibility: Credibility;
  meta: {
    published_at: string;
    lane: string;
    snippet_present: boolean;
    scored_at: string;
  };
}

interface Candidate {
  topic_id: string;
  status: Status;
  lane: Lane;
  source_url: string;
  source_domain: string;
  title_original: string;
  main_reporter: PersonaId;
  co_reporter: PersonaId | null;
  reason: string;
  scores_json: ScoresJson;
  created_at: string;
  updated_at: string;
  duplicate_of?: string;
}

interface Settings {
  fail_disable_threshold: number;
  gemini_model: string;
  gemini_rpm_limit: number;
  score_threshold_hq: number;
  score_threshold_spotlight: number;
  data_dir?: string;
}

// ── constants ──────────────────────────────────────────────────────────────

const PERSONAS: PersonaId[] = ["aurora", "comet", "midnight", "four", "rook", "scale"];

const ROOT = process.cwd();
const PIPELINE_DATA_DIR = path.join(ROOT, "data");
const ITEMS_PATH = path.join(PIPELINE_DATA_DIR, "items.jsonl");
const LOGS_DIR = path.join(ROOT, "logs");

function resolveWebDataDir(dataDirSetting?: string): string {
  if (dataDirSetting) return path.resolve(ROOT, dataDirSetting);
  return PIPELINE_DATA_DIR;
}

// Resolved after readSettings() — populated in main() before use
let CANDIDATES_DIR = path.join(PIPELINE_DATA_DIR, "candidates");

// ── helpers ────────────────────────────────────────────────────────────────

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function readSettings(): Settings {
  return readJson<Settings>(path.join(ROOT, "config", "settings.json"), {
    fail_disable_threshold: 3,
    gemini_model: "gemini-2.0-flash",
    gemini_rpm_limit: 15,
    score_threshold_hq: 50,
    score_threshold_spotlight: 40,
  });
}

function readItems(): NormalizedItem[] {
  if (!fs.existsSync(ITEMS_PATH)) return [];
  return fs
    .readFileSync(ITEMS_PATH, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as NormalizedItem);
}

function getScoredItemIds(): Set<string> {
  const files = fs
    .readdirSync(CANDIDATES_DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."));
  return new Set(files.map((f) => f.replace(".json", "")));
}

function logEvent(event: Record<string, unknown>): void {
  const today = new Date().toISOString().slice(0, 10);
  const logPath = path.join(LOGS_DIR, `${today}.jsonl`);
  fs.appendFileSync(logPath, JSON.stringify({ ...event, ts: new Date().toISOString() }) + "\n");
}

function getLimit(): number | null {
  const idx = process.argv.indexOf("--limit");
  if (idx !== -1 && process.argv[idx + 1]) {
    const n = parseInt(process.argv[idx + 1], 10);
    return isNaN(n) ? null : n;
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── duplicate detection ────────────────────────────────────────────────────

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s\W]+/)
      .filter((w) => w.length > 2)
  );
}

function wordOverlap(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  return intersection / Math.min(setA.size, setB.size);
}

interface ExistingCandidate {
  item_id: string;
  title: string;
}

function loadSameDayCandidates(today: string): ExistingCandidate[] {
  const result: ExistingCandidate[] = [];
  if (!fs.existsSync(CANDIDATES_DIR)) return result;
  for (const f of fs.readdirSync(CANDIDATES_DIR)) {
    if (!f.endsWith(".json") || f.startsWith(".")) continue;
    try {
      const c = JSON.parse(
        fs.readFileSync(path.join(CANDIDATES_DIR, f), "utf-8")
      ) as Candidate;
      if (c.created_at?.startsWith(today)) {
        result.push({ item_id: f.replace(".json", ""), title: c.title_original });
      }
    } catch {}
  }
  return result;
}

function detectDuplicate(
  title: string,
  existing: ExistingCandidate[]
): string | null {
  const THRESHOLD = 0.7;
  for (const e of existing) {
    if (wordOverlap(title, e.title) >= THRESHOLD) return e.item_id;
  }
  return null;
}

// ── scoring prompt ─────────────────────────────────────────────────────────

function buildPrompt(item: NormalizedItem): string {
  return `You are a scoring assistant for SPACiAN, a Japanese space news media site.
SPACiAN has 6 AI personas who each cover space news from a specific angle:
- aurora: 民間宇宙産業・商業ビジネス (commercial space industry & business)
- comet: 打上げ技術・ロケット・衛星開発 (launch tech, rockets, satellites)
- midnight: 安全保障・宇宙軍・デュアルユース技術 (space security, dual-use tech)
- four: 科学教育・初学者向け解説・宇宙の魅力 (science education, accessible explanations)
- rook: 制度・規制・国際条約・法的枠組み (policy, regulation, international law)
- scale: 国際政策・外交・地政学・多国間関係 (geopolitics, international relations)

NEWS ITEM TO SCORE:
Title: ${item.title_original}
Snippet: ${item.snippet ?? "(none)"}
Domain: ${item.domain}
URL: ${item.url_normalized}
Published: ${item.published_at ?? "(unknown)"}

TASK:
1. For each persona, score 0-100 how interesting and writable this news is FROM THAT PERSONA'S SPECIFIC ANGLE.
   (0 = completely irrelevant, 100 = perfect fit)
2. Assess SOURCE CREDIBILITY:
   - HIGH: primary source — space agency (NASA/ESA/JAXA/etc), government, or top-tier specialized media (SpaceNews, NASASpaceFlight)
   - MID: secondary reporting, expert outlet, defense media, popular science
   - LOW: unknown source, anonymous, unverified

Write why/angle/needs fields in Japanese (1–2 sentences each).

Return ONLY valid JSON in exactly this format:
{
  "personas": {
    "aurora":   { "score": <0-100>, "why": "<why this score>", "angle": "<unique writing angle>", "needs": "<additional info needed>" },
    "comet":    { "score": <0-100>, "why": "...", "angle": "...", "needs": "..." },
    "midnight": { "score": <0-100>, "why": "...", "angle": "...", "needs": "..." },
    "four":     { "score": <0-100>, "why": "...", "angle": "...", "needs": "..." },
    "rook":     { "score": <0-100>, "why": "...", "angle": "...", "needs": "..." },
    "scale":    { "score": <0-100>, "why": "...", "angle": "...", "needs": "..." }
  },
  "credibility": "HIGH" or "MID" or "LOW"
}`;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const settings = readSettings();

  // Resolve output paths from data_dir setting
  const webDataDir = resolveWebDataDir(settings.data_dir);
  CANDIDATES_DIR = path.join(webDataDir, "candidates");
  fs.mkdirSync(CANDIDATES_DIR, { recursive: true });

  const allItems = readItems();
  const scored = getScoredItemIds();

  const pending = allItems.filter((item) => !scored.has(item.item_id));
  const limit = getLimit();
  const targets = limit !== null ? pending.slice(0, limit) : pending;

  console.log(
    `[score] ${allItems.length} items total, ${scored.size} already scored, ${pending.length} pending`
  );
  if (limit !== null) console.log(`[score] --limit ${limit} → processing ${targets.length} items`);
  if (targets.length === 0) {
    console.log("[score] nothing to score.");
    return;
  }

  logEvent({ event: "score_start", total: targets.length });

  const today = new Date().toISOString().slice(0, 10);
  let success = 0;
  let failed = 0;

  for (let i = 0; i < targets.length; i++) {
    const item = targets[i];
    const prefix = `[${i + 1}/${targets.length}]`;
    console.log(`\n${prefix} ${item.title_original.slice(0, 70)}`);
    console.log(`       ${item.domain} — ${item.item_id.slice(0, 12)}...`);

    try {
      const response = await generateJson<GeminiScoreResponse>(
        buildPrompt(item),
        settings.gemini_model
      );

      // Sort personas by score descending
      const sorted = PERSONAS.map((id) => ({
        id,
        ...(response.personas[id] ?? { score: 0, why: "", angle: "", needs: "" }),
      })).sort((a, b) => b.score - a.score);

      const mainPick = sorted[0];
      const coPick = sorted[1];
      const coScore = coPick?.score ?? 0;
      const lane: Lane = coScore >= settings.score_threshold_spotlight ? "HQ" : "Spotlight";

      const now = new Date().toISOString();
      const scoresJson: ScoresJson = {
        personas: response.personas,
        main_pick: { id: mainPick.id, score: mainPick.score },
        co_pick: lane === "HQ" ? { id: coPick.id, score: coScore } : null,
        credibility: response.credibility,
        meta: {
          published_at: item.published_at ?? "",
          lane: item.lane,
          snippet_present: !!item.snippet,
          scored_at: now,
        },
      };

      const reason =
        response.personas[mainPick.id]?.angle ||
        response.personas[mainPick.id]?.why ||
        "(no reason)";

      // Duplicate detection against same-day candidates
      const sameDayCandidates = loadSameDayCandidates(today);
      const duplicateOf = detectDuplicate(item.title_original, sameDayCandidates);

      const candidate: Candidate = {
        topic_id: `sha1:${item.item_id}`,
        status: duplicateOf ? "POTENTIAL_DUPLICATE" : "PENDING",
        lane,
        source_url: item.url_normalized,
        source_domain: item.domain,
        title_original: item.title_original,
        main_reporter: mainPick.id,
        co_reporter: lane === "HQ" ? coPick.id : null,
        reason,
        scores_json: scoresJson,
        created_at: now,
        updated_at: now,
        ...(duplicateOf ? { duplicate_of: duplicateOf } : {}),
      };

      const outPath = path.join(CANDIDATES_DIR, `${item.item_id}.json`);
      fs.writeFileSync(outPath, JSON.stringify(candidate, null, 2) + "\n", "utf-8");

      logEvent({
        event: "score_ok",
        item_id: item.item_id,
        main_reporter: mainPick.id,
        main_score: mainPick.score,
        co_reporter: candidate.co_reporter,
        co_score: coScore,
        lane,
        credibility: response.credibility,
      });

      const dupLabel = duplicateOf ? ` ⚠️ dup:${duplicateOf.slice(0, 8)}` : "";
      console.log(
        `       → ${lane} | main: ${mainPick.id}(${mainPick.score}) co: ${coPick?.id ?? "-"}(${coScore}) | ${response.credibility}${dupLabel}`
      );
      success++;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logEvent({ event: "score_error", item_id: item.item_id, error: errMsg });
      console.error(`       → ERROR: ${errMsg.slice(0, 100)}`);
      failed++;
    }

    // Rate limit: 4s delay between requests (15 RPM safety margin)
    if (i < targets.length - 1) await sleep(4_000);
  }

  logEvent({ event: "score_done", success, failed });
  console.log(`\n[score] done — ${success} scored, ${failed} failed`);

  // Send candidate notification (non-fatal if fails)
  if (success > 0) {
    const editorBase = process.env.EDITOR_BASE_URL ?? "http://localhost:3000";
    const editorToken = process.env.EDITOR_TOKEN ?? "";
    const editorUrl = `${editorBase}/editor/${editorToken}/candidates`;
    await sendScoringNotification(success, editorUrl);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
