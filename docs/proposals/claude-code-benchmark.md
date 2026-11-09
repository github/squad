# Proposal: Run the paired A/B benchmark on Claude

**Status:** Draft
**Builds on:** `scripts/premise-checking-ab.mjs` (branch `bradygaster-premise-checking-plan`, not yet on `dev`)
**Related:** #2438 (Claude Code projection)

## Problem

Squad's long-running paired benchmark (8 scenario families × 3 arms, frozen
paired calibration, resumable rows, blinded adjudication) proves the
truth-first coordinator and Fact Checker on one model (`gpt-5.3-codex`)
through one harness (`@github/copilot-sdk`). Claude Code users will ask two
separate questions, and the current run answers neither:

1. **Model:** does Squad help when the model is Claude?
2. **Harness:** does Squad help inside Claude Code, the tool they actually use?

Running Claude models through Copilot answers (1) only. Results from the
Copilot harness will be read in the Claude community as "a Copilot benchmark",
however good the numbers are.

## Design: a 2 × 2, one model, one fixture

Keep everything frozen (fixture, oracle criteria, arms, prompt sources,
budgets, blinding, adjudication guide) and vary only the host:

|                      | Copilot SDK (existing driver) | Claude Agent SDK (new driver) |
|----------------------|-------------------------------|-------------------------------|
| **Claude model**     | Phase A                       | Phase B                       |
| **gpt-5.3-codex**    | existing results              | n/a                           |

- **Phase A vs. existing results** isolates the model effect within one harness.
- **Phase B vs. Phase A** isolates the harness effect with the model held fixed.
- **Phase B alone** is the headline for Claude users: baseline vs.
  truth-first vs. truth-first-notice, in Claude Code's own runtime.

Pin one Claude model ID for both phases (for example `claude-sonnet-5-5`), and
record it in the manifest. Do not use an alias that can move during a campaign.

## Phase A: Claude model through the Copilot SDK

The cheapest step, and no bridge is needed: the harness already talks to
Copilot through `CopilotClient`. Changes:

- Replace the `MODEL_ID` constant with a `--model` flag, defaulting to
  `gpt-5.3-codex` so existing manifests and resume still validate.
- Store the model in the manifest and refuse to resume a campaign under a
  different model.
- `runModelPreflight` / `ensureCapabilityFits` already check that the model
  is available and that its limits fit the budget. Confirm the Claude model's
  `max_prompt_tokens` / `max_output_tokens` on Copilot fit the frozen limits.
  If not, record the change as a new protocol hash rather than editing limits
  in place.

`squad copilot-bridge` (the ACP stdio bridge to the Copilot CLI) is not
involved: the benchmark uses the Copilot SDK directly.

## Phase B: Claude Agent SDK driver

### Extract a host driver

The harness touches the Copilot SDK in a small number of places. Put them
behind an interface, keep the Copilot implementation byte-for-byte equivalent,
and add a Claude implementation:

```ts
interface HostDriver {
  id: 'copilot' | 'claude';
  preflight(model, limits): Promise<ModelInfo>;            // queryAvailableModel + ensureCapabilityFits
  createSession(opts: {
    role: 'coordinator' | 'fact-checker';
    model: string;
    systemPrompt: string;                                  // buildSystemPrompt / Fact Checker prompt
    tools: ToolDef[];                                      // read_evidence, task (same handlers)
    limits: Limits;
    reasoningEffort?: 'medium';
  }): Promise<HostSession>;
}

interface HostSession {
  sessionId: string;
  on(event: 'message' | 'usage' | 'tool.start' | 'tool.end', cb): void;
  sendAndWait(prompt: string, remainingMs: number): Promise<Response>;
  abort(): Promise<void>;
}
```

`attachSessionRecorder`, `createUsageLedger`, the budget checks, blinding and
adjudication stay host-neutral and consume normalized events.

### Map Copilot concepts to the Claude Agent SDK

