import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import {
  AutomatedResponseError,
  normalizeUsage,
  type AutomatedRequestContext,
  type AutomatedResponder,
} from "./automated.js";
import type { Usage } from "./types.js";

export interface ExecResponderOptions {
  command: string;
  persistent?: boolean;
  timeoutSeconds?: number;
}

export class ExecResponder implements AutomatedResponder {
  readonly mode = "exec" as const;
  private readonly argv: string[];
  private executable: string | undefined;
  private persistentSession: PersistentSession | undefined;
  private serial = Promise.resolve();

  constructor(private readonly options: ExecResponderOptions) {
    this.argv = parseCommand(options.command);
    if (this.argv.length === 0) throw new Error("--command must contain an executable");
  }

  async healthCheck(): Promise<string> {
    this.executable = await findExecutable(this.argv[0]!);
    return this.options.persistent ? `ready · ${this.executable} · persistent` : `ready · ${this.executable}`;
  }

  respond(context: AutomatedRequestContext): Promise<void> {
    if (!this.executable) throw new Error("exec responder was not health checked");
    if (!this.options.persistent) return runOneShot(this.executable, this.argv.slice(1), context, this.options.timeoutSeconds);

    const run = this.serial
      .catch(() => undefined)
      .then(async () => {
        if (!this.persistentSession) {
          this.persistentSession = new PersistentSession(this.executable!, this.argv.slice(1));
        }
        try {
          await this.persistentSession.run(context, this.options.timeoutSeconds);
        } catch (error) {
          await this.persistentSession.close();
          this.persistentSession = undefined;
          throw error;
        }
      });
    this.serial = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    await this.persistentSession?.close();
    this.persistentSession = undefined;
  }
}

async function runOneShot(
  executable: string,
  args: string[],
  context: AutomatedRequestContext,
  configuredTimeoutSeconds: number | undefined,
): Promise<void> {
  const child = spawnChild(executable, args, context);
  child.stdin.end(`${JSON.stringify(childRequest(context))}\n`);
  const parser = new OutputParser(context);
  const timeoutMs = execTimeoutMs(context, configuredTimeoutSeconds);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = (): void => {
      terminateChild(child);
      finish(context.signal.reason ?? new Error("request aborted"));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChild(child);
    }, timeoutMs);
    timer.unref?.();

    if (context.signal.aborted) onAbort();
    else context.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      try {
        const done = parser.push(chunk);
        if (done) {
          terminateChild(child);
          finish();
        }
      } catch (error) {
        terminateChild(child);
        finish(error);
      }
    });
    child.once("error", (error) => finish(new AutomatedResponseError(`Could not start command: ${error.message}`, 502, "exec_spawn_error")));
    child.once("exit", (code, signal) => {
      if (settled) return;
      try {
        parser.end();
      } catch (error) {
        finish(error);
        return;
      }
      if (parser.done) {
        finish();
      } else if (timedOut) {
        finish(new AutomatedResponseError("Local command exceeded its execution timeout.", 504, "exec_timeout"));
      } else if (code === 0) {
        parser.finish();
        finish();
      } else if (code === 4) {
        finish(new AutomatedResponseError("Local command declined this request (exit 4).", 422, "exec_declined"));
      } else {
        finish(
          new AutomatedResponseError(
            `Local command exited unsuccessfully (code=${String(code)}, signal=${String(signal)}).`,
            502,
            "exec_failed",
          ),
        );
      }
    });
  });
}

class PersistentSession {
  private child: ChildProcessWithoutNullStreams | undefined;
  private parser: OutputParser | undefined;
  private resolveCurrent: (() => void) | undefined;
  private rejectCurrent: ((error: unknown) => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private currentSignal: AbortSignal | undefined;
  private currentAbort: (() => void) | undefined;

  constructor(
    private readonly executable: string,
    private readonly args: string[],
  ) {}

  async run(context: AutomatedRequestContext, configuredTimeoutSeconds: number | undefined): Promise<void> {
    if (this.parser) throw new Error("persistent exec session received concurrent work");
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) this.start(context);
    const child = this.child!;
    this.parser = new OutputParser(context);

    await new Promise<void>((resolve, reject) => {
      this.resolveCurrent = resolve;
      this.rejectCurrent = reject;
      this.currentSignal = context.signal;
      this.currentAbort = () => {
        this.fail(context.signal.reason ?? new Error("request aborted"));
        terminateChild(child);
      };
      if (context.signal.aborted) {
        this.currentAbort();
        return;
      }
      context.signal.addEventListener("abort", this.currentAbort, { once: true });
      this.timer = setTimeout(() => {
        this.fail(new AutomatedResponseError("Persistent command exceeded its execution timeout.", 504, "exec_timeout"));
        terminateChild(child);
      }, execTimeoutMs(context, configuredTimeoutSeconds));
      this.timer.unref?.();
      child.stdin.write(`${JSON.stringify(childRequest(context))}\n`, (error) => {
        if (error) this.fail(new AutomatedResponseError(`Could not write to persistent command: ${error.message}`, 502, "exec_write_error"));
      });
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      terminateChild(child);
      const force = setTimeout(resolve, 1_000);
      force.unref?.();
    });
  }

