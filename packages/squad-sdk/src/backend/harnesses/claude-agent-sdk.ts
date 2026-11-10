/**
 * `claude-agent-sdk` HarnessAdapter (#2441, epic #2438 Phase 1): runs admitted turns on the Claude Agent SDK.
 *
 * The SDK (`@anthropic-ai/claude-agent-sdk`) is an optional peer dependency, loaded lazily on the first
 * submission, so installs without it are unchanged. Only the small slice of its API used here is typed locally.
 *
 * Mapping (harness-adapters §5, backend `types.ts`):
 * - `submit` → one `query()` per turn; the conversation's Claude session is resumed across turns.
 *   Submissions are deduplicated by `operationId` (or `(conversationId, runId, seq)`).
 * - Assistant text → `message` events; run lifecycle → `state` events (`running`, `completed`, `failed`,
 *   `cancelled`), echoing the admission epoch.
 * - `canUseTool` → `approval-requested`. The broker holds one pending approval per turn, so concurrent tool
 *   calls are queued and offered one at a time. `approvalId` is the SDK `toolUseID`; `hash` is a sha256 of the
 *   canonical tool name and input, and a response whose hash differs never resolves the call. Approve runs the
 *   original input unchanged.
 * - A deny ends the turn, as the broker does (`cancelled`): the call and any queued ones are denied and the query
 *   is aborted. `cancel` does the same.
 * - Permission settings: `permissionMode: 'default'` and `settingSources: []`, so no repository or user allow
 *   rule approves a call the broker never sees. Endpoint-managed policy still applies (it always loads).
 *
 * Not durable across harness restarts: a pending callback lives in this process. On restart the broker's
 * pending approval should be cancelled and the session resumed (see the #2441 notes).
 */
import type { HarnessCapabilities } from '../types.js';
import { canonicalApprovalHash, summarizeAction } from './approval-queue.js';
import { TurnHarness, type TurnRun } from './turn-harness.js';

export const CLAUDE_AGENT_SDK_HARNESS_ID = 'claude-agent-sdk';
const SDK_MODULE = '@anthropic-ai/claude-agent-sdk';

// ── The slice of the Agent SDK this adapter uses ────────────────────────────────────────────────

export type ClaudePermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

export type ClaudeCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID: string; agentID?: string; decisionReason?: string },
) => Promise<ClaudePermissionResult>;

export interface ClaudeQueryOptions {
  cwd?: string;
  model?: string;
  resume?: string;
  maxTurns?: number;
  abortController?: AbortController;
  canUseTool?: ClaudeCanUseTool;
  permissionMode?: 'default';
  settingSources?: string[];
  env?: Record<string, string | undefined>;
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
}

/** A message from the SDK stream; only the fields read here are typed. */
export interface ClaudeSdkMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  parent_tool_use_id?: string | null;
  message?: { content?: Array<{ type: string; text?: string }> };
}

export interface ClaudeAgentSdkModule {
  query(args: { prompt: string; options?: ClaudeQueryOptions }): AsyncIterable<ClaudeSdkMessage>;
}

export interface ClaudeAgentSdkHarnessOptions {
  /** Working directory for every session (the repository root). */
  cwd: string;
  model?: string;
  maxTurns?: number;
  /** Appended to the Claude Code system prompt. */
  appendSystemPrompt?: string;
  /** Subprocess environment; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Loads the SDK. Defaults to a lazy `import('@anthropic-ai/claude-agent-sdk')`. */
  loadSdk?: () => Promise<ClaudeAgentSdkModule>;
}

/**
 * Whether the optional `@anthropic-ai/claude-agent-sdk` peer resolves from this package, without loading it.
 * Used to register the harness only where it can run.
 */
export function isClaudeAgentSdkAvailable(): boolean {
  try {
    import.meta.resolve(SDK_MODULE);
    return true;
  } catch {
    return false;
  }
}

