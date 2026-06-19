/**
 * init-vocab.ts — 既存記事（pending/ + dispatch/）から four-vocab.json を初期生成する。
 * 初回のみ実行: npx tsx --env-file=.env scripts/init-vocab.ts
 */

import fs from "fs";
import path from "path";

interface Settings {
  data_dir?: string;
}

interface VocabEntry {
  count: number;
  lastSeen: string;
}

interface VocabData {
  terms: Record<string, VocabEntry>;
  updatedAt: string;
}

interface ArticleBlock {
  content?: string;
}

interface Article {
  title?: string;
  subtitle?: string;
  blocks?: ArticleBlock[];
  publishedAt?: string;
}

const ROOT = process.cwd();

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

function extractTerms(text: string): string[] {
  const acronyms = text.match(/\b[A-Z]{2,}\b/g) ?? [];
  const properNouns = text.match(/\b[A-Z][a-z]{1,}(?:\s[A-Z][a-z]{1,})*\b/g) ?? [];
  const all = [...acronyms, ...properNouns];
  return [...new Set(all.filter((t) => !TERM_STOPLIST.has(t)))];
}

function readSettings(): Settings {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "config", "settings.json"), "utf-8"));
  } catch {
    return {};
  }
}

function resolveWebDataDir(dataDirSetting?: string): string {
  if (dataDirSetting) return path.resolve(ROOT, dataDirSetting);
  return path.join(ROOT, "data");
}

function processDir(dir: string, vocab: VocabData): number {
  if (!fs.existsSync(dir)) return 0;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("."));
  let count = 0;
  for (const f of files) {
    try {
      const article = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as Article;
      const dateStr = article.publishedAt?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
      const text = [
        article.title ?? "",
        article.subtitle ?? "",
        ...(article.blocks ?? []).map((b) => b.content ?? ""),
      ].join(" ");
      const terms = extractTerms(text);
      for (const term of terms) {
        const entry = vocab.terms[term];
        if (entry) {
          entry.count++;
          if (dateStr > entry.lastSeen) entry.lastSeen = dateStr;
        } else {
          vocab.terms[term] = { count: 1, lastSeen: dateStr };
        }
      }
      count++;
    } catch {
      // skip malformed files
    }
  }
  return count;
}

function main() {
  const settings = readSettings();
  const webDataDir = resolveWebDataDir(settings.data_dir);
  const vocabPath = path.join(webDataDir, "four-vocab.json");

  if (fs.existsSync(vocabPath)) {
    console.log(`[init-vocab] ${vocabPath} already exists — overwriting.`);
  }

  const vocab: VocabData = { terms: {}, updatedAt: "" };

  const pendingDir = path.join(webDataDir, "pending");
  const dispatchDir = path.join(webDataDir, "dispatch");

  const pendingCount = processDir(pendingDir, vocab);
  const dispatchCount = processDir(dispatchDir, vocab);

  vocab.updatedAt = new Date().toISOString();
  fs.writeFileSync(vocabPath, JSON.stringify(vocab, null, 2) + "\n", "utf-8");

  const termCount = Object.keys(vocab.terms).length;
  console.log(`[init-vocab] processed ${pendingCount} pending + ${dispatchCount} dispatch articles`);
  console.log(`[init-vocab] ${termCount} unique terms extracted → ${vocabPath}`);

  // Top 10 preview
  const top10 = Object.entries(vocab.terms)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10);
  console.log("[init-vocab] top 10 terms:");
  for (const [term, entry] of top10) {
    console.log(`  ${term.padEnd(24)} ${entry.count}`);
  }
}

main();
