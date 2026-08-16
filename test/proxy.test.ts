import { afterEach, describe, expect, it, vi } from "vitest";
import { ProxyResponder } from "../src/proxy.js";
import type { AutomatedRequestContext } from "../src/automated.js";

describe("ProxyResponder without a socket", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("health-checks and adapts buffered upstream JSON into deltas", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "found-model" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "buffered" } }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const responder = new ProxyResponder({ upstream: "http://localhost:11434/v1" });
    expect(await responder.healthCheck()).toBe("healthy · found-model");
    const output = sinkContext("stream");
    await responder.respond(output.context);
    expect(output.deltas).toEqual(["buffered"]);
    expect(output.finished).toMatchObject({ usage: { total_tokens: 3 } });
  });

  it("aggregates SSE deltas when the outward transport is JSON", async () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"one "},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":"two"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })));
    const responder = new ProxyResponder({ upstream: "http://localhost:11434/v1" });
    const output = sinkContext("json");
    await responder.respond(output.context);
    expect(output.deltas.join("")).toBe("one two");
    expect(output.finished).toBeDefined();
  });

  it("preserves streamed tool-call deltas when aggregating to JSON", async () => {
    const body = [
      'data: {"id":"x","model":"demo","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_","arguments":"{\\"city\\":"}}]},"finish_reason":null}]}',
      'data: {"id":"x","model":"demo","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"weather","arguments":"\\"Athens\\"}"}}]},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })));
    const responder = new ProxyResponder({ upstream: "http://localhost:11434/v1" });
    const output = sinkContext("json");
    await responder.respond(output.context);
    expect(output.completionValue).toMatchObject({
      object: "chat.completion",
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Athens"}' } }],
        },
        finish_reason: "tool_calls",
      }],
    });
  });
});

function sinkContext(transport: "stream" | "json") {
  const deltas: string[] = [];
  let finished: { usage?: unknown; framing?: unknown } | undefined;
  let completionValue: unknown;
  const context: AutomatedRequestContext = {
    id: "test-id",
    request: { model: "demo", stream: transport === "stream", messages: [{ role: "user", content: "hello" }] },
    transport,
    kind: "machine",
    budgets: { firstByteSeconds: 30, idleSeconds: 60, totalSeconds: 300 },
    signal: new AbortController().signal,
    sink: {
      delta: (content) => deltas.push(content),
      chunk: (_value, content) => {
        if (content) deltas.push(content);
      },
      completion: (value, content, usage) => {
        completionValue = value;
        if (content) deltas.push(content);
        finished = { usage };
      },
      finish: (usage, framing) => {
        finished = { usage, framing };
      },
    },
  };
  return {
    context,
    deltas,
    get finished() {
      return finished;
    },
    get completionValue() {
      return completionValue;
    },
  };
}
