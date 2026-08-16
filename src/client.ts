import type { ModelKind, OwnerModelRuntime, TimeoutBudgets } from "./types.js";

export interface OwnerClientOptions {
  apiKey: string;
  modelId: string;
  apiBase?: string;
  requestTimeoutMs?: number;
}

export class OwnerApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseBody: unknown,
  ) {
    super(message);
    this.name = "OwnerApiError";
  }
}

export class TrustedRouterClient {
  private readonly apiBase: string;
  private readonly modelPath: string;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: OwnerClientOptions) {
    this.apiBase = (options.apiBase ?? "https://api.trustedrouter.com").replace(/\/+$/, "");
    this.modelPath = `/v1/user-models/${encodeURIComponent(options.modelId)}`;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
  }

  async patchEndpointUrl(endpointUrl: string): Promise<unknown> {
    return this.request("PATCH", this.modelPath, { endpoint_url: endpointUrl });
  }

  async clockIn(): Promise<unknown> {
    return this.request("POST", `${this.modelPath}/clock-in`);
  }

  async heartbeat(): Promise<unknown> {
    return this.request("POST", `${this.modelPath}/heartbeat`);
  }

  async clockOut(): Promise<unknown> {
    return this.request("POST", `${this.modelPath}/clock-out`);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.apiKey}`,
      Accept: "application/json",
      "User-Agent": "@trustedrouter/reverse-harness/0.1.0",
    };
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const response = await fetch(`${this.apiBase}${path}`, init);
    const text = await response.text();
    let value: unknown;
    if (text.length > 0) {
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        value = text;
      }
    }
    if (!response.ok) {
      throw new OwnerApiError(
        `TrustedRouter owner API ${method} ${path} returned HTTP ${response.status}`,
        response.status,
        value,
      );
    }
    return value;
  }
}

export function heartbeatBackoffMs(
  consecutiveFailures: number,
  heartbeatIntervalSeconds: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const unjittered = Math.min(1_000 * 2 ** exponent, (heartbeatIntervalSeconds * 1_000) / 2);
  const jitter = 0.8 + random() * 0.4;
  return Math.max(250, Math.round(unjittered * jitter));
}

export interface HeartbeatControllerOptions {
  intervalSeconds: number;
  onSuccess?: (response: unknown) => void;
  onFailure?: (error: unknown, retryInMs: number) => void;
}

export class HeartbeatController {
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  private failures = 0;

  constructor(
    private readonly client: Pick<TrustedRouterClient, "heartbeat">,
    private readonly options: HeartbeatControllerOptions,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule((this.options.intervalSeconds * 1_000) / 2);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      const response = await this.client.heartbeat();
      this.failures = 0;
      this.options.onSuccess?.(response);
      this.schedule((this.options.intervalSeconds * 1_000) / 2);
    } catch (error) {
      this.failures += 1;
      const retryInMs = heartbeatBackoffMs(this.failures, this.options.intervalSeconds);
      this.options.onFailure?.(error, retryInMs);
      this.schedule(retryInMs);
    }
  }
}

export function extractOwnerRuntime(value: unknown): OwnerModelRuntime {
  const root = asRecord(value);
  const model = asRecord(root?.model);
  const source = model ?? root;
  if (!source) return {};

  const runtime: OwnerModelRuntime = {};
  const heartbeat = readPositiveNumber(source, "heartbeat_interval_seconds");
  const maxConcurrency = readPositiveInteger(source, "max_concurrency");
  const kind = readKind(source.kind);
  const supportsStreaming = typeof source.supports_streaming === "boolean" ? source.supports_streaming : undefined;
  const budgets = extractBudgets(source);
  const earnings = extractEarnings(root, source);

  if (heartbeat !== undefined) runtime.heartbeatIntervalSeconds = heartbeat;
  if (maxConcurrency !== undefined) runtime.maxConcurrency = maxConcurrency;
  if (kind !== undefined) runtime.kind = kind;
  if (supportsStreaming !== undefined) runtime.supportsStreaming = supportsStreaming;
  if (budgets !== undefined) runtime.budgets = budgets;
  if (earnings !== undefined) runtime.earnings = earnings;
  return runtime;
}

function extractBudgets(source: Record<string, unknown>): TimeoutBudgets | undefined {
  const nested = asRecord(source.budgets) ?? asRecord(source.timeout_budgets) ?? source;
  const firstByte =
    readPositiveNumber(nested, "first_byte_seconds") ?? readPositiveNumber(nested, "first_byte_timeout_seconds");
  const idle = readPositiveNumber(nested, "idle_seconds") ?? readPositiveNumber(nested, "idle_timeout_seconds");
  const total = readPositiveNumber(nested, "total_seconds") ?? readPositiveNumber(nested, "total_timeout_seconds");
  if (firstByte === undefined || idle === undefined || total === undefined) return undefined;
  return { firstByteSeconds: firstByte, idleSeconds: idle, totalSeconds: total };
}

function extractEarnings(
  root: Record<string, unknown> | undefined,
  source: Record<string, unknown>,
): number | string | undefined {
  for (const record of [root, source]) {
    if (!record) continue;
    for (const key of ["earnings", "earnings_so_far", "earnings_microdollars", "earnings_credits"]) {
      const value = record[key];
      if (typeof value === "number" || typeof value === "string") return value;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readPositiveNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readPositiveInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = readPositiveNumber(record, key);
  return value !== undefined && Number.isInteger(value) ? value : undefined;
}

function readKind(value: unknown): ModelKind | undefined {
  return value === "machine" || value === "agent" || value === "human" ? value : undefined;
}