/** sha256 over canonical JSON (sorted keys) of the tool name and input: the approval's bound payload. */
export function claudeApprovalHash(toolName: string, input: unknown): string {
  return canonicalApprovalHash({ tool: toolName, input });
}

/** The most telling field of a tool input, for the approval summary (the full input stays in the hash). */
function toolDetail(input: Record<string, unknown>): unknown {
  for (const k of ['command', 'file_path', 'notebook_path', 'path', 'url', 'pattern', 'query', 'subagent_type']) {
    if (typeof input[k] === 'string') return input[k];
  }
  return Object.keys(input).length ? { fields: Object.keys(input) } : undefined;
}

export class ClaudeAgentSdkHarness extends TurnHarness {
  readonly id = CLAUDE_AGENT_SDK_HARNESS_ID;
  readonly capabilities: HarnessCapabilities = {
    streaming: true,
    approvals: true,
    cancellation: true,
    tools: true,
    extensionNamespaces: ['x-claude'],
  };
  protected readonly displayName = 'Claude Agent SDK';

  /** Claude session per conversation, resumed by later turns. */
  private readonly sessions = new Map<string, string>();
  private sdk?: Promise<ClaudeAgentSdkModule>;

  constructor(private readonly options: ClaudeAgentSdkHarnessOptions) {
    super();
  }

  protected async init(): Promise<void> {
    await this.loadSdk();
  }

  /** The query listens to the run's abort signal; the turn ends when its stream does. */
  protected async interrupt(): Promise<void> {}

  protected async runTurn(run: TurnRun, prompt: string): Promise<string | undefined> {
    const sdk = await this.loadSdk();
    this.checkpoint(run);
    const resume = this.sessions.get(run.conversationId);
    const stream = sdk.query({
      prompt,
      options: {
        cwd: this.options.cwd,
        permissionMode: 'default',
        settingSources: [],
        abortController: run.abort,
        canUseTool: this.canUseTool(run),
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(this.options.maxTurns ? { maxTurns: this.options.maxTurns } : {}),
        ...(this.options.env ? { env: this.options.env } : {}),
        ...(this.options.appendSystemPrompt
          ? { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: this.options.appendSystemPrompt } }
          : {}),
        ...(resume ? { resume } : {}),
      },
    });
    let failure: string | undefined;
    for await (const message of stream) {
      if (message.session_id) this.sessions.set(run.conversationId, message.session_id);
      if (message.type === 'assistant' && !message.parent_tool_use_id) {
        const text = (message.message?.content ?? [])
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text)
          .join('');
        if (text) this.emit(run, { type: 'message', message: { runId: run.runId, seq: run.seq, role: 'assistant', content: text } });
      } else if (message.type === 'result') {
        if (message.is_error || (message.subtype && message.subtype !== 'success')) {
          failure = message.result?.trim() || message.errors?.join('; ') || message.subtype || 'error';
        }
      }
    }
    return failure;
  }

  private loadSdk(): Promise<ClaudeAgentSdkModule> {
    this.sdk ??= (this.options.loadSdk ?? (() => import(SDK_MODULE) as Promise<ClaudeAgentSdkModule>))().catch((err) => {
      this.sdk = undefined;
      throw new Error(
        `The ${CLAUDE_AGENT_SDK_HARNESS_ID} harness needs ${SDK_MODULE} (an optional peer dependency): ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    return this.sdk;
  }

  private canUseTool(run: TurnRun): ClaudeCanUseTool {
    return async (toolName, input, { signal, toolUseID }) => {
      if (signal.aborted || run.abort.signal.aborted) return { behavior: 'deny', message: 'Turn cancelled', interrupt: true };
      signal.addEventListener('abort', () => run.approvals.drop(toolUseID, 'Turn cancelled'));
      const outcome = await run.approvals.request(toolUseID, summarizeAction(toolName, toolDetail(input)), { tool: toolName, input });
      // Approve runs the original input unchanged, so what runs is what was hashed.
      return outcome.approved ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: outcome.reason, interrupt: true };
    };
  }
}
