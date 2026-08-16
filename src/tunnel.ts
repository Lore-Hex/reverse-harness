import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

const QUICK_TUNNEL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export class CloudflaredNotFoundError extends Error {
  constructor() {
    super("cloudflared was not found on PATH");
    this.name = "CloudflaredNotFoundError";
  }
}

export interface QuickTunnel {
  url: string;
  stop: () => Promise<void>;
}

export function hasCloudflared(): boolean {
  const result = spawnSync("cloudflared", ["--version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

export async function startQuickTunnel(
  localUrl: string,
  onDiagnostic?: (line: string) => void,
  timeoutMs = 30_000,
): Promise<QuickTunnel> {
  if (!hasCloudflared()) throw new CloudflaredNotFoundError();

  const child = spawn("cloudflared", ["tunnel", "--url", localUrl], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();

  const url = await waitForTunnelUrl(child, onDiagnostic, timeoutMs);
  return {
    url,
    stop: () => stopChild(child),
  };
}

function waitForTunnelUrl(
  child: ChildProcessWithoutNullStreams,
  onDiagnostic: ((line: string) => void) | undefined,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffered = "";
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`cloudflared did not publish a quick-tunnel URL within ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref?.();

    const inspect = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      buffered = `${buffered}${text}`.slice(-16_384);
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) onDiagnostic?.(line);
      }
      const match = buffered.match(QUICK_TUNNEL_PATTERN);
      if (!match || settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(match[0]);
    };

    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`cloudflared exited before publishing a URL (code=${String(code)}, signal=${String(signal)})`));
    });
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      resolve();
    };
    child.once("exit", finish);
    child.kill("SIGTERM");
    const force = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, 2_000);
    force.unref?.();
  });
}
