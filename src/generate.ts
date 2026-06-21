import fs from "fs";
import path from "path";
import { generateJson, generateImage } from "./lib/gemini.js";
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

interface SelectedReference {
  role: "support" | "complement" | "critique";
  title: string;
  source_url: string;
  source_domain: string;
  snippet: string;
  notes: string;
}

interface SuggestedRef {
  role: "complement";
  title: string;
  source_url: string;
  source_domain: string;
  snippet: string;
  notes: string;
}

interface HeroImage {
  url: string;
  alt: string;
  credit: string;
  license: string;
  licenseUrl?: string;
  source: string;
  sourceUrl?: string;
  isAiGenerated?: boolean;
}

interface ImagePolicy {
  og_image_usage: "embed" | "attribution_link_only" | "none";
  attribution?: string;
  license?: string;
  notes?: string;
}

interface CuratedImage {
  url: string;
  alt: string;
  tags: string[];
  source_url?: string;
}

interface PressKit {
  name: string;
  match_keywords: string[];
  search_method: "curated" | "og_scrape";
  attribution: string;
  license: string;
  license_url?: string;
  og_domain?: string;
  curated_images?: CuratedImage[];
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
  selected_references?: SelectedReference[];
  suggested_references?: SuggestedRef[];
}

interface SatelliteRef {
  name: string;
  noradId?: number;
}

interface GlossaryEntry {
  slug: string;
  definition: string;
  aliases?: string[];
}

interface GeminiArticleResponse {
  title: string;
  subtitle: string;
  theme: ThemeId;
  blocks: { label: LabelType; content: string }[];
  foursDialogue: { speaker: string; text: string }[];
  sources: { label: string; url: string }[];
  hashtags: string[];
  satellites: SatelliteRef[];
  slug: string;
  glossaryTerms: string[];
  glossaryDefinitions: Record<string, GlossaryEntry>;
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
  foursDialogue: { speaker: string; text: string }[];
  hashtags: string[];
  satellites: SatelliteRef[];
  sources: { label: string; url: string }[];
  heroImage?: HeroImage;
  xEmbedUrl?: string;
  glossaryTerms: string[];
  glossaryDefinitions: Record<string, GlossaryEntry>;
  _pipeline: { topic_id: string; generated_at: string; gemini_model: string };
}

interface Settings {
  gemini_model: string;
  data_dir?: string;
}

// ── vocab types ────────────────────────────────────────────────────────────

interface VocabEntry {
  count: number;
  lastSeen: string; // YYYY-MM-DD
  months?: Record<string, number>; // "2026-06": 5
}

interface VocabData {
  terms: Record<string, VocabEntry>;
  updatedAt: string;
}

// ── constants ──────────────────────────────────────────────────────────────

const VALID_THEMES: ThemeId[] = ["economy", "exploration", "security", "science"];

// Fallback voices (used if ../spacian-web/docs/AI-Personas/<id>.json is missing or lacks prompt_voice)
const PERSONA_VOICE_FALLBACKS: Record<PersonaId, string> = {
  aurora: "宇宙法・倫理・公平性を専門とし、静かで端正な文体で問いの形で読者に渡す。断罪せず、理想→現実→折衷案のセットで締める。",
  comet: "明るく親しみやすいが技術的正確さを優先。まず「何が新しいか」を1行で言い、できること/できないことを分け、身近な例えで説明する。煽り・断定・誇張は使わない。",
  midnight: "宇宙開発を「制約の芸術（予算・契約・政治日程・市場）」として見る経済・産業担当。「なぜ止まらないか」をインセンティブで説明し、主語を構造に置く。生活への影響を1つ接続点として入れる。",
  four: "飛び級12歳の読者代表。「これ、私に関係ある？」で開き、難語を中学生向けに言い換え、弱点を遠慮なく指摘する。幼稚化・煽り・断罪なし。",
  rook: "安保とデュアルユース技術の境界を専門とする冷静な安保担当。メリット/リスクを同じ皿に載せ、誤認問題を軸に据え、安心を「明日も同じ夜が来ると信じられること」として定義する。",
  scale: "ソ連宇宙政策を体験で知る74歳の歴史編集者。格調高く旧メディア的文体。歴史サイクルで位置づけ、過去の類例と今回の違いを並べる視点を持つ。断罪でなく比較。",
};

function loadPersonaVoices(): Record<PersonaId, string> {
  // Mirrors data_dir convention: data is at ../spacian-web/src/data, personas at ../spacian-web/docs/AI-Personas
  // Use process.cwd() directly — ROOT is defined below and not yet initialized at this call site
  const personasDir = path.resolve(process.cwd(), "../spacian-web/docs/AI-Personas");
  const result = { ...PERSONA_VOICE_FALLBACKS };
  for (const id of Object.keys(result) as PersonaId[]) {
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(personasDir, `${id}.json`), "utf-8")
      ) as { prompt_voice?: string };
      if (raw.prompt_voice) result[id] = raw.prompt_voice;
    } catch {
      // file missing or malformed — keep fallback
    }
  }
  return result;
}

