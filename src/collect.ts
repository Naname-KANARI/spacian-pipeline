import fs from "fs";
import path from "path";
import Parser from "rss-parser";
import { toNormalizedItem, type NormalizedItem } from "./lib/normalizer.js";
import {
  readHealth,
  writeHealth,
  getSourceHealth,
  recordSuccess,
  recordFailure,
} from "./lib/health.js";

// ── types ──────────────────────────────────────────────────────────────────

interface Source {
  source_id: string;
  lane: NormalizedItem["lane"];
  name: string;
  url: string;
  enabled: boolean;
  priority: number;
  max_items: number;
  notes: string;
  language_hint?: string;
}

interface Settings {
  fail_disable_threshold: number;
  default_max_items_per_source: number;
}

interface SeenEntry {
  url: string;
  seen_at: string;
}

type SeenIndex = Record<string, SeenEntry>;

// ── paths ──────────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const LOGS_DIR = path.join(ROOT, "logs");
const ITEMS_PATH = path.join(DATA_DIR, "items.jsonl");
const SEEN_PATH = path.join(DATA_DIR, "seen_index.json");

// ── helpers ────────────────────────────────────────────────────────────────

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function readSources(): Source[] {
  const cfg = readJson<{ sources: Source[] }>(
    path.join(ROOT, "config", "sources.json"),
    { sources: [] }
  );
  return cfg.sources;
}

function readSettings(): Settings {
  return readJson<Settings>(path.join(ROOT, "config", "settings.json"), {
    fail_disable_threshold: 3,
    default_max_items_per_source: 25,
  });
}

function readSeenIndex(): SeenIndex {
  return readJson<SeenIndex>(SEEN_PATH, {});
}

function writeSeenIndex(index: SeenIndex): void {
  fs.writeFileSync(SEEN_PATH, JSON.stringify(index, null, 2) + "\n", "utf-8");
}

function appendItems(items: NormalizedItem[]): void {
  const lines = items.map((item) => JSON.stringify(item)).join("\n") + "\n";
  fs.appendFileSync(ITEMS_PATH, lines, "utf-8");
}

function logEvent(event: Record<string, unknown>): void {
  const today = new Date().toISOString().slice(0, 10);
  const logPath = path.join(LOGS_DIR, `${today}.jsonl`);
  const line = JSON.stringify({ ...event, ts: new Date().toISOString() }) + "\n";
  fs.appendFileSync(logPath, line, "utf-8");
}

// ── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const sources = readSources();
  const settings = readSettings();
  const health = readHealth();
  const seen = readSeenIndex();
  const parser = new Parser({ timeout: 15_000 });

  const enabledSources = sources.filter((s) => s.enabled);
  logEvent({ event: "collect_start", source_count: enabledSources.length });
  console.log(`[collect] ${enabledSources.length} sources enabled\n`);

  let totalNew = 0;
  let totalSkipped = 0;

  for (const source of enabledSources) {
    const sh = getSourceHealth(health, source.source_id);
    if (sh.disabled) {
      logEvent({ event: "source_skipped", source_id: source.source_id, reason: "disabled" });
      console.log(`[SKIP] ${source.name} — disabled (${sh.fail_count} consecutive failures)`);
      continue;
    }

    try {
      const feed = await parser.parseURL(source.url);
      recordSuccess(health, source.source_id);

      const maxItems = source.max_items ?? settings.default_max_items_per_source;
      const rawItems = (feed.items ?? []).slice(0, maxItems);
      const newItems: NormalizedItem[] = [];

      for (const raw of rawItems) {
        const item = toNormalizedItem(raw, source.source_id, source.lane, source.language_hint);
        if (!item) continue;

        if (seen[item.item_id]) {
          totalSkipped++;
          continue;
        }

        seen[item.item_id] = { url: item.url_normalized, seen_at: item.collected_at };
        newItems.push(item);
        totalNew++;
      }

      if (newItems.length > 0) appendItems(newItems);

      logEvent({
        event: "source_ok",
        source_id: source.source_id,
        fetched: rawItems.length,
        new_items: newItems.length,
        skipped: rawItems.length - newItems.length,
      });
      console.log(
        `[OK]   ${source.name.padEnd(32)} ${String(newItems.length).padStart(3)} new / ${String(rawItems.length).padStart(3)} fetched`
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      recordFailure(health, source.source_id, errMsg, settings.fail_disable_threshold);
      const failCount = getSourceHealth(health, source.source_id).fail_count;

      logEvent({
        event: "source_error",
        source_id: source.source_id,
        error: errMsg,
        fail_count: failCount,
        auto_disabled: failCount >= settings.fail_disable_threshold,
      });
      console.error(
        `[ERR]  ${source.name.padEnd(32)} ${errMsg.slice(0, 80)}${failCount >= settings.fail_disable_threshold ? " → AUTO-DISABLED" : ""}`
      );
    }
  }

  writeHealth(health);
  writeSeenIndex(seen);

  logEvent({ event: "collect_done", total_new: totalNew, total_skipped: totalSkipped });
  console.log(
    `\n[collect] done — ${totalNew} new items, ${totalSkipped} duplicates skipped`
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
