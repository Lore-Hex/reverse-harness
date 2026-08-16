#!/usr/bin/env node

import { createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import {
  extractOwnerRuntime,
  HeartbeatController,
  OwnerApiError,
  TrustedRouterClient,
} from "./client.js";
import type { AutomatedResponder } from "./automated.js";
import { ExecResponder } from "./exec.js";
import { ProxyResponder } from "./proxy.js";
import { HarnessServer, type HarnessLogger, type HarnessServerOptions } from "./server.js";
import { CloudflaredNotFoundError, startQuickTunnel, type QuickTunnel } from "./tunnel.js";
import { KIND_BUDGETS, type HarnessMode, type ModelKind } from "./types.js";

interface CliOptions {
  apiKey: string;
  modelId: string;
  signingSecret: string;
  apiBase: string;
  mode: HarnessMode;
  port: number;
  kind: ModelKind;
  supportsStreaming: boolean;
  maxConcurrency: number;
  declineStatus: number;
  verbose: boolean;
  openBrowser: boolean;
  uiEnabled: boolean;
  patchEndpoint: boolean;
  upstream?: string;
  upstreamModel?: string;
  upstreamKey?: string;
  command?: string;
  execPersistent: boolean;
  /** Local demo: no TrustedRouter account, no tunnel, no clock, nothing billed. */
  demo: boolean;
  /** Answer only: the model is created and clocked in from the website. */
  serveOnly: boolean;
  execTimeoutSeconds?: number;
  publicUrl?: string;
  requireBearer?: string;
}

const VERSION = "0.2.0";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let options: CliOptions;
  try {
    const result = parseArgs(argv);
    if (result === "help") {
      console.log(helpText());
      return;
    }
    if (result === "version") {
      console.log(VERSION);
      return;
    }
    options = result;
  } catch (error) {
    console.error(`[reverse-harness] ${messageFor(error)}`);
    console.error("Run reverse-harness --help for usage.");
    process.exitCode = 1;
    return;
  }

  const logger: HarnessLogger = (level, message) => {
    const line = `[reverse-harness] ${message}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };
  const uiToken = randomBytes(24).toString("base64url");
  let responder: AutomatedResponder | undefined;
  if (options.mode === "proxy") {
    const proxyOptions = { upstream: options.upstream ?? "http://localhost:11434/v1" };
    if (options.upstreamModel !== undefined) Object.assign(proxyOptions, { upstreamModel: options.upstreamModel });
    if (options.upstreamKey !== undefined) Object.assign(proxyOptions, { upstreamKey: options.upstreamKey });
    responder = new ProxyResponder(proxyOptions);
  } else if (options.mode === "exec") {
    const execOptions = { command: options.command!, persistent: options.execPersistent };
    if (options.execTimeoutSeconds !== undefined) Object.assign(execOptions, { timeoutSeconds: options.execTimeoutSeconds });
    responder = new ExecResponder(execOptions);
  }
  const serverOptions: HarnessServerOptions = {
    signingSecret: options.signingSecret,
    modelId: options.modelId,
    uiToken,
    mode: options.mode,
    supportsStreaming: options.supportsStreaming,
    maxConcurrency: options.maxConcurrency,
    kind: options.kind,
    budgets: KIND_BUDGETS[options.kind],
    declineStatus: options.declineStatus,
    verbose: options.verbose,
    uiEnabled: options.uiEnabled,
    logger,
  };
  if (options.requireBearer !== undefined) serverOptions.requireBearer = options.requireBearer;
  if (responder !== undefined) serverOptions.responder = responder;
  const server = new HarnessServer(serverOptions);
  const client = new TrustedRouterClient({
    apiKey: options.apiKey,
    modelId: options.modelId,
    apiBase: options.apiBase,
  });
  let tunnel: QuickTunnel | undefined;
  let heartbeat: HeartbeatController | undefined;
  let shuttingDown = false;

  try {
    await server.start(options.port);
    logger("info", `local server ${server.localUrl}`);

    if (options.mode !== "human") {
      const health = await server.checkAutomatedHealth();
      if (options.mode === "proxy" && options.upstream === undefined) {
        logger("info", `detected Ollama-compatible upstream at http://localhost:11434/v1 (${health ?? "healthy"})`);
      } else {
        logger("info", `${options.mode} backend ${health ?? "healthy"}`);
      }
    }

    if (options.demo) {
      server.setTunnelUrl(server.localUrl);
      logger("info", "DEMO MODE — no TrustedRouter account, no tunnel, nothing billed");
    } else if (options.publicUrl) {
      server.setTunnelUrl(options.publicUrl);
      logger("info", `using public URL ${options.publicUrl}`);
    } else {
      logger("info", "starting account-free cloudflared quick tunnel…");
      tunnel = await startQuickTunnel(
        server.localUrl,
        options.verbose ? (line) => logger("info", `cloudflared: ${line}`) : undefined,
      );
      server.setTunnelUrl(tunnel.url);
      logger("info", `tunnel ${tunnel.url}`);
    }

    if (!options.uiEnabled) logger("info", "headless monitor enabled (--no-ui)");
    else if (options.openBrowser) openLocalBrowser(server.dashboardUrl, logger);
    else logger("info", `dashboard ${server.dashboardUrl}`);

    const endpointUrl = options.demo ? server.localUrl : (options.publicUrl ?? tunnel?.url);
    if (!endpointUrl) throw new Error("No public endpoint URL is available");
    if (options.demo) {
      printDemoInstructions(endpointUrl, options, logger);
    } else if (options.serveOnly) {
      logger("info", "");
      logger("info", `endpoint_url for this model: ${endpointUrl}`);
      logger("info", "Paste it at /console/user-models, then press “Probe and clock in”.");
      logger("info", "");
    } else if (options.patchEndpoint) {
      try {
        await client.patchEndpointUrl(endpointUrl);
        logger("info", `pointed ${options.modelId} at ${endpointUrl}`);
      } catch (error) {
        logger("warn", `could not update endpoint_url automatically: ${ownerErrorMessage(error)}`);
        logger("warn", `paste this endpoint_url in the TrustedRouter owner console: ${endpointUrl}`);
      }
    } else {
      logger("info", `endpoint_url to register: ${endpointUrl}`);
    }

    if (options.demo) {
      server.setOnClock(true);
      logger("info", "ON THE CLOCK (demo) — Ctrl-C to stop");
    } else if (options.serveOnly) {
      server.setOnClock(true);
      logger("info", "SERVING — clock in and out on the website; Ctrl-C stops answering");
    } else {
    logger("info", "clocking in (the signed canary is answered automatically)…");
    const clockResponse = await client.clockIn();
    const runtime = extractOwnerRuntime(clockResponse);
    server.applyOwnerRuntime(runtime);
    server.setOnClock(true);
    logger("info", "ON THE CLOCK — Ctrl-C clocks out");

    const heartbeatIntervalSeconds = runtime.heartbeatIntervalSeconds ?? 30;
    heartbeat = new HeartbeatController(client, {
      intervalSeconds: heartbeatIntervalSeconds,
      onSuccess: (response) => server.applyOwnerRuntime(extractOwnerRuntime(response)),
      onFailure: (error, retryInMs) => {
        logger(
          "warn",
          `heartbeat failed (${ownerErrorMessage(error)}); retrying in ${(retryInMs / 1_000).toFixed(1)}s; active answers continue`,
        );
      },
    });
    heartbeat.start();
    }

    await new Promise<void>((resolve) => {
      const shutdown = (signal: NodeJS.Signals): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger("info", `${signal} received; clocking out…`);
        void (async () => {
          heartbeat?.stop();
          if (!options.demo && !options.serveOnly) {
            try {
              await client.clockOut();
            } catch (error) {
              logger("warn", `clock-out failed: ${ownerErrorMessage(error)}`);
            }
          }
          server.setOnClock(false);
          await tunnel?.stop();
          await server.stop();
          logger("info", "off the clock");
          resolve();
        })();
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  } catch (error) {
    logger("error", messageForStartup(error));
    process.exitCode = 1;
    heartbeat?.stop();
    await tunnel?.stop().catch(() => undefined);
    await server.stop().catch(() => undefined);
  }
}

