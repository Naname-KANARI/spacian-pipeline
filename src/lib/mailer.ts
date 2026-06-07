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

export async function sendScoringNotification(
  count: number,
  editorUrl: string
): Promise<void> {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.log("[mailer] GMAIL credentials not set, skipping email");
    return;
  }
  try {
    await transporter.sendMail({
      from: `SPACiAN Pipeline <${process.env.GMAIL_USER}>`,
      to: process.env.EDITOR_EMAIL,
      subject: `[SPACiAN] ${count}件の候補記事が届きました`,
      text: `スコアリングが完了しました。\n\nエディターUIで確認: ${editorUrl}`,
    });
    console.log(`[mailer] notification sent (${count} candidates)`);
  } catch (err) {
    // Non-fatal: notification failure should not break the pipeline
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[mailer] send failed (non-fatal): ${msg.slice(0, 100)}`);
  }
}
