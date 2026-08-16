import { AutomatedResponseError, normalizeUsage, type AutomatedRequestContext, type AutomatedResponder } from "./automated.js";
import type { ChatCompletionRequest, Usage } from "./types.js";

const FORWARDED_KEYS = new Set([
  "messages",
  "temperature",
  "top_p",
  "n",
  "stop",
  "max_tokens",
  "max_completion_tokens",
  "presence_penalty",
  "frequency_penalty",
  "logit_bias",
  "logprobs",
  "top_logprobs",
  "response_format",
  "seed",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning_effort",
  "metadata",
  "stream_options",
  "model",
  "stream",
]);

export interface ProxyResponderOptions {
  upstream: string;
  upstreamModel?: string;
  upstreamKey?: string;
  healthTimeoutMs?: number;
}

export class ProxyResponder implements AutomatedResponder {
  readonly mode = "proxy" as const;
  readonly completionUrl: string;
  readonly modelsUrl: string;
  private discoveredModel: string | undefined;

  constructor(private readonly options: ProxyResponderOptions) {
    this.completionUrl = appendEndpoint(options.upstream, "chat/completions");
    this.modelsUrl = modelsEndpoint(options.upstream);
  }

  async healthCheck(): Promise<string> {
    let response: Response;
    try {
      response = await fetch(this.modelsUrl, {
        method: "GET",
        headers: this.headers(),
        signal: AbortSignal.timeout(this.options.healthTimeoutMs ?? 5_000),
      });
    } catch (error) {
      throw new Error(`upstream is unreachable at ${this.modelsUrl}: ${errorMessage(error)}`);
    }
    if (!response.ok) throw new Error(`upstream health check returned HTTP ${response.status} at ${this.modelsUrl}`);

    try {
      const value = (await response.json()) as unknown;
      this.discoveredModel = firstModelId(value);
    } catch {
      // Reachability is enough when the request already supplies a model.
    }
    return this.discoveredModel ? `healthy · ${this.discoveredModel}` : "healthy";
  }

  async respond(context: AutomatedRequestContext): Promise<void> {
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort(context.signal.reason);
    if (context.signal.aborted) forwardAbort();
    else context.signal.addEventListener("abort", forwardAbort, { once: true });

    let firstByteTimedOut = false;
    const firstByteTimeoutMs = Math.max(
      250,
      Math.min(context.budgets.firstByteSeconds, context.budgets.totalSeconds) * 1_000 - 1_000,
    );
    const firstByteTimer = setTimeout(() => {
      firstByteTimedOut = true;
      controller.abort(new Error("upstream first-byte timeout"));
    }, firstByteTimeoutMs);
    firstByteTimer.unref?.();

    const body = forwardBody(
      context.request,
      this.options.upstreamModel ?? (context.request.model || this.discoveredModel),
      context.transport === "stream",
    );

    let response: Response;
    try {
      response = await fetch(this.completionUrl, {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json", Accept: "text/event-stream, application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      context.signal.removeEventListener("abort", forwardAbort);
      clearTimeout(firstByteTimer);
      if (firstByteTimedOut) {
        throw new AutomatedResponseError("Local upstream exceeded the first-byte budget.", 504, "upstream_timeout");
      }
      if (context.signal.aborted) throw error;
      throw new AutomatedResponseError(`Local upstream request failed: ${errorMessage(error)}`, 502, "upstream_unreachable");
    }
    clearTimeout(firstByteTimer);

    if (!response.ok) {
      context.signal.removeEventListener("abort", forwardAbort);
      throw new AutomatedResponseError(
        `Local upstream returned HTTP ${response.status}.`,
        502,
        "upstream_error",
      );
    }

    try {
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType.includes("text/event-stream")) {
        await consumeUpstreamSse(response, context);
      } else {
        await consumeUpstreamJson(response, context);
      }
    } catch (error) {
      if (error instanceof AutomatedResponseError) throw error;
      if (context.signal.aborted) throw error;
      throw new AutomatedResponseError(`Could not parse local upstream response: ${errorMessage(error)}`, 502, "malformed_upstream");
    } finally {
      context.signal.removeEventListener("abort", forwardAbort);
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.options.upstreamKey !== undefined) headers.Authorization = `Bearer ${this.options.upstreamKey}`;
    return headers;
  }
}

async function consumeUpstreamSse(response: Response, context: AutomatedRequestContext): Promise<void> {
  if (!response.body) throw new AutomatedResponseError("Local upstream returned an empty SSE body.", 502, "empty_upstream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: Usage | undefined;
  let finishChunkSent = false;
  let usageChunkSent = false;
  const accumulator = new StreamCompletionAccumulator();

  const consumeEvents = (final: boolean): boolean => {
    buffer += final ? decoder.decode() : "";
    const normalized = buffer.replace(/\r\n/g, "\n");
    const events = normalized.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) {
      const data = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      if (data.trim() === "[DONE]") return true;

      let value: unknown;
      try {
        value = JSON.parse(data) as unknown;
      } catch {
        throw new AutomatedResponseError("Local upstream emitted malformed SSE JSON.", 502, "malformed_upstream");
      }
      const delta = extractDelta(value);
      const candidateUsage = extractUsage(value);
      if (candidateUsage) usage = candidateUsage;
      const hasFinish = hasFinishReason(value);
      const isUsageOnly = isUsageOnlyChunk(value);
      if (context.transport === "stream") {
        context.sink.chunk(value, delta);
        if (hasFinish) finishChunkSent = true;
        if (isUsageOnly) usageChunkSent = true;
      } else {
        accumulator.add(value);
      }
    }
    return false;
  };

  let doneMarker = false;
  while (!doneMarker) {
    const part = await reader.read();
    if (part.done) {
      if (buffer.trim()) {
        buffer += "\n\n";
        consumeEvents(true);
      }
      break;
    }
    buffer += decoder.decode(part.value, { stream: true });
    doneMarker = consumeEvents(false);
  }
  if (context.transport === "json") {
    context.sink.completion(accumulator.completion(usage), accumulator.content, usage);
  } else {
    context.sink.finish(usage, { finishChunkSent, usageChunkSent });
  }
}

async function consumeUpstreamJson(response: Response, context: AutomatedRequestContext): Promise<void> {
  const value = (await response.json()) as unknown;
  const choices = completionChoices(value);
  if (choices.length === 0) {
    throw new AutomatedResponseError("Local upstream JSON had no completion choices.", 502, "malformed_upstream");
  }
  const content = choices
    .map((choice) => asRecord(choice.message)?.content)
    .filter((item): item is string => typeof item === "string")
    .join("");
  const usage = extractUsage(value);
  if (context.transport === "json") {
    context.sink.completion(value, content, usage);
    return;
  }
  const [deltaChunk, finishChunk] = completionAsChunks(value, choices);
  context.sink.chunk(deltaChunk, content);
  context.sink.chunk(finishChunk);
  context.sink.finish(usage, { finishChunkSent: true });
}

export function forwardBody(
  request: ChatCompletionRequest,
  upstreamModel: string | undefined,
  stream: boolean,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request)) {
    if (FORWARDED_KEYS.has(key)) result[key] = value;
  }
  if (upstreamModel !== undefined) result.model = upstreamModel;
  result.stream = stream;
  if (!stream) delete result.stream_options;
  return result;
}

