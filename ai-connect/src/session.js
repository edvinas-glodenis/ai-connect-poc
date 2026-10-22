// Session flow on top of AhpClient:
// initialize → authenticate → createSession → subscribe session → subscribe chat → turns.
// No DOM access, so it can move into the reports dashboard as is.

import { AhpClient, RpcError } from './ahp-client.js';

export const ROOT = 'ahp-root://';
const PROTOCOL_VERSIONS = ['1.0.0', '0.10.0', '0.9.0'];

/**
 * Accepts `ws://127.0.0.1:8081`, `ws://localhost:49495?tkn=…`, or a whole
 * `Local: ws://…` line printed by the host.
 * @param {string} input
 * @returns {{ url: string, tkn: string | null }}
 */
export function parseHostInput(input) {
  const match = String(input).match(/wss?:\/\/\S+/);
  if (!match) throw new Error('Host URL must start with ws://');
  const u = new URL(match[0]);
  const tkn = u.searchParams.get('tkn');
  u.searchParams.delete('tkn');
  return { url: u.toString().replace(/\/$/, '').replace(/\/\?$/, ''), tkn };
}

/** @param {string} url @param {string} tkn */
export function buildSocketUrl(url, tkn) {
  const u = new URL(url);
  u.searchParams.set('tkn', tkn);
  return u.toString();
}

/**
 * Absolute POSIX (`/Users/me/x`) or Windows (`C:\x`) path → file:// URI.
 * @param {string} path
 */
export function pathToFileUri(path) {
  const p = String(path).trim();
  if (/^[A-Za-z]:[\\/]/.test(p)) {
    const [drive, ...rest] = p.replace(/\\/g, '/').split('/');
    return `file:///${drive}/` + rest.map(encodeURIComponent).join('/');
  }
  if (p.startsWith('/')) return 'file://' + p.split('/').map(encodeURIComponent).join('/');
  throw new Error('Working directory must be an absolute path');
}

/**
 * `acme.ghe.com`, `https://acme.ghe.com/`, `github.company.com` → `https://<host>`.
 * Empty or github.com → '' (meaning github.com).
 * @param {string} input
 */
export function normalizeGitHubHost(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (['github.com', 'www.github.com', 'api.github.com'].includes(u.host)) return '';
  return `${u.protocol}//${u.host}`;
}

/** @param {unknown} s StringOrMarkdown */
export function textOf(s) {
  if (typeof s === 'string') return s;
  if (s && typeof s === 'object' && 'markdown' in s) return String(/** @type {any} */ (s).markdown);
  return '';
}

/** Coarse token type from its prefix only; never inspect more than that. @param {string} token */
export function tokenKind(token) {
  if (token.startsWith('gho_')) return 'gh CLI OAuth token';
  if (token.startsWith('ghp_')) return 'classic personal access token';
  if (token.startsWith('github_pat_')) return 'fine-grained personal access token';
  return 'unknown token type';
}

export class AhpSession {
  /** @param {import('./ahp-client.js').AhpClientOptions} [clientOptions] */
  constructor(clientOptions = {}) {
    this.clientOptions = clientOptions;
    /** @type {AhpClient | null} */
    this.client = null;
    this.protocolVersion = null;
    /** @type {any[]} */
    this.agents = [];
    this.agent = null;
    this.sessionUri = null;
    this.chatUri = null;
    /** @type {Map<string, number>} turnId → local start time, for cancel duration */
    this.turnStarts = new Map();
  }

  /** @param {string} hostUrl @param {string} tkn */
  async connect(hostUrl, tkn) {
    this.client = new AhpClient(buildSocketUrl(hostUrl, tkn), this.clientOptions);
    await this.client.connect();
    const init = await this.initialize(PROTOCOL_VERSIONS).catch((e) => {
      if (e instanceof RpcError && e.code === -32005 && Array.isArray(e.data?.supportedVersions)) {
        return this.initialize(e.data.supportedVersions);
      }
      throw e;
    });
    this.protocolVersion = init?.protocolVersion ?? null;
    let rootState = init?.snapshots?.find?.((s) => s.resource === ROOT)?.state;
    if (!rootState) {
      const sub = await this.client.request('subscribe', { channel: ROOT });
      rootState = sub?.snapshot?.state;
    }
    this.agents = rootState?.agents ?? [];
    /** @type {Record<string, any>} */
    this.rootConfig = { ...(rootState?.config?.values ?? {}) };
    this.client.on('action', ROOT, ({ action }) => {
      if (action?.type === 'root/agentsChanged' && Array.isArray(action.agents)) this.agents = action.agents;
      if (action?.type === 'root/configChanged') {
        this.rootConfig = action.replace ? { ...action.config } : { ...this.rootConfig, ...action.config };
      }
    });
    return { protocolVersion: this.protocolVersion, agents: this.agents };
  }

