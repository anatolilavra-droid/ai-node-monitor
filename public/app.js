// Vanilla ES module. No bundler, no framework - talks to the Fastify API
// directly over fetch + a hand-rolled SSE frame parser (native EventSource
// cannot send a POST body or custom headers, and Idempotency-Key is
// required on the mutating route).

const MAX_OUTPUT_CHARS = 20000; // bounded rendering during a high-token-rate stream
const READY_POLL_MS = 5000;
const RECONNECT_POLL_MS = 1000;
const MAX_RECONNECT_ATTEMPTS = 30;

const els = {
  readyBadge: document.getElementById('ready-badge'),
  form: document.getElementById('generate-form'),
  generateBtn: document.getElementById('generate-btn'),
  cancelBtn: document.getElementById('cancel-btn'),
  status: document.getElementById('run-status'),
  runId: document.getElementById('meta-run-id'),
  tokens: document.getElementById('meta-tokens'),
  duration: document.getElementById('meta-duration'),
  output: document.getElementById('output'),
  refreshRunsBtn: document.getElementById('refresh-runs-btn'),
  runsTableBody: document.querySelector('#runs-table tbody')
};

let currentRunId = null;
let reconnectTimer = null;
let reconnectAttempts = 0;

let outputBuffer = '';
let flushScheduled = false;

function scheduleOutputFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(() => {
    flushScheduled = false;
    if (outputBuffer.length > MAX_OUTPUT_CHARS) {
      outputBuffer = outputBuffer.slice(outputBuffer.length - MAX_OUTPUT_CHARS);
    }
    els.output.textContent = outputBuffer;
    els.output.scrollTop = els.output.scrollHeight;
  });
}

function appendToken(token) {
  outputBuffer += token;
  scheduleOutputFlush();
}

function resetOutput() {
  outputBuffer = '';
  els.output.textContent = '';
}

function setStatus(status) {
  els.status.textContent = status;
  els.status.className = `status status-${status}`;
}

function setReadyBadge(ready) {
  els.readyBadge.textContent = ready ? 'engine ready' : 'engine not ready';
  els.readyBadge.className = `badge ${ready ? 'badge-ready' : 'badge-not-ready'}`;
}

// All displayed numbers (tokenCount, durationMs) come straight from the
// server's run record - real engine/gateway timing, never a client-side
// simulation of throughput.
function updateMeta(run) {
  els.runId.textContent = run.id ?? '—';
  els.tokens.textContent = String(run.tokenCount ?? 0);
  els.duration.textContent = typeof run.durationMs === 'number' ? `${run.durationMs} ms` : '—';
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function setGenerating(isGenerating) {
  els.generateBtn.disabled = isGenerating;
  els.cancelBtn.disabled = !isGenerating;
}

async function* parseSseFrames(reader) {
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });

    let sepIndex = buffer.indexOf('\n\n');
    while (sepIndex !== -1) {
      const frame = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      sepIndex = buffer.indexOf('\n\n');

      let eventName = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim();
        else if (line.startsWith('data:')) data += line.slice('data:'.length).trim();
      }
      if (data) yield { eventName, data: JSON.parse(data) };
    }
  }
}

function handleServerEvent(eventName, data) {
  switch (eventName) {
    case 'run.created':
      currentRunId = data.id;
      updateMeta(data);
      setStatus(data.status);
      break;
    case 'run.status':
      setStatus(data.status);
      updateMeta(data);
      break;
    case 'token':
      appendToken(data.token);
      break;
    case 'run.completed':
    case 'run.cancelled':
    case 'run.failed':
      setStatus(data.status);
      updateMeta(data);
      setGenerating(false);
      void refreshRunsTable();
      break;
    default:
      break;
  }
}

async function reconnectPoll() {
  if (!currentRunId) {
    setStatus('failed');
    setGenerating(false);
    return;
  }

  setStatus('reconnecting');
  reconnectAttempts += 1;
  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    setStatus('failed');
    setGenerating(false);
    return;
  }

  try {
    const res = await fetch(`/runs/${currentRunId}`);
    if (res.ok) {
      const run = await res.json();
      updateMeta(run);
      const terminal = run.status === 'completed' || run.status === 'cancelled' || run.status === 'failed';
      if (terminal) {
        setStatus(run.status);
        setGenerating(false);
        void refreshRunsTable();
        return;
      }
    }
  } catch {
    // network still down; fall through to schedule another attempt.
  }

  clearReconnectTimer();
  reconnectTimer = setTimeout(() => void reconnectPoll(), RECONNECT_POLL_MS);
}

async function startGeneration(prompt, model, maxTokens) {
  resetOutput();
  setGenerating(true);
  setStatus('queued');
  currentRunId = null;
  reconnectAttempts = 0;
  clearReconnectTimer();

  const idempotencyKey = crypto.randomUUID();

  try {
    const res = await fetch('/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify({ prompt, model, maxTokens })
    });

    if (!res.ok || !res.body) {
      throw new Error(`generate request failed: ${res.status}`);
    }

    const reader = res.body.getReader();
    for await (const { eventName, data } of parseSseFrames(reader)) {
      handleServerEvent(eventName, data);
    }

    // Stream ended without a terminal event (connection dropped mid-flight).
    if (els.status.textContent === 'running' || els.status.textContent === 'queued') {
      void reconnectPoll();
    } else {
      setGenerating(false);
    }
  } catch (err) {
    console.error('generation stream error', err);
    void reconnectPoll();
  }
}

async function cancelCurrentRun() {
  if (!currentRunId) return;
  try {
    await fetch(`/runs/${currentRunId}/cancel`, {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() }
    });
  } catch (err) {
    console.error('cancel request failed', err);
  }
}

async function refreshRunsTable() {
  try {
    const res = await fetch('/runs?limit=20');
    if (!res.ok) return;
    const { runs } = await res.json();
    els.runsTableBody.innerHTML = '';
    for (const run of runs) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${run.id.slice(0, 8)}</td>
        <td>${run.status}</td>
        <td>${run.model}</td>
        <td>${run.tokenCount}</td>
        <td>${new Date(run.createdAt).toLocaleTimeString()}</td>
      `;
      els.runsTableBody.appendChild(tr);
    }
  } catch (err) {
    console.error('failed to refresh runs table', err);
  }
}

async function pollReady() {
  try {
    const res = await fetch('/ready');
    const body = await res.json();
    setReadyBadge(Boolean(body.ready));
  } catch {
    setReadyBadge(false);
  }
}

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  const formData = new FormData(els.form);
  const prompt = String(formData.get('prompt') ?? '').trim();
  if (!prompt) return;
  const model = String(formData.get('model') ?? 'mock-engine-v1');
  const maxTokens = Number(formData.get('maxTokens') ?? 64);
  void startGeneration(prompt, model, maxTokens);
});

els.cancelBtn.addEventListener('click', () => void cancelCurrentRun());
els.refreshRunsBtn.addEventListener('click', () => void refreshRunsTable());

setStatus('idle');
void pollReady();
setInterval(() => void pollReady(), READY_POLL_MS);
void refreshRunsTable();
