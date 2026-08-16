const params = new URLSearchParams(window.location.search);
const uiToken = params.get("token");

const elements = {
  modelId: document.querySelector("#model-id"),
  clockPill: document.querySelector("#clock-pill"),
  connection: document.querySelector("#connection-label"),
  tunnel: document.querySelector("#tunnel-url"),
  earningsWrap: document.querySelector("#earnings-wrap"),
  earnings: document.querySelector("#earnings"),
  healthWrap: document.querySelector("#health-wrap"),
  healthTitle: document.querySelector("#health-title"),
  health: document.querySelector("#health"),
  alert: document.querySelector("#alert"),
  taskHeading: document.querySelector("#task-heading"),
  transport: document.querySelector("#transport-badge"),
  composerPanel: document.querySelector("#composer-panel"),
  transcript: document.querySelector("#transcript"),
  answer: document.querySelector("#answer"),
  live: document.querySelector("#live-toggle"),
  composerNote: document.querySelector("#composer-note"),
  send: document.querySelector("#send"),
  decline: document.querySelector("#decline"),
  phase: document.querySelector("#timer-phase"),
  firstTimer: document.querySelector("#first-byte-timer"),
  idleTimer: document.querySelector("#idle-timer"),
  totalTimer: document.querySelector("#total-timer"),
  firstMeter: document.querySelector("#first-byte-meter"),
  idleMeter: document.querySelector("#idle-meter"),
  totalMeter: document.querySelector("#total-meter"),
  queueCount: document.querySelector("#queue-count"),
  queue: document.querySelector("#queue"),
  history: document.querySelector("#history"),
};

let harnessState;
let activeTaskId;
let activeRenderedId;
let liveTimer;
let sending = false;
let lastHistoryKey;
const drafts = new Map();
const requestChains = new Map();

if (!uiToken) {
  showAlert("This dashboard URL is missing its local session token. Reopen the exact URL printed by reverse-harness.", true);
  elements.connection.textContent = "Local UI authentication required";
} else {
  connectEvents();
}

function connectEvents() {
  const source = new EventSource(`/events?token=${encodeURIComponent(uiToken)}`);
  source.addEventListener("open", () => {
    elements.connection.textContent = "Connected to local server";
  });
  source.addEventListener("state", (event) => {
    try {
      harnessState = JSON.parse(event.data);
      elements.connection.textContent = "Connected to local server";
      render();
    } catch {
      showAlert("The local server sent an unreadable state update.", true);
    }
  });
  source.addEventListener("error", () => {
    elements.connection.textContent = "Reconnecting to local server…";
  });
}

function render() {
  if (!harnessState) return;
  elements.modelId.textContent = harnessState.modelId;
  const automated = harnessState.mode !== "human";
  document.body.classList.toggle("monitor-mode", automated);
  elements.composerPanel.hidden = automated;
  elements.clockPill.classList.toggle("on", harnessState.onClock);
  elements.clockPill.classList.toggle("off", !harnessState.onClock);
  elements.clockPill.lastChild.textContent = harnessState.onClock ? "On the clock" : "Off the clock";

  if (harnessState.tunnelUrl) {
    elements.tunnel.textContent = harnessState.tunnelUrl;
    elements.tunnel.href = harnessState.tunnelUrl;
    elements.tunnel.target = "_blank";
    elements.tunnel.rel = "noreferrer";
  } else {
    elements.tunnel.textContent = "Not connected";
    elements.tunnel.removeAttribute("href");
    elements.tunnel.removeAttribute("target");
  }
  if (harnessState.earnings !== undefined) {
    elements.earningsWrap.hidden = false;
    elements.earnings.textContent = String(harnessState.earnings);
  } else {
    elements.earningsWrap.hidden = true;
  }
  if (harnessState.health) {
    elements.healthWrap.hidden = false;
    elements.healthTitle.textContent = `${harnessState.mode} health`;
    elements.health.textContent = `${harnessState.health.status} · ${harnessState.health.label}`;
  } else {
    elements.healthWrap.hidden = true;
  }
  elements.transport.textContent = harnessState.supportsStreaming ? "SSE LIVE" : "ONE JSON";
  elements.live.disabled = !harnessState.supportsStreaming;
  if (!harnessState.supportsStreaming) elements.live.checked = false;

  const tasks = harnessState.queue;
  if (!activeTaskId || !tasks.some((task) => task.id === activeTaskId)) {
    activeTaskId = tasks[0]?.id;
  }
  for (const task of tasks) {
    if (!drafts.has(task.id)) drafts.set(task.id, { text: "", sent: "" });
  }
  renderQueue(tasks);
  renderActive(tasks.find((task) => task.id === activeTaskId));
  renderHistory(harnessState.history);
  noticeNewOutcome(harnessState.history[0]);
}

