import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli.js";

describe("CLI mode defaults", () => {
  const originalApiKey = process.env.TR_API_KEY;
  const originalSigningSecret = process.env.TR_SIGNING_SECRET;

  afterEach(() => {
    restore("TR_API_KEY", originalApiKey);
    restore("TR_SIGNING_SECRET", originalSigningSecret);
  });

  it("infers human/1, machine/4, and agent/4 from mode", () => {
    process.env.TR_API_KEY = "owner-key";
    process.env.TR_SIGNING_SECRET = "signing-secret";
    const shared = ["--model", "trustedrouter/user-test", "--no-open"];

    expect(parseArgs([...shared, "--mode", "human"])).toMatchObject({
      mode: "human",
      kind: "human",
      maxConcurrency: 1,
      uiEnabled: true,
    });
    expect(parseArgs([...shared, "--mode", "proxy"])).toMatchObject({
      mode: "proxy",
      kind: "machine",
      maxConcurrency: 4,
    });
    expect(parseArgs([...shared, "--mode", "exec", "--command", "node agent.mjs", "--no-ui"])).toMatchObject({
      mode: "exec",
      kind: "agent",
      maxConcurrency: 4,
      uiEnabled: false,
      execPersistent: false,
    });
  });

  it("rejects headless human mode and missing exec commands", () => {
    process.env.TR_API_KEY = "owner-key";
    process.env.TR_SIGNING_SECRET = "signing-secret";
    const shared = ["--model", "trustedrouter/user-test"];
    expect(() => parseArgs([...shared, "--mode", "human", "--no-ui"])).toThrow(/no-ui/);
    expect(() => parseArgs([...shared, "--mode", "exec"])).toThrow(/requires --command/);
  });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