const PERSONA_VOICES: Record<PersonaId, string> = loadPersonaVoices();

const PERSONA_NICKNAMES: Record<PersonaId, string> = {
  aurora: "Aurora",
  comet: "Comet",
  midnight: "Midnight",
  four: "Four",
  rook: "Rook",
  scale: "Scale",
};

const ROOT = process.cwd();
const PIPELINE_DATA_DIR = path.join(ROOT, "data");
const ITEMS_PATH = path.join(PIPELINE_DATA_DIR, "items.jsonl");
const LOGS_DIR = path.join(ROOT, "logs");

// Resolved in main() after reading settings
let VOCAB_PATH = path.join(PIPELINE_DATA_DIR, "four-vocab.json");

// Common English words that match proper-noun pattern but are not terms
const TERM_STOPLIST = new Set([
  "The","This","That","These","Those","It","Its","An","As","At","Be","By",
  "Do","For","From","In","Is","Of","On","Or","So","To","Up","We","He","She",
  "And","Are","But","Can","Did","Has","Had","If","New","Not","Now","Our",
  "Out","Was","Who","With","You","Have","Their","They","Will","Would","Also",
  "Been","Into","Over","Such","Than","Then","When","Where","Which","While",
  "About","After","All","Any","Each","Even","Every","First","Here","How",
  "Just","Many","May","More","Most","Much","Must","No","Only","Other","Same",
  "Some","Still","There","What","Your","Both","Few","High","Low","Large","Small",
  "Inc","Ltd","Corp","Co","No","Mr","Ms","Dr","Jr","Sr",
  "I","II","III","IV","VI","VII","VIII","IX","XI","XII",
]);

function resolveWebDataDir(dataDirSetting?: string): string {
  if (dataDirSetting) return path.resolve(ROOT, dataDirSetting);
  return PIPELINE_DATA_DIR;
}

// Resolved in main() after reading settings
let CANDIDATES_DIR = path.join(PIPELINE_DATA_DIR, "candidates");
let PENDING_DIR = path.join(PIPELINE_DATA_DIR, "pending");

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
  const chars = blocks.reduce((s, b) => s + (b.content?.length ?? 0), 0);
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

// ── reference suggestion ───────────────────────────────────────────────────

const SUGGEST_THRESHOLD = 0.25;
const SUGGEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[\s\p{P}\p{Z}\p{S}]+/u).filter((w) => w.length > 2));
}

function wordOverlap(a: string, b: string): number {
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (!sa.size || !sb.size) return 0;
  let n = 0;
  for (const w of sa) if (sb.has(w)) n++;
  return n / Math.min(sa.size, sb.size);
}

function suggestReferences(
  title: string,
  sourceDomain: string,
  currentTopicId: string
): SuggestedRef[] {
  if (!fs.existsSync(CANDIDATES_DIR)) return [];
  const now = Date.now();
  const results: Array<{ score: number; ref: SuggestedRef }> = [];

  for (const f of fs.readdirSync(CANDIDATES_DIR)) {
    if (!f.endsWith(".json") || f.startsWith(".")) continue;
    // Exclude self (currentTopicId is "sha1:xxx", file name is just the hash)
    if (`sha1:${f.replace(".json", "")}` === currentTopicId) continue;
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(CANDIDATES_DIR, f), "utf-8")
      ) as Record<string, unknown>;
      const status = String(raw.status ?? "");
      if (status === "REJECTED" || status === "POTENTIAL_DUPLICATE") continue;
      const c = raw as unknown as Candidate;
      if (c.source_domain === sourceDomain) continue;
      if (now - new Date(c.created_at).getTime() > SUGGEST_WINDOW_MS) continue;
      const overlap = wordOverlap(title, c.title_original);
      if (overlap >= SUGGEST_THRESHOLD) {
        results.push({
          score: overlap,
          ref: {
            role: "complement",
            title: c.title_original,
            source_url: c.source_url,
            source_domain: c.source_domain,
            snippet: c.reason,
            notes: "",
          },
        });
      }
    } catch {}
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((r) => r.ref);
}

// ── image sourcing ─────────────────────────────────────────────────────────

function readImagePolicies(): Map<string, ImagePolicy> {
  const config = readJson<{ sources: Array<{ domain?: string; image_policy?: ImagePolicy }> }>(
    path.join(ROOT, "config", "sources.json"),
    { sources: [] }
  );
  const map = new Map<string, ImagePolicy>();
  for (const s of config.sources) {
    if (s.domain && s.image_policy) map.set(s.domain, s.image_policy);
  }
  return map;
}