| Harness need | Copilot SDK today | Claude Agent SDK |
|---|---|---|
| Session | `client.createSession(...)` | `query({ prompt, options })` per turn, or a streaming-input session |
| System prompt | `systemMessage: { mode: 'append' }` | `systemPrompt: { type: 'preset', preset: 'claude_code', append }` for the in-Claude-Code arm; a plain string for a bare-model control |
| Custom tools | `defineTool(...)` | `createSdkMcpServer({ tools: [tool(...)] })` passed in `mcpServers` |
| Tool allowlist | `availableTools: [...]` | `allowedTools` set to the two MCP tools only, all built-in tools disallowed, `settingSources: []` so no user or project config leaks in |
| Permissions | `onPermissionRequest` reject | `canUseTool` rejects anything outside the allowlist and logs it |
| Usage | `assistant.usage` events | `usage` on each assistant message, plus `total_cost_usd` / `modelUsage` on the result message |
| Output cap | `modelCapabilities.limits` | output cap via the SDK's max-output setting; prompt cap enforced by the existing ledger plus `interrupt()` |
| Abort | `session.abort()` | `AbortController` / `interrupt()` |

Verify each row against the current Claude Agent SDK docs before you build it.
The SDK changes often.

### Keep the Fact Checker dispatch identical

The `task` tool handler today starts a separate reviewer session with its own
tool set and budget. Keep that as the measured path: on Claude, the handler
starts a second `query()` with the Fact Checker prompt and only
`read_evidence`. Do **not** switch to Claude's native `Agent` tool for the
measured arms, because that changes two variables at once.

Add native subagent dispatch later as an optional fourth arm
(`truth-first-native`), with the Fact Checker defined through the SDK's
`agents` option, i.e. the same shape the Claude projection writes to
`.claude/agents/`. It shows whether the projection itself helps or hurts.

### Token accounting differences

Claude reports cache reads and cache writes separately from fresh input. The
ledger must:

- record `input_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens` and `output_tokens` separately;
- charge budgets on the sum of all input classes, so a cached run cannot fit
  more work under the same limit than an uncached one;
- report cost (`total_cost_usd`) next to tokens, because that is the number
  Claude users compare.

`hasCompleteModelCallUsage` and the `accounting-unknown` stop reason apply
unchanged: a model call without observed usage still stops the campaign.

## What to publish

- One table per phase: per family, per arm, pass/contradicted/unknown rates
  from blinded adjudication, with the paired difference and its interval.
- Tokens, cost and wall-clock per episode per arm.
- The manifest, fixture hash, protocol hashes, model ID and SDK versions.
- Raw JSONL transcripts, so anyone can re-adjudicate.
- A one-command rerun: `node scripts/premise-checking-ab.mjs --host claude --model <id> --mode paired-calibration`.

## Cost estimate

Measured from the Phase A pilot (2026-11-09: `claude-sonnet-5.5` through the
Copilot SDK, `revenue-midflight-agent`, all three arms).

- Each episode made 2 coordinator calls: about 78K input tokens (about 38K
  written to the cache and 40K read from it) and about 310 output tokens. The
  coordinator prompt is about 38K tokens.
- Pilot total: 234,541 charged tokens. Each episode took 7–20 seconds.
- No arm dispatched the Fact Checker. An episode that does will add a reviewer
  session and one more coordinator call, about +$0.05 on Sonnet.
- Per episode at Claude API rates: about $0.11 on Sonnet 5.5 with caching
  ($0.16 without), and about $0.22 on Opus 5.5.

| Phase B campaign (incl. ~50% for retries) | Sonnet 5.5 | Opus 5.5 |
|---|---|---|
| Pilot (3 runs) | ~$0.35 | ~$0.70 |
| Paired calibration (16) | ~$2–4 | ~$4–8 |
| Full plan (60) | ~$8–15 | ~$16–30 |

Phase B adds Claude Code's own system prompt when it uses the `claude_code`
preset. Measure that in the Phase B pilot.

Phase A, through Copilot, uses Copilot premium requests rather than per-token
billing. The full plan runs in about 15–20 minutes sequentially.

## Scope and limits

- This is a prompt-behavior evaluation on a synthetic fixture: evidence
  handling and authorization discipline. It is not a coding benchmark. Say so
  in the write-up, and pair it with a coding benchmark (for example a SWE-bench
  Verified subset, Claude Code alone vs. Claude Code + Squad) as a separate
  proposal.
- The harness branch is not on `dev`. Land it (or the driver extraction
  first) before Phase B, so the Claude driver does not fork the harness.

## Order of work

1. `--model` flag and manifest field (Phase A). Run Phase A.
2. Extract `HostDriver`. Prove the Copilot driver unchanged by re-running one
   frozen paired row and matching its protocol hashes.
3. Claude driver behind `--host claude`. Pilot on one episode, then the frozen
   paired calibration (Phase B).
4. Optional `truth-first-native` arm.
5. Write-up and published artifacts.
