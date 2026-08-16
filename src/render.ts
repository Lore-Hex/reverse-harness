import type { ChatCompletionRequest, Usage } from "./types.js";

export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return text.length === 0 ? 0 : Math.max(1, Math.ceil(text.length / 4));
}

export function usageFor(request: ChatCompletionRequest, answer: string): Usage {
  const promptTokens = estimateTokens(request.messages);
  const completionTokens = estimateTokens(answer);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

export function completionId(taskId: string): string {
  return `chatcmpl-${taskId}`;
}

export function chatCompletionChunk(
  taskId: string,
  model: string,
  content: string | undefined,
  finishReason: "stop" | null = null,
  created = Math.floor(Date.now() / 1000),
): Record<string, unknown> {
  return {
    id: completionId(taskId),
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: content === undefined ? {} : { content },
        finish_reason: finishReason,
      },
    ],
  };
}

export function usageChunk(
  taskId: string,
  model: string,
  usage: Usage,
  created = Math.floor(Date.now() / 1000),
): Record<string, unknown> {
  return {
    id: completionId(taskId),
    object: "chat.completion.chunk",
    created,
    model,
    choices: [],
    usage,
  };
}

export function chatCompletion(
  taskId: string,
  model: string,
  content: string,
  usage: Usage,
  created = Math.floor(Date.now() / 1000),
): Record<string, unknown> {
  return {
    id: completionId(taskId),
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage,
  };
}

export function sseData(value: unknown): string {
  const data = typeof value === "string" ? value : JSON.stringify(value);
  return `data: ${data}\n\n`;
}

export function openAIError(message: string, type: string, code: string): { error: Record<string, unknown> } {
  return {
    error: {
      message,
      type,
      param: null,
      code,
    },
  };
}

export function declineError(): { error: Record<string, unknown> } {
  return openAIError("The human model declined this request.", "request_declined", "human_declined");
}
