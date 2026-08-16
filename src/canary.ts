import type { ChatCompletionRequest } from "./types.js";

export const CANARY_PROMPT = "Reply with the single word: pong";

export function isCanaryRequest(request: ChatCompletionRequest): boolean {
  if (!Array.isArray(request.messages) || request.messages.length !== 1) return false;
  const [message] = request.messages;
  if (!message || message.role !== "user" || typeof message.content !== "string") return false;
  return message.content.length <= 64 && message.content.toLowerCase() === CANARY_PROMPT.toLowerCase();
}
