// Minimal Agent Host Protocol client: JSON-RPC 2.0 over one WebSocket.
// No DOM access here, so the module also runs under Node (tests) and can be
// moved into the reports dashboard unchanged.

/** @typedef {{ code: number, message: string, data?: any }} RpcErrorShape */

export class RpcError extends Error {
  /** @param {string} method @param {RpcErrorShape} error */
  constructor(method, error) {
    super(`${method} failed (${error.code}): ${error.message}`);
    this.name = 'RpcError';
    this.method = method;
    this.code = error.code;
    this.data = error.data;
  }
}

export class ConnectionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConnectionError';
  }
}

/**
 * @typedef {object} AhpClientOptions
 * @property {any} [WebSocketImpl] WebSocket constructor (defaults to globalThis.WebSocket).
 * @property {number} [requestTimeoutMs] Per-request timeout. Default 30 s.
 * @property {number} [pingIntervalMs] Keep-alive interval; 0 disables. Default 30 s.
 * @property {(dir: 'in' | 'out', text: string) => void} [onFrame] Raw frame tap for debugging.
 */

export class AhpClient {
  /** @param {string} url Full ws:// URL including ?tkn=… @param {AhpClientOptions} [options] */
  constructor(url, options = {}) {
    this.url = url;
    this.WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.pingIntervalMs = options.pingIntervalMs ?? 30_000;
    this.onFrame = options.onFrame;
    /** @type {WebSocket | null} */
    this.ws = null;
    this.nextId = 1;
    this.clientSeq = 1;
    /** @type {Map<number, { method: string, resolve: Function, reject: Function, timer: any }>} */
    this.pending = new Map();
    /** @type {{ method: string, channel: string, handler: (params: any, msg: any) => void }[]} */
    this.listeners = [];
    /** @type {((info: { code: number, reason: string }) => void)[]} */
    this.closeHandlers = [];
    this.pingTimer = null;
    this.pingSupported = true;
    this.closed = false;
  }

  /** Opens the socket. Rejects if it closes before opening (wrong token → 403, or host not running). */
  connect() {
    return new Promise((resolve, reject) => {
      let opened = false;
      const ws = new this.WebSocketImpl(this.url);
      this.ws = ws;
      ws.addEventListener('open', () => {
        opened = true;
        this.startPing();
        resolve(undefined);
      });
      ws.addEventListener('message', (ev) => this.handleFrame(ev.data));
      ws.addEventListener('close', (ev) => {
        this.closed = true;
        this.stopPing();
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new ConnectionError(`Connection closed during ${p.method}`));
        }
        this.pending.clear();
        if (!opened) {
          reject(new ConnectionError(
            'Could not connect. Either the host is not running at this URL, the connection token was rejected (403), '
            + 'or the host failed to start behind its supervisor (503). The browser console shows the status code; '
            + 'for a 503, open the URL with curl to read the reason.'));
          return;
        }
        for (const h of this.closeHandlers) h({ code: ev.code, reason: ev.reason });
      });
      // Errors are always followed by 'close', which does the real handling.
      ws.addEventListener('error', () => {});
    });
  }

  /** @param {string} method @param {Record<string, any>} params @param {number} [timeoutMs] */
  request(method, params, timeoutMs = this.requestTimeoutMs) {
    if (!this.ws || this.closed) return Promise.reject(new ConnectionError('Not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ConnectionError(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** @param {string} method @param {Record<string, any>} params */
  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /**
   * Client mutation on a channel. Returns the clientSeq used.
   * @param {string} channel @param {Record<string, any>} action
   */
  dispatch(channel, action) {
    const clientSeq = this.clientSeq++;
    this.notify('dispatchAction', { channel, clientSeq, action });
    return clientSeq;
  }

  /**
   * Listen for server notifications. `channel` '*' matches any channel.
   * @param {string} method @param {string} channel @param {(params: any, msg: any) => void} handler
   * @returns {() => void} unsubscribe
   */
  on(method, channel, handler) {
    const entry = { method, channel, handler };
    this.listeners.push(entry);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== entry);
    };
  }

  /** @param {(info: { code: number, reason: string }) => void} handler */
  onClose(handler) {
    this.closeHandlers.push(handler);
  }

  close() {
    this.stopPing();
    if (this.ws && !this.closed) this.ws.close(1000);
  }

  // --- internals ---

  send(obj) {
    const text = JSON.stringify(obj);
    this.onFrame?.('out', text);
    this.ws.send(text);
  }

  handleFrame(data) {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    this.onFrame?.('in', text);
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      console.warn('[ahp] non-JSON frame ignored');
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(p.method, msg.error));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method !== 'string') return;
    const channel = msg.params?.channel;
    let handled = false;
    for (const l of [...this.listeners]) {
      if (l.method !== msg.method) continue;
      if (l.channel !== '*' && l.channel !== channel) continue;
      handled = true;
      try {
        l.handler(msg.params, msg);
      } catch (e) {
        console.error('[ahp] listener failed', e);
      }
    }
    if (!handled) console.debug('[ahp] unhandled notification', msg.method, channel);
  }

  startPing() {
    if (!this.pingIntervalMs) return;
    this.pingTimer = setInterval(() => {
      if (!this.pingSupported) return;
      this.request('ping', { channel: 'ahp-root://' }, 10_000).catch((e) => {
        if (e instanceof RpcError && e.code === -32601) this.pingSupported = false;
        else console.warn('[ahp] ping failed:', e.message);
      });
    }, this.pingIntervalMs);
  }

  stopPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}