function readPressKits(): PressKit[] {
  return readJson<{ companies: PressKit[] }>(
    path.join(ROOT, "config", "press-kits.json"),
    { companies: [] }
  ).companies;
}

// Keywords that uniquely identify a company — a single match is sufficient
const PRESS_KIT_ANCHORS = new Set([
  "SpaceX", "Starlink", "Starship", "Electron", "Neutron", "HASTE",
  "ESA", "Ariane", "Galileo", "Copernicus", "Vega", "Rocket Lab",
  "JAXA", "Hayabusa", "SLIM", "MICHIBIKI",
]);

function matchPressKit(title: string, pressKits: PressKit[]): PressKit | null {
  const terms = new Set(extractTerms(title));
  for (const kit of pressKits) {
    let anchorHits = 0;
    let normalHits = 0;
    for (const kw of kit.match_keywords) {
      const found = kw.includes(" ") ? title.includes(kw) : terms.has(kw);
      if (!found) continue;
      if (PRESS_KIT_ANCHORS.has(kw)) anchorHits++;
      else normalHits++;
    }
    if (anchorHits >= 1 || normalHits >= 2) return kit;
  }
  return null;
}

function selectCuratedImage(title: string, images: CuratedImage[]): CuratedImage {
  const titleLower = title.toLowerCase();
  const tagged = images.filter((img) =>
    img.tags.some((tag) => titleLower.includes(tag.toLowerCase()))
  );
  const pool = tagged.length > 0 ? tagged : images;
  return pool[title.length % pool.length];
}

async function resolveFromPressKit(
  candidate: Candidate,
  kit: PressKit
): Promise<HeroImage | null> {
  if (kit.search_method === "curated" && kit.curated_images?.length) {
    const img = selectCuratedImage(candidate.title_original, kit.curated_images);
    return {
      url: img.url,
      alt: img.alt,
      credit: kit.attribution,
      license: kit.license,
      ...(kit.license_url ? { licenseUrl: kit.license_url } : {}),
      source: kit.name,
      ...(img.source_url ? { sourceUrl: img.source_url } : {}),
    };
  }

  if (kit.search_method === "og_scrape" && kit.og_domain) {
    const domainMatches =
      candidate.source_domain === kit.og_domain ||
      candidate.source_domain.endsWith(`.${kit.og_domain}`);
    if (domainMatches) {
      const ogUrl = await fetchOgImage(candidate.source_url);
      if (ogUrl && isImageUrlValid(ogUrl)) {
        return {
          url: ogUrl,
          alt: candidate.title_original,
          credit: kit.attribution,
          license: kit.license ?? "Press",
          source: kit.name,
          sourceUrl: candidate.source_url,
        };
      }
    }
  }

  return null;
}

function isImageUrlValid(url: string): boolean {
  if (!url.startsWith("http")) return false;
  if (/\b(icon|logo|avatar|thumb|small|16x|32x|64x)\b/i.test(url)) return false;
  return true;
}

// NASA Image Library — only query with terms that actually exist in their archive
const SPACE_KEYWORDS_NASA = new Set([
  "Moon", "Lunar", "Mars", "Martian", "Jupiter", "Saturn", "Asteroid",
  "Solar", "ISS", "Hubble", "Webb", "Telescope", "Orion", "Artemis",
  "Spacecraft", "Astronaut", "Gateway", "Spacewalk",
  // Excluded: Starship/Falcon/Dragon/Starlink — SpaceX terms, handled by press-kits
]);

const NASA_THEME_FALLBACKS: Record<ThemeId, string> = {
  exploration: "rocket launch spacecraft astronaut",
  security: "satellite reconnaissance orbit",
  economy: "commercial launch orbit",
  science: "space telescope nebula galaxy",
};

function buildNasaQuery(title: string): string | null {
  const terms = extractTerms(title).filter((t) => SPACE_KEYWORDS_NASA.has(t));
  if (terms.length >= 2) return terms.slice(0, 3).join(" ");
  if (terms.length === 1) return terms[0];
  return null;
}

async function fetchOgImage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "SPACiAN/1.0 (+https://spacian.news; image-attribution)" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ??
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    const ogUrl = m?.[1] ?? null;
    if (!ogUrl || !ogUrl.startsWith("http")) return null;
    return ogUrl;
  } catch {
    return null;
  }
}

interface NasaApiResponse {
  collection: {
    items: Array<{
      data: Array<{
        title?: string;
        center?: string;
        copyright?: string;
        nasa_id?: string;
        photographer?: string;
      }>;
      links?: Array<{ href: string; rel: string; render?: string }>;
    }>;
  };
}

