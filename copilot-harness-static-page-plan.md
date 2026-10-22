# Plan: a static page that talks to the VS Code Copilot harness

> **For the implementing agent.** Read this whole file before writing code. The facts in §3 come from research and from reading the VS Code source (main branch, Oct 2026), and are needed to get the wire protocol right. Items in §4 are **not verified**: test them early and write the result into this file.

---

## 1. Goal

Build a **single static HTML page**, deployable to GitHub Pages, that connects from the browser to a **Copilot harness running on the user's own machine** (`code agent host`). The page should:

1. Connect over WebSocket.
2. Authenticate.
3. Create a Copilot session.
4. Send a prompt.
5. Stream the reply live.
6. Approve or deny tool calls.

There is **no backend**. The browser is the client and the local Agent Host is the server.

This is a **proof of concept**. It will later become an optional "Connect AI" panel inside a Playwright reports dashboard (static report data in S3, read with DuckDB-WASM). Keep the AHP client code in its own module so it can be moved there.

**Out of scope for v1:** multi-session UI, terminals, changesets, file browsing, reconnect with replay, the report dashboard itself.

---

## 2. Architecture

```
Browser (GitHub Pages, https://<user>.github.io/<repo>/)
   │  WebSocket  ws://127.0.0.1:<port>/?tkn=<connection-token>
   │  JSON-RPC 2.0, one message per text frame (Agent Host Protocol)
   ▼
`code agent host` (local machine, binds 127.0.0.1 by default)
   └── Copilot harness (Copilot SDK runtime, provider id `copilotcli`)
          └── GitHub Copilot API  ← uses the GitHub token the page pushes via `authenticate`
```

---

## 3. Verified facts

### 3.1 What the Agent Host and AHP are
- The VS Code Copilot harness runs in a separate process called the **Agent Host**. VS Code talks to it using the **Agent Host Protocol (AHP)**. Locally VS Code uses a message port; for remote connections it uses **AHP JSON-RPC over WebSocket**.
  → https://code.visualstudio.com/docs/agents/concepts/agent-host
- AHP is **open and agent-agnostic**. Microsoft says other applications can implement either side of the protocol.
  → https://code.visualstudio.com/blogs/2026/08/26/agent-host-architecture
- `code agent host` (Insiders: `code-insiders agent host`) starts a standalone host. By default it listens on localhost and requires a connection token.
  → https://code.visualstudio.com/docs/agents/concepts/agent-host
- Spec home: https://microsoft.github.io/agent-host-protocol/ (Overview, Transport, Lifecycle, Subscriptions, Authentication, Chat Channel pages). Repo: https://github.com/microsoft/agent-host-protocol
- Official TypeScript client: `@microsoft/agent-host-protocol` (imports `.../client` and `.../ws`). Browser support is **unknown** (see §4), so v1 uses raw `WebSocket` + JSON-RPC.

### 3.2 Transport (from the VS Code source)
Source: `src/vs/platform/agentHost/node/webSocketTransport.ts` and `agentHostServerMain.ts` in https://github.com/microsoft/vscode
- **Connection token** goes in the **`tkn` query parameter** of the WebSocket upgrade URL. A wrong token gets HTTP 403. This works in browsers, which can't set custom WebSocket headers.
- **No Origin check.** The upgrade check validates only `tkn`, so a page on `github.io` is not rejected for its origin.
- **Bind address** defaults to `127.0.0.1`. The dev server script uses port **8081** by default. Don't hard-code it: the host prints its URL at startup, e.g. `Local: ws://127.0.0.1:8081?tkn=…`.
- **Server flags:**
  - `--port <n>`
  - `--host <ip>`
  - `--connection-token <token>`: charset `[0-9A-Za-z_-]`
  - `--connection-token-file <path>`
  - `--without-connection-token`: **never use this**
  - With no token flag, the host generates a UUID token.
- **Framing:** one complete JSON-RPC message per WebSocket text frame.
  → https://microsoft.github.io/agent-host-protocol/specification/transport.html

### 3.3 Protocol basics
- JSON-RPC 2.0. **Every** request and notification has `params.channel`.
- Connection-level commands use `channel: "ahp-root://"`: `initialize`, `ping`, `listSessions`, `authenticate`.
- **Channel URIs:**
  - `ahp-root://`: agents, session catalogue
  - `ahp-session:/<uuid>`: session state, including `chats[]` and `defaultChat`
  - `ahp-chat:/<uuid>`: turns, streaming, tool calls
- **Server push** is the `action` notification: `{ channel, action, serverSeq }`.
- **Client mutations** are the `dispatchAction` notification: `{ channel, clientSeq, action }`. The server echoes them back as `action` with an `origin`.
- Error codes:
  - `-32005` UnsupportedProtocolVersion: error data contains `supportedVersions`.
  - `-32007` AuthRequired: error data contains `{ resources: ProtectedResourceMetadata[] }`.
  - `-32002` no agent for that provider.
  - `-32003` session already exists.

  → https://microsoft.github.io/agent-host-protocol/specification/overview.html

### 3.4 Protocol version (a known pitfall)
- VS Code main source lists `SUPPORTED_PROTOCOL_VERSIONS = ['1.0.0', '0.9.0']`, with the current development version at `1.1.0`.
- In another team's test against **VS Code Agent Host 1.139.1**, the client had to pass `--protocol-version 0.10.0`, or initialization failed with `-32005`.
  → https://github.com/tbrandenburg/cade/issues/132
