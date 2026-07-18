/**
 * healthcheck-images.ts — HEAD-check all heroImage URLs in dispatch articles.
 * Reports 4xx/5xx failures to stdout and sends email via mailer.ts when any are found.
 *
 * Usage:
 *   npm run healthcheck-images
 *   npm run healthcheck-images -- --dry-run   (skip email, print only)
 *
 * Recommended: add to server crontab as weekly check, e.g.
 *   0 9 * * 1  cd /home/bitnami/spacian-pipeline && npm run healthcheck-images >> data/healthcheck.log 2>&1
 */
import fs from "fs";
import path from "path";
import nodemailer from "nodemailer";

// ── config ─────────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const WEB_ROOT = path.resolve(ROOT, "../spacian-web");
const DISPATCH_DIR = path.join(WEB_ROOT, "src/data/dispatch");
const DRY_RUN = process.argv.includes("--dry-run");

// 5 seconds per URL, max 8 concurrent
const TIMEOUT_MS = 5000;
const CONCURRENCY = 8;

// ── types ──────────────────────────────────────────────────────────────────

interface HeroImage {
  url: string;
  source: string;
}

interface DispatchArticle {
  slug: string;
  title: string;
  heroImage?: HeroImage;
  status?: string;
}

interface CheckResult {
  slug: string;
  title: string;
  source: string;
  url: string;
  status: number | "timeout" | "error";
  ok: boolean;
}

// ── helpers ────────────────────────────────────────────────────────────────

async function headUrl(url: string): Promise<{ status: number | "timeout" | "error" }> {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": "SPACiAN/1.0 (+https://spacian.news; health-check)" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
    });
    return { status: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("timeout") || msg.includes("TimeoutError") || msg.includes("AbortError")) {
      return { status: "timeout" };
    }
    return { status: "error" };
  }
}

async function runConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

// ── mailer ─────────────────────────────────────────────────────────────────

async function sendHealthReport(failures: CheckResult[]): Promise<void> {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.log("[healthcheck] GMAIL credentials not set, skipping email");
    return;
  }
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  const lines = failures.map((f) =>
    `  [${f.status}] ${f.source}\n    ${f.slug}\n    ${f.url}`
  );

  const body = [
    `${failures.length}件の公開記事でheroImage URLが壊れています。`,
    "",
    "確認: /editor/published から画像差し替えを行ってください。",
    "",
    ...lines,
  ].join("\n");

  try {
    await transporter.sendMail({
      from: `SPACiAN Pipeline <${process.env.GMAIL_USER}>`,
      to: process.env.EDITOR_EMAIL,
      subject: `[SPACiAN] heroImage障害 ${failures.length}件`,
      text: body,
    });
    console.log(`[healthcheck] alert email sent (${failures.length} failures)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[healthcheck] email send failed: ${msg.slice(0, 100)}`);
  }
}

// ── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!fs.existsSync(DISPATCH_DIR)) {
    console.log("[healthcheck] dispatch dir not found, nothing to do.");
    return;
  }

  const files = fs
    .readdirSync(DISPATCH_DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."));

  const articles: DispatchArticle[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(DISPATCH_DIR, file), "utf-8");
      const a = JSON.parse(raw) as DispatchArticle;
      if (a.slug && a.heroImage?.url && a.status !== "unpublished") {
        articles.push(a);
      }
    } catch { /* skip malformed */ }
  }

  console.log(`[healthcheck] checking ${articles.length} articles with heroImage...`);
  const started = Date.now();

  const results = await runConcurrent(articles, CONCURRENCY, async (a) => {
    const url = a.heroImage!.url;
    // Skip local/generated images (served from our own server)
    if (url.startsWith("/")) {
      return { slug: a.slug, title: a.title, source: a.heroImage!.source, url, status: 200, ok: true } as CheckResult;
    }
    const { status } = await headUrl(url);
    const ok = typeof status === "number" && status >= 200 && status < 400;
    if (!ok) {
      console.log(`  [${status}] ${a.slug} — ${url.slice(0, 80)}`);
    }
    return { slug: a.slug, title: a.title, source: a.heroImage!.source, url, status, ok } as CheckResult;
  });

  const failures = results.filter((r) => !r.ok);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\n[healthcheck] done in ${elapsed}s — ${results.length} checked, ${failures.length} failed`);

  if (failures.length === 0) {
    console.log("[healthcheck] all heroImage URLs OK");
    return;
  }

  console.log("\n=== Failures ===");
  for (const f of failures) {
    console.log(`  [${f.status}] ${f.source} — ${f.slug}`);
    console.log(`    ${f.url}`);
  }

  if (!DRY_RUN) {
    await sendHealthReport(failures);
  } else {
    console.log("\n[healthcheck] DRY RUN — email skipped");
  }
}

main().catch((err) => {
  console.error("[healthcheck] fatal:", err);
  process.exit(1);
});
