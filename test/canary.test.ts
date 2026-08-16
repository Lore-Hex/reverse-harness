import { describe, expect, it } from "vitest";
import { CANARY_PROMPT, isCanaryRequest } from "../src/canary.js";

describe("canary detection", () => {
  it("accepts only the single canonical user message, case-insensitively", () => {
    expect(isCanaryRequest({ model: "demo", messages: [{ role: "user", content: CANARY_PROMPT }] })).toBe(true);
    expect(
      isCanaryRequest({ model: "demo", messages: [{ role: "user", content: CANARY_PROMPT.toUpperCase() }] }),
    ).toBe(true);
  });

  it("does not wake the auto-answer path for near matches or extra messages", () => {
    expect(isCanaryRequest({ model: "demo", messages: [{ role: "user", content: `${CANARY_PROMPT} ` }] })).toBe(false);
    expect(
      isCanaryRequest({
        model: "demo",
        messages: [
          { role: "system", content: "test" },
          { role: "user", content: CANARY_PROMPT },
        ],
      }),
    ).toBe(false);
    expect(isCanaryRequest({ model: "demo", messages: [{ role: "assistant", content: CANARY_PROMPT }] })).toBe(false);
  });
});