- **Approach:** offer `["1.0.0", "0.10.0", "0.9.0"]`. On `-32005`, read `error.data.supportedVersions` and retry once with those values. Log the negotiated version.

### 3.5 Authentication
- The host does **not** reuse the VS Code sign-in (`useLoggedInUser: false` in `copilotAgent.ts`). The **client must push a GitHub token**.
- The Copilot agent advertises these `protectedResources` (`src/vs/platform/agentHost/common/githubEndpoints.ts`):
  - `https://api.github.com`: "GitHub Copilot", scopes `read:user user:email`, **required**
  - `https://api.github.com/repos`: "GitHub Repository", scope `repo`, optional. Not needed for v1.
- Push the token with:
  `{"method":"authenticate","params":{"channel":"ahp-root://","resource":"https://api.github.com","token":"<gho_…>"}}`
  → https://microsoft.github.io/agent-host-protocol/specification/authentication.html
- Read the resource URL from the root state's `agents[].protectedResources` rather than hard-coding it. It differs on GitHub Enterprise.
- **Getting a token:** the AHPX CLI resolves one from `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`. For v1 the user runs `gh auth token` and pastes the result into the page. A static site can't run the GitHub OAuth flow itself.
  → https://github.com/TylerLeonhardt/ahpx
- The server may push an `auth/required` notification later, with `reason: "expired"`. Show a "token expired" prompt when that happens.

### 3.6 Message shapes needed for v1
Source: `src/vs/platform/agentHost/common/state/protocol/`

- `initialize`: `{ channel:"ahp-root://", protocolVersions:[…], clientId:"<uuid>", clientInfo:{name,version}, initialSubscriptions:["ahp-root://"] }`
- `subscribe`: `{ channel:"<uri>" }`. The result is `{ snapshot:{ resource, state, fromSeq } }`.
- `createSession`:
  - Params: `{ channel:"ahp-session:/<new uuid>", provider:"copilotcli", workingDirectories:["file:///<abs path>"], config?:{…} }`. The result is `null`.
  - The provider id was `copilotcli` in the 1.139.1 test. **Always** take it from root state `agents[].provider`.
  - The available `config` keys for `copilotcli` include `autoApprove` (`default`/`autoApprove`/`autopilot`), `isolation` (`folder`/`worktree`) and `mode` (`interactive`/`plan`). Use `autoApprove:"default"`, `isolation:"folder"`, `mode:"interactive"`.
- After `createSession`, subscribe to the session channel and read `state.defaultChat` (an `ahp-chat:/…` URI), falling back to `state.chats[0]`. Then subscribe to that chat channel.
- **Send a prompt** with a `dispatchAction` notification on the chat channel:
  ```json
  { "jsonrpc":"2.0", "method":"dispatchAction", "params":{
      "channel":"ahp-chat:/<id>", "clientSeq":1,
      "action":{ "type":"chat/turnStarted", "turnId":"<uuid>",
                 "startedAt":"<ISO 8601>",
                 "message":{ "text":"<prompt>", "origin":{ "kind":"user" } } } } }
  ```
- **Actions to render**, from `action` notifications on the chat channel:
  - `chat/responsePart`: `{turnId, part}` creates a part, e.g. markdown with an id.
  - `chat/delta`: `{turnId, partId, content}` appends text to that part.
  - `chat/reasoning`: optional, show it collapsed.
  - `chat/toolCallStart`, `chat/toolCallReady` (needs confirmation), `chat/toolCallComplete`.
  - `chat/turnComplete`, `chat/turnCancelled`, `chat/error`.
  - Ignore and log unknown action types. Don't crash on them.
- **Approve or deny a tool call** with `dispatchAction` and `type:"chat/toolCallConfirmed"`:
  - Approve: `{turnId, toolCallId, approved:true, confirmed:"user-action"}`
  - Deny: `{turnId, toolCallId, approved:false, reason:"denied"}`
- **Keep-alive:** `ping` (no payload) every ~30 s.
- Before coding, check the exact field names of `ResponsePart`/markdown parts and of `toolCallReady` against the Chat Channel spec:
  → https://microsoft.github.io/agent-host-protocol/specification/chat-channel.html
  → https://microsoft.github.io/agent-host-protocol/reference/chat.html
  → JSON Schemas: https://microsoft.github.io/agent-host-protocol/schema/actions.schema.json, `commands.schema.json`, `state.schema.json`

---

## 4. Unknowns: verify these first and record the results here

| # | Question | How to test | Fallback |
|---|---|---|---|
| U1 | Does Chrome's Local Network Access prompt appear when `https://*.github.io` opens `ws://127.0.0.1`? (Chrome enforces LNA for public → loopback from v142.) | Open the deployed page in Chrome and connect. | Tell the user to click **Allow**. If the connection is still blocked, try `fetch` hints (`targetAddressSpace:"loopback"`), or serve the page from `http://localhost` during development. |
| U2 | Is mixed content (`https` page → `ws://` loopback) allowed? Chrome exempts known-local targets once LNA is granted. | Same test. Use the literal `127.0.0.1`, not a hostname. | Use a local TLS proxy, or run from `localhost`. |
| U3 | Is the protocol version negotiated correctly? | Log the result of `initialize`. | See §3.4. |
| U4 | Does a token from `gh auth token` work for the Copilot resource? (With an org that uses SSO, the token may need SSO authorization.) | Run `authenticate` and then `createSession`. | Run `gh auth refresh -s read:user,user:email` and authorize SSO. |
| U5 | Does the org policy that disables Copilot CLI block `code agent host`? (The host identifies itself as `vscode-agent-host`.) | Run `createSession` and send a prompt. | Report the exact error text to the user. **Do not try to bypass a policy.** |
| U6 | Does `@microsoft/agent-host-protocol` bundle for the browser? | `npm i`, then try building it with Vite. | Keep the raw client. |
| U7 | Does Safari or Firefox work? | Manual test. | Document the page as Chrome/Edge-only for v1. |

