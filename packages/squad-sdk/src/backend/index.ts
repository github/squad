/**
 * Experimental Squad 2.0 conversation & harness backend subpath (`@bradygaster/squad-sdk/backend`).
 *
 * @experimental This surface is exported only from the `./backend` subpath and is not re-exported
 * from the root `@bradygaster/squad-sdk` barrel.
 * @module backend
 */

import { DurableHttpSquadBackend } from './durable-http-backend.js';
import { createFileStateStore, LocalSquadBackend } from './local-backend.js';
import type { BackendConfig, SquadBackend } from './types.js';

export * from './types.js';
export * from './harness-registry.js';
export { LocalSquadBackend, MemoryStateStore, createFileStateStore } from './local-backend.js';
export type { LocalSquadBackendOptions, FileStateStoreOptions } from './local-backend.js';
export { createStateBackendStore } from './state-backend-store.js';
export type { StateBackendLike, StateBackendStoreOptions } from './state-backend-store.js';
export { DurableHttpSquadBackend, validateBaseUrl } from './durable-http-backend.js';
export { ClaudeAgentSdkHarness, CLAUDE_AGENT_SDK_HARNESS_ID, claudeApprovalHash, claudeApiCredentialsConfigured, claudeDenyRules, isClaudeAgentSdkAvailable } from './harnesses/claude-agent-sdk.js';
export { HarnessState, MAX_REMEMBERED } from './harnesses/harness-state.js';
export { CopilotSdkHarness, COPILOT_SDK_HARNESS_ID } from './harnesses/copilot-sdk.js';
export type { CopilotSdkHarnessOptions, CopilotClientLike, CopilotSessionLike, CopilotSessionConfig, CopilotSessionEvent, CopilotPermissionRequest, CopilotPermissionResult } from './harnesses/copilot-sdk.js';
export { TurnApprovals, canonicalApprovalHash, redactApprovalPayload, redactText, summarizeAction } from './harnesses/approval-queue.js';
export { TurnHarness, TurnCancelled } from './harnesses/turn-harness.js';
export type { TurnRun } from './harnesses/turn-harness.js';
export type { ApprovalOutcome } from './harnesses/approval-queue.js';
export type { ClaudeAgentSdkHarnessOptions, ClaudeAgentSdkModule, ClaudeSdkMessage, ClaudeQueryOptions, ClaudeCanUseTool, ClaudePermissionResult } from './harnesses/claude-agent-sdk.js';
export type { DurableHttpOptions } from './durable-http-backend.js';

/**
 * Build a backend for `"local"`, `"mcp"` (in-process; shares the local contract) or `"durable-http"`.
 * @experimental
 */
export function createSquadBackend(config: BackendConfig): SquadBackend {
  switch (config.kind) {
    case 'local':
    case 'mcp':
      return new LocalSquadBackend({
        kind: config.kind,
        state: config.state ?? createFileStateStore(config.squadDir),
        harnesses: config.harnesses,
      });
    case 'durable-http':
      return new DurableHttpSquadBackend(config);
    default:
      throw new Error(`Unknown backend kind: ${(config as { kind: string }).kind}`);
  }
}
