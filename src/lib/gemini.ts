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
          generationConfig: {
            responseMimeType: "application/json",
            thinkingConfig: { thinkingBudget: 0 },
          } as { responseMimeType: string },
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

// ── Grounding ──────────────────────────────────────────────────────────────

export interface GroundedRef {
  /** Domain name returned by grounding API (e.g. "space.com") */
  domain: string;
  /** Grounding redirect URI (vertexaisearch.cloud.google.com/...) */
  uri: string;
}

/**
 * Call Gemini with Google Search grounding and return up to 2 grounded refs.
 * Uses the REST API directly because the @google/generative-ai v0.24.1 SDK
 * no longer supports the server-side `google_search` tool (only the deprecated
 * `google_search_retrieval` is typed, which the API now rejects with 400).
 * Returns [] on any failure — callers should fall back gracefully.
 */
export async function generateGrounded(
  prompt: string,
  model: string
): Promise<GroundedRef[]> {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tools: [{ google_search: {} }],
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return [];

    const data = await res.json() as {
      candidates?: Array<{
        groundingMetadata?: {
          groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
        };
      }>;
    };

    const chunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    return chunks
      .filter((c) => c.web?.uri)
      .slice(0, 2)
      .map((c) => ({
        domain: c.web!.title ?? "",
        uri: c.web!.uri!,
      }));
  } catch {
    return [];
  }
}

/**
 * Generate an image via gemini-2.5-flash-image (Google AI Studio REST API).
 * Uses the generateContent endpoint (v1beta) with responseModalities: IMAGE.
 * Returns base64-encoded PNG, or null on failure.
 *
 * Confirmed behavior (2026-06-21):
 * - v1 endpoint rejects responseModalities/imageConfig (400); v1beta required
 * - Response: candidates[0].content.parts[] contains a text prefix part
 *   ("Sure, here you go: ") and an inlineData part with mimeType "image/png"
 * - aspectRatio "16:9" supported via generationConfig.imageConfig
 */
export async function generateImage(prompt: string): Promise<string | null> {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${API_KEY}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: { aspectRatio: "16:9" },
        },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "(unreadable)");
      console.warn(`[imagen] HTTP ${res.status} ${res.statusText} — ${body.slice(0, 300)}`);
      return null;
    }
    const data = await res.json() as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }>;
        };
      }>;
    };
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const imagePart = parts.find((p) => p.inlineData?.data);
    return imagePart?.inlineData?.data ?? null;
  } catch (err) {
    console.warn(`[imagen] fetch error — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