async function searchNasaImage(query: string): Promise<HeroImage | null> {
  try {
    const params = new URLSearchParams({ q: query, media_type: "image", page_size: "5" });
    const res = await fetch(`https://images-api.nasa.gov/search?${params}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json() as NasaApiResponse;
    const items = data.collection?.items ?? [];

    for (const item of items) {
      const meta = item.data?.[0];
      if (!meta || meta.copyright) continue;
      const thumbUrl = item.links?.find((l) => l.rel === "preview" && l.render === "image")?.href;
      if (!thumbUrl) continue;
      const imageUrl = thumbUrl.replace("~thumb.jpg", "~medium.jpg");
      const center = meta.center ?? "NASA";
      const credit = meta.photographer ? `${meta.photographer} / ${center}` : center;
      return {
        url: imageUrl,
        alt: meta.title ?? query,
        credit,
        license: "Public Domain",
        source: "NASA Image Library",
        sourceUrl: meta.nasa_id
          ? `https://images.nasa.gov/details/${meta.nasa_id}`
          : "https://images.nasa.gov",
      };
    }
    return null;
  } catch {
    return null;
  }
}

const IMAGEN_THEME_PROMPTS: Record<ThemeId, string> = {
  exploration: "futuristic spacecraft approaching a celestial body, deep space background, photorealistic editorial style",
  security: "satellite network orbiting Earth, abstract security grid overlay, dark tones",
  economy: "commercial rocket launching at dawn, industrial scale, editorial photography style",
  science: "deep space telescope view of a colorful nebula, scientific illustration style",
};

async function generateHeroImageWithGemini(
  title: string,
  theme: ThemeId,
  slug: string
): Promise<HeroImage | null> {
  const themePrompt = IMAGEN_THEME_PROMPTS[theme];
  const prompt = `Abstract editorial illustration for a space news article titled: "${title.slice(0, 80)}". ${themePrompt}. Professional, clean composition, no text overlay, no watermarks.`;

  const b64 = await generateImage(prompt);
  if (!b64) return null;

  const imageDir = path.join(PENDING_DIR, "../../../public/generated");
  fs.mkdirSync(imageDir, { recursive: true });
  const filename = `${slug}.jpg`;
  fs.writeFileSync(path.join(imageDir, filename), Buffer.from(b64, "base64"));

  return {
    url: `/generated/${filename}`,
    alt: title,
    credit: "AI illustration",
    license: "AI Generated",
    source: "Gemini Imagen",
    isAiGenerated: true,
  };
}

async function resolveHeroImage(
  candidate: Candidate,
  article: {
    title: string;
    theme: ThemeId;
    blocks: { label: LabelType; content: string }[];
    primaryPersona: PersonaId;
    slug: string;
  },
  imagePolicies: Map<string, ImagePolicy>,
  pressKits: PressKit[]
): Promise<HeroImage | undefined> {
  // 1st: press-kit company match (curated CC0 or og_scrape for own-domain sources)
  const kit = matchPressKit(candidate.title_original, pressKits);
  if (kit) {
    const kitImage = await resolveFromPressKit(candidate, kit);
    if (kitImage) return kitImage;
  }

  // 2nd: og:image for embed-allowed source domains
  const policy = imagePolicies.get(candidate.source_domain);
  if (policy?.og_image_usage === "embed") {
    const ogUrl = await fetchOgImage(candidate.source_url);
    if (ogUrl && isImageUrlValid(ogUrl)) {
      return {
        url: ogUrl,
        alt: article.title,
        credit: policy.attribution ?? candidate.source_domain,
        license: policy.license ?? "Press",
        source: policy.attribution ?? candidate.source_domain,
        sourceUrl: candidate.source_url,
      };
    }
  }

  // 3rd: NASA Image Library — only when title contains specific matching keywords
  const nasaQuery = buildNasaQuery(candidate.title_original);
  if (nasaQuery !== null) {
    const nasaImage = await searchNasaImage(nasaQuery);
    if (nasaImage) return nasaImage;
  }

  // 4th: Gemini Imagen — all articles when no specific image found, non-fatal
  const aiImage = await generateHeroImageWithGemini(article.title, article.theme, article.slug);
  if (aiImage) return aiImage;

  // 5th: NASA theme fallback — last resort generic image
  const fallbackImage = await searchNasaImage(NASA_THEME_FALLBACKS[article.theme]);
  if (fallbackImage) return fallbackImage;

  return undefined;
}

// ── Four vocab ────────────────────────────────────────────────────────────

function extractTerms(text: string): string[] {
  const acronyms = text.match(/\b[A-Z]{2,}\b/g) ?? [];
  const properNouns = text.match(/\b[A-Z][a-z]{1,}(?:\s[A-Z][a-z]{1,})*\b/g) ?? [];
  const all = [...acronyms, ...properNouns];
  return [...new Set(all.filter((t) => !TERM_STOPLIST.has(t)))];
}

