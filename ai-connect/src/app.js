// UI wiring for index.html. Protocol logic lives in session.js / ahp-client.js.

import { AhpSession, parseHostInput, tokenKind, pathToFileUri, normalizeGitHubHost } from './session.js';
import { RpcError } from './ahp-client.js';
import { Transcript } from './render.js';

const STORAGE_KEY = 'ahp-connect';
const $ = (id) => /** @type {any} */ (document.getElementById(id));

const ui = {
  status: $('status'),
  connectForm: $('connect-form'),
  host: $('host'),
  tkn: $('tkn'),
  remember: $('remember'),
  forget: $('forget'),
  connect: $('connect'),
  hostInfo: $('host-info'),
  sessionForm: $('session-form'),
  agent: $('agent'),
  gh: $('gh'),
  ghHost: $('gh-host'),
  ghCommands: $('gh-commands'),
  cwd: $('cwd'),
  start: $('start'),
  promptForm: $('prompt-form'),
  prompt: $('prompt'),
  send: $('send'),
  stop: $('stop'),
};

/** @type {AhpSession | null} */
let session = null;
let activeTurn = null;
const transcript = new Transcript($('transcript'), {
  onConfirm: (c) => session?.confirmTool(c),
  onTurnState: (state, turnId) => {
    activeTurn = state === 'running' ? turnId : null;
    ui.stop.hidden = state !== 'running';
  },
});

// --- storage (sessionStorage only, opt-in) ---

function loadSaved() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!saved) return;
    ui.host.value = saved.host ?? '';
    ui.tkn.value = saved.tkn ?? '';
    ui.gh.value = saved.gh ?? '';
    ui.ghHost.value = saved.ghHost ?? '';
    ui.cwd.value = saved.cwd ?? '';
    ui.remember.checked = true;
  } catch { /* storage unavailable */ }
}

function save() {
  try {
    if (!ui.remember.checked) {
      sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      host: ui.host.value, tkn: ui.tkn.value, gh: ui.gh.value, ghHost: ui.ghHost.value, cwd: ui.cwd.value,
    }));
  } catch { /* storage unavailable */ }
}

// --- status ---

function setStatus(text, kind) {
  ui.status.textContent = text;
  ui.status.className = `pill pill-${kind}`;
}

function setChatEnabled(enabled) {
  ui.prompt.disabled = !enabled;
  ui.send.disabled = !enabled;
  ui.prompt.placeholder = enabled ? 'Ask the agent… (Ctrl/Cmd+Enter to send)' : 'Start a session first';
  if (!enabled) ui.stop.hidden = true;
}

function disconnect() {
  session?.close();
  session = null;
  activeTurn = null;
  setChatEnabled(false);
  ui.sessionForm.hidden = true;
  ui.hostInfo.hidden = true;
  setStatus('Disconnected', 'off');
}

// --- connect ---

ui.host.addEventListener('paste', () => {
  // Let the paste land, then split a pasted `Local: ws://…?tkn=…` into both fields.
  setTimeout(() => {
    try {
      const { url, tkn } = parseHostInput(ui.host.value);
      ui.host.value = url;
      if (tkn) ui.tkn.value = tkn;
    } catch { /* leave as typed */ }
  });
});

ui.connectForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  disconnect();
  let url;
  let tkn;
  try {
    ({ url, tkn } = parseHostInput(ui.host.value));
    tkn = ui.tkn.value.trim() || tkn;
    if (!tkn) throw new Error('Connection token is required');
    ui.host.value = url;
    ui.tkn.value = tkn;
  } catch (e) {
    transcript.notice(e.message, 'error');
    return;
  }
  save();
  setStatus('Connecting…', 'busy');
  ui.connect.disabled = true;
  const s = new AhpSession();
  try {
    const { protocolVersion, agents } = await s.connect(url, tkn);
    session = s;
    s.client.onClose(({ code }) => {
      if (session !== s) return;
      transcript.notice(`Connection closed (code ${code}).`, 'error');
      disconnect();
    });
    s.client.on('auth/required', '*', (params) => {
      const why = params?.reason === 'expired' ? 'expired' : 'required';
      transcript.notice(`GitHub token ${why}. Paste a fresh token and start a new session.`, 'error');
    });
    setStatus(`Connected · AHP ${protocolVersion ?? '?'}`, 'on');
    showAgents(agents);
  } catch (e) {
    s.close();
    setStatus('Disconnected', 'off');
    transcript.notice(e.message, 'error');
  } finally {
    ui.connect.disabled = false;
  }
});

