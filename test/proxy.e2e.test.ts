import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANARY_PROMPT } from "../src/canary.js";
import { ProxyResponder } from "../src/proxy.js";
import { HarnessServer } from "../src/server.js";
import { signBody } from "../src/signature.js";

const secret = "proxy-test-secret";

describe("proxy mode", () => {
  let upstream: Server;
  let upstreamBase: string;
  let completionCalls: number;
  let receivedBodies: Array<Record<string, unknown>>;
  let receivedAuthorization: string | undefined;
  const harnesses: HarnessServer[] = [];

  beforeEach(async () => {
    completionCalls = 0;
    receivedBodies = [];
    receivedAuthorization = undefined;
    upstream = createServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "local-model" }] }));
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      completionCalls += 1;
      receivedAuthorization = request.headers.authorization;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      receivedBodies.push(body);
      const messages = body.messages as Array<{ content?: unknown }>;
      const prompt = String(messages.at(-1)?.content);

      if (prompt.includes("source-stream")) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write('data: {"id":"upstream","object":"chat.completion.chunk","created":1,"model":"local-model","custom":"preserved","choices":[{"index":0,"delta":{"content":"streamed "},"finish_reason":null}]}\n\n');
        response.write('data: {"id":"upstream","object":"chat.completion.chunk","created":1,"model":"local-model","choices":[{"index":0,"delta":{"content":"answer"},"finish_reason":null}]}\n\n');
        response.write('data: {"id":"upstream","object":"chat.completion.chunk","created":1,"model":"local-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
        response.write('data: {"id":"upstream","object":"chat.completion.chunk","created":1,"model":"local-model","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n');
        response.end("data: [DONE]\n\n");
      } else {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            id: "upstream",
            object: "chat.completion",
            model: "local-model",
            choices: [{ index: 0, message: { role: "assistant", content: "buffered answer" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
        );
      }
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", () => {
        upstream.off("error", reject);
        resolve();
      });
    });
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("upstream did not bind");
    upstreamBase = `http://127.0.0.1:${address.port}/v1`;
  });

  afterEach(async () => {
    await Promise.all(harnesses.map((server) => server.stop()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("adapts upstream SSE and JSON into an outward stream without buffering", async () => {
    const server = await startProxyHarness(true);
    const streamSource = await completion(server, "source-stream", true);
    expect(streamSource.headers.get("content-type")).toContain("text/event-stream");
    const streamed = await streamSource.text();
    expect(streamed).toContain('"custom":"preserved"');
    expect(streamed).toContain('"content":"streamed "');
    expect(streamed).toContain('"choices":[],"usage"');
    expect(streamed.match(/"finish_reason":"stop"/g)).toHaveLength(1);
    expect(streamed.endsWith("data: [DONE]\n\n")).toBe(true);

    const jsonSource = await completion(server, "source-json", true);
    const synthesized = await jsonSource.text();
    expect(synthesized).toContain('"content":"buffered answer"');
    expect(synthesized).toContain('"finish_reason":"stop"');
    expect(synthesized.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("aggregates upstream SSE and JSON into an outward JSON completion", async () => {
    const server = await startProxyHarness(false);
    const streamSource = await completion(server, "source-stream", false);
    expect(await streamSource.json()).toMatchObject({
      object: "chat.completion",
      choices: [{ message: { content: "streamed answer" } }],
      usage: { total_tokens: 5 },
    });

    const jsonSource = await completion(server, "source-json", false);
    expect(await jsonSource.json()).toMatchObject({
      object: "chat.completion",
      choices: [{ message: { content: "buffered answer" } }],
      usage: { total_tokens: 5 },
    });
    expect(receivedBodies.every((body) => body.model === "rewritten-model")).toBe(true);
    expect(receivedBodies.every((body) => body.unknown_internal_field === undefined)).toBe(true);
    expect(receivedAuthorization).toBe("Bearer upstream-only-key");
  });

  it("keeps the canary local and refuses an unreachable upstream health check", async () => {
    const server = await startProxyHarness(true);
    const canary = await signedRequest(server, {
      model: "router-model",
      stream: true,
      messages: [{ role: "user", content: CANARY_PROMPT }],
    });
    expect(await canary.text()).toContain('"content":"pong"');
    expect(completionCalls).toBe(0);

    const dead = new HarnessServer({
      signingSecret: secret,
      modelId: "trustedrouter/user-dead",
      uiToken: "proxy-ui",
      mode: "proxy",
      responder: new ProxyResponder({ upstream: "http://127.0.0.1:1/v1", healthTimeoutMs: 100 }),
      logger: () => undefined,
    });
    harnesses.push(dead);
    await dead.start(0);
    await expect(dead.checkAutomatedHealth()).rejects.toThrow(/unreachable|fetch failed/i);
    expect(dead.getState().health?.status).toBe("unhealthy");
  });

  async function startProxyHarness(supportsStreaming: boolean): Promise<HarnessServer> {
    const responder = new ProxyResponder({
      upstream: upstreamBase,
      upstreamModel: "rewritten-model",
      upstreamKey: "upstream-only-key",
    });
    const server = new HarnessServer({
      signingSecret: secret,
      modelId: "trustedrouter/user-proxy",
      uiToken: "proxy-ui",
      mode: "proxy",
      responder,
      supportsStreaming,
      maxConcurrency: 4,
      kind: "machine",
      logger: () => undefined,
    });
    harnesses.push(server);
    await server.start(0);
    await server.checkAutomatedHealth();
    return server;
  }
});

function completion(server: HarnessServer, prompt: string, stream: boolean): Promise<Response> {
  return signedRequest(server, {
    model: "router-model",
    stream,
    stream_options: stream ? { include_usage: true } : undefined,
    messages: [{ role: "user", content: prompt }],
    unknown_internal_field: "must-not-forward",
  });
}

function signedRequest(server: HarnessServer, value: unknown): Promise<Response> {
  const body = JSON.stringify(value);
  const timestamp = Math.floor(Date.now() / 1_000);
  return fetch(`${server.localUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "TR-Signature": signBody(secret, timestamp, Buffer.from(body)),
    },
    body,
  });
}