Sources for U1/U2: https://developer.chrome.com/blog/local-network-access, https://blog.openreplay.com/chrome-local-network-access-lna-permission/

---

## 5. Security requirements (non-negotiable)

1. **Never** commit or embed the connection token or the GitHub token. The user pastes both at runtime.
2. Store tokens in `sessionStorage` only, with an explicit "Remember for this tab" checkbox. Provide a **Disconnect & forget** button.
3. The connection token is a **remote-control key** for an agent that can run tools on the user's machine. Say so in the UI.
4. Start the host with a token and **never** with `--without-connection-token` or `--host 0.0.0.0`.
5. Default the session to `autoApprove:"default"`. **Note (§10.13):** the host still auto-approves reads/writes inside the working directory and "safe" shell commands, so not every tool call needs a click. When the host does ask, show the tool name and arguments before Approve, and make **Deny** the default button.
6. Load no third-party scripts in v1. If you add any later, pin versions and use SRI hashes. Any script on the page can read the tokens.
7. Set a strict CSP `<meta>`:
   - `default-src 'self'`
   - `connect-src ws://127.0.0.1:* ws://localhost:*`
   - `script-src 'self'`
8. Render agent markdown **safely**. Escape HTML or use a sanitizer, and never pass agent output to `innerHTML` unsanitized.

---

## 6. Deliverables and file layout

Everything lives in the **`ai-connect/` subfolder** of this repo. The repo root already has its own `README.md`, `src/` (the TS reporter) and CI workflows, and those must not be touched.

```
ai-connect/index.html          # UI: connection form, transcript, prompt box
ai-connect/src/ahp-client.js   # JSON-RPC over WebSocket: request/response by id,
                               # notification dispatch by (method, channel), ping, clientSeq
ai-connect/src/session.js      # flow: initialize → authenticate → createSession →
                               # subscribe session → subscribe defaultChat → send turn
ai-connect/src/render.js       # map chat actions to DOM (parts, deltas, tool cards)
ai-connect/src/styles.css
ai-connect/test/ahp-client.test.js  # node --test, mock WebSocket
ai-connect/spike/connect.mjs   # Step 0 Node spike
ai-connect/README.md           # how to start the host, get a token, connect; known limits
.github/workflows/pages.yml    # deploys ONLY ai-connect/ to GitHub Pages
```

Use plain ES modules with no build step. GitHub Pages serves them as is.

---

## 7. Implementation steps and acceptance criteria

### Step 0: Local spike in Node (before any UI)
- Write `spike/connect.mjs` using the `ws` npm package. It should run `initialize`, then `subscribe ahp-root://`, then print the `agents` list with their `protectedResources`.
- Then run `authenticate`, `createSession`, subscribe to the session and the chat, send "Say hello in one sentence", and print the deltas.
- **Done when:** the reply text streams to stdout. Record the negotiated version, provider id and any surprises in §4.

### Step 1: `ahp-client.js`
- Wrap the browser `WebSocket`. It should handle:
  - pending requests by `id`, with a timeout of 30 s;
  - `on(method, channel, handler)`;
  - `dispatch(channel, action)`, auto-incrementing `clientSeq`;
  - a `ping` timer;
  - close and error events.
- **Done when:** a unit test against a mock WebSocket shows correct id correlation and channel routing.

### Step 2: Connection UI
- Fields:
  - **Host URL:** default `ws://127.0.0.1:8081`, or accept a pasted `Local:` line that contains `?tkn=`.
  - **Connection token.**
  - **GitHub token.**
  - **Working directory.**
- Connect runs `initialize` and shows the agents list and the negotiated version.
- **Done when:** with a wrong token the page shows "Rejected (403): check connection token", and with the right token it shows the agents.

### Step 3: Auth and session
- Read the resource for the chosen agent from `protectedResources`, then call `authenticate`.
- Handle `-32007` by showing "GitHub token required/invalid".
- Then `createSession`, subscribe to the session, find `defaultChat`, and subscribe to the chat.
- **Done when:** the page shows "Session ready".

### Step 4: Prompt and streaming
- Send `chat/turnStarted` with an optimistic local echo of the user message.
- Render `responsePart` and `delta` incrementally, plus a turn status from `activity`, `turnComplete` and `error`.
- A Stop button sends a turn cancel. Find the exact client-dispatchable action in the chat reference; if there isn't one, hide the button.
- **Done when:** a multi-paragraph answer streams in smoothly.

### Step 5: Tool approval
- When `chat/toolCallReady` arrives, show a card with the tool name and input, plus **Approve** and **Deny** buttons. The buttons dispatch `chat/toolCallConfirmed`.
- **Done when:** asking "list the files in the working directory" shows a card, Approve runs the tool, and Deny cancels it.

### Step 6: Deploy and run the browser test matrix
- Deploy to GitHub Pages and test U1, U2 and U7 from the deployed URL. Update §4 and the README.
- **Done when:** the full flow works from `https://<user>.github.io/<repo>/` in Chrome.

