import crypto from "crypto";

const STRIP_PARAMS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid",
];

export function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }

  // http → https
  if (url.protocol === "http:") url.protocol = "https:";

  // Remove tracking params (explicit list + any utm_* wildcard)
  for (const key of [...url.searchParams.keys()]) {
    if (STRIP_PARAMS.includes(key) || key.startsWith("utm_")) {
      url.searchParams.delete(key);
    }
  }

  // Remove fragment
  url.hash = "";

  // Remove trailing slash from non-root paths
  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString();
}

export function makeItemId(urlNormalized: string): string {
  return crypto.createHash("sha1").update(urlNormalized).digest("hex");
}

export interface NormalizedItem {
  item_id: string;
  collected_at: string;
  published_at?: string;
  title_original: string;
  snippet?: string;
  url_original: string;
  url_normalized: string;
  domain: string;
  lane: "rss" | "gnews_rss" | "json" | "manual";
  source_id: string;
  language_hint?: string;
}

interface RawFeedItem {
  title?: string;
  link?: string;
  contentSnippet?: string;
  content?: string;
  isoDate?: string;
  pubDate?: string;
}

export function toNormalizedItem(
  raw: RawFeedItem,
  sourceId: string,
  lane: NormalizedItem["lane"],
  languageHint = "en"
): NormalizedItem | null {
  const urlOriginal = raw.link?.trim();
  if (!urlOriginal || !raw.title?.trim()) return null;

  const urlNormalized = normalizeUrl(urlOriginal);
  const itemId = makeItemId(urlNormalized);

  let domain = "";
  try {
    domain = new URL(urlNormalized).hostname;
  } catch {
    // unparseable — leave empty
  }

  const snippet = (raw.contentSnippet || raw.content?.replace(/<[^>]+>/g, "") || "")
    .trim()
    .slice(0, 300) || undefined;

  return {
    item_id: itemId,
    collected_at: new Date().toISOString(),
    published_at: raw.isoDate ?? raw.pubDate ?? undefined,
    title_original: raw.title.trim(),
    snippet,
    url_original: urlOriginal,
    url_normalized: urlNormalized,
    domain,
    lane,
    source_id: sourceId,
    language_hint: languageHint,
  };
}
