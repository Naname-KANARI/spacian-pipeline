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
    main_pick: { id: PersonaId; score: number };
    co_pick: { id: PersonaId; score: number } | null;
    credibility: "HIGH" | "MID" | "LOW";
    meta: { published_at: string; snippet_present: boolean };
  };
  created_at: string;
  updated_at: string;
}

interface SatelliteRef {
  name: string;
  noradId?: number;
}

interface GeminiArticleResponse {
  title: string;
  subtitle: string;
  theme: ThemeId;
  blocks: { label: LabelType; content: string }[];
  foursView: {
    relevance: string;
    explanation: string;
    cost: string;
    watchNext: string[];
  };
  sources: { label: string; url: string }[];
  hashtags: string[];
  satellites: SatelliteRef[];
  slug: string;
}

// Matches types.ts DispatchArticle + _pipeline metadata
interface PendingArticle {
  slug: string;
  title: string;
  subtitle: string;
  publishedAt: string;
  readingMinutes: number;
  primaryPersona: PersonaId;
  secondaryPersona?: PersonaId;
  theme: ThemeId;
  blocks: { label: LabelType; content: string }[];
  foursView: { relevance: string; explanation: string; cost: string; watchNext: string[] };
  hashtags: string[];
  satellites: SatelliteRef[];
  sources: { label: string; url: string }[];
  _pipeline: { topic_id: string; generated_at: string; gemini_model: string };
}

interface Settings {
  gemini_model: string;
}

// ── constants ──────────────────────────────────────────────────────────────

const VALID_THEMES: ThemeId[] = ["economy", "exploration", "security", "science"];

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
    .flatMap((f) => {
      const file = path.join(CANDIDATES_DIR, f);
      const candidate = readJson<Candidate>(file, {} as Candidate);
      return candidate.status === "APPROVED_FOR_DRAFT" ? [{ file, candidate }] : [];
    });
}

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
  return new Date(date.getTime() + 9 * 60 * 60 * 1000)
    .toISOString()
    .replace("Z", "+09:00");
}

function calcReadingMinutes(blocks: { content: string }[]): number {
  const chars = blocks.reduce((s, b) => s + b.content.length, 0);
  return Math.max(3, Math.ceil(chars / 400));
}

function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function validateTheme(v: string): ThemeId {
  return VALID_THEMES.includes(v as ThemeId) ? (v as ThemeId) : "economy";
}

function getLimit(): number | null {
  const idx = process.argv.indexOf("--limit");
  if (idx !== -1 && process.argv[idx + 1]) {
    const n = parseInt(process.argv[idx + 1], 10);
    return isNaN(n) ? null : n;
  }
  return null;
}

