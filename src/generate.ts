import fs from "fs";
import path from "path";
import { generateJson } from "./lib/gemini.js";
import type { NormalizedItem } from "./lib/normalizer.js";

// ── types ──────────────────────────────────────────────────────────────────

type PersonaId = "aurora" | "comet" | "midnight" | "four" | "rook" | "scale";
type ThemeId = "economy" | "exploration" | "security" | "science";
type LabelType = "facts" | "analysis" | "note";

interface PersonaScore {
  score: number;
  why: string;
  angle: string;
  needs: string;
}

interface Candidate {
  topic_id: string;
  status: string;
  lane: string;
  source_url: string;
  source_domain: string;
  title_original: string;
  main_reporter: PersonaId;
  co_reporter: PersonaId | null;
  reason: string;
  scores_json: {
    personas: Record<PersonaId, PersonaScore>;
    credibility: "HIGH" | "MID" | "LOW";
    meta: { published_at: string; snippet_present: boolean };
  };
  created_at: string;
  updated_at: string;
}

interface Block {
  label: LabelType;
  content: string;
}

interface FoursView {
  relevance: string;
  explanation: string;
  cost: string;
  watchNext: string[];
}

interface Source {
  label: string;
  url: string;
}

interface GeminiArticleResponse {
  slug: string;
  title: string;
  subtitle: string;
  theme: ThemeId;
  blocks: Block[];
  foursView: FoursView;
  sources: Source[];
}

interface DispatchArticle {
  slug: string;
  title: string;
  subtitle: string;
  publishedAt: string;
  readingMinutes: number;
  primaryPersona: PersonaId;
  secondaryPersona?: PersonaId;
  theme: ThemeId;
  blocks: Block[];
  foursView: FoursView;
  sources: Source[];
  spectrumSatIds: string[];
  _pipeline: {
    topic_id: string;
    generated_at: string;
    gemini_model: string;
  };
}

interface Settings {
  gemini_model: string;
}

// ── constants ──────────────────────────────────────────────────────────────

const PERSONA_DESC: Record<PersonaId, string> = {
  aurora:   "民間宇宙産業・商業ビジネス分析（商業衛星・スタートアップ・投資・市場）",
  comet:    "打上げ技術・ロケット・衛星開発（推進技術・軌道工学・打上げ動向）",
  midnight: "安全保障・宇宙軍・デュアルユース技術（軍事宇宙・諜報・国家安全保障）",
  four:     "科学教育・初学者向け解説（天文・宇宙科学・宇宙の魅力を伝える）",
  rook:     "制度・規制・国際条約・法的枠組み（宇宙法・ITU・ライセンス・規制）",
  scale:    "国際政策・外交・地政学（宇宙外交・多国間関係・地政学的競争）",
};

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const CANDIDATES_DIR = path.join(DATA_DIR, "candidates");
const PENDING_DIR = path.join(DATA_DIR, "pending");
const ITEMS_PATH = path.join(DATA_DIR, "items.jsonl");
const LOGS_DIR = path.join(ROOT, "logs");

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
    gemini_model: "gemini-2.5-flash",
  });
}

