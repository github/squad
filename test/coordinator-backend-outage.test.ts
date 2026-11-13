/**
 * Bridge outage with a non-local state backend (#2487 scenarios).
 *
 * Seen live: with `"stateBackend": "two-layer"` and the squad_state server unable to start, the Claude
 * coordinator wrote the decision straight into .squad/decisions.md, which that backend does not read.
 * The digest now tells it to check config.json and stop instead.
 */
import { describe, it, expect } from 'vitest';
import { CLIENT_IDS, buildCoordinatorInstructions } from '../packages/squad-sdk/src/client/adapters/index.js';

describe('coordinator: squad_state unavailable', () => {
  it.each(CLIENT_IDS.filter((id) => id !== 'copilot'))('%s: checks the configured backend and stops instead of writing state files', (id) => {
    const t = buildCoordinatorInstructions(id, '.team');
    expect(t).toMatch(/If the bridge is unavailable \(the `squad_state` tools are missing, fail to start or error\), read `\.team\/config\.json`/);
    expect(t).toMatch(/`stateBackend` is set to anything other than `local`/);
    expect(t).toMatch(/stop and say so, naming the backend, and NEVER write `\.team\/decisions\.md`, the decisions inbox or other state files directly/);
    expect(t).toContain('`squad doctor`');
  });
});
