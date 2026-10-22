import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AhpClient, RpcError, ConnectionError } from '../src/ahp-client.js';
import { parseHostInput, pathToFileUri, buildSocketUrl, AhpSession, normalizeGitHubHost } from '../src/session.js';

/** Fake WebSocket: records sent frames, lets the test push frames and lifecycle events. */
class FakeSocket {
  static last = null;
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.handlers = {};
    FakeSocket.last = this;
  }
  addEventListener(type, fn) {
    (this.handlers[type] ??= []).push(fn);
  }
  emit(type, ev = {}) {
    for (const fn of this.handlers[type] ?? []) fn(ev);
  }
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  close(code = 1000) {
    this.emit('close', { code, reason: '' });
  }
  open() {
    this.emit('open');
  }
  push(obj) {
    this.emit('message', { data: JSON.stringify(obj) });
  }
}

async function connected(opts = {}) {
  const client = new AhpClient('ws://127.0.0.1:1?tkn=x', { WebSocketImpl: FakeSocket, pingIntervalMs: 0, ...opts });
  const p = client.connect();
  FakeSocket.last.open();
  await p;
  return { client, ws: FakeSocket.last };
}

test('correlates responses to requests by id, out of order', async () => {
  const { client, ws } = await connected();
  const a = client.request('initialize', { channel: 'ahp-root://' });
  const b = client.request('subscribe', { channel: 'ahp-session:/1' });
  const [reqA, reqB] = ws.sent;
  assert.equal(reqA.method, 'initialize');
  assert.notEqual(reqA.id, reqB.id);
  ws.push({ jsonrpc: '2.0', id: reqB.id, result: { snapshot: 'B' } });
  ws.push({ jsonrpc: '2.0', id: reqA.id, result: { protocolVersion: '1.0.0' } });
  assert.deepEqual(await a, { protocolVersion: '1.0.0' });
  assert.deepEqual(await b, { snapshot: 'B' });
  client.close();
});

test('rejects with RpcError carrying code and data', async () => {
  const { client, ws } = await connected();
  const p = client.request('initialize', {});
  ws.push({ jsonrpc: '2.0', id: ws.sent[0].id, error: { code: -32005, message: 'bad version', data: { supportedVersions: ['0.9.0'] } } });
  await assert.rejects(p, (e) => e instanceof RpcError && e.code === -32005 && e.data.supportedVersions[0] === '0.9.0');
  client.close();
});

test('times out pending requests', async () => {
  const { client } = await connected({ requestTimeoutMs: 20 });
  await assert.rejects(client.request('slow', {}), (e) => e instanceof ConnectionError && /timed out/.test(e.message));
  client.close();
});

test('routes notifications by method and channel, with * wildcard', async () => {
  const { client, ws } = await connected();
  const chatA = [];
  const any = [];
  client.on('action', 'ahp-chat:/a', (p) => chatA.push(p.action.type));
  client.on('action', '*', (p) => any.push(p.channel));
  ws.push({ jsonrpc: '2.0', method: 'action', params: { channel: 'ahp-chat:/a', action: { type: 'chat/delta' }, serverSeq: 1 } });
  ws.push({ jsonrpc: '2.0', method: 'action', params: { channel: 'ahp-chat:/b', action: { type: 'chat/delta' }, serverSeq: 2 } });
  assert.deepEqual(chatA, ['chat/delta']);
  assert.deepEqual(any, ['ahp-chat:/a', 'ahp-chat:/b']);
  client.close();
});

test('tolerates unknown notifications, bad JSON and throwing listeners', async () => {
  const { client, ws } = await connected();
  const seen = [];
  client.on('action', '*', () => { throw new Error('boom'); });
  client.on('action', '*', (p) => seen.push(p.action.type));
  const origError = console.error;
  const origWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  try {
    ws.emit('message', { data: 'not json' });
    ws.push({ jsonrpc: '2.0', method: 'something/new', params: { channel: 'x' } });
    ws.push({ jsonrpc: '2.0', method: 'action', params: { channel: 'x', action: { type: 'chat/future' } } });
  } finally {
    console.error = origError;
    console.warn = origWarn;
  }
  assert.deepEqual(seen, ['chat/future']);
  client.close();
});

test('dispatch auto-increments clientSeq', async () => {
  const { client, ws } = await connected();
  assert.equal(client.dispatch('ahp-chat:/a', { type: 'chat/turnStarted' }), 1);
  assert.equal(client.dispatch('ahp-chat:/a', { type: 'chat/turnStarted' }), 2);
  assert.deepEqual(ws.sent.map((m) => [m.method, m.params.clientSeq, 'id' in m]), [
    ['dispatchAction', 1, false],
    ['dispatchAction', 2, false],
  ]);
  client.close();
});

test('connect rejects when the socket closes before opening (403 / host down)', async () => {
  const client = new AhpClient('ws://127.0.0.1:1?tkn=bad', { WebSocketImpl: FakeSocket, pingIntervalMs: 0 });
  const p = client.connect();
  FakeSocket.last.emit('error');
  FakeSocket.last.emit('close', { code: 1006, reason: '' });
  await assert.rejects(p, (e) => e instanceof ConnectionError && /403/.test(e.message));
});

