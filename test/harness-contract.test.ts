/**
 * Runs the shared HarnessAdapter contract against every harness in the repository.
 * A Copilot harness, when one exists, adds a driver here.
 */
import { harnessContract } from './harness-contract.js';
import {
  ClaudeAgentSdkHarness,
  type ClaudeAgentSdkModule,
  type HarnessAdapter,
} from '../packages/squad-sdk/src/backend/index.js';

/** Scripted Agent SDK: requests approval for each tool in parallel, then replies. */
function scriptedClaudeSdk(script: { reply: string; tools?: Array<{ name: string; input: Record<string, unknown> }> }): ClaudeAgentSdkModule {
  return {
    query({ options = {} }) {
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'contract-session' };
        await Promise.all(
          (script.tools ?? []).map((t, i) =>
            options.canUseTool!(t.name, t.input, { signal: options.abortController!.signal, toolUseID: `toolu_${i}` })),
        );
        if (options.abortController?.signal.aborted) throw new Error('aborted');
        yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: script.reply }] } };
        yield { type: 'result', subtype: 'success', is_error: false, result: script.reply };
      })();
    },
  };
}

harnessContract('claude-agent-sdk', {
  create: (script) => new ClaudeAgentSdkHarness({ cwd: process.cwd(), loadSdk: async () => scriptedClaudeSdk(script) }),
  settled: (h: HarnessAdapter, c, r, s) => (h as ClaudeAgentSdkHarness).settled(c, r, s),
});