function loadVocab(): VocabData {
  return readJson<VocabData>(VOCAB_PATH, { terms: {}, updatedAt: "" });
}

function monthRetentionCutoff(keepMonths: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - keepMonths);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function updateVocab(terms: string[], dateStr: string): void {
  const vocab = loadVocab();
  const monthKey = dateStr.slice(0, 7); // "2026-06"

  for (const term of terms) {
    const entry = vocab.terms[term];
    if (entry) {
      entry.count++;
      entry.lastSeen = dateStr;
      entry.months ??= {};
      entry.months[monthKey] = (entry.months[monthKey] ?? 0) + 1;
    } else {
      vocab.terms[term] = { count: 1, lastSeen: dateStr, months: { [monthKey]: 1 } };
    }
  }

  // Retention: drop month buckets older than 24 months
  const cutoff = monthRetentionCutoff(24);
  for (const entry of Object.values(vocab.terms)) {
    if (entry.months) {
      for (const key of Object.keys(entry.months)) {
        if (key < cutoff) delete entry.months[key];
      }
    }
  }

  vocab.updatedAt = new Date().toISOString();
  fs.writeFileSync(VOCAB_PATH, JSON.stringify(vocab, null, 2) + "\n", "utf-8");
}

function getTierLabel(count: number): 0 | 1 | 2 | 3 {
  if (count >= 7) return 3;
  if (count >= 4) return 2;
  if (count >= 2) return 1;
  return 0;
}

interface VocabTiers {
  tier1: string[];
  tier2: string[];
  tier3: string[];
}

function computeTiers(terms: string[], vocab: VocabData): VocabTiers {
  const tiers: VocabTiers = { tier1: [], tier2: [], tier3: [] };
  for (const term of terms) {
    const count = vocab.terms[term]?.count ?? 0;
    const tier = getTierLabel(count);
    if (tier === 1) tiers.tier1.push(term);
    else if (tier === 2) tiers.tier2.push(term);
    else if (tier === 3) tiers.tier3.push(term);
  }
  return tiers;
}

// ── Article validation ────────────────────────────────────────────────────

const REQUIRED_TOP_LEVEL = ["slug", "title", "subtitle", "blocks", "sources", "hashtags"];
const EMBEDDED_FIELD_KEYS = ["sources", "hashtags", "satellites", "spectrumSatIds"];

function validateArticle(article: Record<string, unknown>, slug: string): void {
  for (const field of REQUIRED_TOP_LEVEL) {
    if (!(field in article)) {
      throw new Error(`生成記事に必須フィールド "${field}" がない (slug: ${slug})`);
    }
  }
  const blocks = article.blocks;
  if (Array.isArray(blocks)) {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (typeof block === "object" && block !== null) {
        for (const field of EMBEDDED_FIELD_KEYS) {
          if (field in (block as Record<string, unknown>)) {
            throw new Error(`blocks[${i}] に "${field}" が埋め込まれている — top-levelに移動が必要 (slug: ${slug})`);
          }
        }
      }
    }
  }
}

// ── Gemini prompt（article-template-dispatch.md §Gemini生成プロンプト）────

function buildTierSection(tiers: VocabTiers): string {
  if (!tiers.tier1.length && !tiers.tier2.length && !tiers.tier3.length) return "";
  const lines: string[] = [
    "Fourの既知用語（過去記事での出現回数に基づく記憶）:",
  ];
  if (tiers.tier3.length) lines.push(`  - tier3（お馴染み）: ${tiers.tier3.join(", ")}`);
  if (tiers.tier2.length) lines.push(`  - tier2（最近よく出る）: ${tiers.tier2.join(", ")}`);
  if (tiers.tier1.length) lines.push(`  - tier1（聞いたことある）: ${tiers.tier1.join(", ")}`);
  lines.push(
    "  ※ 記事中にこれらの用語が出てきた場合、Fourはtierに応じた反応をする。",
    '  tier3: 「また○○ね」「お馴染みの○○か」「○○はもう慣れた」',
    '  tier2: 「最近○○ってよく出てくる」「また○○の話か」',
    '  tier1: 「○○って聞いたことある」「なるほど、○○ってことか」',
    '  tier0（初出の用語）: 「○○って何？」（通常通り質問する）',
  );
  return lines.join("\n");
}

const REFERENCE_ROLE_LABELS: Record<SelectedReference["role"], string> = {
  support:    "補強 — データ・事実の追加",
  complement: "補完 — 異なる視点を加える",
  critique:   "批判的視点 — 反論・不確実性を扱う",
};

