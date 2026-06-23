import fs from "fs";
import path from "path";
import { execSync } from "child_process";

// ── types ──────────────────────────────────────────────────────────────────

interface Settings {
  data_dir?: string;
}

interface PublishedIndex {
  [topicId: string]: { slug: string; published_at: string };
}

// ── constants ──────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const PIPELINE_DATA_DIR = path.join(ROOT, "data");
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
  return readJson<Settings>(path.join(ROOT, "config", "settings.json"), {});
}

function resolveWebDataDir(dataDirSetting?: string): string {
  if (dataDirSetting) return path.resolve(ROOT, dataDirSetting);
  return PIPELINE_DATA_DIR;
}

function loadEnvValue(key: string): string | undefined {
  try {
    const envPath = path.join(ROOT, ".env");
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const eqIdx = trimmed.indexOf("=");
      const k = trimmed.slice(0, eqIdx).trim();
      const v = trimmed.slice(eqIdx + 1).trim();
      if (k === key) return v;
    }
  } catch {}
  return process.env[key];
}

function logEvent(event: Record<string, unknown>): void {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const logPath = path.join(LOGS_DIR, `${today}.jsonl`);
  fs.appendFileSync(
    logPath,
    JSON.stringify({ ...event, ts: new Date().toISOString() }) + "\n"
  );
}

// ── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const settings = readSettings();
  const webDataDir = resolveWebDataDir(settings.data_dir);
  const webRoot = path.resolve(webDataDir, "../..");
  const skipGitPush = loadEnvValue("SKIP_GIT_PUSH") === "1";

  const APPROVED_DIR = path.join(webDataDir, "approved");
  const DISPATCH_DIR = path.join(webDataDir, "dispatch");
  const PUBLISHED_DIR = path.join(PIPELINE_DATA_DIR, "published");
  const PUBLISHED_INDEX_PATH = path.join(PIPELINE_DATA_DIR, "published_index.json");

  fs.mkdirSync(APPROVED_DIR, { recursive: true });
  fs.mkdirSync(DISPATCH_DIR, { recursive: true });
  fs.mkdirSync(PUBLISHED_DIR, { recursive: true });

  const publishedIndex = readJson<PublishedIndex>(PUBLISHED_INDEX_PATH, {});

  const files = fs
    .readdirSync(APPROVED_DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."));

  console.log(`[publish] ${files.length} file(s) in approved/`);
  if (files.length === 0) {
    console.log("[publish] nothing to publish.");
    return;
  }

  logEvent({ event: "publish_start", count: files.length });

  const published: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const file of files) {
    const approvedPath = path.join(APPROVED_DIR, file);
    let raw: Record<string, unknown>;

    try {
      raw = JSON.parse(fs.readFileSync(approvedPath, "utf-8")) as Record<string, unknown>;
    } catch {
      console.error(`  [ERR] ${file}: JSON parse failed`);
      failed.push(file);
      continue;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _pipeline, ...article } = raw;
    const pipeline = _pipeline as { topic_id?: string } | undefined;
    const topicId = pipeline?.topic_id ?? "";
    const slug =
      typeof article.slug === "string" ? article.slug : file.replace(".json", "");

    // Double-publish prevention
    if (publishedIndex[topicId]) {
      console.log(
        `  [SKIP] ${slug} — already published (topic_id: ${topicId})`
      );
      // Still clean up approved/ so it doesn't accumulate stale files
      try { fs.unlinkSync(approvedPath); } catch {}
      skipped.push(slug);
      continue;
    }

    const dispatchPath = path.join(DISPATCH_DIR, `${slug}.json`);

    try {
      fs.writeFileSync(
        dispatchPath,
        JSON.stringify(article, null, 2) + "\n",
        "utf-8"
      );

      // Archive to pipeline/data/published/ (keep original with _pipeline for audit)
      fs.copyFileSync(approvedPath, path.join(PUBLISHED_DIR, file));
      fs.unlinkSync(approvedPath);

      // Update published_index
      publishedIndex[topicId] = {
        slug,
        published_at: new Date().toISOString(),
      };

      published.push(slug);
      console.log(`  [OK]  ${slug}`);

      logEvent({
        event: "publish_ok",
        slug,
        topic_id: topicId,
        skip_git: skipGitPush,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [ERR] ${slug}: ${msg.slice(0, 100)}`);
      // Rollback dispatch file if written
      try {
        fs.unlinkSync(dispatchPath);
      } catch {}
      failed.push(slug);
      logEvent({ event: "publish_error", slug, error: msg });
    }
  }

  // Persist published index
  fs.writeFileSync(
    PUBLISHED_INDEX_PATH,
    JSON.stringify(publishedIndex, null, 2) + "\n",
    "utf-8"
  );

  // Git operations
  if (published.length > 0) {
    if (skipGitPush) {
      console.log(
        `\n[publish] SKIP_GIT_PUSH=1 — git operations skipped (${published.length} file(s) written to dispatch/)`
      );
    } else {
      try {
        const relPaths = published
          .map((s) => `"src/data/dispatch/${s}.json"`)
          .join(" ");
        execSync(`git add ${relPaths}`, { cwd: webRoot, stdio: "pipe" });
        const commitMsg =
          published.length === 1
            ? `publish: ${published[0]}`
            : `publish: ${published.join(", ")}`;
        execSync(`git commit -m "${commitMsg}"`, {
          cwd: webRoot,
          stdio: "pipe",
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "SPACiAN Pipeline",
            GIT_AUTHOR_EMAIL: "pipeline@spacian.news",
            GIT_COMMITTER_NAME: "SPACiAN Pipeline",
            GIT_COMMITTER_EMAIL: "pipeline@spacian.news",
          },
        });
        execSync("git push origin main", { cwd: webRoot, stdio: "pipe" });
        console.log(
          `\n[publish] git push OK — ${published.length} article(s) live`
        );
        logEvent({ event: "publish_git_ok", slugs: published });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`\n[publish] git error: ${msg.slice(0, 200)}`);
        logEvent({ event: "publish_git_error", error: msg });
      }
    }
  }

  logEvent({ event: "publish_done", published, skipped, failed });
  console.log(
    `\n[publish] done — ${published.length} published, ${skipped.length} skipped, ${failed.length} failed`
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