function printDemoInstructions(endpointUrl: string, options: CliOptions, logger: HarnessLogger): void {
  const body = JSON.stringify({
    model: options.modelId,
    stream: options.supportsStreaming,
    messages: [{ role: "user", content: "What should I name my dog?" }],
  });
  const timestamp = Math.floor(Date.now() / 1_000);
  const signature = createHmac("sha256", options.signingSecret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  logger("info", "");
  logger("info", "Ask this human a question — paste into a second terminal (valid for 5 minutes):");
  logger("info", "");
  logger(
    "info",
    `curl -N ${endpointUrl}/chat/completions \\
  -H 'content-type: application/json' \\
  -H 'TR-Signature: t=${timestamp},v1=${signature}' \\
  -d '${body}'`,
  );
  logger("info", "");
  logger("info", `signing secret for your own requests: ${options.signingSecret}`);
  logger("info", "");
}

export function parseArgs(argv: string[]): CliOptions | "help" | "version" {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valueOptions = new Set([
    "--key",
    "--model",
    "--signing-secret",
    "--require-bearer",
    "--public-url",
    "--api-base",
    "--mode",
    "--port",
    "--kind",
    "--max-concurrency",
    "--decline-status",
    "--upstream",
    "--upstream-model",
    "--upstream-key",
    "--command",
    "--exec-timeout",
  ]);
  const flagOptions = new Set([
    "--demo",
    "--serve",
    "--stream",
    "--no-stream",
    "--verbose",
    "--no-open",
    "--no-ui",
    "--no-patch",
    "--exec-persistent",
    "--help",
    "-h",
    "--version",
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument) continue;
    if (valueOptions.has(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      values.set(argument, value);
      index += 1;
    } else if (flagOptions.has(argument)) {
      flags.add(argument);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (flags.has("--help") || flags.has("-h")) return "help";
  if (flags.has("--version")) return "version";
  if (flags.has("--stream") && flags.has("--no-stream")) throw new Error("Choose either --stream or --no-stream");

  // --demo runs the whole harness against nobody: it mints a throwaway signing
  // secret, skips every TrustedRouter API call, and prints a signed curl to
  // paste into a second terminal. It is how you show the thing before you have
  // an account.
  const demo = flags.has("--demo");
  // --serve is the console path: create the model and clock in from the
  // website, and let this process do nothing but answer. It needs the signing
  // secret (to verify the requests TrustedRouter sends) and nothing else — no
  // API key, no clock calls, no permission to change anything on the account.
  const serveOnly = flags.has("--serve");
  const apiKey =
    values.get("--key") ??
    process.env.TR_API_KEY ??
    (demo || serveOnly ? "not-required-in-this-mode" : undefined);
  const modelId = values.get("--model") ?? (demo ? "trustedrouter/user-demo" : undefined);
  const signingSecret =
    values.get("--signing-secret") ??
    process.env.TR_SIGNING_SECRET ??
    (demo ? randomBytes(24).toString("hex") : undefined);
  if (!apiKey) {
    throw new Error(
      "Missing --key (or TR_API_KEY). Use --serve to clock in from the website instead, or --demo to run without an account.",
    );
  }
  if (!modelId) throw new Error("Missing --model");
  if (!signingSecret) throw new Error("Missing --signing-secret (or TR_SIGNING_SECRET)");

  const modeText = values.get("--mode") ?? "human";
  if (modeText !== "human" && modeText !== "proxy" && modeText !== "exec") {
    throw new Error("--mode must be human, proxy, or exec");
  }
  if (modeText === "exec" && !values.get("--command")) throw new Error("--mode exec requires --command");
  if (modeText === "human" && flags.has("--no-ui")) throw new Error("--no-ui is available in proxy and exec modes");

  const inferredKind: ModelKind = modeText === "proxy" ? "machine" : modeText === "exec" ? "agent" : "human";
  const kindText = values.get("--kind") ?? inferredKind;
  if (kindText !== "machine" && kindText !== "agent" && kindText !== "human") {
    throw new Error("--kind must be machine, agent, or human");
  }
  const port = integerOption(values.get("--port") ?? "0", "--port", 0, 65_535);
  const defaultConcurrency = modeText === "human" ? "1" : "4";
  const maxConcurrency = integerOption(values.get("--max-concurrency") ?? defaultConcurrency, "--max-concurrency", 1, 1_000);
  const declineStatus = integerOption(values.get("--decline-status") ?? "422", "--decline-status", 400, 499);
  const publicUrlValue = values.get("--public-url");
  if (publicUrlValue && !publicUrlValue.startsWith("https://")) throw new Error("--public-url must use https://");

  const options: CliOptions = {
    apiKey,
    modelId,
    signingSecret,
    apiBase: values.get("--api-base") ?? process.env.TR_API_BASE ?? "https://api.trustedrouter.com",
    mode: modeText,
    port,
    kind: kindText,
    supportsStreaming: !flags.has("--no-stream"),
    maxConcurrency,
    declineStatus,
    verbose: flags.has("--verbose"),
    openBrowser: !flags.has("--no-open") && !flags.has("--no-ui"),
    uiEnabled: !flags.has("--no-ui"),
    patchEndpoint: !flags.has("--no-patch"),
    execPersistent: flags.has("--exec-persistent"),
    demo,
    serveOnly,
  };
  if (publicUrlValue !== undefined) options.publicUrl = publicUrlValue.replace(/\/+$/, "");
  const requireBearer = values.get("--require-bearer");
  if (requireBearer !== undefined) options.requireBearer = requireBearer;
  const upstream = values.get("--upstream");
  if (upstream !== undefined) {
    try {
      const url = new URL(upstream);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    } catch {
      throw new Error("--upstream must be an http:// or https:// URL");
    }
    options.upstream = upstream.replace(/\/+$/, "");
  }
  const upstreamModel = values.get("--upstream-model");
  if (upstreamModel !== undefined) options.upstreamModel = upstreamModel;
  const upstreamKey = values.get("--upstream-key") ?? process.env.TR_UPSTREAM_KEY;
  if (upstreamKey !== undefined) options.upstreamKey = upstreamKey;
  const command = values.get("--command");
  if (command !== undefined) options.command = command;
  const execTimeout = values.get("--exec-timeout");
  if (execTimeout !== undefined) options.execTimeoutSeconds = numberOption(execTimeout, "--exec-timeout", 0.25, 86_400);
  return options;
}

function integerOption(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function numberOption(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be a number from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function openLocalBrowser(url: string, logger: HarnessLogger): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", () => logger("warn", `could not open a browser; dashboard ${url}`));
  child.unref();
}

function ownerErrorMessage(error: unknown): string {
  if (error instanceof OwnerApiError) return `${error.message}${formatOwnerReason(error.responseBody)}`;
  return messageFor(error);
}

function formatOwnerReason(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const message = record.message ?? (record.error && typeof record.error === "object" ? (record.error as Record<string, unknown>).message : undefined);
  return typeof message === "string" ? `: ${message}` : "";
}

function messageForStartup(error: unknown): string {
  if (error instanceof CloudflaredNotFoundError) {
    return [
      "cloudflared is not installed.",
      "Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
      "or start any HTTPS tunnel yourself and rerun with --public-url https://your-tunnel.example.",
      "Quick tunnels require no Cloudflare account.",
    ].join("\n");
  }
  return ownerErrorMessage(error);
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function helpText(): string {
  return `reverse-harness ${VERSION} — expose a local model, agent, or human on TrustedRouter

Usage:
  reverse-harness --mode proxy --upstream http://localhost:11434/v1 [shared options]
  reverse-harness --mode exec --command "python my_agent.py" [shared options]
  reverse-harness --mode human [shared options]

Shared required:
  --demo                      Run with no TrustedRouter account: no tunnel, no clock,\n                              prints a signed curl you can paste to ask a question\n  --serve                     Answer only. Create the model and clock in on the\n                              website; needs --signing-secret, no API key\n  --key <key>                 TrustedRouter management key (or TR_API_KEY)
  --model <id>                TrustedRouter model id
  --signing-secret <secret>   Endpoint signing secret (or TR_SIGNING_SECRET)

Mode:
  --mode human|proxy|exec     Answer source (default: human)
  --upstream <url>            OpenAI API base (proxy; auto-detects Ollama if omitted)
  --upstream-model <id>       Rewrite model sent to the local upstream
  --upstream-key <key>        Bearer sent only to the local upstream (or TR_UPSTREAM_KEY)
  --command <argv>            Program spawned for each request (exec)
  --exec-persistent           Keep one JSONL command process and serialize requests
  --exec-timeout <seconds>    Child deadline (default: total budget minus 2s)

Endpoint:
  --require-bearer <token>    Require the registered endpoint_api_key
  --public-url <https-url>    Use an existing HTTPS tunnel instead of cloudflared
  --port <port>               Local port; 0 chooses a free port (default: 0)
  --stream / --no-stream      Registered response transport (default: --stream)
  --kind <kind>               Default inferred from mode: human, machine, agent
  --max-concurrency <n>       Default: 1 human, 4 proxy/exec
  --decline-status <4xx>      Status returned for Decline (default: 422)

Owner API:
  --api-base <url>            API base (or TR_API_BASE)
  --no-patch                  Print endpoint_url instead of patching the model

Local:
  --no-open                   Print the dashboard URL instead of opening it
  --no-ui                     Run proxy/exec headless without dashboard assets
  --verbose                   Log prompt and output bodies (off by default)
  -h, --help                  Show this help
  --version                   Show the version`;
}

// npm installs the bin as a SYMLINK in node_modules/.bin, so under `npx` this
// file's URL is the real dist/cli.js while process.argv[1] is the link. A plain
// equality check silently does nothing and the command exits 0 with no output —
// which is exactly what shipped in 0.1.0 and 0.1.1. Resolve both sides.
function isDirectEntrypoint(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  const self = fileURLToPath(import.meta.url);
  const candidates = [invoked];
  try {
    candidates.push(realpathSync(invoked));
  } catch {
    // the path may not exist on disk (piped input); the raw compare still holds
  }
  let resolvedSelf = self;
  try {
    resolvedSelf = realpathSync(self);
  } catch {
    // keep the unresolved path
  }
  return candidates.some((candidate) => candidate === self || candidate === resolvedSelf);
}

if (isDirectEntrypoint()) {
  void main();
}
