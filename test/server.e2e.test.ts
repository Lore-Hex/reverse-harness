import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANARY_PROMPT } from "../src/canary.js";
import { HarnessServer } from "../src/server.js";
import { signBody } from "../src/signature.js";

const signingSecret = "e2e-signing-secret";
const uiToken = "e2e-ui-token";

describe("local signed HTTP flow", () => {
  let server: HarnessServer;

  beforeEach(async () => {
    server = new HarnessServer({
      signingSecret,
      modelId: "trustedrouter/user-test",
      uiToken,
      supportsStreaming: true,
      maxConcurrency: 1,
      declineStatus: 422,
      logger: () => undefined,
    });
    await server.start(0);
  });

  afterEach(async () => {
    await server.stop();
  });

  it("auto-answers canaries, streams answers, declines with 4xx, rejects bad signatures, and returns 429 at capacity", async () => {
    const badBody = JSON.stringify({ model: "demo", stream: true, messages: [{ role: "user", content: "hello" }] });
    const badSignature = await fetch(`${server.localUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "TR-Signature": `t=${now()},v1=${"0".repeat(64)}` },
      body: badBody,
    });
    expect(badSignature.status).toBe(401);
    expect(await badSignature.json()).toMatchObject({ error: { code: "invalid_signature" } });

    const canaryBody = JSON.stringify({
      model: "demo",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: CANARY_PROMPT }],
    });
    const canary = await signedFetch(server, canaryBody);
    expect(canary.status).toBe(200);
    const canaryText = await canary.text();
    expect(canaryText).toContain('"content":"pong"');
    expect(canaryText).toContain('"choices":[],"usage"');
    expect(canaryText.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(server.getState().history).toHaveLength(0);

    const answerBody = JSON.stringify({
      model: "demo",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "What is two plus two?" }],
    });
    const upstreamPromise = signedFetch(server, answerBody);
    await waitForQueue(server, 1);
    const taskId = server.getState().queue[0]!.id;

    const overCapacity = await signedFetch(
      server,
      JSON.stringify({ model: "demo", stream: true, messages: [{ role: "user", content: "second" }] }),
    );
    expect(overCapacity.status).toBe(429);
    expect(overCapacity.headers.get("retry-after")).toBe("1");

    await uiPost(server, "/answer", { taskId, content: "Four", final: false });
    const upstream = await upstreamPromise;
    await uiPost(server, "/answer", { taskId, content: ".", final: true });
    const stream = await upstream.text();
    const frames = stream.split("\n\n").filter(Boolean);
    expect(frames.some((frame) => frame.includes('"content":"Four"'))).toBe(true);
    expect(frames.some((frame) => frame.includes('"content":"."'))).toBe(true);
    expect(frames.at(-3)).toContain('"finish_reason":"stop"');
    expect(frames.at(-2)).toContain('"choices":[],"usage"');
    expect(frames.at(-1)).toBe("data: [DONE]");

    const declineBody = JSON.stringify({
      model: "demo",
      stream: true,
      messages: [{ role: "user", content: "Please decline this" }],
    });
    const declinedPromise = signedFetch(server, declineBody);
    await waitForQueue(server, 1);
    const declineId = server.getState().queue[0]!.id;
    await uiPost(server, "/decline", { taskId: declineId });
    const declined = await declinedPromise;
    expect(declined.status).toBe(422);
    expect(await declined.json()).toMatchObject({ error: { type: "request_declined", code: "human_declined" } });
  });
  it("serves the canary at /v1/chat/completions as well as /chat/completions", async () => {
    // TrustedRouter appends /chat/completions to the endpoint_url you
    // registered, and the docs example registers a URL ending in /v1. A
    // copy-paste setup therefore calls /v1/chat/completions here. Serving
    // only the bare path made that a 404 with nothing on screen to explain
    // it — the likeliest first-run failure there is.
    const raw = JSON.stringify({
      model: "demo",
      stream: false,
      messages: [{ role: "user", content: CANARY_PROMPT }],
    });

    const responses = await Promise.all(
      ["/chat/completions", "/v1/chat/completions"].map((path) => {
        const timestamp = now();
        return fetch(`${server.localUrl}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "TR-Signature": signBody(signingSecret, timestamp, Buffer.from(raw)),
          },
          body: raw,
        });
      }),
    );

    for (const response of responses) {
      expect(response.status).toBe(200);
    }
    const bodies = await Promise.all(responses.map((r) => r.json()));
    for (const body of bodies) {
      expect(body.choices[0].message.role).toBe("assistant");
    }
  });

  it("still 404s an unrelated path", async () => {
    const response = await fetch(`${server.localUrl}/v2/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(404);
  });
});

function now(): number {
  return Math.floor(Date.now() / 1_000);
}

function signedFetch(server: HarnessServer, rawBody: string): Promise<Response> {
  const timestamp = now();
  return fetch(`${server.localUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "TR-Signature": signBody(signingSecret, timestamp, Buffer.from(rawBody)),
    },
    body: rawBody,
  });
}

async function uiPost(server: HarnessServer, path: string, body: unknown): Promise<void> {
  const response = await fetch(`${server.localUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Reverse-Harness-UI-Token": uiToken,
    },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
}

async function waitForQueue(server: HarnessServer, count: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (server.getState().queue.length === count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Queue did not reach ${count}`);
}