function logEvent(event: Record<string, unknown>): void {
  const today = new Date().toISOString().slice(0, 10);
  const logPath = path.join(LOGS_DIR, `${today}.jsonl`);
  fs.appendFileSync(logPath, JSON.stringify({ ...event, ts: new Date().toISOString() }) + "\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Gemini prompt（article-template-dispatch.md §Gemini生成プロンプト）────

function buildPrompt(candidate: Candidate, snippet: string | undefined): string {
  const main = candidate.main_reporter;
  const co = candidate.co_reporter;
  const angle = candidate.scores_json.personas[main]?.angle ?? candidate.reason;
  const now = new Date();
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  // Template from article-template-dispatch.md with variables substituted
  return `あなたはSPACiANのAI記者です。
担当ペルソナ: ${main}（主）/ ${co ?? "なし"}（副）

以下のニュースをもとに、SPACiAN Dispatch記事をJSON形式で作成してください。

【入力情報】
タイトル（原文）: ${candidate.title_original}
URL: ${candidate.source_url}
ドメイン: ${candidate.source_domain}
スニペット: ${snippet ?? "（取得不可 — タイトルと文脈から推定）"}
ペルソナの切り口: ${angle}（${main}の視点）

【出力形式】
以下のJSONフィールドをすべて日本語で生成してください。

title: 45字以内。主語＋事実＋変化点。

subtitle: 3行を改行（\\n）で区切る。
  1行目（20〜30字）: 事実 — 何が起きたか
  2行目（20〜30字）: 重要性 — なぜ注目されるか
  3行目（20〜30字）: 視点 — 今後どこを見るべきか

blocks:
  - label: "facts"
    content: ニュースの詳細（事実のみ、小見出しあり、読了2〜3分相当）
             何が起きたか・いつ・誰が・背景・現状を明確に。意見を含めない。
  - label: "analysis"
    content: 解説・視点（${main}の専門角度から。なぜ重要か・示唆・見通し、読了3〜4分相当）
  - label: "note"（必要な場合のみ。不要なら省略）
    content: 留意点・不確実性・反対意見

foursView:
  relevance: このニュースが読者の日常・社会とどう繋がるか
  explanation: 専門用語・背景知識の補足（中高生でも分かるレベル）
  cost: 費用・予算・経済規模の概算（不明なら「現時点では非公開」）
  watchNext: 次に注目すべきイベント・期日を1〜3件（配列）

sources:
  - label: "${candidate.source_domain}: ${candidate.title_original.slice(0, 50)}"
    url: "${candidate.source_url}"

hashtags: 記事内容から5〜10個生成。英語・日本語混在可。
  テーマ・組織・技術・地域の軸でカバーする。
  例: ["#Starlink", "#SpaceX", "#衛星通信", "#LEO"]

satellites: 衛星が記事に登場する場合のみ。登場しない場合は空配列 []。
  SATCAT衛星名（大文字）とNORAD IDを推定する。
  不明なNORAD IDは省略し name のみ記載。
  例: [{ "name": "HUBBLE SPACE TELESCOPE", "noradId": 20580 }]

slug: 英数字ハイフンのみ。例: hubble-reboost-${yearMonth}

theme: 記事の内容から独立して判断すること（担当ペルソナのデフォルトに引きずられない）。
  exploration = 探査・打上・技術開発
  security    = 安保・軍事・外交・地政学・国際協力の緊張
  economy     = 産業・市場・保険・規制・ビジネス
  science     = 科学・観測・宇宙天気・研究
  ペルソナが economy 担当でも内容が security なら security を選ぶ。

【原則】
- 事実と意見を明確に分離すること（factsに意見を混ぜない）
- 語調は中立・知的・簡潔
- 読者が次の行動を取れる情報を提供すること
- JSON以外のテキストを出力しないこと`;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const settings = readSettings();
  const limit = getLimit();

  const allApproved = readApprovedCandidates();
  const targets = limit !== null ? allApproved.slice(0, limit) : allApproved;

  console.log(`[generate] ${allApproved.length} approved candidate(s)` +
    (limit !== null ? ` | --limit ${limit} → processing ${targets.length}` : ""));

  if (targets.length === 0) {
    console.log(
      "[generate] nothing to generate.\n" +
      '  → Set a candidate status to "APPROVED_FOR_DRAFT" in data/candidates/{id}.json'
    );
    return;
  }

  logEvent({ event: "generate_start", count: targets.length });

  let success = 0;
  let failed = 0;

  for (const [index, { file, candidate }] of targets.entries()) {
    if (index > 0) await sleep(4000);
    const main = candidate.main_reporter;
    const co = candidate.co_reporter;
    console.log(`\n[generate] ${candidate.title_original.slice(0, 72)}`);
    console.log(`           main: ${main} / co: ${co ?? "-"} | ${candidate.topic_id.slice(0, 22)}...`);

    const originalItem = findOriginalItem(candidate.topic_id);

    try {
      const response = await generateJson<GeminiArticleResponse>(
        buildPrompt(candidate, originalItem?.snippet),
        settings.gemini_model
      );

      // Sanitize slug, fallback to timestamp if empty
      let slug = sanitizeSlug(response.slug ?? "");
      if (!slug) slug = `article-${Date.now()}`;

      // Guard slug collision
      const pendingPath = path.join(PENDING_DIR, `${slug}.json`);
      if (fs.existsSync(pendingPath)) {
        const ts = Date.now().toString().slice(-6);
        slug = `${slug}-${ts}`;
        console.warn(`  [warn] slug collision — renamed to ${slug}`);
      }

      const now = new Date();
      const article: PendingArticle = {
        slug,
        title: response.title,
        subtitle: response.subtitle,
        publishedAt: toJST(now),
        readingMinutes: calcReadingMinutes(response.blocks),
        primaryPersona: main,
        ...(co ? { secondaryPersona: co } : {}),
        theme: validateTheme(response.theme),
        blocks: response.blocks,
        foursView: response.foursView,
        hashtags: response.hashtags ?? [],
        satellites: response.satellites ?? [],
        sources: response.sources,
        _pipeline: {
          topic_id: candidate.topic_id,
          generated_at: toJST(now),
          gemini_model: settings.gemini_model,
        },
      };

      fs.writeFileSync(
        path.join(PENDING_DIR, `${slug}.json`),
        JSON.stringify(article, null, 2) + "\n",
        "utf-8"
      );

      // Update candidate → DRAFTED
      fs.writeFileSync(
        file,
        JSON.stringify({ ...candidate, status: "DRAFTED", updated_at: now.toISOString() }, null, 2) + "\n",
        "utf-8"
      );

      logEvent({
        event: "generate_ok",
        topic_id: candidate.topic_id,
        slug,
        title: article.title,
        theme: article.theme,
        hashtags: article.hashtags,
        satellites: article.satellites.map((s) => s.name),
        reading_minutes: article.readingMinutes,
      });

      console.log(`  → slug:      ${slug}`);
      console.log(`  → title:     ${article.title}`);
      console.log(`  → theme:     ${article.theme} | ~${article.readingMinutes}min`);
      console.log(`  → hashtags:  ${article.hashtags.join(" ")}`);
      if (article.satellites.length > 0) {
        console.log(`  → satellites: ${article.satellites.map((s) => `${s.name}(${s.noradId ?? "?"})` ).join(", ")}`);
      }
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