### Step 7 (optional): Hook for the reports dashboard
- Export a `connectAI({hostUrl, tkn, ghToken, cwd})` function and an `analyzeRun(runId)` helper.
- The helper sends a fixed prompt that points the agent at that run's files, e.g. `runs/<id>/failures.md` and `tests.jsonl` under the working directory. It asks for JSON output: failure clusters, likely root cause and flaky suspects.
- Keep the dashboard working with no connection; the AI panel is progressive enhancement.

---

## 8. User-facing README content (must include)

1. **Start the host:**
   `code agent host --connection-token "$(openssl rand -hex 16)"`
   Copy the printed `Local: ws://…?tkn=…` line. If `code` isn't on your PATH, use the CLI inside the app bundle, e.g. `"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"`, or run "Shell Command: Install 'code' command in PATH".
2. **Get a GitHub token:** first make sure the token has the Copilot scopes: `gh auth refresh -s read:user,user:email`. Then run `gh auth token`. Requires the `gh` CLI, signed in.
3. **Connect:** open the page, paste the values, click Connect, and allow local network access if Chrome asks.
4. **Limits:**
   - Chrome/Edge only.
   - Works only on the machine where the host runs. Remote use would need a dev tunnel or SSH, which is out of scope.
   - Tokens are never stored after the tab closes.

---

## 9. Reference links

- Agent Host concepts: https://code.visualstudio.com/docs/agents/concepts/agent-host
- Agent harnesses (Copilot vs Local): https://code.visualstudio.com/docs/agents/agent-harnesses
- Agent Host blog post: https://code.visualstudio.com/blogs/2026/08/26/agent-host-architecture
- Remote agent sessions: https://github.com/microsoft/vscode-docs/blob/main/docs/agents/remote-agent-sessions.md
- AHP docs: https://microsoft.github.io/agent-host-protocol/
  - Transport: https://microsoft.github.io/agent-host-protocol/specification/transport.html
  - Lifecycle: https://microsoft.github.io/agent-host-protocol/specification/lifecycle.html
  - Subscriptions: https://microsoft.github.io/agent-host-protocol/specification/subscriptions.html
  - Authentication: https://microsoft.github.io/agent-host-protocol/specification/authentication.html
  - Chat channel: https://microsoft.github.io/agent-host-protocol/specification/chat-channel.html
  - Message index: https://microsoft.github.io/agent-host-protocol/reference/messages.html
  - Error codes: https://microsoft.github.io/agent-host-protocol/reference/error-codes.html
- AHP repo and clients: https://github.com/microsoft/agent-host-protocol
- AHPX (reference CLI client, token resolution, `copilotcli` config keys): https://github.com/TylerLeonhardt/ahpx
- VS Code server source:
  - https://github.com/microsoft/vscode/blob/main/src/vs/platform/agentHost/node/webSocketTransport.ts
  - https://github.com/microsoft/vscode/blob/main/src/vs/platform/agentHost/node/agentHostServerMain.ts
  - https://github.com/microsoft/vscode/blob/main/src/vs/platform/agentHost/common/githubEndpoints.ts
  - https://github.com/microsoft/vscode/tree/main/src/vs/platform/agentHost/common/state/protocol
- Auth PR (RFC 9728-style flow): https://github.com/microsoft/vscode/issues/302995
- Working third-party test against Agent Host 1.139.1: https://github.com/tbrandenburg/cade/issues/132
- Chrome Local Network Access: https://developer.chrome.com/blog/local-network-access

---

## 10. Clarifications (repo- and environment-specific, added 2026-10-21)

These override anything above that conflicts with them.

### 10.1 Location and deploy
- All code goes in `ai-connect/` (see §6). Do not touch the root `README.md`, `src/`, `report-ui/`, or the existing `ci.yml`/`release.yml`.
- `pages.yml`: trigger on `push` to `main` with `paths: ['ai-connect/**']`, plus `workflow_dispatch`. Use `actions/configure-pages`, then `actions/upload-pages-artifact` with `path: ai-connect`, then `actions/deploy-pages`. No build step. Permissions: `pages: write` and `id-token: write`.
- The repo has **no git remote yet**. Steps 0–5 are verified from `http://localhost` (`python3 -m http.server -d ai-connect 5173`). **Step 6 (U1/U2/U7 from github.io) is pending deploy**, after the user pushes and enables Pages.

### 10.2 Environment facts (this dev machine)
- VS Code **1.142.0** is installed at `/Applications/Visual Studio Code 3.app`. `code` is **not on PATH**. Start the host with:
  `"/Applications/Visual Studio Code 3.app/Contents/Resources/app/bin/code" agent host --connection-token "$(openssl rand -hex 16)"`
- The current `gh` token has scopes `gist, read:org, repo, workflow`, so it is **missing `read:user user:email`**. Run `gh auth refresh -s read:user,user:email` before U4.
- Node is v22 and has a **built-in global `WebSocket`**. The spike uses it and **does not need the `ws` package**. The token goes in the query string, so no custom headers are needed.

### 10.3 Protocol defaults (verify in the spike, then update this section)
- **`ping`**: send it as a JSON-RPC *request* (with an `id`) and ignore the result. A ping timeout logs a warning but does not disconnect.
- **`clientSeq`**: one monotonically increasing counter **per connection**, starting at 1. If the server turns out to expect a per-channel counter, change it and record that here.
- **Working directory → URI**: accept only an absolute POSIX path (reject anything else in the UI), and convert it with `'file://' + path.split('/').map(encodeURIComponent).join('/')`.
- **Ids**: use `crypto.randomUUID()` for `clientId`, session ids and `turnId`. Both github.io and localhost are secure contexts.
- **Stop button**: dispatch `chat/turnCancelled` only if the chat reference lists it as client-dispatchable. Otherwise hide the button.
- **Field names** from §3.6 (`ResponsePart`, `toolCallReady`, `toolCallConfirmed`) must be confirmed against the JSON schemas **and** the real spike output before writing `render.js`. The spike writes raw frames to `ai-connect/spike/last-run.jsonl`. That file is gitignored, and tokens are redacted before writing.