function readApprovedCandidates(): { file: string; candidate: Candidate }[] {
  return fs
    .readdirSync(CANDIDATES_DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .map((f) => ({
      file: path.join(CANDIDATES_DIR, f),
      candidate: readJson<Candidate>(path.join(CANDIDATES_DIR, f), {} as Candidate),
    }))
    .filter(({ candidate }) => candidate.status === "APPROVED_FOR_DRAFT");
}

/** Find original item in items.jsonl by item_id (from topic_id "sha1:{id}") */
function findOriginalItem(topicId: string): NormalizedItem | undefined {
  const itemId = topicId.replace(/^sha1:/, "");
  if (!fs.existsSync(ITEMS_PATH)) return undefined;
  for (const line of fs.readFileSync(ITEMS_PATH, "utf-8").split("\n").filter(Boolean)) {
    const item = JSON.parse(line) as NormalizedItem;
    if (item.item_id === itemId) return item;
  }
  return undefined;
}

function toJST(date: Date = new Date()): string {
  const offset = 9 * 60 * 60 * 1000;
  return new Date(date.getTime() + offset).toISOString().replace("Z", "+09:00");
}

function calcReadingMinutes(blocks: Block[]): number {
  const totalChars = blocks.reduce((sum, b) => sum + b.content.length, 0);
  return Math.max(3, Math.ceil(totalChars / 400));
}

function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function validateTheme(v: string): ThemeId {
  const valid: ThemeId[] = ["economy", "exploration", "security", "science"];
  return valid.includes(v as ThemeId) ? (v as ThemeId) : "economy";
}

function logEvent(event: Record<string, unknown>): void {
  const today = new Date().toISOString().slice(0, 10);
  const logPath = path.join(LOGS_DIR, `${today}.jsonl`);
  fs.appendFileSync(logPath, JSON.stringify({ ...event, ts: new Date().toISOString() }) + "\n");
}

// ── generation prompt ──────────────────────────────────────────────────────

function buildPrompt(candidate: Candidate, snippet: string | undefined): string {
  const main = candidate.main_reporter;
  const co = candidate.co_reporter;
  const mainScore = candidate.scores_json.personas[main];
  const coScore = co ? candidate.scores_json.personas[co] : null;
  const now = new Date();
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  return `You are a Japanese-language space journalist writing for SPACiAN (spacian.news).

ASSIGNMENT:
- Primary journalist: ${main} — ${PERSONA_DESC[main]}
${co ? `- Supporting journalist: ${co} — ${PERSONA_DESC[co]}` : "- Solo article (no co-journalist)"}

SOURCE NEWS:
- Title: ${candidate.title_original}
- URL: ${candidate.source_url}
- Domain: ${candidate.source_domain}
- Snippet: ${snippet ?? "(unavailable — infer from title and context)"}

JOURNALISTS' ANALYSIS CONTEXT:
- ${main}'s angle: ${mainScore?.angle ?? "(none)"}
- ${main}'s needs: ${mainScore?.needs ?? "(none)"}
${coScore ? `- ${co}'s perspective: ${coScore.angle}` : ""}

WRITING GUIDELINES:
- All text must be in Japanese
- title: max 45 characters, informative, NOT sensational or clickbait
- subtitle: 2–3 line summary (2–4 sentences)
- blocks:
    • facts:    ONLY verifiable facts from the source. Zero opinion or speculation.
    • analysis: Written from ${main}'s unique perspective (angle above). ${co ? `${co} contributes a secondary insight.` : "Solo voice."}
    • note:     Caveats, background context, limitations, or what to monitor
  Each block content should be 150–400 characters in Japanese.
- foursView: Four (science educator) explains to general readers:
    • relevance: Why should a non-specialist care? (1–2 sentences)
    • explanation: Key concept explained simply (2–3 sentences)
    • cost: Cost/economic aspects mentioned (1–2 sentences; if none: "このニュースでは具体的なコスト情報は示されていない")
    • watchNext: 2–3 follow-up topics as short strings
- sources: Must include the original article. Add 1–2 other authoritative sources if you know them.
- slug format: short-english-kebab-case-${yearMonth}

THEME — pick the single best fit:
- economy:     commercial industry, business, funding, policy, regulation
- exploration: missions, launches, rockets, satellites, deep space
- security:    military, defense, dual-use, surveillance
- science:     astronomy, physics, biology, discovery, research

Return ONLY valid JSON (no markdown, no extra text):
{
  "slug": "short-english-slug-${yearMonth}",
  "title": "記事タイトル（45字以内）",
  "subtitle": "2〜3行の記事概要。",
  "theme": "economy" | "exploration" | "security" | "science",
  "blocks": [
    { "label": "facts",    "content": "事実のみ。意見なし。" },
    { "label": "analysis", "content": "${main}視点の分析。独自角度。" },
    { "label": "note",     "content": "補足・留意点。" }
  ],
  "foursView": {
    "relevance": "読者への重要性",
    "explanation": "概念の平易な説明",
    "cost": "コスト・経済的側面",
    "watchNext": ["トピック1", "トピック2"]
  },
  "sources": [
    { "label": "${candidate.source_domain}: ${candidate.title_original.slice(0, 40)}", "url": "${candidate.source_url}" }
  ]
}`;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const settings = readSettings();
  const approved = readApprovedCandidates();

  console.log(`[generate] ${approved.length} candidate(s) approved for draft`);
  if (approved.length === 0) {
    console.log(
      "[generate] nothing to generate.\n" +
      '  → Approve a candidate first: set status to "APPROVED_FOR_DRAFT" in data/candidates/{id}.json'
    );
    return;
  }

  logEvent({ event: "generate_start", count: approved.length });

  let success = 0;
  let failed = 0;

  for (const { file, candidate } of approved) {
    console.log(`\n[generate] ${candidate.title_original.slice(0, 70)}`);
    console.log(`           main: ${candidate.main_reporter} / co: ${candidate.co_reporter ?? "-"} / ${candidate.topic_id.slice(0, 20)}...`);

    const originalItem = findOriginalItem(candidate.topic_id);
    const snippet = originalItem?.snippet;

    try {
      const response = await generateJson<GeminiArticleResponse>(
        buildPrompt(candidate, snippet),
        settings.gemini_model
      );

      const slug = sanitizeSlug(response.slug) || `article-${Date.now()}`;
      const pendingPath = path.join(PENDING_DIR, `${slug}.json`);

      // Guard against slug collision
      if (fs.existsSync(pendingPath)) {
        console.warn(`  [warn] slug collision: ${slug} — appending timestamp`);
      }

      const now = new Date();
      const article: DispatchArticle = {
        slug,
        title: response.title,
        subtitle: response.subtitle,
        publishedAt: toJST(now),
        readingMinutes: calcReadingMinutes(response.blocks),
        primaryPersona: candidate.main_reporter,
        ...(candidate.co_reporter ? { secondaryPersona: candidate.co_reporter } : {}),
        theme: validateTheme(response.theme),
        blocks: response.blocks,
        foursView: response.foursView,
        sources: response.sources,
        spectrumSatIds: [],
        _pipeline: {
          topic_id: candidate.topic_id,
          generated_at: toJST(now),
          gemini_model: settings.gemini_model,
        },
      };

      fs.writeFileSync(pendingPath, JSON.stringify(article, null, 2) + "\n", "utf-8");

      // Update candidate status to DRAFTED
      const updated: Candidate = {
        ...candidate,
        status: "DRAFTED",
        updated_at: now.toISOString(),
      };
      fs.writeFileSync(file, JSON.stringify(updated, null, 2) + "\n", "utf-8");

      logEvent({
        event: "generate_ok",
        topic_id: candidate.topic_id,
        slug,
        title: article.title,
        theme: article.theme,
        reading_minutes: article.readingMinutes,
      });

      console.log(`  → slug: ${slug}`);
      console.log(`  → title: ${article.title}`);
      console.log(`  → theme: ${article.theme} | ~${article.readingMinutes}min | saved to pending/${slug}.json`);
      success++;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logEvent({ event: "generate_error", topic_id: candidate.topic_id, error: errMsg });
      console.error(`  → ERROR: ${errMsg.slice(0, 120)}`);
      failed++;
    }
  }

  logEvent({ event: "generate_done", success, failed });
  console.log(`\n[generate] done — ${success} generated, ${failed} failed`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
