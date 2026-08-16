import { describe, expect, it } from "vitest";
import { extractOwnerRuntime, heartbeatBackoffMs } from "../src/client.js";

describe("heartbeat behavior", () => {
  it("uses capped exponential backoff with bounded jitter", () => {
    const centeredRandom = () => 0.5;
    expect(heartbeatBackoffMs(1, 30, centeredRandom)).toBe(1_000);
    expect(heartbeatBackoffMs(2, 30, centeredRandom)).toBe(2_000);
    expect(heartbeatBackoffMs(5, 30, centeredRandom)).toBe(15_000);
    expect(heartbeatBackoffMs(8, 30, centeredRandom)).toBe(15_000);
  });

  it("reads scheduling, capacity, transport, budget, and earnings fields", () => {
    expect(
      extractOwnerRuntime({
        model: {
          heartbeat_interval_seconds: 40,
          max_concurrency: 2,
          kind: "human",
          supports_streaming: true,
          budgets: { first_byte_seconds: 300, idle_seconds: 120, total_seconds: 900 },
        },
        earnings_microdollars: 123,
      }),
    ).toEqual({
      heartbeatIntervalSeconds: 40,
      maxConcurrency: 2,
      kind: "human",
      supportsStreaming: true,
      budgets: { firstByteSeconds: 300, idleSeconds: 120, totalSeconds: 900 },
      earnings: 123,
    });
  });
});