function appendEndpoint(base: string, suffix: string): string {
  const url = new URL(base);
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith(`/${suffix}`)) return url.toString();
  url.pathname = `${path}/${suffix}`.replace(/\/+/g, "/");
  return url.toString();
}

function modelsEndpoint(base: string): string {
  const url = new URL(base);
  let path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/chat/completions")) path = path.slice(0, -"/chat/completions".length);
  if (!path.endsWith("/models")) path = `${path}/models`;
  url.pathname = path.replace(/\/+/g, "/");
  return url.toString();
}

function firstModelId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = (value as Record<string, unknown>).data;
  if (!Array.isArray(data)) return undefined;
  for (const item of data) {
    if (item && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string") {
      return (item as Record<string, unknown>).id as string;
    }
  }
  return undefined;
}

function extractDelta(value: unknown): string | undefined {
  const choice = firstChoice(value);
  const delta = asRecord(choice?.delta);
  if (typeof delta?.content === "string") return delta.content;
  const message = asRecord(choice?.message);
  return typeof message?.content === "string" ? message.content : undefined;
}

function completionChoices(value: unknown): Record<string, unknown>[] {
  const choices = asRecord(value)?.choices;
  return Array.isArray(choices)
    ? choices.map(asRecord).filter((choice): choice is Record<string, unknown> => choice !== undefined)
    : [];
}

function completionAsChunks(
  value: unknown,
  choices: Record<string, unknown>[],
): [Record<string, unknown>, Record<string, unknown>] {
  const completion = asRecord(value) ?? {};
  const shared: Record<string, unknown> = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created ?? Math.floor(Date.now() / 1_000),
    model: completion.model,
  };
  for (const key of ["system_fingerprint", "service_tier"]) {
    if (completion[key] !== undefined) shared[key] = completion[key];
  }
  return [
    {
      ...shared,
      choices: choices.map((choice, position) => ({
        index: typeof choice.index === "number" ? choice.index : position,
        delta: asRecord(choice.message) ?? {},
        logprobs: choice.logprobs ?? null,
        finish_reason: null,
      })),
    },
    {
      ...shared,
      choices: choices.map((choice, position) => ({
        index: typeof choice.index === "number" ? choice.index : position,
        delta: {},
        logprobs: choice.logprobs ?? null,
        finish_reason: choice.finish_reason ?? "stop",
      })),
    },
  ];
}

