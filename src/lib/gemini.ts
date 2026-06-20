import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";
import path from "path";

// Load .env (simple parser — no dotenv dependency needed)
function loadEnv(): void {
  const envPath = path.join(process.cwd(), ".env");
  try {
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    // no .env — rely on environment variables
  }
}

loadEnv();

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY || API_KEY === "PLACEHOLDER" || API_KEY === "your_key_here") {
  throw new Error("GEMINI_API_KEY is not set. Add a real key to .env");
}

const genAI = new GoogleGenerativeAI(API_KEY);

export type GeminiUsage = {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
  /** Thinking tokens (Gemini 2.5 Flash/Pro with reasoning). Absent on non-thinking models. */
  thoughtsTokenCount?: number;
};

/**
 * Call Gemini and return parsed JSON.
 * Uses responseMimeType: "application/json" to guarantee valid JSON output.
 * Retries up to maxRetries times on transient errors with exponential backoff.
 * onUsage is called once on success with token counts from usageMetadata.
 */
export async function generateJson<T>(
  prompt: string,
  model = "gemini-2.0-flash",
  maxRetries = 2,
  onUsage?: (usage: GeminiUsage) => void
): Promise<T> {
  let lastError: Error = new Error("unknown");

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const m = genAI.getGenerativeModel({ model });
      const timeoutMs = 60_000;
      const result = await Promise.race([
        m.generateContent({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json" },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Gemini timeout after ${timeoutMs}ms`)), timeoutMs)
        ),
      ]);
      const parsed = JSON.parse(result.response.text()) as T;
      if (onUsage) {
        // usageMetadata is typed for 0.24.1 but newer API responses also include
        // thoughtsTokenCount (Gemini 2.5 Flash thinking tokens). Cast to capture it.
        const meta = result.response.usageMetadata as (typeof result.response.usageMetadata & {
          thoughtsTokenCount?: number;
        });
        onUsage({
          promptTokenCount: meta?.promptTokenCount ?? 0,
          candidatesTokenCount: meta?.candidatesTokenCount ?? 0,
          totalTokenCount: meta?.totalTokenCount ?? 0,
          thoughtsTokenCount: meta?.thoughtsTokenCount,
        });
      }
      return parsed;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const wait = (attempt + 1) * 5_000;
        console.warn(`  [gemini] retry ${attempt + 1}/${maxRetries} after ${wait}ms — ${lastError.message}`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  throw lastError;
}

/**
 * Generate an image via Imagen 3 (Google AI Studio REST API).
 * Returns base64-encoded JPEG, or null on failure/unsupported access.
 */
export async function generateImage(prompt: string): Promise<string | null> {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${API_KEY}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: { sampleCount: 1, aspectRatio: "16:9" },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }>;
    };
    return data.predictions?.[0]?.bytesBase64Encoded ?? null;
  } catch {
    return null;
  }
}