function renderQueue(tasks) {
  elements.queueCount.textContent = `${tasks.length} / ${harnessState.maxConcurrency}`;
  elements.queue.replaceChildren();
  if (tasks.length === 0) {
    elements.queue.append(emptyRail("No requests waiting."));
    return;
  }
  for (const task of tasks) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `queue-item ${task.status}${task.id === activeTaskId ? " active" : ""}`;
    button.dataset.taskId = task.id;

    const dot = document.createElement("span");
    dot.className = "queue-dot";
    const name = document.createElement("span");
    name.className = "queue-name";
    name.textContent = task.messages.at(-1)?.role ?? "request";
    const age = document.createElement("span");
    age.className = "queue-age";
    age.textContent = ageLabel(Date.now() - task.createdAt);
    button.append(dot, name, age);
    button.addEventListener("click", () => selectTask(task.id));
    elements.queue.append(button);
  }
}

function renderActive(task) {
  if (!task) {
    activeRenderedId = undefined;
    elements.taskHeading.textContent = harnessState.mode === "human" ? "The queue is quiet." : `${harnessState.mode} monitor is quiet.`;
    elements.transcript.className = "transcript empty-state";
    elements.transcript.replaceChildren();
    const mark = document.createElement("div");
    mark.className = "empty-mark";
    mark.textContent = "_";
    const message = document.createElement("p");
    message.textContent = harnessState.mode === "human"
      ? "Stay on this tab. The next prompt will appear here."
      : "Requests will appear here while the local backend answers them automatically.";
    elements.transcript.append(mark, message);
    elements.answer.value = "";
    elements.answer.disabled = true;
    elements.answer.placeholder = "A request will unlock this field…";
    elements.send.disabled = true;
    elements.decline.disabled = true;
    elements.composerNote.textContent = "Live mode sends append-only batches as you type.";
    return;
  }

  elements.taskHeading.textContent = `Request ${task.id.slice(0, 8)}`;
  if (activeRenderedId !== task.id) {
    activeRenderedId = task.id;
    renderTranscript(task.messages);
  }
  const draft = drafts.get(task.id);
  if (elements.answer.value !== draft.text) elements.answer.value = draft.text;
  elements.answer.disabled = false;
  elements.answer.placeholder = harnessState.supportsStreaming
    ? "Start typing. In Live mode, each pause crosses the wire…"
    : "Type the complete answer, then send it as one response…";
  elements.send.disabled = sending;
  elements.decline.disabled = sending || task.firstByteAt !== undefined;
  elements.decline.title = task.firstByteAt === undefined
    ? "Return an HTTP 4xx. This does not count as an owner fault."
    : "An HTTP 200 stream has begun, so this request can no longer be declined.";

  if (!harnessState.supportsStreaming) {
    elements.composerNote.textContent = "Non-streaming mode holds everything until Send.";
  } else if (task.firstByteAt !== undefined) {
    elements.composerNote.textContent = "Output is live and append-only. Finish the answer; HTTP decline is no longer possible.";
  } else if (elements.live.checked) {
    elements.composerNote.textContent = "Live mode sends append-only batches about 80ms after each pause.";
  } else {
    elements.composerNote.textContent = "Send-at-end mode holds new text locally until Send.";
  }
}

function renderTranscript(messages) {
  elements.transcript.className = "transcript";
  elements.transcript.replaceChildren();
  for (const message of messages) {
    const article = document.createElement("article");
    article.className = "message";
    const role = document.createElement("div");
    role.className = "message-role";
    role.textContent = message.role;
    const content = document.createElement("pre");
    content.className = "message-content";
    content.textContent = displayContent(message.content, message);
    article.append(role, content);
    elements.transcript.append(article);
  }
  elements.transcript.scrollTop = elements.transcript.scrollHeight;
}

