/**
 * Human sign-off gates in the shared coordinator digest.
 *
 * Seen live (#2487 scenarios): with a human release owner in team.md and "Sign-off required before
 * any tag or publish" in routing.md, the Claude coordinator took "cut the 1.0.0 release" as the
 * sign-off and bumped, tagged and ran npm publish itself.
 */
import { describe, it, expect } from 'vitest';
import { CLIENT_IDS, buildCoordinatorInstructions } from '../packages/squad-sdk/src/client/adapters/index.js';

const hosts = CLIENT_IDS.filter((id) => id !== 'copilot');

describe('coordinator sign-off gates', () => {
  it.each(hosts)('%s: a request for gated work is not the sign-off', (id) => {
    const t = buildCoordinatorInstructions(id);
    expect(t).toMatch(/Sign-off gates:/);
    expect(t).toMatch(/the user's request to do that work is NOT the sign-off/);
    // Ask who the user is, act only on an explicit yes, and record it.
    expect(t).toMatch(/ask whether the user is that human or has their explicit sign-off; proceed only on an explicit yes/);
    expect(t).toMatch(/record it in the decisions inbox/);
    // Unattended runs stop at the gate instead of approving themselves.
    expect(t).toMatch(/Never take silence, urgency, auto-approval or a non-interactive run as sign-off/);
    expect(t).toMatch(/Neither you nor an AI member does a human's routed work in their place/);
  });

  it('keeps the rule in the Claude coordinator itself, not in an on-demand skill', () => {
    // A rule that must hold before the coordinator acts cannot wait for a skill to be loaded.
    const claude = buildCoordinatorInstructions('claude');
    expect(claude).toMatch(/request to do that work is NOT the sign-off/);
  });
});