### 10.4 Safe rendering (implements §5.8 with no third-party libs)
- v1 does **not** parse markdown. Text goes in elements via `textContent` with `white-space: pre-wrap`. Fenced code blocks (```` ``` ````) are split out into `<pre><code>`, also via `textContent`.
- There is **no `innerHTML` anywhere**: `grep -r innerHTML ai-connect/src` must return nothing.

### 10.5 CSP (refines §5.7)
`default-src 'self'; script-src 'self'; style-src 'self'; connect-src ws://127.0.0.1:* ws://localhost:*; img-src 'self' data:; base-uri 'none'; form-action 'none'`. No inline scripts or styles.

### 10.6 Testing (Step 1)
- No test framework. `ahp-client.js` accepts an injectable WebSocket constructor (defaulting to `globalThis.WebSocket`), and `node --test ai-connect/test/` runs it against a fake socket.
- The tests cover id correlation, channel routing, request timeout, `clientSeq` increments and tolerance of unknown notifications.

### 10.7 Step 7 compatibility
- `report-ui` is TS + Vite. `ahp-client.js` and `session.js` carry JSDoc types so they can later be imported there with `allowJs`. Nothing changes in `report-ui` in v1.

### 10.8 What the implementer needs from the user before Step 0
1. Start `code agent host` (command in §10.2) and share the printed `Local:` URL. The token can be passed via an env var instead of being pasted into chat.
2. Run `gh auth refresh -s read:user,user:email` once.
3. Choose a working directory for the test session (e.g. this repo's path).

### 10.9 Windows notes (the README must include these)
- The `gh` CLI isn't installed by default. Install it with `winget install --id GitHub.cli`, open a **new** terminal, then run `gh auth login`.
- Generate the connection token in PowerShell, since `openssl` and `$(…)` are bash-only:
  `code agent host --connection-token ([guid]::NewGuid().ToString('N'))`
- Get the GitHub token the same way: `gh auth refresh -s read:user,user:email`, then `gh auth token`.
- The browser and the host must run on the **same** machine.
- Unverified: whether a manually created classic PAT (`ghp_…`) with `read:user user:email` works instead of the `gh` OAuth token (`gho_…`). Copilot may reject PATs. Test this only if `gh` isn't an option.

### 10.10 Two ways to get the GitHub token (gh first, PAT as fallback)
The page has one **GitHub token** field. A help panel next to it offers two tabs, and the page itself never runs OAuth: GitHub's OAuth/device-flow endpoints don't allow CORS, so a static page can't call them.

1. **gh CLI (recommended).**
   - github.com, including GitHub Enterprise Cloud with SSO: `gh auth login`, then `gh auth refresh -s read:user,user:email`, then `gh auth token`. With SAML SSO, `gh` asks you to authorize the org; accept it.
   - GHE Cloud with data residency (`<tenant>.ghe.com`): add `--hostname <tenant>.ghe.com` to each command.
2. **Personal access token (fallback, unverified).** Create a classic PAT with `read:user` and `user:email`, then click **Configure SSO → Authorize** for the enterprise org. Enterprise policy may block PATs, or Copilot may reject them. If so, the page shows the host's error text as is.

Behavior:
- After `initialize`, read `agents[].protectedResources[].resource`. If it isn't `https://api.github.com`, show "Enterprise host detected: <host>" and the matching `--hostname` command in the gh tab.
- If `authenticate` or `createSession` fails with `-32007` or an auth error, show which token type was likely used (`gho_`, `ghp_`, `github_pat_`, or other, judged from the prefix only), plus the fix for that type: missing scopes, SSO not authorized, or PAT not allowed.
- Never log the token or send it anywhere except the local host's `authenticate` call.

### 10.11 Mac: `code` not on PATH
- Either run the CLI from the app bundle with its full path (§10.2), or, in VS Code, open the Command Palette and run **Shell Command: Install 'code' command in PATH**, then open a new terminal.
- Windows already has `code` on PATH. There, `code agent host` prints the URL with the token, as expected.

### 10.12 Step 0 spike results (Mac, VS Code 1.142.0, 2026-10-21): PASSED
- **U3:** the first offer `["1.0.0","0.10.0","0.9.0"]` negotiated **`1.0.0`**. No `-32005`.
- **Port and token:** with no flags, the host picked port **49495** (not 8081) and a new UUID token, both of which change on every start. The UI must not assume a port. Recommend `--port` and `--connection-token-file` for a stable setup.
- **`initialize` already returns the root snapshot** in `result.snapshots[]`, with `{resource:"ahp-root://", state:{agents, activeSessions, config}}`. No separate `subscribe ahp-root://` is needed.
- **Agents:** `copilotcli` (Copilot, GitHub resource `required:true`) and **`claude`** (GitHub resource `required:false`). For v1, default to `copilotcli`, and show a picker later if wanted.
- **U4:** `authenticate` with a `gho_` token from `gh` returned `{}` and worked, **even though the token had only `gist, read:org, repo, workflow`**, without `read:user user:email`. Keep `gh auth refresh` in the README as a fallback, not as a hard requirement.
- `createSession` returned `null`, as expected. The session state's `defaultChat` looks like **`ahp-chat://default/<base64 of session uri>`**, not `ahp-chat:/<uuid>`. Always use `defaultChat` exactly as given, and never build it yourself.
- **Streaming shapes are confirmed:**
  - `chat/responsePart` `{turnId, part:{kind:"markdown", id, content}}`. **The part already carries the first chunk of text in `content`.**
  - `chat/delta` `{turnId, partId, content}` appends to that part.
  - `chat/turnComplete` `{turnId, duration}`.
  - The `chat/turnStarted` dispatch is echoed back. The UI must de-duplicate it against its optimistic echo by `turnId`.
- **Other actions seen, which the UI ignores or uses for status only:** `session/chatUpdated` (has `changes.status`), `session/titleChanged`, `session/metaChanged`, `session/ready`, `session/serverToolsChanged`, `session/customizationUpdated` (MCP server state), `session/changesetsChanged`, `chat/changesetsChanged`, `chat/usage` (tokens, model), `root/agentsChanged`, `root/activeSessionsChanged`.
- Model reported in `chat/usage`: `claude-sonnet-5.5` (Copilot "Auto").
- Token redaction in `last-run.jsonl` was verified: neither token appears in the log.
- **Still to verify:** tool-call actions (`toolCallStart`, `toolCallReady`, `toolCallConfirmed`) and turn cancel. Steps 4 and 5 will exercise them.

### 10.13 Tool approval findings (spike, 2026-10-21): changes §5.5 and Step 5
- **Even with `autoApprove:"default"` ("Manual permissions"), the host auto-approves:**
  - reads and writes inside the working directory;
  - shell commands that match its default safe-command rules (e.g. `ls`, `echo … > file-in-cwd`).

  Source: `src/vs/platform/agentHost/node/sessionPermissions.ts` → `getAutoApproval()`. `sandboxEnabled:"off"` doesn't change this. The only switch is the **host-wide** root config `terminalAutoApproveEnabled`, which the page must not change. **"Every tool call needs a click" (§5.5) is not achievable from the client.** The UI must say so, and recommend a dedicated working directory.
- **`chat/toolCallReady` can arrive twice for one call:**
  1. The first carries `confirmed:"not-needed"`. It's a preliminary event, and a Deny sent then is ignored.
  2. The second is either:
     - auto-approved: it carries `confirmed` again; or
     - a **real prompt**: there is **no `confirmed` field**, and it carries `confirmationTitle` (e.g. "Run in terminal?") and `options:[{id,label,kind:"approve"|"deny",group?}]` (e.g. `allow-session` / `allow-once` / `skip`).
- **UI rule:** show buttons **only** when `toolCallReady` has no `confirmed`. Render the server's `options` when present, with the deny option as the default and focused button. Otherwise show plain Approve/Deny.
  - Approve: `{type:"chat/toolCallConfirmed", turnId, toolCallId, approved:true, confirmed:"user-action", selectedOptionId?}`
  - Deny: `{…, approved:false, reason:"denied", selectedOptionId?}`
  - Calls with `confirmed` set get an "auto-approved by host" badge.
- **Deny verified:** for a `touch` outside the working directory, the file was not created, and `toolCallComplete` returned `success:false` with "The user rejected this tool call".
- **More shapes:**
  - `chat/toolCallStart` `{toolCallId, toolName, displayName, _meta.toolKind}`
  - `chat/toolCallDelta` `{invocationMessage}` (string or `{markdown}`)
  - `chat/toolCallContentChanged` (terminal resource, ignored in v1)
  - `chat/toolCallComplete` `{result:{success, pastTenseMessage, content}}`
- **Turn cancel:** `chat/turnCancelled` is `@clientDispatchable` and has the shape `{turnId, duration}`, where `duration` is measured on the client's own clock.
- **Working directory on Windows:** accept `C:\…` too, and convert it to `file:///C:/…`. This supersedes the POSIX-only rule in §10.3.
- **Browsers can't tell a 403 apart from "host not running":** both surface as WebSocket error + close 1006. The UI shows one combined message, which replaces the Step 2 "Rejected (403)" acceptance text.

### 10.14 Implementation status (2026-10-21)
- **Step 0:** done (§10.12, §10.13).
- **Step 1:** done. `ai-connect/src/ahp-client.js` has 13 tests passing with `cd ai-connect && npm test` (Node 22 needs `node --test test/*.test.js`; it doesn't accept a directory argument). `ai-connect/package.json` sets `"type":"module"`.
- **Steps 2–5:** implemented in `index.html`, `src/{session,render,app}.js` and `src/styles.css`.
  - `session.js` was verified end to end from Node against the real host: a multi-paragraph answer streamed, and pings worked.
  - **Pending:** a manual browser check of the page UI, including a tool card with Approve/Deny and Stop.
- **Step 6:** `.github/workflows/pages.yml` is written. Its test job runs the unit tests plus the innerHTML grep; deploy uploads `ai-connect/` only. **Pending** a git remote and enabling Pages (U1, U2, U7).
- **Step 7:** not started.
- **Added a file not in §6:** `src/app.js`, the UI wiring. The CSP forbids inline scripts, so this code has to live in its own file.

### 10.15 GitHub Enterprise with its own domain (from source; not tested live, since there's no GHE account here)
- The host derives its GitHub endpoints and `protectedResources` from the **root config key `githubEnterpriseUri`**. Source: `agentHostGitHubEndpointService.ts`, `deriveGitHubEndpoints()`.
  - `https://acme.ghe.com` → `https://api.acme.ghe.com`
  - `https://ghe.example.com` (Enterprise Server) → `https://ghe.example.com/api/v3`
  - Empty or github.com → `https://api.github.com`
- VS Code normally pushes this value. A standalone host can get it from `agent-host-config.json`, or from any client via the **client-dispatchable** action `{type:"root/configChanged", config:{githubEnterpriseUri}}` on `ahp-root://`.
- The page has an optional **GitHub host** field. If it differs from the host's current value, the page dispatches `root/configChanged`, waits up to 5 s for `root/agentsChanged`, then authenticates against the new resource. The setting is host-wide, and the UI says so.
- gh commands: `gh auth login|token|refresh --hostname <host>`, or set `GH_HOST`.
- Enterprise Cloud on github.com with SSO needs no host setting.

### 10.16 Token types tested (2026-10-21)
- **`gho_` from `gh auth token`:** works (Mac).
- **Classic PAT `ghp_`:** `authenticate` and `createSession` succeed, but the first turn fails with `chat/error` → `part.error = {errorType:"query", message:"Execution failed: 400 Bad Request (Request ID: …)"}`. The request ID is GitHub's, so GitHub's Copilot service refused the token. **Not usable.** The page warns when the token starts with `ghp_`.
- **Fine-grained PAT with the "Copilot Requests" permission:** untested. It's the documented option for the standalone Copilot CLI.
- `chat/error` shape (fixes §3.6): `{turnId, duration, part:{kind:"error", error:{errorType, message, stack?}, resumable?}}`. The page previously showed "Unknown error" because it read `a.error.message`.

### 10.17 Personal access tokens are ruled out (host log, 2026-10-21)
- Fine-grained PAT (`github_pat_`) fails exactly like the classic one. `~/.vscode-server/data/logs/<ts>/agenthost.log` shows Copilot API `models.list` → `400 … "checking third-party user token: bad request: Personal Access Tokens are not supported for this endpoint"`.
- **Only OAuth tokens work** (`gho_` from `gh auth token`, or VS Code's own sign-in). This supersedes the PAT fallback in §10.10 and §10.16. The page warns on the `ghp_` and `github_pat_` prefixes.
- **Debug tip:** the browser only sees `chat/error` with "400 Bad Request". The real cause is in the host log: `~/.vscode-server/data/logs/<ts>/agenthost.log` on macOS/Linux, `%USERPROFILE%\.vscode-server\data\logs\<ts>\agenthost.log` on Windows (path assumed, by analogy).

### 10.18 PAT deep-dive (2026-10-21), CONCLUDED: supersedes the "ruled out" wording in §10.17
**Evidence so far:**
- **Host and runtime logs.** `~/.copilot/logs/process-*.log` shows `get_model_list` → 400 with `"checking third-party user token: bad request: Personal Access Tokens are not supported for this endpoint"`. The response has a Copilot API request id. The URL and request headers are not logged.
- **Runtime binary** (`@github/copilot-sdk-darwin-arm64` 1.0.19 / runtime 1.0.95) contains its own message: "Classic personal access tokens (ghp_) are not supported. Use a fine-grained personal access token with the 'Copilot Requests' permission, or an OAuth token…". So **the runtime itself intends to support fine-grained PATs.** It also reads `GITHUB_COPILOT_INTEGRATION_ID` / `COPILOT_INTEGRATION_ID_OVERRIDE`.
- **VS Code source.** The agent host passes client name `vscode-agent-host` to the runtime (`copilotManagedSettings.ts`, `AGENT_HOST_COPILOT_CLIENT_NAME`). The GitHub token is sent directly as `Authorization: Bearer` to the Copilot API (`copilotApiService.ts`). There is no session-token exchange.
- **Community evidence:**
  - [copilot-cli#233](https://github.com/github/copilot-cli/issues/233): a GitHub maintainer says the PAT 400 was caused by the wrong integration id, which must be `copilot-developer-cli`.
  - [flutter_agent_harness#1606](https://github.com/IstiN/flutter_agent_harness/issues/1606): a fine-grained PAT gets 200 on `/models` and `/chat/completions` with `Copilot-Integration-Id: copilot-developer-cli`, and the identical "not supported" 400 without it.
- **Hypothesis:** the Copilot API accepts fine-grained PATs only for the official CLI's integration id. The agent host identifies as `vscode-agent-host`, so it is refused regardless of token permissions.
- **Fine-grained PAT preconditions:** resource owner = **your personal account** (the Copilot Requests permission is hidden when an org is the owner), with the **Copilot Requests** permission added.

**Remaining step:** run `PROBE_TOKEN='github_pat_…' node ai-connect/spike/token-probe.mjs`. It compares `vscode-agent-host` vs `copilot-developer-cli` on `/models` and `/chat/completions` for the same token. Baseline with the `gho_` token: all 200.

**Probe result with the user's fine-grained PAT (2026-10-21): hypothesis PROVEN.**
- The token is valid: `/user` 200, expires 2026-11-20. The Copilot entitlement is fine: `/copilot_internal/user` 200, `cli_enabled:true`, individual plan.
- Same token, same endpoints, only `Copilot-Integration-Id` varied:

  | Request | none | `vscode-agent-host` | `copilot-cli` | `copilot-developer-cli` |
  |---|---|---|---|---|
  | `GET /models` | 400 | **400** | 400 | **200** |
  | `POST /chat/completions` | n/a | **400** | n/a | **200** ("Ok!") |

  All 400s are "checking third-party user token: bad request: Personal Access Tokens are not supported for this endpoint".
- **Verdict:** the Copilot API accepts PATs only from the official Copilot CLI integration (`copilot-developer-cli`). The agent host identifies as `vscode-agent-host`, so **every PAT (classic or fine-grained) is refused through the agent host**, whatever its permissions, owner or SSO state. The token isn't the problem; the client is.
- **Not pursued:** making the host send `copilot-developer-cli`, e.g. via the runtime's `COPILOT_INTEGRATION_ID_OVERRIDE` env var. That would impersonate another GitHub client to get around GitHub's access rule.
- **Working options:** OAuth tokens. `gh auth token` (`gho_`) is verified. A token from the GitHub Copilot CLI's own login is also OAuth, but is untested here.

### 10.19 Shared host sign-in, and the VS Code route (2026-10-21)
- **Verified:** the host keeps **one GitHub sign-in for all connections**. Connection A ran `authenticate` and disconnected. Connection B never authenticated, yet created a session and got an answer ("shared auth ok"). The page's GitHub token field is therefore **optional**: without a token, the page relies on the host's existing sign-in and shows a clear message on `-32007`.
- **VS Code can sign the host in** (from source, *not yet tested*). Desktop VS Code connects to WebSocket agent hosts listed in its settings:
  ```json
  "chat.remoteAgentHostsEnabled": true,
  "chat.remoteAgentHosts": [{ "address": "ws://127.0.0.1:8081", "name": "Local AHP", "connectionToken": "<token>" }]
  ```
  Source: `remoteAgentHostService.ts`, `IRawRemoteAgentHostEntry {address, name, connectionToken}`. VS Code then pushes its own GitHub OAuth sign-in to that host, so the page needs no GitHub token. That matters for machines where `gh` can't sign in.
- **Copilot CLI policy (U5):** inconclusive. The runtime has no obvious client-side "CLI disabled" check, but a server-side policy can't be ruled out. Test on the machine with the policy: does a Copilot harness session in VS Code's Agents window work there?

### 10.20 VS Code signs the host in: VERIFIED on Mac (2026-10-21)
- **Setup:**
  - A fresh host: `code agent host --replace --port 8081 --connection-token-file ~/.ahp-test-token`. Only one host per machine is allowed; `--replace` takes over from the running one.
  - **Baseline without any token:** `createSession` succeeds, but the first turn fails with `chat/error` "Execution failed: InvalidArg, No GitHub OAuth token or Copilot HMAC key provided".
- **Then:**
  1. Add the host to VS Code settings (`chat.remoteAgentHostsEnabled`, `chat.remoteAgentHosts:[{address,name,connectionToken}]`).
  2. Open the Agents window: `code --agents`, or **Chat: Open Agents Window**.
  3. VS Code connects at once (`clientInfo.name:"vscode-agents-window"`, `vscode.clientConnectionKind:"direct_websocket"`) and calls `authenticate` for `https://api.github.com` and `https://api.github.com/repos` with its own GitHub OAuth sign-in. No session is needed.
- **Result:** a client that never authenticates (the page or `session.js`) gets a full answer ("signed in via host").
- **Consequences:**
  - On machines where `gh` can't sign in, use **VS Code's own GitHub sign-in**. Leave the page's GitHub token empty.
  - The host keeps the sign-in until it restarts. After a host restart, reopen the Agents window.
- **Security notes:**
  - The connection token now also lives in VS Code `settings.json` (plain text). Treat that file accordingly, or use a test token and rotate it.
  - VS Code also pushed its `repo`-scoped token to the host. Any client holding the connection token can then use the agent with your repo access.

### 10.21 503 on the WebSocket handshake (Windows, 2026-10-21)
- `code agent host` runs a CLI supervisor (`code-tunnel`, source in `cli/src/tunnels/agent_host.rs`). It owns the port and forwards to the agent host over a local socket.
- It returns **503** when `ensure_server()` fails, with the body "Error starting agent host: …". That includes `ServerDownloadError`, because the supervisor downloads the server bits, which can fail behind a corporate proxy. It also returns 503 when it can't reach the host socket ("Error connecting to agent host: …").
- The agent host itself only returns 403, and only for a bad token.
- The browser can't read the 503 body. **Diagnose with:**
  - `curl.exe -i "http://localhost:8081/?tkn=…"`
  - the supervisor log, `%USERPROFILE%\.vscode-server\cli\agent-host-stable.log`
- A likely fix on a corporate network: set `HTTPS_PROXY` before starting the host. To be confirmed with the real error text.

### 10.22 Windows corporate machine: WORKING (2026-10-22)
- **Host:** VS Code 1.143.0 (commit `2d0b7506…`), standalone host on port 8089.
  - The server package download had failed with `ServerDownloadError` because the network blocks the download. The fix was to place the server in `%USERPROFILE%\.vscode\cli\servers\Stable-<commit>\server` plus `lru.json` (or use a proxy). Afterwards the supervisor runs on the cached copy ("Error checking for updates, using cached").
- **Sign-in:** `gh` can't sign in on that network, and PATs are refused through the agent host (§10.18). **VS Code signed the host in** via `chat.remoteAgentHosts` + the Agents window (§10.20). The page then ran a Copilot session with an empty GitHub token field.
- **U5 answered:** the org's "Copilot CLI disabled" policy does **not** block the Copilot harness in the agent host.
- **Harmless log noise:** `Agent host WebSocket proxy ended with error: Os { code: 10053 … }` appears when the browser closes a connection, e.g. on a page reload.
- **Still open:** U1, U2 and U7 (the deployed github.io page in Chrome/Edge, local network access prompt, corporate browser policy), and Step 7.