  private start(context: AutomatedRequestContext): void {
    const child = spawnChild(this.executable, this.args, context);
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => {
      if (!this.parser) return;
      try {
        if (this.parser.push(chunk)) this.succeed();
      } catch (error) {
        this.fail(error);
        terminateChild(child);
      }
    });
    child.once("error", (error) => {
      this.fail(new AutomatedResponseError(`Persistent command failed: ${error.message}`, 502, "exec_spawn_error"));
      this.child = undefined;
    });
    child.once("exit", (code, signal) => {
      if (this.parser) {
        try {
          this.parser.end();
        } catch (error) {
          this.fail(error);
          this.child = undefined;
          return;
        }
        if (this.parser.done) this.succeed();
        else if (code === 4) this.fail(new AutomatedResponseError("Persistent command declined this request (exit 4).", 422, "exec_declined"));
        else this.fail(new AutomatedResponseError(`Persistent command exited (code=${String(code)}, signal=${String(signal)}).`, 502, "exec_failed"));
      }
      this.child = undefined;
    });
  }

  private succeed(): void {
    const resolve = this.resolveCurrent;
    this.cleanupCurrent();
    resolve?.();
  }

  private fail(error: unknown): void {
    const reject = this.rejectCurrent;
    this.cleanupCurrent();
    reject?.(error);
  }

  private cleanupCurrent(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.currentSignal && this.currentAbort) {
      this.currentSignal.removeEventListener("abort", this.currentAbort);
    }
    this.timer = undefined;
    this.currentSignal = undefined;
    this.currentAbort = undefined;
    this.parser = undefined;
    this.resolveCurrent = undefined;
    this.rejectCurrent = undefined;
  }
}

class OutputParser {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private usage: Usage | undefined;
  done = false;

  constructor(private readonly context: AutomatedRequestContext) {}

  push(chunk: Buffer): boolean {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    this.consumeLines(false);
    return this.done;
  }

  end(): void {
    this.buffer += this.decoder.decode();
    this.consumeLines(true);
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    this.context.sink.finish(this.usage);
  }

  private consumeLines(final: boolean): void {
    const lines = this.buffer.split(/\r?\n/);
    const tail = lines.pop() ?? "";
    this.buffer = final ? "" : tail;
    for (const line of lines) this.consumeLine(line, true);
    if (final && tail.length > 0) this.consumeLine(tail, false);
  }

  private consumeLine(line: string, hadNewline: boolean): void {
    if (this.done || line.length === 0) return;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      this.context.sink.delta(hadNewline ? `${line}\n` : line);
      return;
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.delta === "string") this.context.sink.delta(record.delta);
      const reportedUsage = normalizeUsage(record.usage);
      if (reportedUsage) this.usage = reportedUsage;
      if (record.done === true) {
        this.done = true;
        this.context.sink.finish(this.usage);
      }
      if (typeof record.delta === "string" || record.done === true || reportedUsage) return;
    }
    this.context.sink.delta(hadNewline ? `${line}\n` : line);
  }
}

function spawnChild(
  executable: string,
  args: string[],
  context: AutomatedRequestContext,
): ChildProcessWithoutNullStreams {
  const child = spawn(executable, args, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: childEnvironment(context),
  });
  child.stderr.resume();
  return child;
}

function childEnvironment(context: AutomatedRequestContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (["TR_API_KEY", "TR_SIGNING_SECRET", "TR_UPSTREAM_KEY"].includes(key)) continue;
    env[key] = value;
  }
  env.TR_REQUEST_ID = context.id;
  env.TR_MODEL = context.request.model;
  env.TR_KIND = context.kind;
  return env;
}

function childRequest(context: AutomatedRequestContext): Record<string, unknown> {
  return {
    ...context.request,
    model: context.request.model,
    stream: context.transport === "stream",
    request_id: context.id,
    kind: context.kind,
  };
}

function execTimeoutMs(context: AutomatedRequestContext, configuredTimeoutSeconds: number | undefined): number {
  const seconds = configuredTimeoutSeconds ?? Math.max(1, context.budgets.totalSeconds - 2);
  return seconds * 1_000;
}

function terminateChild(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Fall back to signaling just the child.
      child.kill("SIGTERM");
    }
  } else {
    child.kill("SIGTERM");
  }
  const force = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
        return;
      } catch {
        // Fall through to the direct child.
      }
    }
    child.kill("SIGKILL");
  }, 500);
  force.unref?.();
}

export function parseCommand(command: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;

  for (const character of command.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      started = true;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      started = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) {
        result.push(current);
        current = "";
        started = false;
      }
    } else {
      current += character;
      started = true;
    }
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("--command contains an unterminated quote");
  if (started) result.push(current);
  return result;
}

async function findExecutable(command: string): Promise<string> {
  const candidates: string[] = [];
  if (isAbsolute(command) || command.includes("/")) {
    candidates.push(command);
  } else {
    const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
    const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
    for (const directory of pathEntries) {
      for (const extension of extensions) candidates.push(join(directory, `${command}${extension}`));
    }
  }
  for (const candidate of candidates) {
    try {
      await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(`command executable not found: ${command}`);
}
