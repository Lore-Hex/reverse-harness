import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  AnswerHistoryItem,
  AnswerTransport,
  ChatCompletionRequest,
  PublicTask,
  TaskOutcome,
  TimeoutBudgets,
  TimeoutKind,
} from "./types.js";

export interface QueueTask extends PublicTask {
  request: ChatCompletionRequest;
}

interface TaskTimers {
  firstByte?: NodeJS.Timeout;
  idle?: NodeJS.Timeout;
  total?: NodeJS.Timeout;
}

export interface CompletionDetails {
  completionTokens?: number;
  timeoutKind?: TimeoutKind;
}

export class TaskQueue extends EventEmitter {
  private readonly tasks = new Map<string, QueueTask>();
  private readonly timers = new Map<string, TaskTimers>();
  private readonly answerHistory: AnswerHistoryItem[] = [];
  private concurrency: number;
  private currentBudgets: TimeoutBudgets;

  constructor(
    maxConcurrency: number,
    budgets: TimeoutBudgets,
    private readonly now: () => number = Date.now,
  ) {
    super();
    this.concurrency = validateConcurrency(maxConcurrency);
    this.currentBudgets = { ...budgets };
  }

  get maxConcurrency(): number {
    return this.concurrency;
  }

  get size(): number {
    return this.tasks.size;
  }

  get history(): readonly AnswerHistoryItem[] {
    return this.answerHistory;
  }

  setMaxConcurrency(value: number): void {
    this.concurrency = validateConcurrency(value);
    this.emit("changed");
  }

  setBudgets(value: TimeoutBudgets): void {
    this.currentBudgets = { ...value };
    this.emit("changed");
  }

  enqueue(request: ChatCompletionRequest, transport: AnswerTransport): QueueTask | undefined {
    if (this.tasks.size >= this.concurrency) return undefined;

    const task: QueueTask = {
      id: randomUUID(),
      createdAt: this.now(),
      status: "queued",
      transport,
      messages: request.messages,
      budgets: { ...this.currentBudgets },
      request,
    };
    this.tasks.set(task.id, task);
    this.scheduleInitialTimeouts(task);
    this.emit("changed");
    return task;
  }

  get(id: string): QueueTask | undefined {
    return this.tasks.get(id);
  }

  list(): PublicTask[] {
    return [...this.tasks.values()]
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(toPublicTask);
  }

  markByte(id: string): QueueTask | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;

    const timestamp = this.now();
    if (task.firstByteAt === undefined) task.firstByteAt = timestamp;
    task.lastByteAt = timestamp;
    task.status = "responding";

    const timers = this.timers.get(id);
    if (timers?.firstByte) {
      clearTimeout(timers.firstByte);
      delete timers.firstByte;
    }
    if (timers?.idle) clearTimeout(timers.idle);
    if (timers) {
      timers.idle = setTimeout(() => this.expire(id, "idle"), task.budgets.idleSeconds * 1_000);
      timers.idle.unref?.();
    }
    this.emit("changed");
    return task;
  }

  complete(id: string, outcome: Exclude<TaskOutcome, "timed_out">, details: CompletionDetails = {}): AnswerHistoryItem | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    return this.finish(task, outcome, details);
  }

  cancelAll(): void {
    for (const task of [...this.tasks.values()]) {
      this.finish(task, "disconnected");
    }
  }

  private scheduleInitialTimeouts(task: QueueTask): void {
    const timers: TaskTimers = {
      firstByte: setTimeout(
        () => this.expire(task.id, "first_byte"),
        task.budgets.firstByteSeconds * 1_000,
      ),
      total: setTimeout(() => this.expire(task.id, "total"), task.budgets.totalSeconds * 1_000),
    };
    timers.firstByte?.unref?.();
    timers.total?.unref?.();
    this.timers.set(task.id, timers);
  }

  private expire(id: string, kind: TimeoutKind): void {
    const task = this.tasks.get(id);
    if (!task) return;
    this.finish(task, "timed_out", { timeoutKind: kind }, false);
    this.emit("timeout", task, kind);
    this.emit("changed");
  }

  private finish(
    task: QueueTask,
    outcome: TaskOutcome,
    details: CompletionDetails = {},
    notify = true,
  ): AnswerHistoryItem {
    this.clearTimers(task.id);
    this.tasks.delete(task.id);

    const finishedAt = this.now();
    const history: AnswerHistoryItem = {
      id: task.id,
      outcome,
      createdAt: task.createdAt,
      finishedAt,
      totalMs: Math.max(0, finishedAt - task.createdAt),
    };
    if (task.firstByteAt !== undefined) history.ttftMs = Math.max(0, task.firstByteAt - task.createdAt);
    if (details.completionTokens !== undefined) history.completionTokens = details.completionTokens;
    if (details.timeoutKind !== undefined) history.timeoutKind = details.timeoutKind;

    this.answerHistory.unshift(history);
    this.answerHistory.splice(10);
    if (notify) this.emit("changed");
    return history;
  }

  private clearTimers(id: string): void {
    const timers = this.timers.get(id);
    if (!timers) return;
    if (timers.firstByte) clearTimeout(timers.firstByte);
    if (timers.idle) clearTimeout(timers.idle);
    if (timers.total) clearTimeout(timers.total);
    this.timers.delete(id);
  }
}

function validateConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error("maxConcurrency must be a positive integer");
  return value;
}

function toPublicTask(task: QueueTask): PublicTask {
  const result: PublicTask = {
    id: task.id,
    createdAt: task.createdAt,
    status: task.status,
    transport: task.transport,
    messages: task.messages,
    budgets: { ...task.budgets },
  };
  if (task.firstByteAt !== undefined) result.firstByteAt = task.firstByteAt;
  if (task.lastByteAt !== undefined) result.lastByteAt = task.lastByteAt;
  return result;
}
