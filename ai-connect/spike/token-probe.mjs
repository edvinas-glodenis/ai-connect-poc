// Probes the GitHub / Copilot endpoints the agent host uses, with one token,
// to find out exactly where and why a token is rejected.
//
// Usage (the token is read from the environment and never printed):
//   PROBE_TOKEN='github_pat_…' node ai-connect/spike/token-probe.mjs
//   PROBE_TOKEN="$(gh auth token)" node ai-connect/spike/token-probe.mjs   # baseline
//
// Optional: PROBE_GITHUB_API=https://api.acme.ghe.com for GitHub Enterprise with its own domain.

const token = process.env.PROBE_TOKEN?.trim();
if (!token) {
  console.error('Set PROBE_TOKEN to the token to test.');
  process.exit(1);
}
const githubApi = (process.env.PROBE_GITHUB_API ?? 'https://api.github.com').replace(/\/$/, '');

const kind = token.startsWith('github_pat_') ? 'fine-grained PAT'
  : token.startsWith('ghp_') ? 'classic PAT'
    : token.startsWith('gho_') ? 'OAuth app token (gh)'
      : token.startsWith('ghu_') ? 'GitHub App user token'
        : 'unknown';
console.log(`Token type by prefix: ${kind} (length ${token.length})\n`);

const redact = (s) => String(s).split(token).join('<token>');

async function probe(label, url, { headers = {}, method = 'GET', body } = {}) {
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'ahp-token-probe/1.0', ...headers },
      body,
    });
    const text = await res.text();
    const pick = ['x-oauth-scopes', 'x-accepted-oauth-scopes', 'x-accepted-github-permissions',
      'github-authentication-token-expiration', 'x-github-sso', 'x-github-request-id', 'x-copilot-service-request-id'];
    const hdrs = pick.filter((h) => res.headers.get(h) !== null).map((h) => `${h}: ${res.headers.get(h)}`);
    console.log(`${label}\n  ${method} ${url}\n  → ${res.status} ${res.statusText}`);
    for (const h of hdrs) console.log(`    ${h}`);
    console.log(`    body: ${redact(text.slice(0, 300)).replace(/\s+/g, ' ')}\n`);
    return { status: res.status, text };
  } catch (e) {
    console.log(`${label}\n  ${method} ${url}\n  → network error: ${e.message}\n`);
    return { status: 0, text: '' };
  }
}

// 1. Is the token valid at all, and who is it?
await probe('1. GitHub user (token valid?)', `${githubApi}/user`);

// 2. Copilot entitlement + endpoint discovery (the host calls this first).
const user = await probe('2. Copilot user / entitlement', `${githubApi}/copilot_internal/user`);
let capi = 'https://api.githubcopilot.com';
try {
  const discovered = JSON.parse(user.text)?.endpoints?.api;
  if (discovered) capi = discovered;
} catch { /* keep default */ }
console.log(`Copilot API base used below: ${capi}\n`);

// 3. Model list — this is the call that failed in agenthost.log — once per client id.
//    vscode-agent-host is what the agent host sends. The others are diagnostic only.
for (const id of [null, 'vscode-agent-host', 'copilot-developer-cli', 'copilot-cli']) {
  await probe(`3. Copilot models, Copilot-Integration-Id: ${id ?? '<none>'}`, `${capi}/models`,
    { headers: id ? { 'Copilot-Integration-Id': id } : {} });
}

// 3b. Same, with the official CLI's user agent too (community reports say both headers matter).
await probe('3b. Copilot models, copilot-developer-cli + CLI user agent', `${capi}/models`,
  { headers: { 'Copilot-Integration-Id': 'copilot-developer-cli', 'User-Agent': 'copilot/1.0.95 (darwin) term/unknown' } });

// 4. One tiny completion, as the agent host sends it and (diagnostic) as the CLI id.
const completion = JSON.stringify({ model: 'gpt-4.1', max_tokens: 5, messages: [{ role: 'user', content: 'Say ok' }] });
for (const id of ['vscode-agent-host', 'copilot-developer-cli']) {
  await probe(`4. Copilot chat completion, Copilot-Integration-Id: ${id}`, `${capi}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Copilot-Integration-Id': id },
    body: completion,
  });
}
