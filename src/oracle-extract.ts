import fs from "fs";
import path from "path";
import Parser from "rss-parser";
import * as cheerio from "cheerio";
import { generateJson } from "./lib/gemini.js";

// ── paths ─────────────────────────────────────────────────────────────────

const ROOT = process.cwd();

function readSettings(): { data_dir?: string; gemini_model?: string } {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "config", "settings.json"), "utf-8"));
  } catch { return {}; }
}

const settings = readSettings();
const WEB_DATA_DIR = path.resolve(ROOT, settings.data_dir ?? "../spacian-web/src/data");
const GEMINI_MODEL = settings.gemini_model ?? "gemini-2.0-flash";

const WATCH_TARGETS_DIR = path.join(WEB_DATA_DIR, "oracle-watch-targets");
const CANDIDATES_DIR    = path.join(WEB_DATA_DIR, "oracle-candidates");
const ORACLES_DIR       = path.join(WEB_DATA_DIR, "oracles");

// ── types (local mirror of spacian-web types) ─────────────────────────────

type WatchTargetType = "reddit-subreddit" | "reddit-thread" | "nsf-thread" | "x-account";
type OracleConfidenceLevel = "Speculation" | "Plausible" | "Developing";
type OracleCandidateStatus = "pending" | "approved" | "rejected" | "expired";

interface WatchTarget {
  id: string;
  type: WatchTargetType;
  url: string;
  label: string;
  active: boolean;
  createdAt: string;
  lastScannedAt?: string;
  lastItemId?: string;
}

interface OracleCandidate {
  id: string;
  watchTargetId: string;
  sourceType: WatchTargetType;
  sourceUrl: string;
  sourceAuthor?: string;
  rawSnippet: string;
  extractedClaim: string;
  extractedWhyNotable: string;
  extractedConfidence: OracleConfidenceLevel;
  scannedAt: string;
  expiresAt: string;
  status: OracleCandidateStatus;
}

interface GeminiClaimResult {
  hasNovelClaim: boolean;
  claim: string;
  whyNotable: string;
  confidence: OracleConfidenceLevel;
}

// ── io helpers ────────────────────────────────────────────────────────────

function readJsonDir<T>(dir: string): T[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .flatMap((f) => {
      try { return [JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as T]; }
      catch { return []; }
    });
}