function displayContent(content, message) {
  if (typeof content === "string") return content;
  if (content === undefined && message.tool_calls) return JSON.stringify(message.tool_calls, null, 2);
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content ?? "");
  }
}

function renderHistory(history) {
  elements.history.replaceChildren();
  if (history.length === 0) {
    elements.history.append(emptyRail("No answers this shift."));
    return;
  }
  for (const item of history) {
    const row = document.createElement("div");
    row.className = "history-item";
    const id = document.createElement("span");
    id.className = "history-id";
    id.textContent = item.id.slice(0, 8);
    const metric = document.createElement("span");
    metric.className = "history-metric";
    const ttft = item.ttftMs === undefined ? "—" : formatDuration(item.ttftMs);
    const tokens = item.completionTokens === undefined ? "— tok" : `${item.completionTokens} tok`;
    metric.textContent = `${ttft} TTFT · ${tokens}`;
    const outcome = document.createElement("span");
    outcome.className = `history-outcome ${item.outcome}`;
    outcome.textContent = item.timeoutKind ? `${item.outcome.replace("_", " ")} / ${item.timeoutKind.replace("_", " ")}` : item.outcome.replace("_", " ");
    row.append(id, metric, outcome);
    elements.history.append(row);
  }
}

function noticeNewOutcome(item) {
  if (!item) return;
  const key = `${item.id}:${item.finishedAt}`;
  if (!lastHistoryKey) {
    lastHistoryKey = key;
    return;
  }
  if (lastHistoryKey === key) return;
  lastHistoryKey = key;
  if (item.outcome === "timed_out") {
    showAlert(`Request ${item.id.slice(0, 8)} exceeded its ${item.timeoutKind.replace("_", "-")} budget. The connection was closed; this is an owner fault / strike.`, true);
  } else if (item.outcome === "declined") {
    showAlert(`Request ${item.id.slice(0, 8)} declined with HTTP 4xx. No owner strike.`);
  }
}

function selectTask(taskId) {
  if (activeTaskId === taskId) return;
  flushLive();
  activeTaskId = taskId;
  activeRenderedId = undefined;
  render();
  elements.answer.focus();
}

elements.answer.addEventListener("input", () => {
  const task = activeTask();
  if (!task) return;
  const draft = drafts.get(task.id);
  if (harnessState.supportsStreaming && draft.sent && !elements.answer.value.startsWith(draft.sent)) {
    elements.answer.value = draft.text;
    showAlert("Live text has already crossed the wire and cannot be edited. You can only append to it.");
    return;
  }
  draft.text = elements.answer.value;
  if (harnessState.supportsStreaming && elements.live.checked) {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(flushLive, 80);
  }
});

elements.live.addEventListener("change", () => {
  if (elements.live.checked) flushLive();
  render();
});

elements.send.addEventListener("click", () => void sendAnswer());
elements.decline.addEventListener("click", () => void declineTask());

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    void sendAnswer();
    return;
  }
  if (event.key === "Escape") {
    const task = activeTask();
    if (task && task.firstByteAt === undefined) {
      event.preventDefault();
      void declineTask();
    }
    return;
  }
  if (event.key === "/" && document.activeElement !== elements.answer && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    elements.answer.focus();
  }
});

function flushLive() {
  clearTimeout(liveTimer);
  const task = activeTask();
  if (!task || !harnessState.supportsStreaming || !elements.live.checked) return;
  const draft = drafts.get(task.id);
  const delta = draft.text.slice(draft.sent.length);
  if (!delta) return;
  draft.sent = draft.text;
  void enqueueTaskRequest(task.id, "/answer", { taskId: task.id, content: delta, final: false }).catch((error) => {
    showAlert(error.message, true);
  });
}

async function sendAnswer() {
  const task = activeTask();
  if (!task || sending) return;
  clearTimeout(liveTimer);
  const draft = drafts.get(task.id);
  const content = harnessState.supportsStreaming ? draft.text.slice(draft.sent.length) : draft.text;
  draft.sent = draft.text;
  sending = true;
  render();
  try {
    await enqueueTaskRequest(task.id, "/answer", { taskId: task.id, content, final: true });
  } catch (error) {
    showAlert(error.message, true);
  } finally {
    sending = false;
    render();
  }
}

