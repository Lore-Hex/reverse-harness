import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { isCanaryRequest } from "./canary.js";
import {
  AutomatedResponseError,
  type AutomatedResponder,
  type AutomatedRequestContext,
} from "./automated.js";
import { TaskQueue, type QueueTask } from "./queue.js";
import {
  chatCompletion,
  chatCompletionChunk,
  declineError,
  openAIError,
  sseData,
  usageChunk,
  usageFor,
} from "./render.js";
import { timingSafeStringEqual, verifySignature } from "./signature.js";
import type {
  AnswerTransport,
  ChatCompletionRequest,
  HarnessState,
  HarnessMode,
  ModelKind,
  OwnerModelRuntime,
  TimeoutBudgets,
  TimeoutKind,
  Usage,
} from "./types.js";
import { KIND_BUDGETS } from "./types.js";

const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024;
const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_SSE_LINE_BYTES = 1024 * 1024;
// JSON can expand a control character to six ASCII bytes. This keeps a content
// delta below the 1 MiB SSE-line cap even in that worst case.
const MAX_SSE_CONTENT_BYTES = 160 * 1024;

export type LogLevel = "info" | "warn" | "error";
export type HarnessLogger = (level: LogLevel, message: string) => void;

export interface HarnessServerOptions {
  signingSecret: string;
  modelId: string;
  uiToken: string;
  requireBearer?: string;
  supportsStreaming?: boolean;
  maxConcurrency?: number;
  kind?: ModelKind;
  budgets?: TimeoutBudgets;
  declineStatus?: number;
  verbose?: boolean;
  uiDirectory?: string;
  logger?: HarnessLogger;
  mode?: HarnessMode;
  responder?: AutomatedResponder;
  uiEnabled?: boolean;
}

interface PendingAnswer {
  task: QueueTask;
  response: ServerResponse;
  answer: string;
  answerBytes: number;
  streamBytes: number;
  includeUsage: boolean;
  abortController: AbortController;
}

interface UiAnswerBody {
  taskId: string;
  content: string;
  final: boolean;
}

export class HarnessServer {
  private readonly httpServer: Server;
  private readonly queue: TaskQueue;
  private readonly pending = new Map<string, PendingAnswer>();
  private readonly uiClients = new Set<ServerResponse>();
  private readonly assets = new Map<string, { body: Buffer; contentType: string }>();
  private readonly logger: HarnessLogger;
  private readonly signingSecret: string;
  private readonly requireBearer: string | undefined;
  private readonly uiToken: string;
  private readonly modelId: string;
  private readonly declineStatus: number;
  private readonly verbose: boolean;
  private readonly uiDirectory: string;
  private readonly mode: HarnessMode;
  private readonly responder: AutomatedResponder | undefined;
  private readonly uiEnabled: boolean;
  private streamMode: boolean;
  private currentKind: ModelKind;
  private listeningPort: number | undefined;
  private onClock = false;
  private tunnelUrl: string | undefined;
  private earnings: number | string | undefined;
  private health: HarnessState["health"];

