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

/**
 * Call Gemini and return parsed JSON.
 * Uses responseMimeType: "application/json" to guarantee valid JSON output.
 * Retries up to maxRetries times on transient errors with exponential backoff.
 */
export async function generateJson<T>(
  prompt: string,
  model = "gemini-2.0-flash",
  maxRetries = 2
): Promise<T> {
  let lastError: Error = new Error("unknown");

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const m = genAI.getGenerativeModel({ model });
      const result = await m.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" },
      });
      return JSON.parse(result.response.text()) as T;
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