async function declineTask() {
  const task = activeTask();
  if (!task || sending || task.firstByteAt !== undefined) return;
  clearTimeout(liveTimer);
  sending = true;
  render();
  try {
    await enqueueTaskRequest(task.id, "/decline", { taskId: task.id });
  } catch (error) {
    showAlert(error.message, true);
  } finally {
    sending = false;
    render();
  }
}

function enqueueTaskRequest(taskId, path, body) {
  const previous = requestChains.get(taskId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => post(path, body));
  requestChains.set(taskId, next);
  const clean = () => {
    if (requestChains.get(taskId) === next) requestChains.delete(taskId);
  };
  void next.then(clean, clean);
  return next;
}

async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Reverse-Harness-UI-Token": uiToken,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let message = `Local server returned HTTP ${response.status}.`;
    try {
      const value = await response.json();
      if (value.error?.message) message = value.error.message;
    } catch {
      // Keep the status-based message.
    }
    throw new Error(message);
  }
}

function activeTask() {
  return harnessState?.queue.find((task) => task.id === activeTaskId);
}

function renderTimers() {
  const task = activeTask();
  if (!task) {
    setTimer(elements.firstTimer, elements.firstMeter, undefined);
    setTimer(elements.idleTimer, elements.idleMeter, undefined);
    setTimer(elements.totalTimer, elements.totalMeter, undefined);
    elements.phase.textContent = "WAITING";
    return;
  }
  const now = Date.now();
  const firstElapsed = now - task.createdAt;
  const firstTotal = task.budgets.firstByteSeconds * 1000;
  const totalElapsed = now - task.createdAt;
  const totalTotal = task.budgets.totalSeconds * 1000;
  const idleElapsed = task.lastByteAt === undefined ? undefined : now - task.lastByteAt;
  const idleTotal = task.budgets.idleSeconds * 1000;

  setTimer(elements.firstTimer, elements.firstMeter, task.firstByteAt === undefined ? { elapsed: firstElapsed, total: firstTotal } : { done: true, elapsed: task.firstByteAt - task.createdAt, total: firstTotal });
  setTimer(elements.idleTimer, elements.idleMeter, idleElapsed === undefined ? undefined : { elapsed: idleElapsed, total: idleTotal });
  setTimer(elements.totalTimer, elements.totalMeter, { elapsed: totalElapsed, total: totalTotal });
  elements.phase.textContent = task.firstByteAt === undefined ? "TO FIRST BYTE" : "STREAMING";

  for (const item of document.querySelectorAll(".queue-item")) {
    const queued = harnessState.queue.find((candidate) => candidate.id === item.dataset.taskId);
    const age = item.querySelector(".queue-age");
    if (queued && age) age.textContent = ageLabel(now - queued.createdAt);
  }
}

function setTimer(label, meter, timing) {
  meter.className = "";
  if (!timing) {
    label.textContent = "—";
    meter.style.width = "0%";
    return;
  }
  const fraction = Math.max(0, Math.min(1, timing.elapsed / timing.total));
  const remaining = Math.max(0, timing.total - timing.elapsed);
  label.textContent = timing.done ? `${formatDuration(timing.elapsed)} ✓` : formatCountdown(remaining);
  meter.style.width = `${fraction * 100}%`;
  if (!timing.done && fraction >= 1) meter.classList.add("danger");
  else if (!timing.done && fraction >= 0.8) meter.classList.add("amber");
}

function formatCountdown(milliseconds) {
  if (milliseconds >= 60_000) {
    const minutes = Math.floor(milliseconds / 60_000);
    const seconds = Math.floor((milliseconds % 60_000) / 1000);
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function formatDuration(milliseconds) {
  return milliseconds < 10_000 ? `${(milliseconds / 1000).toFixed(1)}s` : `${Math.round(milliseconds / 1000)}s`;
}

function ageLabel(milliseconds) {
  return milliseconds < 60_000 ? `${Math.floor(milliseconds / 1000)}s` : `${Math.floor(milliseconds / 60_000)}m`;
}

function emptyRail(text) {
  const element = document.createElement("p");
  element.className = "rail-empty";
  element.textContent = text;
  return element;
}

function showAlert(message, danger = false) {
  elements.alert.hidden = false;
  elements.alert.textContent = message;
  elements.alert.classList.toggle("danger", danger);
}

setInterval(renderTimers, 250);
