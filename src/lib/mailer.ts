import fs from "fs";
import path from "path";
import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

// ── credentials guard ──────────────────────────────────────────────────────

function hasCredentials(): boolean {
  return !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

// ── error notification cooldown ────────────────────────────────────────────

const COOLDOWN_FILE = path.join(process.cwd(), "data", "last_error_notified.json");
const ERROR_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

interface CooldownRecord {
  hash: string;
  notified_at: string;
}

function shouldSendError(errKey: string): boolean {
  try {
    const rec = JSON.parse(fs.readFileSync(COOLDOWN_FILE, "utf-8")) as CooldownRecord;
    if (rec.hash === errKey) {
      const elapsed = Date.now() - new Date(rec.notified_at).getTime();
      if (elapsed < ERROR_COOLDOWN_MS) return false;
    }
  } catch { /* first run or file missing */ }
  return true;
}

function recordErrorNotified(errKey: string): void {
  try {
    fs.mkdirSync(path.dirname(COOLDOWN_FILE), { recursive: true });
    fs.writeFileSync(
      COOLDOWN_FILE,
      JSON.stringify({ hash: errKey, notified_at: new Date().toISOString() }, null, 2) + "\n",
      "utf-8"
    );
  } catch { /* non-fatal */ }
}

// ── exports ────────────────────────────────────────────────────────────────

export async function sendScoringNotification(
  count: number,
  editorUrl: string
): Promise<void> {
  if (!hasCredentials()) {
    console.log("[mailer] GMAIL credentials not set, skipping email");
    return;
  }
  try {
    await transporter.sendMail({
      from: `SPACiAN Pipeline <${process.env.GMAIL_USER}>`,
      to: process.env.EDITOR_EMAIL,
      subject: `[SPACiAN] ${count}件の候補記事が届きました`,
      text: `スコアリングが完了しました。\n\n${count}件の候補記事があります。\n\nエディターUIで確認: ${editorUrl}`,
    });
    console.log(`[mailer] scoring notification sent (${count} candidates)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[mailer] send failed (non-fatal): ${msg.slice(0, 100)}`);
  }
}

export async function sendGenerationNotification(
  count: number,
  editorUrl: string
): Promise<void> {
  if (!hasCredentials()) {
    console.log("[mailer] GMAIL credentials not set, skipping email");
    return;
  }
  try {
    await transporter.sendMail({
      from: `SPACiAN Pipeline <${process.env.GMAIL_USER}>`,
      to: process.env.EDITOR_EMAIL,
      subject: `[SPACiAN] ${count}件の記事が生成されました`,
      text: `generate.ts が完了しました。\n\n${count}件の記事が pending/ に追加されました。\n\nエディターUIで確認: ${editorUrl}`,
    });
    console.log(`[mailer] generation notification sent (${count} articles)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[mailer] send failed (non-fatal): ${msg.slice(0, 100)}`);
  }
}

export async function sendErrorNotification(
  script: string,
  error: Error
): Promise<void> {
  if (!hasCredentials()) {
    console.log("[mailer] GMAIL credentials not set, skipping error email");
    return;
  }
  // Dedup key: script name + first 100 chars of error message
  const errKey = `${script}:${error.message.slice(0, 100)}`;
  if (!shouldSendError(errKey)) {
    console.log(`[mailer] error notification suppressed (6h cooldown): ${errKey.slice(0, 80)}`);
    return;
  }
  try {
    await transporter.sendMail({
      from: `SPACiAN Pipeline <${process.env.GMAIL_USER}>`,
      to: process.env.EDITOR_EMAIL,
      subject: `[SPACiAN] パイプラインエラー: ${script}`,
      text: [
        `${script} が異常終了しました。`,
        "",
        `エラー: ${error.message}`,
        "",
        error.stack ?? "",
      ].join("\n"),
    });
    recordErrorNotified(errKey);
    console.log(`[mailer] error notification sent (${script})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[mailer] send failed (non-fatal): ${msg.slice(0, 100)}`);
  }
}