function buildReferencesSection(refs: SelectedReference[]): string {
  if (!refs.length) return "";

  const blocks = refs.map((ref, i) => {
    const roleLabel = REFERENCE_ROLE_LABELS[ref.role];
    const lines = [
      `【参照記事${i + 1}】（${roleLabel}）`,
      `タイトル: ${ref.title}`,
      `URL: ${ref.source_url}`,
      `スニペット: ${ref.snippet || "（取得不可）"}`,
    ];
    if (ref.notes) lines.push(`編集メモ: ${ref.notes}`);
    return lines.join("\n");
  }).join("\n\n");

  return `---
【マルチソースモード】
以下の参照記事を活用して、単なる要約でなく複数視点を統合した独自分析を作成してください。

- facts ブロック: メイン記事の事実を中心に、補強参照のデータで裏付けを加える
- analysis ブロック: 補完参照の視点を取り込み、SPACiAN独自の分析を展開する
- note ブロック: 批判的視点参照の反論・不確実性を正面から扱う（「〇〇によれば△△」と明示）
- 参照記事を引用するときは「〇〇によれば」と出典を明示すること

${blocks}
---`;
}

function getEffectiveRefs(candidate: Candidate): SelectedReference[] {
  if (candidate.selected_references?.length) return candidate.selected_references;
  return (candidate.suggested_references ?? []) as SelectedReference[];
}

function buildSourcesTemplate(candidate: Candidate, refs: SelectedReference[]): string {
  const lines = [
    `  - label: "${candidate.source_domain}: ${candidate.title_original.slice(0, 50)}"`,
    `    url: "${candidate.source_url}"`,
    ...refs.map((ref) =>
      `  - label: "${ref.source_domain}: ${ref.title.slice(0, 50)}"\n    url: "${ref.source_url}"`
    ),
  ];
  return lines.join("\n");
}

