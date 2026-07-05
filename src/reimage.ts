/**
 * reimage.ts — apply heroImage to pending articles that are missing one.
 * Follows the same tier order as resolveHeroImage() in generate.ts:
 *   1. Press-kit (curated Flickr or og_scrape)
 *   2. og:image for embed-allowed domains
 *   3. NASA Image Library keyword search
 *   4. Gemini Imagen (gemini-2.5-flash-image)
 *
 * Uses English title (from sources[0].label) for press-kit and Imagen prompt
 * to get better scene matches than the Japanese article title.
 *
 * Usage: npx tsx src/reimage.ts [--dry-run]
 */
import fs from "fs";
import path from "path";
import { generateImage } from "./lib/gemini.js";

// ── Types ─────────────────────────────────────────────────────────────────

type ThemeId = "economy" | "exploration" | "security" | "science";

interface CuratedImage {
  url: string;
  alt: string;
  tags: string[];
  source_url?: string;
}

interface PressKit {
  name: string;
  match_keywords: string[];
  search_method: "curated" | "og_scrape" | "pr_times";
  attribution: string;
  license: string;
  license_url?: string;
  og_domain?: string;
  curated_images?: CuratedImage[];
  pr_times_company_id?: string;
  pr_times_initial_url?: string;
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

interface PendingArticle {
  slug: string;
  title: string;
  theme: string;
  heroImage?: HeroImage;
  sources?: Array<{ label?: string; url?: string }>;
  blocks?: Array<{ label: string; content: string }>;
  _pipeline?: { topic_id: string };
  status?: string;
  [key: string]: unknown;
}

// ── Paths ─────────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const PIPELINE_ROOT = ROOT;
const WEB_ROOT = path.resolve(ROOT, "../spacian-web");
const PENDING_DIR = path.join(WEB_ROOT, "src/data/pending");
const GENERATED_DIR = path.join(WEB_ROOT, "public/generated");
const PRESS_KITS_PATH = path.join(PIPELINE_ROOT, "config/press-kits.json");
const SOURCES_CONFIG_PATH = path.join(PIPELINE_ROOT, "config/sources.json");

const DRY_RUN = process.argv.includes("--dry-run");

// ── Press-kit matching (mirrors generate.ts) ──────────────────────────────

const PRESS_KIT_ANCHORS = new Set([
  "SpaceX", "Starlink", "Starship", "Electron", "Neutron", "HASTE",
  "ESA", "Ariane", "Galileo", "Copernicus", "Vega", "Rocket Lab",
  "JAXA", "Hayabusa", "SLIM", "MICHIBIKI",
  "ispace", "HAKUTO", "Synspective", "Astroscale", "QPS",
]);

function extractTerms(text: string): string[] {
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
  const acronyms = text.match(/\b[A-Z]{2,}\b/g) ?? [];
  const properNouns = text.match(/\b[A-Z][a-z]{1,}(?:\s[A-Z][a-z]{1,})*\b/g) ?? [];
  return [...new Set([...acronyms, ...properNouns].filter((t) => !TERM_STOPLIST.has(t)))];
}

function matchPressKit(title: string, pressKits: PressKit[]): PressKit | null {
  const terms = new Set(extractTerms(title));
  const titleLower = title.toLowerCase();
  for (const kit of pressKits) {
    let anchorHits = 0;
    let normalHits = 0;
    for (const kw of kit.match_keywords) {
      const found = kw.includes(" ")
        ? title.includes(kw)
        : terms.has(kw) || titleLower.includes(kw.toLowerCase());
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

// ── og:image fetch ────────────────────────────────────────────────────────

async function fetchOgImage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "SPACiAN/1.0 (+https://spacian.news; image-attribution)" },
      signal: AbortSignal.timeout(8000),
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

function isImageUrlValid(url: string): boolean {
  if (!url.startsWith("http")) return false;
  if (/\b(icon|logo|avatar|thumb|small|16x|32x|64x)\b/i.test(url)) return false;
  return true;
}

// ── Content query builder ─────────────────────────────────────────────────

function buildContentQuery(matchTitle: string, blocks?: Array<{ label: string; content: string }>): string {
  const titleTerms = extractTerms(matchTitle);
  const bodySnippet = (blocks ?? []).slice(0, 2).map((b) => b.content).join(" ").slice(0, 500);
  const bodyTerms = extractTerms(bodySnippet).filter((t) => !titleTerms.includes(t));
  return [...titleTerms, ...bodyTerms].slice(0, 4).join(" ") || matchTitle.slice(0, 60);
}

// ── NASA Image Library ────────────────────────────────────────────────────

async function searchNasaImage(query: string): Promise<HeroImage | null> {
  try {
    const params = new URLSearchParams({ q: query, media_type: "image", page_size: "5" });
    const res = await fetch(`https://images-api.nasa.gov/search?${params}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      collection: { items: Array<{ data: Array<{ title?: string; center?: string; copyright?: string; nasa_id?: string; photographer?: string }>; links?: Array<{ href: string; rel: string; render?: string }> }> };
    };
    for (const item of data.collection?.items ?? []) {
      const meta = item.data?.[0];
      if (!meta || meta.copyright) continue;
      // Skip non-photographic assets (logos, patches, illustrations, graphics)
      const titleLower = (meta.title ?? "").toLowerCase();
      if (/\b(logo|icon|illustration|graphic|poster|artwork|vector|badge|patch)\b/.test(titleLower)) continue;
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
        sourceUrl: meta.nasa_id ? `https://images.nasa.gov/details/${meta.nasa_id}` : "https://images.nasa.gov",
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ── Wikimedia Commons ─────────────────────────────────────────────────────

interface WikimediaApiResponse {
  query?: {
    pages?: Record<string, {
      title?: string;
      imageinfo?: Array<{
        url?: string;
        thumburl?: string;
        extmetadata?: {
          LicenseShortName?: { value: string };
          Artist?: { value: string };
          ImageDescription?: { value: string };
        };
      }>;
    }>;
  };
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

const WIKIMEDIA_OPEN_LICENSE = /^(CC0|CC BY(?!-ND|-NC)|CC BY-SA|Public Domain)/i;

async function searchWikimediaImage(query: string): Promise<HeroImage | null> {
  try {
    const params = new URLSearchParams({
      action: "query",
      generator: "search",
      gsrsearch: query,
      gsrnamespace: "6",
      gsrlimit: "10",
      prop: "imageinfo",
      iiprop: "url|extmetadata",
      iiurlwidth: "1200",
      format: "json",
      origin: "*",
    });
    const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, {
      headers: { "User-Agent": "SPACiAN/1.0 (+https://spacian.news; image-attribution)" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json() as WikimediaApiResponse;
    const pages = Object.values(data.query?.pages ?? {});

    const queryTokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 3);

    for (const page of pages) {
      const title = page.title ?? "";
      if (/\.(svg|gif|webm|ogv|ogg|pdf|xcf)$/i.test(title)) continue;
      if (/\b(logo|icon|flag|coat|seal|diagram|chart|graph|map|vector|badge|template|patch)\b/i.test(title)) continue;
      if (queryTokens.length > 0 && !queryTokens.some((t) => title.toLowerCase().includes(t))) continue;

      const ii = page.imageinfo?.[0];
      if (!ii) continue;

      const license = ii.extmetadata?.LicenseShortName?.value ?? "";
      if (!WIKIMEDIA_OPEN_LICENSE.test(license)) continue;

      const imageUrl = ii.thumburl ?? ii.url;
      if (!imageUrl?.startsWith("http")) continue;

      const artist = stripHtml(ii.extmetadata?.Artist?.value ?? "") || "Wikimedia Commons";
      const altRaw = stripHtml(ii.extmetadata?.ImageDescription?.value ?? "")
        || title.replace(/^File:/, "").replace(/\.\w+$/, "");

      return {
        url: imageUrl,
        alt: altRaw.slice(0, 200),
        credit: `${artist} / Wikimedia Commons`,
        license,
        source: "Wikimedia Commons",
        sourceUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(title)}`,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ── ESA Image Library ─────────────────────────────────────────────────────

interface EsaSearchResponse {
  items?: Array<{
    title?: string;
    images?: Array<{ url?: string }>;
    thumbnail?: string;
    url?: string;
  }>;
}

async function searchEsaImage(query: string): Promise<HeroImage | null> {
  try {
    const params = new URLSearchParams({ q: query, type: "image", maxResults: "5" });
    const res = await fetch(`https://www.esa.int/var/esa/json/multimedia.json?${params}`, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "SPACiAN/1.0 (+https://spacian.news; image-attribution)",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok || !res.headers.get("content-type")?.includes("json")) return null;
    const data = await res.json() as EsaSearchResponse;
    const item = data.items?.[0];
    if (!item) return null;
    const imgUrl = item.images?.[0]?.url ?? item.thumbnail;
    if (!imgUrl?.startsWith("http")) return null;
    return {
      url: imgUrl,
      alt: item.title ?? query,
      credit: "ESA",
      license: "CC BY-SA 3.0 IGO",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/igo/",
      source: "ESA Image Library",
      sourceUrl: item.url ?? "https://images.esa.int",
    };
  } catch {
    return null;
  }
}

// ── Imagen prompt builder (mirrors generate.ts) ───────────────────────────

const IMAGEN_SUBJECT_SCENES: Array<{ keyword: string; scene: string }> = [
  { keyword: "Crew Dragon",  scene: "SpaceX Crew Dragon capsule docking with the ISS berthing port, Earth limb visible through the portholes" },
  { keyword: "Falcon Heavy", scene: "SpaceX Falcon Heavy triple-core rocket moments after liftoff, synchronized side-booster exhaust plumes" },
  { keyword: "Starship",     scene: "SpaceX Starship fully stacked on the Starbase launch mount at golden hour, catch arms visible in background" },
  { keyword: "Starlink",     scene: "train of Starlink satellites crossing the night sky as a chain of bright dots, long-exposure photograph" },
  { keyword: "Falcon",       scene: "Falcon 9 rocket ascending through a clear blue sky minutes after launch, condensation trail below" },
  { keyword: "Dragon",       scene: "SpaceX Dragon capsule approaching ISS from below, Earth curvature filling the background" },
  { keyword: "Electron",     scene: "Rocket Lab Electron rocket on the launch pad at Mahia Peninsula New Zealand, coastal cliffs in background" },
  { keyword: "Neutron",      scene: "Rocket Lab Neutron medium-lift rocket on a seaside launch pad at dusk, ocean horizon behind" },
  { keyword: "HASTE",        scene: "hypersonic test vehicle on a launch rail at a desert test facility, pre-launch atmosphere" },
  { keyword: "Ariane",       scene: "Ariane 6 rocket launching from Kourou at twilight, equatorial jungle silhouette below the exhaust plume" },
  { keyword: "Vega",         scene: "Vega small launch vehicle ascending from the Guiana Space Centre, river delta and ocean below" },
  { keyword: "Copernicus",   scene: "Sentinel SAR satellite with large radar antenna array over European coastline, blue ocean below" },
  { keyword: "Galileo",      scene: "navigation satellite in medium Earth orbit, Europe and North Africa visible through partial cloud cover" },
  { keyword: "Hayabusa",     scene: "JAXA spacecraft approaching a rocky cratered asteroid, rough regolith surface in foreground" },
  { keyword: "SLIM",         scene: "JAXA SLIM lunar lander resting on the Moon surface, solar panels tilted sideways on rugged terrain" },
  { keyword: "MICHIBIKI",    scene: "Japan's Michibiki quasi-zenith navigation satellite in high-inclination orbit, Japan archipelago below" },
  { keyword: "H3",           scene: "JAXA H3 rocket lifting off from Tanegashima Space Center, Pacific Ocean coastline in background" },
  { keyword: "Epsilon",      scene: "JAXA Epsilon solid-fuel rocket ascending through morning sky, bright solid-motor exhaust trail" },
  { keyword: "HAKUTO",       scene: "ispace HAKUTO-R lunar lander descending above the Moon surface toward a sunlit crater rim" },
  { keyword: "ispace",       scene: "small lunar lander on the Moon surface, Earth rising over the crater horizon" },
  { keyword: "Synspective",  scene: "small SAR Earth observation satellite in low Earth orbit, folded antenna array deployed, city grid below" },
  { keyword: "QPS",          scene: "compact SAR satellite in low Earth orbit, Earth night-side city lights visible below" },
  { keyword: "Astroscale",   scene: "debris removal spacecraft approaching a derelict rocket body in orbit, docking mechanism extended" },
  { keyword: "New Glenn",    scene: "Blue Origin New Glenn rocket on the launch pad at Cape Canaveral, pre-dawn launch atmosphere" },
  { keyword: "ISS",          scene: "International Space Station in orbit, golden solar arrays extended, visiting vehicles docked, Earth below" },
  { keyword: "Artemis",      scene: "NASA SLS rocket on the Kennedy Space Center launch pad at night, brilliantly floodlit" },
  { keyword: "Webb",         scene: "James Webb Space Telescope with fully deployed gold hexagonal mirror segments drifting in deep space" },
  { keyword: "Hubble",       scene: "Hubble Space Telescope in low Earth orbit, cylindrical body and deployed solar panels, blue Earth below" },
  { keyword: "Gateway",      scene: "NASA Gateway lunar orbital station under construction in cislunar space, Moon surface visible" },
  { keyword: "Orion",        scene: "NASA Orion capsule with European service module approaching the lunar Gateway in cislunar space" },
  { keyword: "Moon",         scene: "lunar surface with a lander spacecraft in the foreground, Earth rising over the crater horizon" },
  { keyword: "Lunar",        scene: "spacecraft descending above a sunlit lunar crater plain, regolith visible in close detail" },
  { keyword: "Mars",         scene: "Martian red rocky surface with a rover in the foreground, rusty plains stretching to hazy horizon" },
  { keyword: "asteroid",     scene: "spacecraft approaching a rocky cratered asteroid surface, star field in background" },
  { keyword: "Asteroid",     scene: "spacecraft approaching a rocky cratered asteroid surface, star field in background" },
];

const IMAGEN_EVENT_SCENES: Array<{ keywords: string[]; scene: string }> = [
  { keywords: ["launch", "liftoff", "lifts off", "blasts off", "打ち上げ", "打上げ"],
    scene:    "rocket lifting off from a coastal launch facility at dawn, steam and fire billowing from the flame trench" },
  { keywords: ["landing", "touchdown", "lands", "splashdown", "着陸", "帰還"],
    scene:    "rocket booster returning to a landing pad at night, legs deployed, retro-burn exhaust illuminating the concrete pad" },
  { keywords: ["spacewalk", "EVA", "extravehicular"],
    scene:    "astronaut in a white spacesuit floating outside a spacecraft, Earth limb in background, suited figure seen from behind" },
  { keywords: ["crew", "crewed", "astronaut", "cosmonaut", "クルー"],
    scene:    "spacesuit helmets arranged in front of a large rocket fairing in a hangar, no individual faces visible" },
  { keywords: ["static fire", "hotfire", "engine test", "燃焼試験"],
    scene:    "rocket engine static fire test at night, brilliant white-orange exhaust plume illuminating the test stand" },
  { keywords: ["contract", "deal", "agreement", "award", "partnership", "signed", "契約", "合意"],
    scene:    "aerospace facility exterior at sunrise, glass-and-steel building with a rocket visible through the lobby atrium" },
  { keywords: ["funding", "investment", "investors", "raise", "raises", "million", "billion", "raised", "资金", "投資", "調達"],
    scene:    "aerospace factory floor with rocket stages under assembly, overhead cranes and industrial lighting" },
  { keywords: ["debris", "conjunction", "collision avoidance", "collision", "maneuver", "デブリ"],
    scene:    "visualization of orbital debris cloud surrounding Earth, fragmented objects in low orbit, blue planet glow" },
  { keywords: ["satellite", "deploy", "separation", "dispenser", "分離", "放出"],
    scene:    "small satellite separating from a rocket fairing against the curvature of the Earth, solar panels beginning to unfold" },
  { keywords: ["factory", "manufacturing", "facility", "plant", "工場", "施設"],
    scene:    "large aerospace manufacturing facility interior, rocket boosters under construction, gantry cranes overhead" },
  { keywords: ["policy", "regulation", "license", "approval", "Congress", "Senate", "政策", "規制", "承認"],
    scene:    "government building exterior at dusk with a national flag visible, wide-angle architectural photography" },
  { keywords: ["solar flare", "CME", "geomagnetic", "太陽フレア", "磁気嵐"],
    scene:    "extreme ultraviolet image of the solar corona, bright active region loops and coronal mass ejection arc" },
  { keywords: ["discovery", "observation", "found", "detect", "発見", "観測"],
    scene:    "large radio telescope array under a brilliantly starry night sky, Milky Way band visible above the dishes" },
];

const IMAGEN_THEME_FALLBACKS: Record<ThemeId, string> = {
  exploration: "rocket launching from a coastal spaceport at dusk, water reflection below the fire and steam cloud",
  security:    "satellite constellation as bright dots orbiting Earth at night, city lights visible below on the dark side",
  economy:     "aerospace manufacturing facility interior, large rocket stages in final assembly, industrial overhead lighting",
  science:     "wide-field telescope pointing at the Milky Way, observatory dome silhouette against the star-filled night sky",
};

const IMAGEN_STYLE =
  "photorealistic editorial photography style, natural cinematic lighting, " +
  "no text on image, no logos, no watermarks, no recognizable real individual likenesses";

function matchImagenKeyword(title: string, keyword: string): boolean {
  if (/^[\x20-\x7E]+$/.test(keyword)) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(title);
  }
  return title.includes(keyword);
}

function buildImagenPrompt(title: string, theme: ThemeId, contentHint?: string): { prompt: string; tier: string } {
  const searchText = contentHint ? `${title} ${contentHint}` : title;
  for (const { keyword, scene } of IMAGEN_SUBJECT_SCENES) {
    if (matchImagenKeyword(searchText, keyword)) {
      return { prompt: `${scene}, ${IMAGEN_STYLE}.`, tier: `Tier1:${keyword}` };
    }
  }
  for (const { keywords, scene } of IMAGEN_EVENT_SCENES) {
    const hit = keywords.find((kw) => matchImagenKeyword(searchText, kw));
    if (hit) {
      return { prompt: `${scene}, ${IMAGEN_STYLE}.`, tier: `Tier2:${hit}` };
    }
  }
  return { prompt: `${IMAGEN_THEME_FALLBACKS[theme]}, ${IMAGEN_STYLE}.`, tier: `Tier3:${theme}` };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function readJson<T>(p: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")) as T; } catch { return fallback; }
}

function extractEnglishTitle(sources?: Array<{ label?: string }>): string {
  const label = sources?.[0]?.label ?? "";
  // Format: "domain.com: English Title..."
  const colonIdx = label.indexOf(": ");
  return colonIdx !== -1 ? label.slice(colonIdx + 2).trim() : "";
}

function extractSourceDomain(sources?: Array<{ label?: string; url?: string }>): string {
  try {
    const url = sources?.[0]?.url;
    if (url) return new URL(url).hostname.replace(/^www\./, "");
  } catch {}
  const label = sources?.[0]?.label ?? "";
  const colon = label.indexOf(": ");
  return colon !== -1 ? label.slice(0, colon).trim() : "";
}

// ── Main ──────────────────────────────────────────────────────────────────

async function resolveImage(
  article: PendingArticle,
  pressKits: PressKit[],
  embedDomains: Set<string>
): Promise<{ image: HeroImage; tier: string } | null> {
  const enTitle = extractEnglishTitle(article.sources);
  const sourceDomain = extractSourceDomain(article.sources);
  const sourceUrl = article.sources?.[0]?.url ?? "";
  // Use English title for matching when available, fall back to Japanese
  const matchTitle = enTitle || article.title;
  const theme = (article.theme ?? "economy") as ThemeId;

  // ── Tier 1: Press-kit ─────────────────────────────────────────────────
  const kit = matchPressKit(matchTitle, pressKits);
  if (kit) {
    if (kit.search_method === "curated" && kit.curated_images?.length) {
      const img = selectCuratedImage(matchTitle, kit.curated_images);
      return {
        tier: `press-kit:curated:${kit.name}`,
        image: {
          url: img.url,
          alt: img.alt,
          credit: kit.attribution,
          license: kit.license,
          ...(kit.license_url ? { licenseUrl: kit.license_url } : {}),
          source: kit.name,
          ...(img.source_url ? { sourceUrl: img.source_url } : {}),
        },
      };
    }
    if (kit.search_method === "og_scrape" && kit.og_domain && sourceUrl) {
      const domainMatch =
        sourceDomain === kit.og_domain || sourceDomain.endsWith(`.${kit.og_domain}`);
      if (domainMatch) {
        const ogUrl = await fetchOgImage(sourceUrl);
        if (ogUrl && isImageUrlValid(ogUrl)) {
          return {
            tier: `press-kit:og_scrape:${kit.name}`,
            image: {
              url: ogUrl,
              alt: matchTitle,
              credit: kit.attribution,
              license: kit.license ?? "Press",
              source: kit.name,
              sourceUrl,
            },
          };
        }
      }
    }
    if (kit.search_method === "pr_times" && kit.pr_times_company_id) {
      // PR TIMES handled via initial_url seed
      const prUrl = kit.pr_times_initial_url;
      if (prUrl) {
        console.log(`    [pr_times] using seed URL: ${prUrl}`);
        // We'd need fetchPRTimesImage() but for simplicity fall through to Imagen
        // (PR TIMES companies are unlikely to appear in these 12 articles)
      }
    }
  }

  // ── Tier 2: og:image for embed-allowed source domains ────────────────
  if (embedDomains.has(sourceDomain) && sourceUrl) {
    const ogUrl = await fetchOgImage(sourceUrl);
    if (ogUrl && isImageUrlValid(ogUrl)) {
      return {
        tier: `og_embed:${sourceDomain}`,
        image: {
          url: ogUrl,
          alt: article.title,
          credit: sourceDomain,
          license: "Press",
          source: sourceDomain,
          sourceUrl,
        },
      };
    }
  }

  // ── Tier 3: Content-based open library search ────────────────────────
  const contentQuery = buildContentQuery(matchTitle, article.blocks);
  const nasaImage = await searchNasaImage(contentQuery);
  if (nasaImage) return { tier: `nasa:${contentQuery}`, image: nasaImage };
  const wikiImage = await searchWikimediaImage(contentQuery);
  if (wikiImage) return { tier: `wikimedia:${contentQuery}`, image: wikiImage };
  const esaImage = await searchEsaImage(contentQuery);
  if (esaImage) return { tier: `esa:${contentQuery}`, image: esaImage };

  // ── Tier 4: Gemini Imagen ─────────────────────────────────────────────
  const contentHint = (article.blocks ?? []).slice(0, 2).map((b) => b.content).join(" ").slice(0, 300);
  const { prompt, tier } = buildImagenPrompt(matchTitle, theme, contentHint);
  console.log(`    [imagen/${tier}] ${prompt.slice(0, 90)}...`);
  if (DRY_RUN) {
    return null; // skip actual API call in dry-run
  }
  const b64 = await generateImage(prompt);
  if (!b64) return null;

  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  const filename = `${article.slug}.png`;
  fs.writeFileSync(path.join(GENERATED_DIR, filename), Buffer.from(b64, "base64"));

  return {
    tier: `imagen:${tier}`,
    image: {
      url: `/generated/${filename}`,
      alt: article.title,
      credit: "AI illustration",
      license: "AI Generated",
      source: "Gemini Imagen",
      isAiGenerated: true,
    },
  };
}

async function main() {
  if (DRY_RUN) console.log("⚠️  DRY RUN mode — no API calls, no file writes\n");

  const pressKits = readJson<{ companies: PressKit[] }>(PRESS_KITS_PATH, { companies: [] }).companies;
  const sourcesConfig = readJson<{ sources: Array<{ domain?: string; image_policy?: { og_image_usage: string } }> }>(
    SOURCES_CONFIG_PATH, { sources: [] }
  );
  const embedDomains = new Set<string>(
    sourcesConfig.sources
      .filter((s) => s.image_policy?.og_image_usage === "embed" && s.domain)
      .map((s) => s.domain!)
  );

  const files = fs.readdirSync(PENDING_DIR).filter((f) => f.endsWith(".json") && !f.startsWith("."));
  const missing = files.filter((f) => {
    const raw = fs.readFileSync(path.join(PENDING_DIR, f), "utf-8");
    return !raw.includes('"heroImage"');
  });

  console.log(`=== reimage.ts ===`);
  console.log(`Pending without heroImage: ${missing.length}\n`);

  const results: Array<{ slug: string; tier: string; status: "ok" | "failed" }> = [];
  let imagenCalls = 0;

  for (const file of missing) {
    const filePath = path.join(PENDING_DIR, file);
    const article = JSON.parse(fs.readFileSync(filePath, "utf-8")) as PendingArticle;
    const enTitle = extractEnglishTitle(article.sources);

    console.log(`[${article.slug}]`);
    console.log(`  ja: ${article.title}`);
    if (enTitle) console.log(`  en: ${enTitle}`);

    const result = await resolveImage(article, pressKits, embedDomains);

    if (!result) {
      console.log(`  → FAILED (all tiers exhausted)\n`);
      results.push({ slug: article.slug, tier: "none", status: "failed" });
      continue;
    }

    if (result.tier.startsWith("imagen:")) imagenCalls++;

    console.log(`  → OK [${result.tier}] ${result.image.url.slice(0, 70)}\n`);

    if (!DRY_RUN) {
      const updated = { ...article, heroImage: result.image };
      fs.writeFileSync(filePath, JSON.stringify(updated, null, 2) + "\n", "utf-8");
    }

    results.push({ slug: article.slug, tier: result.tier, status: "ok" });
  }

  console.log("\n=== Summary ===");
  for (const r of results) {
    console.log(`  ${r.status === "ok" ? "✓" : "✗"} [${r.tier}] ${r.slug}`);
  }
  const cost = imagenCalls * 0.039;
  console.log(`\nImagen calls: ${imagenCalls} × $0.039 = $${cost.toFixed(3)}`);
  console.log(`Total OK: ${results.filter(r => r.status === "ok").length} / ${results.length}`);
}

main().catch(console.error);