function saveJson(dir: string, id: string, data: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ── duplicate check ───────────────────────────────────────────────────────

function buildSeenUrls(): Set<string> {
  const seen = new Set<string>();
  for (const c of readJsonDir<OracleCandidate>(CANDIDATES_DIR)) seen.add(c.sourceUrl);
  for (const o of readJsonDir<{ sourceUrl: string }>(ORACLES_DIR)) seen.add(o.sourceUrl);
  return seen;
}

// ── Gemini claim extraction ───────────────────────────────────────────────

const CLAIM_PROMPT = (sourceType: string, sourceUrl: string, author: string, text: string) => `
あなたは宇宙業界専門のニュース編集者です。
以下のフォーラム投稿を読み、宇宙業界・商業宇宙・軍事宇宙開発に関して、
まだ一般に確認されていない具体的な主張（新製品・スケジュール・計画・人事・技術情報・打ち上げ日程変更等）が
含まれているかを判断してください。

ソース種別: ${sourceType}
URL: ${sourceUrl}
著者: ${author || "不明"}
投稿本文:
---
${text.slice(0, 1200)}
---

以下のJSONを返してください（JSON以外は不要）：
{
  "hasNovelClaim": true か false,
  "claim": "主張の要約（編集者が公開する文章として適切な伝聞語調で50〜200字。hasNovelClaimがfalseなら空文字）",
  "whyNotable": "なぜ注目に値するか（30〜100字。hasNovelClaimがfalseなら空文字）",
  "confidence": "Speculation" または "Plausible" または "Developing"
}

hasNovelClaim を false とすべき場合:
- 既知の公式発表の話題のみ
- 単なる意見・感想・質問
- 個人のプライバシーや名誉毀損になりうる内容
- 宇宙業界と無関係
`.trim();

async function extractClaim(
  sourceType: string,
  sourceUrl: string,
  author: string,
  text: string
): Promise<GeminiClaimResult | null> {
  try {
    const result = await generateJson<GeminiClaimResult>(
      CLAIM_PROMPT(sourceType, sourceUrl, author, text),
      GEMINI_MODEL,
      1
    );
    if (typeof result.hasNovelClaim !== "boolean") return null;
    return result;
  } catch (err) {
    console.warn("  [gemini] claim extraction failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ── Reddit RSS fetcher ────────────────────────────────────────────────────

interface RssItem {
  id: string;
  title: string;
  link: string;
  author: string;
  content: string;
  isoDate: string;
}

async function fetchRedditRss(url: string, lastItemId?: string): Promise<RssItem[]> {
  const rssUrl = url.replace(/\/?$/, ".rss?limit=25");

  const parser = new Parser({
    customFields: { item: ["author", "content", "media:thumbnail"] },
    headers: {
      "User-Agent": "SPACiAN/1.0 (+https://spacian.news; oracle-extract; contact: constellation@spacian.news)",
      "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    },
  });

  let feed: Awaited<ReturnType<typeof parser.parseURL>>;
  try {
    feed = await parser.parseURL(rssUrl);
  } catch (err) {
    console.warn(`  [reddit-rss] fetch failed for ${rssUrl}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const items: RssItem[] = (feed.items ?? []).map((item) => ({
    id: (item.id ?? item.guid ?? item.link ?? "").split("/").filter(Boolean).pop() ?? "",
    title: item.title ?? "",
    link: item.link ?? "",
    author: (item as { author?: string }).author ?? "",
    content: (item as { content?: string; contentSnippet?: string }).content
      ?? (item as { contentSnippet?: string }).contentSnippet ?? "",
    isoDate: item.isoDate ?? new Date().toISOString(),
  }));

  if (!lastItemId) return items;

  const lastIdx = items.findIndex((i) => i.id === lastItemId || i.link.includes(lastItemId));
  return lastIdx === -1 ? items : items.slice(0, lastIdx);
}

// ── NSF Forum SMF scraper ─────────────────────────────────────────────────

interface ForumPost {
  id: string;
  author: string;
  content: string;
  url: string;
}

async function fetchNsfThreadPosts(url: string, lastItemId?: string): Promise<ForumPost[]> {
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://forum.nasaspaceflight.com/",
  };

  let html: string;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      console.warn(`  [nsf-forum] HTTP ${res.status} for ${url} — skipping`);
      return [];
    }
    html = await res.text();
  } catch (err) {
    console.warn(`  [nsf-forum] fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const $ = cheerio.load(html);
  const posts: ForumPost[] = [];

  // SMF post structure: div.post_wrapper > div#msg_NNNNN + .poster h4 a + .inner
  $(".post_wrapper").each((_, el) => {
    const msgDiv = $(el).find("[id^='msg_']").filter((_, e) => /^msg_\d+$/.test((e as { attribs?: Record<string, string> }).attribs?.id ?? "")).first();
    const msgId = msgDiv.attr("id")?.replace("msg_", "") ?? "";
    if (!msgId) return;

    const author = $(el).find(".poster h4 a").first().text().trim()
      || $(el).find(".poster h4").first().text().trim();
    const content = $(el).find(".inner").first().text().trim().slice(0, 800);

    if (!content || content.length < 50) return;

    const postUrl = `${url.split("?")[0]}?topic=${url.match(/topic=(\d+)/)?.[1]}.msg${msgId}#msg${msgId}`;
    posts.push({ id: msgId, author, content, url: postUrl });
  });

  if (!lastItemId) return posts;
  const lastIdx = posts.findIndex((p) => p.id === lastItemId);
  return lastIdx === -1 ? posts : posts.slice(lastIdx + 1);
}

// ── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const targets = readJsonDir<WatchTarget>(WATCH_TARGETS_DIR)
    .filter((t) => t.active && t.type !== "x-account");

  if (targets.length === 0) {
    console.log("[oracle-extract] no active watch targets — done");
    return;
  }

  const seenUrls = buildSeenUrls();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();
  let totalNew = 0;

  for (const target of targets) {
    console.log(`[oracle-extract] scanning: ${target.label} (${target.type})`);

    let posts: { id: string; author: string; content: string; url: string; title?: string }[] = [];

    if (target.type === "reddit-subreddit" || target.type === "reddit-thread") {
      const rssItems = await fetchRedditRss(target.url, target.lastItemId);
      posts = rssItems.map((i) => ({
        id: i.id,
        author: i.author,
        content: i.title + "\n\n" + i.content,
        url: i.link,
        title: i.title,
      }));
      // rate limit: RSS is ~1/min max; we're running every 30-60min so no need to sleep
    } else if (target.type === "nsf-thread") {
      const fp = await fetchNsfThreadPosts(target.url, target.lastItemId);
      posts = fp;
    }

    if (posts.length === 0) {
      console.log(`  no new items`);
      // still update lastScannedAt
      target.lastScannedAt = now.toISOString();
      saveJson(WATCH_TARGETS_DIR, target.id, target);
      continue;
    }

    console.log(`  ${posts.length} new item(s) to process`);

    let newLastItemId = target.lastItemId;
    let newCandidates = 0;

    for (const post of posts) {
      // track latest id
      if (posts.indexOf(post) === 0) newLastItemId = post.id;

      // pre-filter: minimum length
      const text = post.content.trim();
      if (text.length < 80) continue;

      // duplicate check
      if (seenUrls.has(post.url)) continue;

      // Gemini claim extraction
      const label = target.type === "nsf-thread" ? "NSF SMF thread" : `Reddit ${target.type}`;
      const result = await extractClaim(label, post.url, post.author, text);
      if (!result || !result.hasNovelClaim || !result.claim) continue;

      // write candidate
      const candidateId = `candidate-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const candidate: OracleCandidate = {
        id: candidateId,
        watchTargetId: target.id,
        sourceType: target.type,
        sourceUrl: post.url,
        sourceAuthor: post.author || undefined,
        rawSnippet: text.slice(0, 500),
        extractedClaim: result.claim,
        extractedWhyNotable: result.whyNotable,
        extractedConfidence: result.confidence,
        scannedAt: now.toISOString(),
        expiresAt,
        status: "pending",
      };

      saveJson(CANDIDATES_DIR, candidateId, candidate);
      seenUrls.add(post.url);
      newCandidates++;
      totalNew++;

      // small delay to stay within Gemini RPM limit
      await new Promise((r) => setTimeout(r, 2_000));
    }

    // update watch target
    target.lastScannedAt = now.toISOString();
    if (newLastItemId) target.lastItemId = newLastItemId;
    saveJson(WATCH_TARGETS_DIR, target.id, target);

    console.log(`  → ${newCandidates} candidate(s) added`);
  }

  console.log(`[oracle-extract] done. total new candidates: ${totalNew}`);
}

main().catch((err) => {
  console.error("[oracle-extract] fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
