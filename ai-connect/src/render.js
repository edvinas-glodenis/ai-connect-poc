// Maps chat actions to DOM. Agent output is only ever set via textContent.
// Markdown is not parsed in v1: text keeps its line breaks, and ``` fences
// become <pre><code> blocks.

import { textOf } from './session.js';

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Re-renders `target` with text split into prose and fenced code blocks. */
function renderText(target, text) {
  const parts = text.split(/^```[^\n]*\n?/m);
  const nodes = parts.map((chunk, i) => {
    if (i % 2 === 1) {
      const pre = el('pre', 'code');
      pre.append(el('code', undefined, chunk.replace(/\n$/, '')));
      return pre;
    }
    return el('div', 'prose', chunk);
  });
  target.replaceChildren(...nodes.filter((n) => n.textContent !== '' || n.tagName === 'PRE'));
}

function prettyInput(toolInput) {
  if (toolInput === undefined || toolInput === null) return '';
  if (typeof toolInput !== 'string') return JSON.stringify(toolInput, null, 2);
  try {
    return JSON.stringify(JSON.parse(toolInput), null, 2);
  } catch {
    return toolInput;
  }
}

/**
 * @typedef {object} TranscriptCallbacks
 * @property {(c: { turnId: string, toolCallId: string, approved: boolean, optionId?: string }) => void} onConfirm
 * @property {(state: 'running' | 'idle', turnId?: string) => void} [onTurnState]
 */

export class Transcript {
  /** @param {HTMLElement} root @param {TranscriptCallbacks} callbacks */
  constructor(root, callbacks) {
    this.root = root;
    this.callbacks = callbacks;
    /** @type {Map<string, HTMLElement>} */
    this.turns = new Map();
    /** @type {Map<string, { el: HTMLElement, body: HTMLElement, text: string }>} */
    this.parts = new Map();
    /** @type {Map<string, any>} */
    this.tools = new Map();
  }

  clear() {
    this.root.replaceChildren();
    this.turns.clear();
    this.parts.clear();
    this.tools.clear();
  }

  /** @param {string} text */
  notice(text, kind = 'info') {
    this.root.append(el('div', `notice notice-${kind}`, text));
    this.scroll();
  }

  /** Optimistic echo; the server echo with the same turnId is ignored. @param {string} turnId @param {string} text */
  addUserMessage(turnId, text) {
    this.turnEl(turnId, text);
  }

  /** @param {any} a */
  handleAction(a) {
    switch (a.type) {
      case 'chat/turnStarted':
        this.turnEl(a.turnId, textOf(a.message?.text ?? a.message));
        this.setStatus(a.turnId, 'Working…');
        this.callbacks.onTurnState?.('running', a.turnId);
        break;
      case 'chat/responsePart':
        this.addPart(a.turnId, a.part ?? {});
        break;
      case 'chat/delta':
        this.appendDelta(a.turnId, a.partId, a.content ?? '');
        break;
      case 'chat/reasoning':
        this.appendReasoning(a);
        break;
      case 'chat/toolCallStart':
      case 'chat/toolCallDelta':
      case 'chat/toolCallReady':
      case 'chat/toolCallConfirmed':
      case 'chat/toolCallComplete':
        this.updateTool(a);
        break;
      case 'chat/turnComplete':
        this.setStatus(a.turnId, `Done in ${(a.duration / 1000).toFixed(1)} s`);
        this.callbacks.onTurnState?.('idle', a.turnId);
        break;
      case 'chat/turnCancelled':
        this.setStatus(a.turnId, 'Cancelled');
        this.callbacks.onTurnState?.('idle', a.turnId);
        break;
      case 'chat/error': {
        // Shape: { turnId, duration, part: { kind: 'error', error: { errorType, message } } }
        console.warn('[render] chat/error', a);
        const info = a.part?.error ?? a.error ?? {};
        const msg = textOf(info.message ?? a.message) || 'Unknown error (details in the browser console)';
        const type = info.errorType ? ` [${info.errorType}]` : '';
        const hint = /No GitHub OAuth token/i.test(msg)
          ? ' The host is not signed in: paste a gh auth token, or open VS Code\'s Agents window connected to this host.'
          : /Personal Access Tokens are not supported/i.test(msg) || /400 Bad Request/.test(msg)
            ? ' If you used a personal access token: the agent host can\'t use those. See the token help.'
            : '';
        this.setStatus(a.turnId, `Error${type}: ${msg}${hint}`, 'error');
        this.callbacks.onTurnState?.('idle', a.turnId);
        break;
      }
      default:
        console.debug('[render] ignored action', a.type);
    }
  }

  // --- turns and text parts ---

  turnEl(turnId, userText) {
    let turn = this.turns.get(turnId);
    if (turn) return turn;
    turn = el('section', 'turn');
    if (userText !== undefined) turn.append(el('div', 'msg msg-user', userText));
    turn.append(el('div', 'turn-body'), el('div', 'turn-status'));
    this.root.append(turn);
    this.turns.set(turnId, turn);
    this.scroll();
    return turn;
  }

  body(turnId) {
    return /** @type {HTMLElement} */ (this.turnEl(turnId).querySelector('.turn-body'));
  }

  setStatus(turnId, text, kind = '') {
    const status = this.turnEl(turnId).querySelector('.turn-status');
    status.textContent = text;
    status.className = `turn-status ${kind}`;
  }

  addPart(turnId, part) {
    const id = part.id ?? crypto.randomUUID();
    const isReasoning = part.kind === 'reasoning' || part.kind === 'thinking';
    let wrapper;
    let body;
    if (isReasoning) {
      wrapper = el('details', 'reasoning');
      wrapper.append(el('summary', undefined, 'Reasoning'));
      body = el('div');
      wrapper.append(body);
    } else {
      wrapper = el('div', `msg msg-agent part-${String(part.kind ?? 'unknown').replace(/[^a-z-]/gi, '')}`);
      body = wrapper;
    }
    const text = part.kind === 'error'
      ? `Error${part.error?.errorType ? ` [${part.error.errorType}]` : ''}: ${textOf(part.error?.message) || 'unknown'}`
      : textOf(part.content ?? part.text ?? '') || (part.kind && part.kind !== 'markdown' ? `[${part.kind}]` : '');
    const entry = { el: wrapper, body, text };
    this.parts.set(id, entry);
    renderText(body, text);
    this.body(turnId).append(wrapper);
    this.scroll();
  }

  appendDelta(turnId, partId, content) {
    let entry = this.parts.get(partId);
    if (!entry) {
      this.addPart(turnId, { id: partId, kind: 'markdown', content: '' });
      entry = this.parts.get(partId);
    }
    entry.text += content;
    renderText(entry.body, entry.text);
    this.scroll();
  }

  appendReasoning(a) {
    const id = a.partId ?? `reasoning-${a.turnId}`;
    if (!this.parts.has(id)) this.addPart(a.turnId, { id, kind: 'reasoning', content: '' });
    const entry = this.parts.get(id);
    entry.text += textOf(a.content ?? a.text ?? '');
    renderText(entry.body, entry.text);
  }

  // --- tool cards ---

  updateTool(a) {
    let t = this.tools.get(a.toolCallId);
    if (!t) {
      const card = el('div', 'tool');
      const head = el('div', 'tool-head');
      const name = el('span', 'tool-name', a.displayName ?? a.toolName ?? 'Tool');
      const badge = el('span', 'tool-badge', 'preparing');
      head.append(name, badge);
      const message = el('div', 'tool-message');
      const input = el('pre', 'tool-input');
      input.hidden = true;
      const actions = el('div', 'tool-actions');
      const result = el('div', 'tool-result');
      card.append(head, message, input, actions, result);
      this.body(a.turnId).append(card);
      t = { card, name, badge, message, input, actions, result, turnId: a.turnId, asked: false };
      this.tools.set(a.toolCallId, t);
    }
    switch (a.type) {
      case 'chat/toolCallStart':
        t.name.textContent = a.displayName ?? a.toolName ?? 'Tool';
        break;
      case 'chat/toolCallDelta':
        if (a.invocationMessage) t.message.textContent = textOf(a.invocationMessage);
        break;
      case 'chat/toolCallReady':
        this.toolReady(t, a);
        break;
      case 'chat/toolCallConfirmed':
        if (t.actions.childElementCount) {
          t.actions.replaceChildren();
          this.setBadge(t, a.approved ? 'approved' : 'denied', a.approved ? 'ok' : 'warn');
        }
        break;
      case 'chat/toolCallComplete': {
        const ok = a.result?.success !== false;
        const how = t.asked ? '' : 'auto-approved by host · ';
        this.setBadge(t, how + (ok ? 'done' : 'failed'), ok ? (t.asked ? 'ok' : 'auto') : 'warn');
        t.actions.replaceChildren();
        t.result.textContent = textOf(a.result?.pastTenseMessage);
        break;
      }
    }
    this.scroll();
  }

  toolReady(t, a) {
    const msg = textOf(a.confirmationTitle) || textOf(a.invocationMessage) || a.intention || '';
    if (msg) t.message.textContent = msg;
    const input = prettyInput(a.toolInput);
    t.input.textContent = input;
    t.input.hidden = input === '';
    if (a.confirmed) {
      // The host decided by itself (see plan §10.13); a Deny now would be ignored.
      // A real prompt may still follow as a second toolCallReady without `confirmed`.
      if (!t.asked) this.setBadge(t, 'running', 'auto');
      return;
    }
    t.asked = true;
    this.setBadge(t, 'needs your approval', 'ask');
    const options = Array.isArray(a.options) && a.options.length
      ? a.options
      : [{ id: undefined, label: 'Deny', kind: 'deny' }, { id: undefined, label: 'Approve', kind: 'approve' }];
    // Deny options first so the safe choice is leftmost and focused.
    const ordered = [...options.filter((o) => o.kind === 'deny'), ...options.filter((o) => o.kind !== 'deny')];
    const buttons = ordered.map((o) => {
      const b = el('button', o.kind === 'deny' ? 'btn btn-deny' : 'btn btn-approve', o.label);
      b.type = 'button';
      b.addEventListener('click', () => {
        for (const x of buttons) x.disabled = true;
        this.callbacks.onConfirm({ turnId: a.turnId, toolCallId: a.toolCallId, approved: o.kind !== 'deny', optionId: o.id });
      });
      return b;
    });
    t.actions.replaceChildren(...buttons);
    buttons[0]?.focus();
  }

  setBadge(t, text, kind) {
    t.badge.textContent = text;
    t.badge.className = `tool-badge badge-${kind}`;
  }

  scroll() {
    this.root.scrollTop = this.root.scrollHeight;
  }
}