test('pending requests fail when the connection drops', async () => {
  const { client, ws } = await connected();
  const closed = [];
  client.onClose((info) => closed.push(info.code));
  const p = client.request('createSession', {});
  ws.emit('close', { code: 1006, reason: '' });
  await assert.rejects(p, ConnectionError);
  assert.deepEqual(closed, [1006]);
});

test('session: initialize retries once with server-supported versions', async () => {
  const session = new AhpSession({ WebSocketImpl: FakeSocket, pingIntervalMs: 0 });
  const p = session.connect('ws://127.0.0.1:1', 'tok');
  const ws = FakeSocket.last;
  assert.equal(ws.url, 'ws://127.0.0.1:1/?tkn=tok');
  ws.open();
  await new Promise((r) => setImmediate(r));
  const first = ws.sent[0];
  ws.push({ jsonrpc: '2.0', id: first.id, error: { code: -32005, message: 'x', data: { supportedVersions: ['0.10.0'] } } });
  await new Promise((r) => setImmediate(r));
  const second = ws.sent[1];
  assert.deepEqual(second.params.protocolVersions, ['0.10.0']);
  ws.push({ jsonrpc: '2.0', id: second.id, result: {
    protocolVersion: '0.10.0',
    snapshots: [{ resource: 'ahp-root://', state: { agents: [{ provider: 'copilotcli' }] } }],
  } });
  const res = await p;
  assert.equal(res.protocolVersion, '0.10.0');
  assert.equal(res.agents[0].provider, 'copilotcli');
  session.close();
});

test('parseHostInput accepts a pasted Local: line', () => {
  assert.deepEqual(parseHostInput('  Local: ws://127.0.0.1:49495?tkn=abc-123 '), { url: 'ws://127.0.0.1:49495', tkn: 'abc-123' });
  assert.deepEqual(parseHostInput('ws://localhost:8081'), { url: 'ws://localhost:8081', tkn: null });
  assert.throws(() => parseHostInput('http://x'));
});

test('buildSocketUrl puts the token in tkn', () => {
  assert.equal(buildSocketUrl('ws://127.0.0.1:8081', 'a_b-1'), 'ws://127.0.0.1:8081/?tkn=a_b-1');
});

test('pathToFileUri handles POSIX and Windows paths', () => {
  assert.equal(pathToFileUri('/Users/me/my project'), 'file:///Users/me/my%20project');
  assert.equal(pathToFileUri('C:\\work\\repo'), 'file:///C:/work/repo');
  assert.throws(() => pathToFileUri('relative/path'));
});

test('AhpSession.authResource prefers the required resource', () => {
  const agent = { protectedResources: [
    { resource: 'https://api.github.com/repos', required: false },
    { resource: 'https://api.github.com', required: true },
  ] };
  assert.equal(AhpSession.authResource(agent), 'https://api.github.com');
  assert.equal(AhpSession.authResource({}), null);
});

test('normalizeGitHubHost maps inputs to the host config value', () => {
  assert.equal(normalizeGitHubHost(''), '');
  assert.equal(normalizeGitHubHost('github.com'), '');
  assert.equal(normalizeGitHubHost('https://github.com/'), '');
  assert.equal(normalizeGitHubHost('acme.ghe.com'), 'https://acme.ghe.com');
  assert.equal(normalizeGitHubHost('https://github.company.com/some/path'), 'https://github.company.com');
});

test('setGitHubEnterpriseUri dispatches root/configChanged and waits for agents', async () => {
  const session = new AhpSession({ WebSocketImpl: FakeSocket, pingIntervalMs: 0 });
  const p = session.connect('ws://127.0.0.1:1', 'tok');
  const ws = FakeSocket.last;
  ws.open();
  await new Promise((r) => setImmediate(r));
  ws.push({ jsonrpc: '2.0', id: ws.sent[0].id, result: {
    protocolVersion: '1.0.0',
    snapshots: [{ resource: 'ahp-root://', state: { agents: [], config: { values: {} } } }],
  } });
  await p;
  assert.equal(await session.setGitHubEnterpriseUri(''), false);
  const changed = session.setGitHubEnterpriseUri('https://acme.ghe.com');
  const sent = ws.sent.at(-1);
  assert.equal(sent.method, 'dispatchAction');
  assert.deepEqual(sent.params.action, { type: 'root/configChanged', config: { githubEnterpriseUri: 'https://acme.ghe.com' } });
  ws.push({ jsonrpc: '2.0', method: 'action', params: { channel: 'ahp-root://', action: sent.params.action } });
  ws.push({ jsonrpc: '2.0', method: 'action', params: { channel: 'ahp-root://', action: {
    type: 'root/agentsChanged', agents: [{ provider: 'copilotcli', protectedResources: [{ resource: 'https://api.acme.ghe.com', required: true }] }],
  } } });
  assert.equal(await changed, true);
  assert.equal(session.gitHubEnterpriseUri, 'https://acme.ghe.com');
  assert.equal(AhpSession.authResource(session.agents[0]), 'https://api.acme.ghe.com');
  session.close();
});
