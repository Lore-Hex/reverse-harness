import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AutomatedRequestContext } from "../src/automated.js";
import { ExecResponder } from "../src/exec.js";

const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url));

describe("ExecResponder without a socket", () => {
  it("streams JSONL and maps child exits", async () => {
    const responder = new ExecResponder({ command: `${process.execPath} ${join(fixtures, "exec-stream.mjs")}` });
    await responder.healthCheck();
    const output = context();
    await responder.respond(output.value);
    expect(output.deltas.join("")).toContain("hello|demo|agent|no-key done");
    expect(output.finished).toMatchObject({ total_tokens: 5 });

    const decline = new ExecResponder({ command: `${process.execPath} ${join(fixtures, "exec-decline.mjs")}` });
    await decline.healthCheck();
    await expect(decline.respond(context().value)).rejects.toMatchObject({ status: 422, code: "exec_declined" });

    const fail = new ExecResponder({ command: `${process.execPath} ${join(fixtures, "exec-fail.mjs")}` });
    await fail.healthCheck();
    await expect(fail.respond(context().value)).rejects.toMatchObject({ status: 502, code: "exec_failed" });
  });

  it("reuses a persistent JSONL process across serialized requests", async () => {
    const responder = new ExecResponder({
      command: `${process.execPath} ${join(fixtures, "exec-persistent.mjs")}`,
      persistent: true,
    });
    await responder.healthCheck();
    const first = context("first");
    const second = context("second");
    await responder.respond(first.value);
    await responder.respond(second.value);
    expect(first.deltas.join("")).toBe("first:persistent");
    expect(second.deltas.join("")).toBe("second:persistent");
    await responder.close();
  });
});

function context(prompt = "hello") {
  const deltas: string[] = [];
  let finished: unknown;
  const value: AutomatedRequestContext = {
    id: "request-id",
    request: { model: "demo", stream: true, messages: [{ role: "user", content: prompt }] },
    transport: "stream",
    kind: "agent",
    budgets: { firstByteSeconds: 60, idleSeconds: 60, totalSeconds: 600 },
    signal: new AbortController().signal,
    sink: {
      delta: (content) => deltas.push(content),
      chunk: () => undefined,
      completion: () => undefined,
      finish: (usage) => {
        finished = usage;
      },
    },
  };
  return {
    value,
    deltas,
    get finished() {
      return finished;
    },
  };
}