  constructor(options: HarnessServerOptions) {
    this.signingSecret = options.signingSecret;
    this.modelId = options.modelId;
    this.uiToken = options.uiToken;
    this.requireBearer = options.requireBearer;
    this.streamMode = options.supportsStreaming ?? true;
    this.declineStatus = options.declineStatus ?? 422;
    this.verbose = options.verbose ?? false;
    this.logger = options.logger ?? defaultLogger;
    const kind = options.kind ?? "human";
    this.currentKind = kind;
    this.mode = options.mode ?? "human";
    this.responder = options.responder;
    this.uiEnabled = options.uiEnabled ?? true;
    if (this.mode === "human" && this.responder) throw new Error("human mode cannot use an automated responder");
    if (this.mode !== "human" && !this.responder) throw new Error(`${this.mode} mode requires an automated responder`);
    this.queue = new TaskQueue(options.maxConcurrency ?? 1, options.budgets ?? KIND_BUDGETS[kind]);
    this.uiDirectory = options.uiDirectory ?? fileURLToPath(new URL("../ui", import.meta.url));
    this.httpServer = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => this.handleUnexpected(response, error));
    });

    this.queue.on("changed", () => this.broadcastState());
    this.queue.on("timeout", (task: QueueTask, kindValue: TimeoutKind) => this.handleTimeout(task, kindValue));
  }

  get port(): number {
    if (this.listeningPort === undefined) throw new Error("Server has not started");
    return this.listeningPort;
  }

  get localUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get dashboardUrl(): string {
    return `${this.localUrl}/?token=${encodeURIComponent(this.uiToken)}`;
  }

  async start(port = 0, host = "127.0.0.1"): Promise<void> {
    if (this.uiEnabled) await this.loadAssets();
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.httpServer.once("error", onError);
      this.httpServer.listen(port, host, () => {
        this.httpServer.off("error", onError);
        const address = this.httpServer.address();
        if (!address || typeof address === "string") {
          reject(new Error("Could not determine listening port"));
          return;
        }
        this.listeningPort = address.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.onClock = false;
    this.broadcastState();
    for (const client of this.uiClients) client.end();
    this.uiClients.clear();
    for (const pending of this.pending.values()) {
      pending.abortController.abort(new Error("server stopping"));
      pending.response.destroy();
    }
    this.pending.clear();
    this.queue.cancelAll();
    if (this.httpServer.listening) {
      await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
    }
    await this.responder?.close?.();
    this.listeningPort = undefined;
  }

  setTunnelUrl(value: string): void {
    this.tunnelUrl = value;
    this.broadcastState();
  }

  setOnClock(value: boolean): void {
    this.onClock = value;
    this.broadcastState();
  }

  applyOwnerRuntime(runtime: OwnerModelRuntime): void {
    if (runtime.maxConcurrency !== undefined) this.queue.setMaxConcurrency(runtime.maxConcurrency);
    if (runtime.budgets !== undefined) this.queue.setBudgets(runtime.budgets);
    if (runtime.kind !== undefined) {
      this.currentKind = runtime.kind;
      if (runtime.budgets === undefined) this.queue.setBudgets(KIND_BUDGETS[runtime.kind]);
    }
    if (runtime.supportsStreaming !== undefined && runtime.supportsStreaming !== this.streamMode) {
      this.logger(
        "warn",
        `TRANSPORT CHANGED: owner API reports supports_streaming=${String(runtime.supportsStreaming)}; using the registered mode.`,
      );
      this.streamMode = runtime.supportsStreaming;
    }
    if (runtime.earnings !== undefined) this.earnings = runtime.earnings;
    this.broadcastState();
  }

  getState(): HarnessState {
    const state: HarnessState = {
      modelId: this.modelId,
      mode: this.mode,
      onClock: this.onClock,
      supportsStreaming: this.streamMode,
      maxConcurrency: this.queue.maxConcurrency,
      queue: this.queue.list(),
      history: [...this.queue.history],
    };
    if (this.tunnelUrl !== undefined) state.tunnelUrl = this.tunnelUrl;
    if (this.earnings !== undefined) state.earnings = this.earnings;
    if (this.health !== undefined) state.health = this.health;
    return state;
  }

  async checkAutomatedHealth(): Promise<string | undefined> {
    if (!this.responder) return undefined;
    this.health = { status: "checking", label: "checking" };
    this.broadcastState();
    try {
      const label = await this.responder.healthCheck();
      this.health = { status: "healthy", label };
      this.broadcastState();
      return label;
    } catch (error) {
      this.health = { status: "unhealthy", label: error instanceof Error ? error.message : String(error) };
      this.broadcastState();
      throw error;
    }
  }

  private async loadAssets(): Promise<void> {
    const definitions = [
      ["/", "index.html", "text/html; charset=utf-8"],
      ["/app.js", "app.js", "text/javascript; charset=utf-8"],
      ["/app.css", "app.css", "text/css; charset=utf-8"],
    ] as const;
    await Promise.all(
      definitions.map(async ([route, filename, contentType]) => {
        const body = await readFile(join(this.uiDirectory, filename));
        this.assets.set(route, { body, contentType });
      }),
    );
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://reverse-harness.local");

    if (request.method === "GET" && this.assets.has(url.pathname)) {
      this.serveAsset(response, url.pathname);
      return;
    }
    if (request.method === "GET" && url.pathname === "/events") {
      this.handleUiEvents(request, response, url);
      return;
    }
    if (request.method === "POST" && url.pathname === "/answer") {
      await this.handleUiAnswer(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/decline") {
      await this.handleUiDecline(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/chat/completions") {
      await this.handleCompletionRequest(request, response);
      return;
    }
    this.sendError(response, 404, "Route not found.", "invalid_request_error", "not_found");
  }

  private serveAsset(response: ServerResponse, pathname: string): void {
    const asset = this.assets.get(pathname);
    if (!asset) return;
    response.writeHead(200, {
      "Content-Type": asset.contentType,
      "Content-Length": asset.body.length,
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    response.end(asset.body);
  }

  private handleUiEvents(request: IncomingMessage, response: ServerResponse, url: URL): void {
    const token = url.searchParams.get("token");
    if (!token || !timingSafeStringEqual(token, this.uiToken)) {
      this.sendError(response, 401, "Invalid local UI session.", "authentication_error", "invalid_ui_token");
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write("retry: 1000\n\n");
    this.uiClients.add(response);
    this.writeUiState(response);

    const keepalive = setInterval(() => response.write(": keepalive\n\n"), 15_000);
    keepalive.unref?.();
    request.once("close", () => {
      clearInterval(keepalive);
      this.uiClients.delete(response);
    });
  }

  private async handleUiAnswer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.authorizeUiRequest(request, response)) return;
    if (this.mode !== "human") {
      this.sendError(response, 409, "This dashboard is a monitor in automated mode.", "invalid_request_error", "monitor_only");
      return;
    }
    const body = await this.readJson<UiAnswerBody>(request);
    if (!body || typeof body.taskId !== "string" || typeof body.content !== "string" || typeof body.final !== "boolean") {
      this.sendError(response, 400, "Expected taskId, content, and final.", "invalid_request_error", "invalid_answer");
      return;
    }
    const pending = this.pending.get(body.taskId);
    if (!pending || !this.queue.get(body.taskId)) {
      this.sendError(response, 404, "Task is no longer active.", "invalid_request_error", "task_not_found");
      return;
    }

    const addedBytes = Buffer.byteLength(body.content);
    if (pending.answerBytes + addedBytes > MAX_STREAM_BYTES) {
      this.sendError(response, 413, "Answer exceeds the 64 MiB contract limit.", "invalid_request_error", "answer_too_large");
      return;
    }
    pending.answer += body.content;
    pending.answerBytes += addedBytes;

    try {
      if (pending.task.transport === "stream" && body.content.length > 0) {
        for (const content of splitUtf8(body.content, MAX_SSE_CONTENT_BYTES)) {
          this.writeStreamFrame(pending, chatCompletionChunk(pending.task.id, pending.task.request.model, content));
        }
      }
      if (body.final) this.finishAnswer(pending);
    } catch (error) {
      const answerError = error instanceof AutomatedResponseError
        ? error
        : new AutomatedResponseError("Could not write answer stream.", 502, "stream_write_error");
      this.failPendingAnswer(pending, answerError);
      this.sendError(response, 413, answerError.message, "invalid_request_error", answerError.code);
      return;
    }
    this.sendJson(response, 200, { ok: true });
  }

  private async handleUiDecline(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.authorizeUiRequest(request, response)) return;
    if (this.mode !== "human") {
      this.sendError(response, 409, "This dashboard is a monitor in automated mode.", "invalid_request_error", "monitor_only");
      return;
    }
    const body = await this.readJson<{ taskId?: unknown }>(request);
    if (!body || typeof body.taskId !== "string") {
      this.sendError(response, 400, "Expected taskId.", "invalid_request_error", "invalid_decline");
      return;
    }
    const pending = this.pending.get(body.taskId);
    if (!pending || !this.queue.get(body.taskId)) {
      this.sendError(response, 404, "Task is no longer active.", "invalid_request_error", "task_not_found");
      return;
    }
    if (pending.response.headersSent) {
      this.sendError(
        response,
        409,
        "Cannot decline after live output has started; finish the answer instead.",
        "invalid_request_error",
        "answer_already_started",
      );
      return;
    }

    this.pending.delete(body.taskId);
    this.queue.complete(body.taskId, "declined");
    this.sendJson(pending.response, this.declineStatus, declineError());
    this.logger("info", `declined id=${shortId(body.taskId)} status=${this.declineStatus} (no owner strike)`);
    this.sendJson(response, 200, { ok: true });
  }

  private async handleCompletionRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let rawBody: Buffer;
    try {
      rawBody = await readBody(request, DEFAULT_BODY_LIMIT);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        this.sendError(response, 413, "Request body is too large.", "invalid_request_error", "body_too_large");
        return;
      }
      throw error;
    }

    const verification = verifySignature(request.headers["tr-signature"], this.signingSecret, rawBody);
    if (!verification.ok) {
      this.sendError(
        response,
        401,
        `Invalid TR-Signature (${verification.reason}).`,
        "authentication_error",
        "invalid_signature",
      );
      return;
    }
    if (this.requireBearer !== undefined) {
      const authorization = request.headers.authorization;
      const expected = `Bearer ${this.requireBearer}`;
      if (!authorization || !timingSafeStringEqual(authorization, expected)) {
        this.sendError(response, 401, "Invalid bearer token.", "authentication_error", "invalid_bearer");
        return;
      }
    }

    let completionRequest: ChatCompletionRequest;
    try {
      completionRequest = JSON.parse(rawBody.toString("utf8")) as ChatCompletionRequest;
    } catch {
      this.sendError(response, 400, "Body must be valid JSON.", "invalid_request_error", "invalid_json");
      return;
    }
    if (!isCompletionRequest(completionRequest)) {
      this.sendError(
        response,
        400,
        "Body must include model and messages.",
        "invalid_request_error",
        "invalid_chat_request",
      );
      return;
    }
    if (this.verbose) this.logger("info", `request body=${rawBody.toString("utf8")}`);

    if (completionRequest.stream !== this.streamMode) {
      this.logger(
        "warn",
        `TRANSPORT MISMATCH: request stream=${String(completionRequest.stream)} but harness is registered with supports_streaming=${String(this.streamMode)}; answering in the registered mode.`,
      );
    }
    const transport: AnswerTransport = this.streamMode ? "stream" : "json";

    if (isCanaryRequest(completionRequest)) {
      this.answerCanary(response, completionRequest, transport);
      this.logger("info", "canary answered automatically");
      return;
    }

    const task = this.queue.enqueue(completionRequest, transport);
    if (!task) {
      response.setHeader("Retry-After", "1");
      this.sendError(response, 429, "Reverse harness is at capacity.", "rate_limit_error", "at_capacity");
      return;
    }

    response.setTimeout(0);
    const pending: PendingAnswer = {
      task,
      response,
      answer: "",
      answerBytes: 0,
      streamBytes: 0,
      includeUsage: completionRequest.stream_options?.include_usage === true,
      abortController: new AbortController(),
    };
    this.pending.set(task.id, pending);
    response.once("close", () => {
      if (this.pending.get(task.id) !== pending || response.writableFinished) return;
      this.pending.delete(task.id);
      pending.abortController.abort(new Error("caller disconnected"));
      this.queue.complete(task.id, "disconnected");
      this.logger("info", `caller disconnected id=${shortId(task.id)} (no owner strike)`);
    });
    this.logger("info", `queued id=${shortId(task.id)} transport=${transport} active=${this.queue.size}/${this.queue.maxConcurrency}`);
    if (this.responder) void this.runAutomated(pending);
  }

  private answerCanary(
    response: ServerResponse,
    request: ChatCompletionRequest,
    transport: AnswerTransport,
  ): void {
    const taskId = `canary-${Date.now().toString(36)}`;
    const usage = usageFor(request, "pong");
    if (transport === "stream") {
      this.setStreamHeaders(response);
      response.write(sseData(chatCompletionChunk(taskId, request.model, "pong")));
      response.write(sseData(chatCompletionChunk(taskId, request.model, undefined, "stop")));
      if (request.stream_options?.include_usage === true) {
        response.write(sseData(usageChunk(taskId, request.model, usage)));
      }
      response.end(sseData("[DONE]"));
      return;
    }
    this.sendJson(response, 200, chatCompletion(taskId, request.model, "pong", usage));
  }

  private finishAnswer(
    pending: PendingAnswer,
    reportedUsage?: Usage,
    framing: { finishChunkSent?: boolean; usageChunkSent?: boolean } = {},
  ): void {
    if (this.pending.get(pending.task.id) !== pending) return;
    const usage = reportedUsage ?? usageFor(pending.task.request, pending.answer);

    if (pending.task.transport === "stream") {
      if (!framing.finishChunkSent) {
        this.writeStreamFrame(
          pending,
          chatCompletionChunk(pending.task.id, pending.task.request.model, undefined, "stop"),
        );
      }
      if (pending.includeUsage && !framing.usageChunkSent) {
        this.writeStreamFrame(pending, usageChunk(pending.task.id, pending.task.request.model, usage));
      }
      this.queue.markByte(pending.task.id);
      const done = sseData("[DONE]");
      if (pending.streamBytes + Buffer.byteLength(done) > MAX_STREAM_BYTES) {
        pending.response.destroy(new Error("Stream exceeded the 64 MiB contract limit"));
      } else {
        pending.response.end(done);
      }
    } else {
      this.queue.markByte(pending.task.id);
      this.sendJson(
        pending.response,
        200,
        chatCompletion(pending.task.id, pending.task.request.model, pending.answer, usage),
      );
    }

    this.pending.delete(pending.task.id);
    const history = this.queue.complete(pending.task.id, "answered", {
      completionTokens: usage.completion_tokens,
    });
    if (this.verbose) this.logger("info", `answer id=${shortId(pending.task.id)} body=${pending.answer}`);
    this.logger(
      "info",
      `answered id=${shortId(pending.task.id)} ttft_ms=${history?.ttftMs ?? 0} total_ms=${history?.totalMs ?? 0} tokens=${usage.completion_tokens}`,
    );
  }

  private writeStreamFrame(pending: PendingAnswer, value: unknown): void {
    const frame = sseData(value);
    const bytes = Buffer.byteLength(frame);
    if (bytes > MAX_SSE_LINE_BYTES) {
      throw new AutomatedResponseError("SSE line exceeded the 1 MiB contract limit.", 502, "sse_line_too_large");
    }
    if (pending.streamBytes + bytes + Buffer.byteLength(sseData("[DONE]")) > MAX_STREAM_BYTES) {
      throw new AutomatedResponseError("Stream exceeded the 64 MiB contract limit.", 502, "answer_too_large");
    }
    if (!pending.response.headersSent) this.setStreamHeaders(pending.response);
    this.queue.markByte(pending.task.id);
    pending.streamBytes += bytes;
    pending.response.write(frame);
  }

  private setStreamHeaders(response: ServerResponse): void {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
  }

  private handleTimeout(task: QueueTask, kind: TimeoutKind): void {
    const pending = this.pending.get(task.id);
    if (pending) {
      this.pending.delete(task.id);
      pending.abortController.abort(new Error(`${kind} budget exceeded`));
      pending.response.destroy(new Error(`TrustedRouter ${kind} budget exceeded`));
    }
    this.logger("error", `OWNER FAULT: timeout=${kind} id=${shortId(task.id)} (this is a strike)`);
  }

  private async runAutomated(pending: PendingAnswer): Promise<void> {
    const responder = this.responder;
    if (!responder) return;
    const context: AutomatedRequestContext = {
      id: pending.task.id,
      request: pending.task.request,
      transport: pending.task.transport,
      kind: this.currentKind,
      budgets: pending.task.budgets,
      signal: pending.abortController.signal,
      sink: {
        delta: (content) => this.automatedDelta(pending, content),
        chunk: (value, contentDelta) => this.automatedChunk(pending, value, contentDelta),
        completion: (value, content, usage) => this.automatedCompletion(pending, value, content, usage),
        finish: (usage, framing) => this.finishAnswer(pending, usage, framing),
      },
    };
    try {
      await responder.respond(context);
    } catch (error) {
      if (this.pending.get(pending.task.id) !== pending) return;
      this.pending.delete(pending.task.id);
      const automatedError = error instanceof AutomatedResponseError
        ? error
        : new AutomatedResponseError("Automated responder failed.", 502, "automated_responder_error");
      pending.abortController.abort(automatedError);
      const responseAlreadyStarted = pending.response.headersSent;
      if (responseAlreadyStarted) {
        pending.response.destroy(automatedError);
      } else {
        this.sendError(
          pending.response,
          automatedError.status,
          automatedError.message,
          automatedError.status >= 500 ? "provider_error" : "request_declined",
          automatedError.code,
        );
      }
      const outcome = !responseAlreadyStarted && automatedError.status >= 400 && automatedError.status < 500 && automatedError.status !== 429
        ? "declined"
        : "failed";
      this.queue.complete(pending.task.id, outcome);
      this.logger(
        automatedError.status >= 500 ? "error" : "info",
        `${outcome} id=${shortId(pending.task.id)} status=${automatedError.status} code=${automatedError.code}`,
      );
    }
  }

  private automatedDelta(pending: PendingAnswer, content: string): void {
    if (this.pending.get(pending.task.id) !== pending || content.length === 0) return;
    this.appendAutomatedContent(pending, content);
    if (pending.task.transport === "stream") {
      for (const part of splitUtf8(content, MAX_SSE_CONTENT_BYTES)) {
        this.writeStreamFrame(pending, chatCompletionChunk(pending.task.id, pending.task.request.model, part));
      }
    }
  }

  private automatedChunk(pending: PendingAnswer, value: unknown, contentDelta?: string): void {
    if (this.pending.get(pending.task.id) !== pending) return;
    if (contentDelta) this.appendAutomatedContent(pending, contentDelta);
    if (pending.task.transport === "stream") this.writeStreamFrame(pending, value);
  }

  private automatedCompletion(
    pending: PendingAnswer,
    value: unknown,
    content = "",
    usage?: Usage,
  ): void {
    if (this.pending.get(pending.task.id) !== pending) return;
    if (pending.task.transport !== "json") {
      throw new AutomatedResponseError("Responder emitted JSON on a streaming sink.", 502, "transport_error");
    }
    if (content) this.appendAutomatedContent(pending, content);
    this.queue.markByte(pending.task.id);
    this.sendJson(pending.response, 200, value);
    this.pending.delete(pending.task.id);
    const effectiveUsage = usage ?? usageFor(pending.task.request, pending.answer);
    const history = this.queue.complete(pending.task.id, "answered", {
      completionTokens: effectiveUsage.completion_tokens,
    });
    this.logger(
      "info",
      `answered id=${shortId(pending.task.id)} ttft_ms=${history?.ttftMs ?? 0} total_ms=${history?.totalMs ?? 0} tokens=${effectiveUsage.completion_tokens}`,
    );
  }

  private appendAutomatedContent(pending: PendingAnswer, content: string): void {
    const addedBytes = Buffer.byteLength(content);
    if (pending.answerBytes + addedBytes > MAX_STREAM_BYTES) {
      throw new AutomatedResponseError("Automated answer exceeded the 64 MiB contract limit.", 502, "answer_too_large");
    }
    pending.answer += content;
    pending.answerBytes += addedBytes;
  }

  private failPendingAnswer(pending: PendingAnswer, error: AutomatedResponseError): void {
    if (this.pending.get(pending.task.id) !== pending) return;
    this.pending.delete(pending.task.id);
    pending.abortController.abort(error);
    if (pending.response.headersSent) pending.response.destroy(error);
    else this.sendError(pending.response, error.status, error.message, "provider_error", error.code);
    this.queue.complete(pending.task.id, "failed");
    this.logger("error", `failed id=${shortId(pending.task.id)} status=${error.status} code=${error.code}`);
  }

  private authorizeUiRequest(request: IncomingMessage, response: ServerResponse): boolean {
    const token = request.headers["x-reverse-harness-ui-token"];
    if (typeof token !== "string" || !timingSafeStringEqual(token, this.uiToken)) {
      this.sendError(response, 401, "Invalid local UI session.", "authentication_error", "invalid_ui_token");
      return false;
    }
    return true;
  }

  private async readJson<T>(request: IncomingMessage): Promise<T | undefined> {
    try {
      const raw = await readBody(request, DEFAULT_BODY_LIMIT);
      return JSON.parse(raw.toString("utf8")) as T;
    } catch (error) {
      if (error instanceof BodyTooLargeError) return undefined;
      return undefined;
    }
  }

  private broadcastState(): void {
    for (const client of this.uiClients) this.writeUiState(client);
  }

  private writeUiState(response: ServerResponse): void {
    if (response.destroyed || response.writableEnded) return;
    response.write(`event: state\ndata: ${JSON.stringify(this.getState())}\n\n`);
  }

  private sendError(response: ServerResponse, status: number, message: string, type: string, code: string): void {
    this.sendJson(response, status, openAIError(message, type, code));
  }

  private sendJson(response: ServerResponse, status: number, value: unknown): void {
    if (response.headersSent) return;
    const body = Buffer.from(JSON.stringify(value));
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(body);
  }

  private handleUnexpected(response: ServerResponse, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger("error", `server error: ${message}`);
    if (!response.headersSent) {
      this.sendError(response, 500, "Internal reverse-harness error.", "server_error", "internal_error");
    } else {
      response.destroy();
    }
  }
}

class BodyTooLargeError extends Error {}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let tooLarge = false;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
    bytes += chunk.length;
    if (bytes > limit) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (tooLarge) throw new BodyTooLargeError("Body too large");
  return Buffer.concat(chunks, bytes);
}

function isCompletionRequest(value: unknown): value is ChatCompletionRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<ChatCompletionRequest>;
  return typeof request.model === "string" && Array.isArray(request.messages);
}

function splitUtf8(value: string, maxBytes: number): string[] {
  if (Buffer.byteLength(value) <= maxBytes) return [value];
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character);
    if (currentBytes + bytes > maxBytes && current.length > 0) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function defaultLogger(level: LogLevel, message: string): void {
  const line = `[reverse-harness] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
