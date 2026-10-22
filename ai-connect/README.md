# Copilot Harness Connect

A single static page that connects from your browser to the **Copilot harness running on your own machine** (`code agent host`). It speaks the [Agent Host Protocol](https://microsoft.github.io/agent-host-protocol/) (JSON-RPC over WebSocket). There is no backend.

Proof of concept: it will later become an optional "Connect AI" panel in the Playwright reports dashboard.

## 1. Start the host

**macOS / Linux**

```sh
code agent host --connection-token "$(openssl rand -hex 16)"
```

If you get `code: command not found`, open VS Code and run **Shell Command: Install 'code' command in PATH** from the Command Palette, then open a new terminal. Or call the CLI inside the app bundle:

```sh
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" agent host
```

**Windows (PowerShell)**

```powershell
code agent host --connection-token ([guid]::NewGuid().ToString('N'))
```

Copy the `Local: ws://…?tkn=…` line that the host prints.

Without flags, the host picks a **new port and token every time it starts**. For stable values, use:

```sh
code agent host --port 8081 --connection-token-file ~/.ahp-token
```

Never use `--without-connection-token` or `--host 0.0.0.0`.

## 2. Get a GitHub token

The host doesn't reuse your VS Code sign-in, so the page has to send it a GitHub token.

**Option A: gh CLI (recommended)**

```sh
gh auth login        # once
gh auth token        # prints gho_…
```

- If the host rejects the token, add the Copilot scopes with `gh auth refresh -s read:user,user:email`.
- With GitHub Enterprise Cloud SSO, authorize the org when `gh` asks.
- GitHub Enterprise with its **own domain** (Enterprise Cloud with data residency, `acme.ghe.com`, or Enterprise Server, `github.company.com`):
  1. Add `--hostname <host>` to every gh command, e.g. `gh auth login --hostname acme.ghe.com`, then `gh auth token --hostname acme.ghe.com`. Alternatively, set `GH_HOST=acme.ghe.com` once in that terminal.
  2. Enter the same host in the page's **GitHub host** field. The page then points the local host at that instance (root config `githubEnterpriseUri`) before signing in. This setting is host-wide: put the field back to empty to switch back to github.com.
- Enterprise Cloud **on github.com** (SSO orgs, `github.com/your-org`) is plain github.com. Leave **GitHub host** empty and use no `--hostname`.
- On Windows, install `gh` first with `winget install --id GitHub.cli`, then open a new terminal.

**Personal access tokens don't work through the agent host.** This applies to classic (`ghp_…`) and fine-grained (`github_pat_…`) tokens, whatever their permissions. It was verified on 2026-10-21 with `spike/token-probe.mjs`:

- The same fine-grained token returns 200 from the Copilot API when the request identifies as the official Copilot CLI (`Copilot-Integration-Id: copilot-developer-cli`).
- It returns 400 "Personal Access Tokens are not supported for this endpoint" when the request identifies as the VS Code agent host (`vscode-agent-host`).

The agent host accepts the token at sign-in, then every answer fails. Use an OAuth token from `gh auth token`.

**Option B: let VS Code sign the host in (no `gh`, no token to paste)**

The host keeps one GitHub sign-in for all its clients. VS Code can provide it:

1. Start the host with a fixed port and token: `code agent host --port 8081 --connection-token-file ~/.ahp-token`
2. Add this to VS Code `settings.json`:
   ```json
   "chat.remoteAgentHostsEnabled": true,
   "chat.remoteAgentHosts": [{ "address": "ws://127.0.0.1:8081", "name": "Local AHP", "connectionToken": "<contents of ~/.ahp-token>" }]
   ```
3. Open the Agents window: **Chat: Open Agents Window**, or run `code --agents`. VS Code connects and signs the host in with your VS Code GitHub account.
4. In the page, leave **GitHub token** empty.

Repeat step 3 after each host restart. The connection token is then also stored in `settings.json`.

## 3. Connect

1. Open the page:
   - deployed: `https://<user>.github.io/<repo>/`
   - locally: `npm run serve` in this folder, then open http://localhost:5173
2. Paste the `Local:` line into **Host URL**. The token field fills itself in.
3. Click **Connect**. If Chrome asks to allow access to devices on your local network, click **Allow**.
4. Pick the agent, paste the GitHub token, enter a **working directory**, and click **Start session**.
5. Send a prompt. Tool calls that need your approval show buttons, and **Skip/Deny** is the default.

## Tool approvals: read this

Even in "Manual permissions" mode, the host **runs these without asking**:

- reads and writes inside the working directory;
- shell commands that it considers safe (e.g. `ls`, `cat`, `echo > file` inside the folder).

It asks before anything else, such as writes outside the folder or unknown commands. **Point the session at a dedicated folder**, not your home directory.

## Security

- The connection token is a **remote-control key** for an agent that can run commands on your machine.
- Tokens are kept in `sessionStorage` only if you tick **Remember for this tab**. **Disconnect & forget** clears them.
- The page loads no third-party scripts and has a strict CSP: it can connect only to `ws://127.0.0.1:*` and `ws://localhost:*`.
- Agent output is rendered as plain text. Markdown is not interpreted, and no HTML is injected.

## Limits

- Tested in Chrome on macOS. Safari, Firefox and the github.io deployment are not verified yet.
- Works only on the machine where the host runs.
- A rejected connection token and a host that isn't running look the same to a browser. The page reports both with one message.

## Development

```sh
npm test                                   # unit tests (node --test, no dependencies)
AHP_URL='ws://127.0.0.1:…?tkn=…' npm run spike -- --full --cwd "$PWD"
```

The spike writes raw protocol frames to `spike/last-run.jsonl`, with tokens redacted. That file is gitignored.

Files:

- `src/ahp-client.js`: JSON-RPC over WebSocket. Handles request/response by id, routing by (method, channel), ping and `clientSeq`. Has no DOM access.
- `src/session.js`: the flow initialize → authenticate → createSession → subscribe → turns. Has no DOM access.
- `src/render.js`: chat actions → DOM (text parts, deltas, tool cards).
- `src/app.js`: wiring for `index.html`.

Protocol notes and findings are in [`../copilot-harness-static-page-plan.md`](../copilot-harness-static-page-plan.md) §10.
