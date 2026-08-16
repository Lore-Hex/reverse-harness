import type {
  AnswerTransport,
  ChatCompletionRequest,
  HarnessMode,
  ModelKind,
  TimeoutBudgets,
  Usage,
} from "./types.js";

export interface AutomatedSink {
  delta: (content: string) => void;
  chunk: (value: unknown, contentDelta?: string) => void;
  completion: (value: unknown, content?: string, usage?: Usage) => void;
  finish: (
    usage?: Usage,
    framing?: { finishChunkSent?: boolean; usageChunkSent?: boolean },
  ) => void;
}

export interface AutomatedRequestContext {
  id: string;
  request: ChatCompletionRequest;
  transport: AnswerTransport;
  kind: ModelKind;
  budgets: TimeoutBudgets;
  signal: AbortSignal;
  sink: AutomatedSink;
}

export interface AutomatedResponder {
  readonly mode: Exclude<HarnessMode, "human">;
  healthCheck: () => Promise<string>;
  respond: (context: AutomatedRequestContext) => Promise<void>;
  close?: () => Promise<void>;
}

export class AutomatedResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "AutomatedResponseError";
  }
}

export function isUsage(value: unknown): value is Usage {
  if (!value || typeof value !== "object") return false;
  const usage = value as Partial<Usage>;
  return (
    typeof usage.prompt_tokens === "number" &&
    Number.isFinite(usage.prompt_tokens) &&
    usage.prompt_tokens >= 0 &&
    typeof usage.completion_tokens === "number" &&
    Number.isFinite(usage.completion_tokens) &&
    usage.completion_tokens >= 0 &&
    (usage.total_tokens === undefined ||
      (typeof usage.total_tokens === "number" && Number.isFinite(usage.total_tokens) && usage.total_tokens >= 0))
  );
}

export function normalizeUsage(value: unknown): Usage | undefined {
  if (!isUsage(value)) return undefined;
  return {
    prompt_tokens: Math.floor(value.prompt_tokens),
    completion_tokens: Math.floor(value.completion_tokens),
    total_tokens: Math.floor(value.total_tokens ?? value.prompt_tokens + value.completion_tokens),
  };
}