function showAgents(agents) {
  ui.agent.replaceChildren(...agents.map((a) => {
    const o = document.createElement('option');
    o.value = a.provider;
    o.textContent = `${a.displayName ?? a.provider} (${a.provider})`;
    return o;
  }));
  const preferred = agents.find((a) => a.provider === 'copilotcli');
  if (preferred) ui.agent.value = preferred.provider;
  ui.hostInfo.textContent = `Agents: ${agents.map((a) => a.displayName ?? a.provider).join(', ') || 'none'}`;
  const configured = session?.gitHubEnterpriseUri;
  if (configured) {
    ui.hostInfo.textContent += ` · Host is set to GitHub Enterprise: ${configured}`;
    if (!ui.ghHost.value) ui.ghHost.value = new URL(configured).host;
  }
  ui.hostInfo.hidden = false;
  ui.sessionForm.hidden = agents.length === 0;
  updateGhCommands();
}

/** Shows the gh commands for the GitHub host typed in the form. */
function updateGhCommands() {
  let host = '';
  try {
    const uri = normalizeGitHubHost(ui.ghHost.value);
    host = uri ? new URL(uri).host : '';
  } catch { /* incomplete input */ }
  const flag = host ? ` --hostname ${host}` : '';
  ui.ghCommands.textContent = `gh auth login${flag}\ngh auth token${flag}`;
}
ui.ghHost.addEventListener('input', updateGhCommands);

// --- session ---

ui.sessionForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!session) return;
  const token = ui.gh.value.trim();
  const cwd = ui.cwd.value.trim();
  let gitHubUri;
  try {
    pathToFileUri(cwd);
    gitHubUri = normalizeGitHubHost(ui.ghHost.value);
  } catch (e) {
    transcript.notice(e instanceof TypeError ? 'GitHub host is not a valid host name' : e.message, 'error');
    return;
  }
  save();
  ui.start.disabled = true;
  setChatEnabled(false);
  try {
    if (await session.setGitHubEnterpriseUri(gitHubUri)) {
      transcript.notice(`Local host now uses ${gitHubUri || 'github.com'} for GitHub sign-in.`);
    }
    setStatus('Authenticating…', 'busy');
    if (!token) {
      // The host keeps one GitHub sign-in for all connections, so another client
      // (e.g. VS Code connected to this host) may already have provided it.
      transcript.notice('No GitHub token entered: using the sign-in the host already has, if any.');
    }
    if (token.startsWith('ghp_') || token.startsWith('github_pat_')) {
      transcript.notice('Personal access tokens (ghp_…, github_pat_…) will fail on the first answer with "400 Bad Request": '
        + 'GitHub\'s Copilot service accepts them only from the official Copilot CLI, not from the VS Code agent host. Use the output of gh auth token.', 'error');
    }
    if (token) await session.authenticate(ui.agent.value, token);
    else session.agent = session.agents.find((a) => a.provider === ui.agent.value);

    setStatus('Creating session…', 'busy');
    transcript.clear();
    await session.createSession({ cwd });
    session.onChatAction((a) => transcript.handleAction(a));
    setStatus(`Session ready · ${session.agent.displayName ?? session.agent.provider}`, 'on');
    transcript.notice(`Session ready in ${cwd}`);
    setChatEnabled(true);
    ui.prompt.focus();
  } catch (e) {
    setStatus(session ? 'Connected' : 'Disconnected', session ? 'on' : 'off');
    transcript.notice(describeSessionError(e, token), 'error');
  } finally {
    ui.start.disabled = false;
  }
});

function describeSessionError(e, token) {
  if (e instanceof RpcError && e.code === -32007 && !token) {
    return 'The host is not signed in to GitHub. Paste a token from gh auth token, or sign the host in from VS Code first.';
  }
  if (e instanceof RpcError && e.code === -32007) {
    return `GitHub token required or invalid (${token ? tokenKind(token) : 'no token'}). `
      + 'Try: gh auth refresh -s read:user,user:email, and authorize SSO for your org. '
      + `Host said: ${e.message}`;
  }
  if (e instanceof RpcError && e.code === -32002) return `The host has no agent for that provider. ${e.message}`;
  return e.message;
}

// --- prompt ---

ui.promptForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const text = ui.prompt.value.trim();
  if (!text || !session?.chatUri) return;
  const turnId = session.sendPrompt(text);
  transcript.addUserMessage(turnId, text);
  ui.prompt.value = '';
});

ui.prompt.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) ui.promptForm.requestSubmit();
});

ui.stop.addEventListener('click', () => {
  if (activeTurn) session?.cancelTurn(activeTurn);
});

ui.forget.addEventListener('click', () => {
  disconnect();
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
  for (const input of [ui.host, ui.tkn, ui.gh, ui.ghHost, ui.cwd]) input.value = '';
  ui.remember.checked = false;
  transcript.clear();
  transcript.notice('Disconnected. Tokens cleared from this tab.');
});

ui.remember.addEventListener('change', save);

// --- token help tabs ---

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t === tab));
    for (const p of document.querySelectorAll('.tab-panel')) p.hidden = p.dataset.panel !== tab.dataset.tab;
  });
}

loadSaved();