function buildPrompt(candidate: Candidate, snippet: string | undefined, vocabTiers: VocabTiers): string {
  const main = candidate.main_reporter;
  const co = candidate.co_reporter;
  const angle = candidate.scores_json.personas[main]?.angle ?? candidate.reason;
  const now = new Date();
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  // dialogueExpert: the non-Four participant. null when Four is solo main (→ skip dialogue).
  const dialogueExpert: PersonaId | null = main === "four" ? co : main;
  const tierSection = dialogueExpert ? buildTierSection(vocabTiers) : "";
  const foursDialogueSection = !dialogueExpert
    ? `foursDialogue: []`
    : main === "four"
    ? `foursDialogue: Fourと${dialogueExpert}による対談（Four = 説明・導入、${dialogueExpert} = 質問・反応）。
  - 配列の要素: { "speaker": "four" または "${dialogueExpert}", "text": 発言内容 }
  - Fourの発言から始める
  - 5〜7往復
  - Fourのキャラクター: ${PERSONA_VOICES["four"]}
  - ${dialogueExpert}のキャラクター: ${PERSONA_VOICES[dialogueExpert]}
  - 記事のblocksに基づく内容のみ（hallucination禁止）
  - 文体は全員常体（だ・である調）
  - 呼称: 互いにニックネーム呼び捨て（Four、${PERSONA_NICKNAMES[dialogueExpert]}）
  - 専門用語が出てきたら、${dialogueExpert}が素朴な疑問として聞くこともある
  - 対談全体の読解レベル: 中学生でも要点が分かる平易さを目指す。${dialogueExpert}の説明もFourに向けて噛み砕いた言葉で行う（Fourのキャラクターは維持する）
  - その他、${dialogueExpert}がしそうな質問
  ${tierSection}
  例（形式のみ、内容は記事に基づくこと）:
  [
    { "speaker": "four", "text": "今回の件だが..." },
    { "speaker": "${dialogueExpert}", "text": "それって何？" },
    { "speaker": "four", "text": "..." },
    { "speaker": "${dialogueExpert}", "text": "..." }
  ]`
    : `foursDialogue: ${dialogueExpert}とFourによる対談（${dialogueExpert} = 説明・導入、Four = 質問・反応）。
  - 配列の要素: { "speaker": "${dialogueExpert}" または "four", "text": 発言内容 }
  - ${dialogueExpert}の発言から始める
  - 5〜7往復
  - ${dialogueExpert}のキャラクター: ${PERSONA_VOICES[dialogueExpert]}
  - Fourのキャラクター: ${PERSONA_VOICES["four"]}
  - 記事のblocksに基づく内容のみ（hallucination禁止）
  - 文体は全員常体（だ・である調）
  - 呼称: 互いにニックネーム呼び捨て（${PERSONA_NICKNAMES[dialogueExpert]}、Four）
  - 専門用語が出てきたら、Fourが素朴な疑問として聞くこともある
  - 対談全体の読解レベル: 中学生でも要点が分かる平易さを目指す。${dialogueExpert}の説明もFourに向けて噛み砕いた言葉で行う（Fourのキャラクターは維持する）
  - その他、Fourがしそうな質問
  ${tierSection}
  例（形式のみ、内容は記事に基づくこと）:
  [
    { "speaker": "${dialogueExpert}", "text": "今回の件だが..." },
    { "speaker": "four", "text": "それって何？" },
    { "speaker": "${dialogueExpert}", "text": "..." },
    { "speaker": "four", "text": "..." }
  ]`;

  const refs = getEffectiveRefs(candidate);
  const referencesSection = buildReferencesSection(refs);
  const sourcesTemplate = buildSourcesTemplate(candidate, refs);

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

${referencesSection}
【出力形式】
以下のJSONフィールドをすべて日本語で生成してください。

title: 45字以内。主語＋事実＋変化点。

subtitle: 3行を改行（\\n）で区切る。
  1行目（20〜30字）: 事実 — 何が起きたか
  2行目（20〜30字）: 重要性 — なぜ注目されるか
  3行目（20〜30字）: 視点 — 今後どこを見るべきか

blocks:
  - label: "facts"
    content: ニュースの詳細（事実のみ、小見出しは最大3つまで、読了2〜2.5分相当）
             何が起きたか・いつ・誰が・背景・現状を明確に。意見を含めない。
  - label: "analysis"
    content: 解説・視点（${main}の専門角度から。${PERSONA_VOICES[main]} なぜ重要か・示唆・見通し、読了2〜3分相当）
  - label: "note"（必要な場合のみ。不要なら省略）
    content: 留意点・不確実性・反対意見${refs.some((r) => r.role === "critique") ? "\n             ※ 批判的視点参照がある場合、その反論をこのブロックで取り上げること" : ""}

${foursDialogueSection}

sources（メイン記事 + 参照記事をすべて含めること）:
${sourcesTemplate}

hashtags: 記事内容から5〜10個生成。英語・日本語混在可。
  テーマ・組織・技術・地域の軸でカバーする。
  例: ["#Starlink", "#SpaceX", "#衛星通信", "#LEO"]

glossaryTerms: この記事に登場する専門用語のうち、高校生の読者が「何それ？」と思いそうな語を配列で列挙。
  英語略語（LEO・GEO・TLE等）と日本語専門用語の両方を含む。固有名詞・組織名（SpaceX・NASA等）は除く。
  例: ["デブリ", "LEO", "ランデブー", "ペイロード", "ホールマン遷移軌道"]
  該当用語がない場合は [] を出力する。

glossaryDefinitions: glossaryTerms の各用語について定義を生成する。
  キー: 用語名（日本語または英語略語、glossaryTerms と完全一致）
  値: { "slug": "英語スラッグ（小文字ハイフン区切り）", "definition": "1〜2文の定義（高校生向け・日本語）", "aliases": ["別表記・日英対応語"] }
  英語略語の場合: 日本語訳・正式英語名を aliases に含める。例: "LEO" → aliases: ["低軌道", "低地球軌道", "Low Earth Orbit"]
  日本語用語の場合: 英語名・略語を aliases に含める。例: "ランデブー" → aliases: ["rendezvous"]
  表記ゆれも含める。例: "ホールマン遷移軌道" → aliases: ["ホーマン遷移軌道", "Hohmann transfer orbit"]
  aliases が特にない場合は [] を出力する。
  例: {
    "デブリ": { "slug": "debris", "definition": "軌道上を漂う使用済みロケット部品や衛星の残骸。現在70,000個以上が追跡されている。", "aliases": ["space debris", "宇宙ゴミ"] },
    "LEO": { "slug": "leo", "definition": "低軌道（Low Earth Orbit）の略。高度2,000km以下の軌道帯で、ISSやStarlinkはここに位置する。", "aliases": ["低軌道", "低地球軌道", "Low Earth Orbit"] }
  }
  glossaryTerms が空の場合は {} を出力する。

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
- blocks（facts/analysis/note）は高校生が一読して概要を理解できる語彙・説明を心がける。専門用語は初出時に括弧で補足する（例: 「デブリ（軌道上を漂う使用済み機材などの破片）」「LEO（低軌道、高度2000km以下）」）
- blocks（facts/analysis/note）およびfoursDialogueはすべて常体（だ・である調）で統一すること。「です」「ます」は記事全体で使わない
- 読者が次の行動を取れる情報を提供すること
- JSON以外のテキストを出力しないこと`;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const settings = readSettings();

  // Resolve output paths from data_dir setting
  const webDataDir = resolveWebDataDir(settings.data_dir);
  CANDIDATES_DIR = path.join(webDataDir, "candidates");
  PENDING_DIR = path.join(webDataDir, "pending");
  VOCAB_PATH = path.join(webDataDir, "four-vocab.json");
  fs.mkdirSync(PENDING_DIR, { recursive: true });

  const vocab = loadVocab();
  const imagePolicies = readImagePolicies();
  const pressKits = readPressKits();

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

    // Case C: compute suggested_references at generation time if not yet set
    if (!candidate.selected_references?.length && !candidate.suggested_references?.length) {
      const suggested = suggestReferences(
        candidate.title_original,
        candidate.source_domain,
        candidate.topic_id
      );
      if (suggested.length > 0) {
        candidate.suggested_references = suggested;
        fs.writeFileSync(
          file,
          JSON.stringify({ ...candidate, suggested_references: suggested }, null, 2) + "\n",
          "utf-8"
        );
        console.log(`           💡 suggested refs: ${suggested.length}`);
      }
    }

    const originalItem = findOriginalItem(candidate.topic_id);

    try {
      const inputText = `${candidate.title_original} ${originalItem?.snippet ?? ""}`;
      const candidateTerms = extractTerms(inputText);
      const vocabTiers = computeTiers(candidateTerms, vocab);

      const response = await generateJson<GeminiArticleResponse>(
        buildPrompt(candidate, originalItem?.snippet, vocabTiers),
        settings.gemini_model,
        2,
        (usage) => {
          const thinkingPart = usage.thoughtsTokenCount !== undefined
            ? ` thinking:${usage.thoughtsTokenCount}` : "";
          console.log(
            `  [tokens] prompt:${usage.promptTokenCount} out:${usage.candidatesTokenCount}${thinkingPart} total:${usage.totalTokenCount}`
          );
          logEvent({
            event: "generate_token_usage",
            topic_id: candidate.topic_id,
            model: settings.gemini_model,
            prompt_tokens: usage.promptTokenCount,
            candidates_tokens: usage.candidatesTokenCount,
            thoughts_tokens: usage.thoughtsTokenCount,
            total_tokens: usage.totalTokenCount,
          });
        }
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

      // Gemini sometimes embeds foursDialogue and source entries inside blocks[].
      // Normalize: extract them and keep only text blocks with string content.
      const rawBlocks = response.blocks ?? [];
      const textBlocks: { label: LabelType; content: string }[] = [];
      const embeddedDialogue: { speaker: string; text: string }[] = [];
      const embeddedSources: { label: string; url: string }[] = [];
      for (const b of rawBlocks) {
        const bAny = b as Record<string, unknown>;
        if (typeof bAny.url === "string") {
          embeddedSources.push({ label: String(bAny.label ?? ""), url: bAny.url });
        } else if (bAny.label === "foursDialogue" && Array.isArray(bAny.content)) {
          embeddedDialogue.push(...(bAny.content as { speaker: string; text: string }[]));
        } else if (typeof b.content === "string" && (["facts", "analysis", "note"] as string[]).includes(b.label)) {
          textBlocks.push(b as { label: LabelType; content: string });
        }
      }

      const article: PendingArticle = {
        slug,
        title: response.title,
        subtitle: response.subtitle,
        publishedAt: toJST(now),
        readingMinutes: calcReadingMinutes(textBlocks),
        primaryPersona: main,
        ...(co ? { secondaryPersona: co } : {}),
        theme: validateTheme(response.theme),
        blocks: textBlocks,
        foursDialogue: (main === "four" && !co) ? [] : [...(response.foursDialogue ?? []), ...embeddedDialogue],
        hashtags: response.hashtags ?? [],
        satellites: response.satellites ?? [],
        sources: [...(response.sources ?? []), ...embeddedSources],
        glossaryTerms: response.glossaryTerms ?? [],
        glossaryDefinitions: response.glossaryDefinitions ?? {},
        _pipeline: {
          topic_id: candidate.topic_id,
          generated_at: toJST(now),
          gemini_model: settings.gemini_model,
        },
      };

      validateArticle(article as unknown as Record<string, unknown>, slug);

      // Fetch hero image (non-fatal)
      const heroImage = await resolveHeroImage(
        candidate,
        { title: article.title, theme: article.theme, blocks: textBlocks, primaryPersona: main, slug },
        imagePolicies,
        pressKits
      );
      const articleWithImage = heroImage ? { ...article, heroImage } : article;

      if (heroImage) {
        console.log(`  → image:     [${heroImage.source}] ${heroImage.url.slice(0, 60)}`);
      } else {
        console.log(`  → image:     none`);
      }

      fs.writeFileSync(
        path.join(PENDING_DIR, `${slug}.json`),
        JSON.stringify(articleWithImage, null, 2) + "\n",
        "utf-8"
      );

      // Update vocab with terms from the generated article
      const articleText = [article.title, article.subtitle, ...article.blocks.map((b) => b.content)].join(" ");
      const articleTerms = extractTerms(articleText);
      const dateStr = now.toISOString().slice(0, 10);
      updateVocab(articleTerms, dateStr);
      // Refresh vocab in memory so subsequent articles in this run see updated counts
      Object.assign(vocab, loadVocab());

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
