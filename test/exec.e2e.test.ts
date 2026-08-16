import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CANARY_PROMPT } from "../src/canary.js";
import { ExecResponder, parseCommand } from "../src/exec.js";
import { HarnessServer } from "../src/server.js";
import { signBody } from "../src/signature.js";

const secret = "exec-test-secret";
const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url));

describe("exec mode", () => {
  const servers: HarnessServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.stop()));
  });

  it("parses quoted argv without invoking a shell", () => {
    expect(parseCommand('python "my agent.py" --label \'hello world\'')).toEqual([
      "python",
      "my agent.py",
      "--label",
      "hello world",
    ]);
  });

  it("streams JSON lines, passes request context, and strips harness secrets", async () => {
    const previousKey = process.env.TR_API_KEY;
    const previousSecret = process.env.TR_SIGNING_SECRET;
    process.env.TR_API_KEY = "must-not-reach-child";
    process.env.TR_SIGNING_SECRET = "must-not-reach-child";
    try {
      const server = await startExec("exec-stream.mjs", true);
      const response = await request(server, "hello", true);
      const stream = await response.text();
      expect(stream).toContain('"content":"hello|trustedrouter/user-exec|agent|no-key"');
      expect(stream).toContain('"content":" done"');
      expect(stream).toContain('"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}');
      expect(stream.endsWith("data: [DONE]\n\n")).toBe(true);
    } finally {
      restoreEnv("TR_API_KEY", previousKey);
      restoreEnv("TR_SIGNING_SECRET", previousSecret);
    }
  });

  it("maps exit 4 to a decline and other nonzero exits to an owner 5xx", async () => {
    const declineServer = await startExec("exec-decline.mjs", false);
    const declined = await request(declineServer, "decline", false);
    expect(declined.status).toBe(422);
    expect(await declined.json()).toMatchObject({ error: { code: "exec_declined" } });

    const failureServer = await startExec("exec-fail.mjs", false);
    const failed = await request(failureServer, "fail", false);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: { code: "exec_failed" } });
  });

  it("never sends a canary to the command", async () => {
    const server = await startExec("exec-fail.mjs", true);
    const response = await signedRequest(server, {
      model: "trustedrouter/user-exec",
      stream: true,
      messages: [{ role: "user", content: CANARY_PROMPT }],
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"content":"pong"');
  });

  async function startExec(fixture: string, supportsStreaming: boolean): Promise<HarnessServer> {
    const responder = new ExecResponder({ command: `${process.execPath} ${join(fixtures, fixture)}` });
    const server = new HarnessServer({
      signingSecret: secret,
      modelId: "trustedrouter/user-exec",
      uiToken: "exec-ui",
      mode: "exec",
      responder,
      supportsStreaming,
      maxConcurrency: 4,
      kind: "agent",
      logger: () => undefined,
    });
    servers.push(server);
    await server.start(0);
    await server.checkAutomatedHealth();
    return server;
  }
});

function request(server: HarnessServer, prompt: string, stream: boolean): Promise<Response> {
  return signedRequest(server, {
    model: "trustedrouter/user-exec",
    stream,
    stream_options: stream ? { include_usage: true } : undefined,
    messages: [{ role: "user", content: prompt }],
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

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
