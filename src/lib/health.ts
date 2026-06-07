import fs from "fs";
import path from "path";

const HEALTH_PATH = path.join(process.cwd(), "data", "source_health.json");

export interface SourceHealth {
  disabled: boolean;
  fail_count: number;
  last_ok_at: string | null;
  last_error: string | null;
  last_http_status: number | null;
}

export type HealthMap = Record<string, SourceHealth>;

const DEFAULT_HEALTH: SourceHealth = {
  disabled: false,
  fail_count: 0,
  last_ok_at: null,
  last_error: null,
  last_http_status: null,
};

export function readHealth(): HealthMap {
  try {
    return JSON.parse(fs.readFileSync(HEALTH_PATH, "utf-8")) as HealthMap;
  } catch {
    return {};
  }
}

export function writeHealth(health: HealthMap): void {
  fs.writeFileSync(HEALTH_PATH, JSON.stringify(health, null, 2) + "\n", "utf-8");
}

export function getSourceHealth(health: HealthMap, sourceId: string): SourceHealth {
  return health[sourceId] ?? { ...DEFAULT_HEALTH };
}

export function recordSuccess(health: HealthMap, sourceId: string, httpStatus = 200): void {
  health[sourceId] = {
    disabled: false,
    fail_count: 0,
    last_ok_at: new Date().toISOString(),
    last_error: null,
    last_http_status: httpStatus,
  };
}

export function recordFailure(
  health: HealthMap,
  sourceId: string,
  error: string,
  threshold: number
): void {
  const current = getSourceHealth(health, sourceId);
  const failCount = current.fail_count + 1;
  health[sourceId] = {
    ...current,
    fail_count: failCount,
    last_error: error,
    disabled: failCount >= threshold,
  };
}
