// Step 0 spike: talk AHP to a local `code agent host` from Node 22 (built-in WebSocket).
//
// Usage:
//   AHP_URL='ws://127.0.0.1:49495?tkn=…' node ai-connect/spike/connect.mjs [--full] [--cwd /abs/path] [--prompt "…"]
//
// Without --full it stops after printing the agents list.
// With --full it also authenticates (token from GITHUB_TOKEN / GH_TOKEN / `gh auth token`),
// creates a session and streams a reply.
// Every raw frame is appended to ai-connect/spike/last-run.jsonl with tokens redacted.

import { execSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};

const url = process.env.AHP_URL;
if (!url) {
  console.error('Set AHP_URL to the `Local:` URL printed by `code agent host`.');
  process.exit(1);
}
const full = flag('--full');
const cwd = opt('--cwd', process.cwd());
const prompt = opt('--prompt', 'Say hello in one sentence.');
const logFile = fileURLToPath(new URL('./last-run.jsonl', import.meta.url));
writeFileSync(logFile, '');

const secrets = [];
const tkn = new URL(url.replace(/^ws/, 'http')).searchParams.get('tkn');
if (tkn) secrets.push(tkn);
const redact = (s) => secrets.reduce((acc, x) => acc.split(x).join('<redacted>'), s);
const log = (dir, text) => appendFileSync(logFile, JSON.stringify({ t: Date.now(), dir, frame: redact(text) }) + '\n');

const ws = new WebSocket(url);
let nextId = 1;
let clientSeq = 1;
const pending = new Map();
const listeners = [];

function send(obj) {
  const text = JSON.stringify({ jsonrpc: '2.0', ...obj });
  log('out', text);
  ws.send(text);
}

function request(method, params, timeoutMs = 30000) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, method });
  });
}

function dispatch(channel, action) {
  send({ method: 'dispatchAction', params: { channel, clientSeq: clientSeq++, action } });
}

ws.addEventListener('message', (ev) => {
  const text = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
  log('in', text);
  const msg = JSON.parse(text);
  if (msg.id !== undefined && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) {
      const err = new Error(`${p.method} failed: ${msg.error.code} ${msg.error.message}`);
      err.rpc = msg.error;
      p.reject(err);
    } else {
      p.resolve(msg.result);
    }
    return;
  }
  for (const l of listeners) l(msg);
});

ws.addEventListener('close', (ev) => {
  console.error(`\n[socket closed] code=${ev.code} reason=${ev.reason || '-'}`);
  process.exit(ev.code === 1000 ? 0 : 1);
});
ws.addEventListener('error', (ev) => {
  console.error('[socket error]', ev.message || ev.error?.message || ev);
});

await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
console.log('[open]');

// --- initialize, with one retry on -32005 ---
async function initialize(versions) {
  return request('initialize', {
    channel: 'ahp-root://',
    protocolVersions: versions,
    clientId: randomUUID(),
    clientInfo: { name: 'ahp-spike', version: '0.0.1' },
    initialSubscriptions: ['ahp-root://'],
  });
}

let init;
try {
  init = await initialize(['1.0.0', '0.10.0', '0.9.0']);
} catch (e) {
  if (e.rpc?.code === -32005 && e.rpc.data?.supportedVersions) {
    console.log('[initialize] -32005, retrying with', e.rpc.data.supportedVersions);
    init = await initialize(e.rpc.data.supportedVersions);
  } else {
    throw e;
  }
}
console.log('[initialize result]', JSON.stringify(init, null, 2));

let rootState = init?.snapshots?.find?.((s) => s.resource === 'ahp-root://')?.state;
if (!rootState) {
  const sub = await request('subscribe', { channel: 'ahp-root://' });
  console.log('[subscribe ahp-root:// keys]', Object.keys(sub || {}));
  rootState = sub?.snapshot?.state;
}
const agents = rootState?.agents ?? [];
console.log('[agents]', JSON.stringify(agents, null, 2));

if (!full) {
  ws.close(1000);
  await new Promise(() => {});
}

// --- authenticate ---
const agent = agents.find((a) => a.provider === 'copilotcli') ?? agents[0];
if (!agent) throw new Error('No agents advertised');
const resource = agent.protectedResources?.find((r) => r.required)?.resource
  ?? agent.protectedResources?.[0]?.resource
  ?? 'https://api.github.com';
const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  || execSync('gh auth token', { encoding: 'utf8' }).trim();
secrets.push(ghToken);
console.log(`[authenticate] resource=${resource} tokenPrefix=${ghToken.slice(0, 4)}…`);
console.log('[authenticate result]', JSON.stringify(await request('authenticate', {
  channel: 'ahp-root://', resource, token: ghToken,
})));

// --- createSession ---
const sessionUri = `ahp-session:/${randomUUID()}`;
const cwdUri = 'file://' + cwd.split('/').map(encodeURIComponent).join('/');
console.log(`[createSession] provider=${agent.provider} cwd=${cwdUri}`);
console.log('[createSession result]', JSON.stringify(await request('createSession', {
  channel: sessionUri,
  provider: agent.provider,
  workingDirectories: [cwdUri],
  config: { autoApprove: 'default', isolation: 'folder', mode: 'interactive', ...JSON.parse(opt('--config', '{}')) },
}, 60000)));

const sessSub = await request('subscribe', { channel: sessionUri });
const sessState = sessSub?.snapshot?.state;
console.log('[session state keys]', Object.keys(sessState || {}));
const chatUri = sessState?.defaultChat ?? sessState?.chats?.[0]?.resource ?? sessState?.chats?.[0];
console.log('[chat]', JSON.stringify(chatUri));
const chatSub = await request('subscribe', { channel: chatUri });
console.log('[chat state keys]', Object.keys(chatSub?.snapshot?.state || {}));

// --- send a turn and stream ---
const turnId = randomUUID();
const done = new Promise((resolve) => {
  listeners.push((msg) => {
    if (msg.method !== 'action') return;
    const a = msg.params?.action;
    if (!a) return;
    switch (a.type) {
      case 'chat/delta':
        process.stdout.write(a.content ?? '');
        break;
      case 'chat/toolCallReady': {
        console.log(`\n[action ${a.type}]`, JSON.stringify(a).slice(0, 1500));
        const approved = flag('--approve');
        console.log(`[spike] ${approved ? 'approving' : 'denying'} ${a.toolCallId}`);
        dispatch(chatUri, approved
          ? { type: 'chat/toolCallConfirmed', turnId: a.turnId, toolCallId: a.toolCallId, approved: true, confirmed: 'user-action' }
          : { type: 'chat/toolCallConfirmed', turnId: a.turnId, toolCallId: a.toolCallId, approved: false, reason: 'denied' });
        break;
      }
      case 'chat/turnComplete':
      case 'chat/turnCancelled':
      case 'chat/error':
        console.log(`\n[${a.type}]`, JSON.stringify(a).slice(0, 500));
        resolve();
        break;
      default:
        console.log(`\n[action ${a.type}]`, JSON.stringify(a).slice(0, 300));
    }
  });
});
dispatch(chatUri, {
  type: 'chat/turnStarted',
  turnId,
  startedAt: new Date().toISOString(),
  message: { text: prompt, origin: { kind: 'user' } },
});
await done;
ws.close(1000);
