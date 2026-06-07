import { Resend } from "resend";
import fs from "fs";
import path from "path";

function loadEnvValue(key: string): string | undefined {
  try {
    const envPath = path.join(process.cwd(), ".env");
    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
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

export async function sendCandidateNotification(count: number): Promise<void> {
  const apiKey = loadEnvValue("RESEND_API_KEY");
  if (!apiKey || apiKey === "re_placeholder" || apiKey.trim() === "") {
    console.log("[resend] RESEND_API_KEY not configured — skipping notification");
    return;
  }

  const editorToken = loadEnvValue("EDITOR_TOKEN");
  const siteBase = loadEnvValue("SITE_BASE_URL") ?? "http://localhost:3000";
  const to = loadEnvValue("NOTIFY_EMAIL") ?? "constellation@spacian.news";

  const url = editorToken
    ? `${siteBase}/editor/${editorToken}/candidates`
    : `${siteBase}/editor/(token)/candidates`;

  try {
    const resend = new Resend(apiKey);
    await resend.emails.send({
      from: "SPACiAN Pipeline <noreply@spacian.news>",
      to,
      subject: `SPACiAN 候補 ${count}件 — 判断をお願いします`,
      html: `<p>本日のスコアリングが完了しました。</p>
<p><strong>${count}件</strong>の候補が判断待ちです。</p>
<p><a href="${url}">→ 候補を確認する</a></p>
<p style="color:#888;font-size:12px">${url}</p>`,
    });
    console.log(`[resend] notification sent to ${to} (${count} candidates)`);
  } catch (err) {
    // Non-fatal: notification failure should not break the pipeline
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[resend] send failed (non-fatal): ${msg.slice(0, 100)}`);
  }
}