function hasFinishReason(value: unknown): boolean {
  const choice = firstChoice(value);
  return choice?.finish_reason !== null && choice?.finish_reason !== undefined;
}

function isUsageOnlyChunk(value: unknown): boolean {
  const record = asRecord(value);
  return Array.isArray(record?.choices) && record.choices.length === 0 && normalizeUsage(record.usage) !== undefined;
}

function extractUsage(value: unknown): Usage | undefined {
  return normalizeUsage(asRecord(value)?.usage);
}

function firstChoice(value: unknown): Record<string, unknown> | undefined {
  const choices = asRecord(value)?.choices;
  return Array.isArray(choices) ? asRecord(choices[0]) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class StreamCompletionAccumulator {
  private readonly choices = new Map<number, { message: Record<string, unknown>; finishReason: unknown; logprobs?: unknown }>();
  private metadata: Record<string, unknown> = {};
  content = "";

  add(value: unknown): void {
    const record = asRecord(value);
    if (!record) return;
    if (Object.keys(this.metadata).length === 0) {
      for (const key of ["id", "created", "model", "system_fingerprint", "service_tier"]) {
        if (record[key] !== undefined) this.metadata[key] = record[key];
      }
    }
    const choices = Array.isArray(record.choices) ? record.choices : [];
    for (let position = 0; position < choices.length; position += 1) {
      const choice = asRecord(choices[position]);
      if (!choice) continue;
      const index = typeof choice.index === "number" ? choice.index : position;
      const current = this.choices.get(index) ?? { message: {}, finishReason: null };
      const delta = asRecord(choice.delta) ?? asRecord(choice.message);
      if (delta) mergeMessageDelta(current.message, delta);
      const content = delta?.content;
      if (typeof content === "string") this.content += content;
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        current.finishReason = choice.finish_reason;
      }
      if (choice.logprobs !== undefined) current.logprobs = choice.logprobs;
      this.choices.set(index, current);
    }
  }

  completion(usage: Usage | undefined): Record<string, unknown> {
    const result: Record<string, unknown> = {
      ...this.metadata,
      object: "chat.completion",
      choices: [...this.choices.entries()]
        .sort(([left], [right]) => left - right)
        .map(([index, choice]) => {
          if (choice.message.role === undefined) choice.message.role = "assistant";
          if (choice.message.content === undefined && choice.message.tool_calls !== undefined) {
            choice.message.content = null;
          }
          const rendered: Record<string, unknown> = {
            index,
            message: choice.message,
            finish_reason: choice.finishReason ?? "stop",
          };
          if (choice.logprobs !== undefined) rendered.logprobs = choice.logprobs;
          return rendered;
        }),
    };
    if (usage) result.usage = usage;
    return result;
  }
}

function mergeMessageDelta(target: Record<string, unknown>, delta: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(delta)) {
    if ((key === "content" || key === "refusal") && typeof value === "string") {
      target[key] = `${typeof target[key] === "string" ? target[key] : ""}${value}`;
    } else if (key === "tool_calls" && Array.isArray(value)) {
      const calls = Array.isArray(target.tool_calls) ? target.tool_calls as unknown[] : [];
      for (let position = 0; position < value.length; position += 1) {
        const part = asRecord(value[position]);
        if (!part) continue;
        const index = typeof part.index === "number" ? part.index : position;
        const call = asRecord(calls[index]) ?? {};
        for (const field of ["id", "type"]) {
          if (part[field] !== undefined) call[field] = part[field];
        }
        const functionPart = asRecord(part.function);
        if (functionPart) {
          const fn = asRecord(call.function) ?? {};
          for (const field of ["name", "arguments"]) {
            if (typeof functionPart[field] === "string") {
              fn[field] = `${typeof fn[field] === "string" ? fn[field] : ""}${functionPart[field]}`;
            }
          }
          call.function = fn;
        }
        calls[index] = call;
      }
      target.tool_calls = calls;
    } else if (key === "function_call" && value && typeof value === "object") {
      const fn = asRecord(target.function_call) ?? {};
      const part = asRecord(value) ?? {};
      for (const field of ["name", "arguments"]) {
        if (typeof part[field] === "string") {
          fn[field] = `${typeof fn[field] === "string" ? fn[field] : ""}${part[field]}`;
        }
      }
      target.function_call = fn;
    } else if (Array.isArray(value)) {
      target[key] = [...(Array.isArray(target[key]) ? target[key] as unknown[] : []), ...value];
    } else if (value !== undefined) {
      target[key] = value;
    }
  }
}
