import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskQueue } from "../src/queue.js";

const budgets = { firstByteSeconds: 300, idleSeconds: 120, totalSeconds: 900 };
const request = { model: "demo", messages: [{ role: "user", content: "hello" }] };

describe("TaskQueue", () => {
  afterEach(() => vi.useRealTimers());

  it("enforces max_concurrency and releases capacity on completion", () => {
    const queue = new TaskQueue(2, budgets);
    const first = queue.enqueue(request, "stream");
    const second = queue.enqueue(request, "stream");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(queue.enqueue(request, "stream")).toBeUndefined();

    queue.complete(first!.id, "answered", { completionTokens: 2 });
    expect(queue.enqueue(request, "stream")).toBeDefined();
    queue.cancelAll();
  });

  it("moves from first-byte to idle timing and records timeout faults", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const queue = new TaskQueue(1, { firstByteSeconds: 2, idleSeconds: 1, totalSeconds: 10 });
    const timeout = vi.fn();
    queue.on("timeout", timeout);
    const task = queue.enqueue(request, "stream")!;

    vi.advanceTimersByTime(1_000);
    queue.markByte(task.id);
    vi.advanceTimersByTime(1_001);

    expect(timeout).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), "idle");
    expect(queue.history[0]).toMatchObject({ outcome: "timed_out", timeoutKind: "idle", ttftMs: 1_000 });
  });
});
