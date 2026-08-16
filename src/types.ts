export type ModelKind = "machine" | "agent" | "human";
export type HarnessMode = "human" | "proxy" | "exec";
export type AnswerTransport = "stream" | "json";

export interface ChatMessage {
  role: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown;
  [key: string]: unknown;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface TimeoutBudgets {
  firstByteSeconds: number;
  idleSeconds: number;
  totalSeconds: number;
}

export interface PublicTask {
  id: string;
  createdAt: number;
  firstByteAt?: number;
  lastByteAt?: number;
  status: "queued" | "responding";
  transport: AnswerTransport;
  messages: ChatMessage[];
  budgets: TimeoutBudgets;
}

export type TaskOutcome = "answered" | "declined" | "failed" | "timed_out" | "disconnected";
export type TimeoutKind = "first_byte" | "idle" | "total";

export interface AnswerHistoryItem {
  id: string;
  outcome: TaskOutcome;
  createdAt: number;
  finishedAt: number;
  totalMs: number;
  ttftMs?: number;
  completionTokens?: number;
  timeoutKind?: TimeoutKind;
}

export interface HarnessState {
  modelId: string;
  mode: HarnessMode;
  onClock: boolean;
  tunnelUrl?: string;
  earnings?: number | string;
  supportsStreaming: boolean;
  maxConcurrency: number;
  queue: PublicTask[];
  history: AnswerHistoryItem[];
  health?: {
    status: "checking" | "healthy" | "unhealthy";
    label: string;
  };
}

export interface OwnerModelRuntime {
  heartbeatIntervalSeconds?: number;
  maxConcurrency?: number;
  kind?: ModelKind;
  supportsStreaming?: boolean;
  budgets?: TimeoutBudgets;
  earnings?: number | string;
}

export const KIND_BUDGETS: Record<ModelKind, TimeoutBudgets> = {
  machine: { firstByteSeconds: 30, idleSeconds: 60, totalSeconds: 300 },
  agent: { firstByteSeconds: 60, idleSeconds: 60, totalSeconds: 600 },
  human: { firstByteSeconds: 300, idleSeconds: 120, totalSeconds: 900 },
};
