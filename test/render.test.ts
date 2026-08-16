import { describe, expect, it } from "vitest";
import { chatCompletionChunk, declineError, sseData, usageChunk } from "../src/render.js";

describe("OpenAI rendering", () => {
  it("frames chunks as one SSE data event", () => {
    const chunk = chatCompletionChunk("abc", "demo", "hello", null, 1_700_000_000);
    const frame = sseData(chunk);
    expect(frame).toBe(`data: ${JSON.stringify(chunk)}\n\n`);
    expect(chunk).toMatchObject({
      object: "chat.completion.chunk",
      choices: [{ delta: { content: "hello" }, finish_reason: null }],
    });
  });

  it("builds a choices-empty usage chunk", () => {
    expect(
      usageChunk("abc", "demo", { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }, 1_700_000_000),
    ).toMatchObject({ object: "chat.completion.chunk", choices: [], usage: { total_tokens: 3 } });
  });

  it("uses an OpenAI-shaped 4xx decline body", () => {
    expect(declineError()).toEqual({
      error: {
        message: "The human model declined this request.",
        type: "request_declined",
        param: null,
        code: "human_declined",
      },
    });
  });
});