  /** @param {string[]} versions */
  initialize(versions) {
    return this.client.request('initialize', {
      channel: ROOT,
      protocolVersions: versions,
      clientId: crypto.randomUUID(),
      clientInfo: { name: 'ahp-static-page', version: '0.1.0' },
      initialSubscriptions: [ROOT],
    });
  }

  /** The resource the agent requires a token for (differs on GitHub Enterprise). @param {any} agent */
  static authResource(agent) {
    const resources = agent?.protectedResources ?? [];
    return (resources.find((r) => r.required) ?? resources[0])?.resource ?? null;
  }

  /** The GitHub Enterprise base URI the host is configured for ('' = github.com). */
  get gitHubEnterpriseUri() {
    return this.rootConfig?.githubEnterpriseUri || '';
  }

  /**
   * Points the host at github.com ('') or a GitHub Enterprise instance. This is
   * host-wide root config (`githubEnterpriseUri`), normally pushed by VS Code.
   * Waits for the host to republish the agents with the new protected resources.
   * @param {string} uri normalized with normalizeGitHubHost
   * @returns {Promise<boolean>} whether anything changed
   */
  async setGitHubEnterpriseUri(uri) {
    if (uri === this.gitHubEnterpriseUri) return false;
    const agentsUpdated = new Promise((resolve) => {
      const off = this.client.on('action', ROOT, ({ action }) => {
        if (action?.type !== 'root/agentsChanged') return;
        off();
        resolve(undefined);
      });
      setTimeout(() => { off(); resolve(undefined); }, 5000);
    });
    this.client.dispatch(ROOT, { type: 'root/configChanged', config: { githubEnterpriseUri: uri } });
    await agentsUpdated;
    return true;
  }

  /** @param {string} provider @param {string} token */
  async authenticate(provider, token) {
    this.agent = this.agents.find((a) => a.provider === provider) ?? null;
    if (!this.agent) throw new Error(`Agent "${provider}" is not offered by this host`);
    const resource = AhpSession.authResource(this.agent);
    if (!resource) return null;
    await this.client.request('authenticate', { channel: ROOT, resource, token });
    return resource;
  }

  /**
   * @param {{ cwd: string, config?: Record<string, any> }} opts
   * @returns {Promise<{ sessionUri: string, chatUri: string, chatState: any }>}
   */
  async createSession({ cwd, config = {} }) {
    const sessionUri = `ahp-session:/${crypto.randomUUID()}`;
    await this.client.request('createSession', {
      channel: sessionUri,
      provider: this.agent.provider,
      workingDirectories: [pathToFileUri(cwd)],
      config: { autoApprove: 'default', isolation: 'folder', mode: 'interactive', ...config },
    }, 60_000);
    const sess = await this.client.request('subscribe', { channel: sessionUri });
    const state = sess?.snapshot?.state ?? {};
    const firstChat = state.chats?.[0];
    const chatUri = state.defaultChat ?? (typeof firstChat === 'string' ? firstChat : firstChat?.resource);
    if (!chatUri) throw new Error('Session has no chat channel');
    const chat = await this.client.request('subscribe', { channel: chatUri });
    this.sessionUri = sessionUri;
    this.chatUri = chatUri;
    return { sessionUri, chatUri, chatState: chat?.snapshot?.state };
  }

  /** @param {(action: any) => void} handler */
  onChatAction(handler) {
    return this.client.on('action', this.chatUri, (params) => {
      if (params?.action) handler(params.action);
    });
  }

  /** @param {(action: any) => void} handler */
  onSessionAction(handler) {
    return this.client.on('action', this.sessionUri, (params) => {
      if (params?.action) handler(params.action);
    });
  }

  /** @param {string} text @returns {string} turnId */
  sendPrompt(text) {
    const turnId = crypto.randomUUID();
    this.turnStarts.set(turnId, Date.now());
    this.client.dispatch(this.chatUri, {
      type: 'chat/turnStarted',
      turnId,
      startedAt: new Date().toISOString(),
      message: { text, origin: { kind: 'user' } },
    });
    return turnId;
  }

  /** @param {string} turnId */
  cancelTurn(turnId) {
    const started = this.turnStarts.get(turnId) ?? Date.now();
    this.client.dispatch(this.chatUri, { type: 'chat/turnCancelled', turnId, duration: Date.now() - started });
  }

  /**
   * @param {{ turnId: string, toolCallId: string, approved: boolean, optionId?: string }} c
   */
  confirmTool({ turnId, toolCallId, approved, optionId }) {
    const action = approved
      ? { type: 'chat/toolCallConfirmed', turnId, toolCallId, approved: true, confirmed: 'user-action' }
      : { type: 'chat/toolCallConfirmed', turnId, toolCallId, approved: false, reason: 'denied' };
    if (optionId) action.selectedOptionId = optionId;
    this.client.dispatch(this.chatUri, action);
  }

  close() {
    this.client?.close();
    this.client = null;
  }
}
