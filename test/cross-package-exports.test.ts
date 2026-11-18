/**
 * Cross-package export smoke test
 *
 * Validates that every value import squad-cli uses from squad-sdk actually
 * exists at runtime.  TypeScript can resolve from source during development,
 * but the compiled npm output may diverge (missing re-exports, renamed files,
 * ESM/CJS mismatches).  This test catches that class of bug.
 *
 * How it works:
 *   For each SDK subpath the CLI imports from, we dynamically import the
 *   module and assert every named export the CLI relies on is defined.
 *
 * Maintenance:
 *   When a new import from @squad/sdk is added to squad-cli,
 *   add a corresponding assertion here.  The grep one-liner in the test
 *   description shows how to audit.
 *
 * Related incident: v0.9.3-insider.1 shipped with FSStorageProvider missing
 * from the SDK barrel — broke users at runtime while tests passed locally.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Helper ──────────────────────────────────────────────────────────────

/** Assert a set of named exports exist on a module. */
function expectExports(mod: Record<string, unknown>, names: string[], subpath: string) {
  for (const name of names) {
    expect(mod[name], `"${name}" should be exported from ${subpath}`).toBeDefined();
  }
}

// ─── Root barrel: @squad/sdk ─────────────────────────────────

describe('cross-package exports — CLI → SDK', () => {
  describe('@squad/sdk (root barrel)', () => {
    it('exports FSStorageProvider and core runtime symbols', async () => {
      const sdk = await import('@squad/sdk');
      expectExports(sdk, [
        'FSStorageProvider',
        'SquadState',
        'TIMEOUTS',
        'StreamingPipeline',
        'RuntimeEventBus',
        'resolveSquad',
        'resolveGlobalSquadPath',
        'initSquadTelemetry',
        'recordAgentSpawn',
        'recordAgentDuration',
        'recordAgentError',
        'recordAgentDestroy',
        'safeTimestamp',
        'getMeter',
        'addSquadStateGitignoreBlock',
        'removeSquadStateGitignoreBlock',
        'readSquadRegistry',
        'addRegistryEntry',
        'removeRegistryEntry',
      ], '@squad/sdk');
    });

    it('exports role helpers', async () => {
      const sdk = await import('@squad/sdk');
      expectExports(sdk, [
        'listRoles',
        'searchRoles',
        'getCategories',
        'getRoleById',
        'generateCharterFromRole',
        'addAgentToConfig',
      ], '@squad/sdk');
    });

    it('exports init helpers', async () => {
      const sdk = await import('@squad/sdk');
      expectExports(sdk, [
        'initSquad',
        'cleanupOrphanInitPrompt',
      ], '@squad/sdk');
    });

    it('exports external-state helpers', async () => {
      const sdk = await import('@squad/sdk');
      expectExports(sdk, [
        'resolveExternalStateDir',
        'deriveProjectKey',
      ], '@squad/sdk');
    });

    it('exports cross-squad helpers', async () => {
      const sdk = await import('@squad/sdk');
      expectExports(sdk, [
        'discoverSquads',
        'formatDiscoveryTable',
        'findSquadByName',
        'buildDelegationArgs',
        'loadSubSquadsConfig',
        'resolveSubSquad',
      ], '@squad/sdk');
    });

    it('exports RemoteBridge', async () => {
      const sdk = await import('@squad/sdk');
      expectExports(sdk, ['RemoteBridge'], '@squad/sdk');
    });
  });

  // ─── Subpath: /config ──────────────────────────────────────────────────

  describe('@squad/sdk/config', () => {
    it('exports config helpers used by CLI', async () => {
      const mod = await import('@squad/sdk/config');
      expectExports(mod, [
        'initSquad',
        'MigrationRegistry',
        'writeEconomyMode',
        'readEconomyMode',
      ], '@squad/sdk/config');
    });
  });

  // ─── Subpath: /config/agent-source ─────────────────────────────────────

  describe('@squad/sdk/config/agent-source', () => {
    it('exports LocalAgentSource', async () => {
      const mod = await import('@squad/sdk/config/agent-source');
      expectExports(mod, ['LocalAgentSource'], '@squad/sdk/config/agent-source');
    });
  });

  // ─── Subpath: /resolution ──────────────────────────────────────────────

  describe('@squad/sdk/resolution', () => {
    it('exports resolution helpers', async () => {
      const mod = await import('@squad/sdk/resolution');
      expectExports(mod, [
        'resolveSquad',
        'resolveSquadPaths',
        'resolveGlobalSquadPath',
      ], '@squad/sdk/resolution');
    });
  });

  // ─── Subpath: /client ──────────────────────────────────────────────────

  describe('@squad/sdk/client', () => {
    it('exports SquadClient', async () => {
      const mod = await import('@squad/sdk/client');
      expectExports(mod, ['SquadClient'], '@squad/sdk/client');
    });
  });

  // ─── Subpath: /adapter/errors ──────────────────────────────────────────

  describe('@squad/sdk/adapter/errors', () => {
    it('exports RateLimitError', async () => {
      const mod = await import('@squad/sdk/adapter/errors');
      expectExports(mod, ['RateLimitError'], '@squad/sdk/adapter/errors');
    });
  });

  // ─── Subpath: /casting ─────────────────────────────────────────────────

  describe('@squad/sdk/casting', () => {
    it('exports CastingEngine', async () => {
      const mod = await import('@squad/sdk/casting');
      expectExports(mod, ['CastingEngine'], '@squad/sdk/casting');
    });
  });

  // ─── Subpath: /platform ────────────────────────────────────────────────

  describe('@squad/sdk/platform', () => {
    it('exports createPlatformAdapter', async () => {
      const mod = await import('@squad/sdk/platform');
      expectExports(mod, ['createPlatformAdapter'], '@squad/sdk/platform');
    });
  });

  // ─── Subpath: /ralph ───────────────────────────────────────────────────

  describe('@squad/sdk/ralph', () => {
    it('exports RalphMonitor', async () => {
      const mod = await import('@squad/sdk/ralph');
      expectExports(mod, ['RalphMonitor'], '@squad/sdk/ralph');
    });
  });

  describe('@squad/sdk/ralph/triage', () => {
    it('exports triage helpers', async () => {
      const mod = await import('@squad/sdk/ralph/triage');
      expectExports(mod, [
        'parseRoster',
        'parseRoutingRules',
        'parseModuleOwnership',
        'triageIssue',
      ], '@squad/sdk/ralph/triage');
    });
  });

  describe('@squad/sdk/ralph/rate-limiting', () => {
    it('exports rate-limiting helpers', async () => {
      const mod = await import('@squad/sdk/ralph/rate-limiting');
      expectExports(mod, [
        'PredictiveCircuitBreaker',
        'getTrafficLight',
      ], '@squad/sdk/ralph/rate-limiting');
    });
  });

  describe('@squad/sdk/ralph/claims', () => {
    it('exports the work claim contract', async () => {
      const mod = await import('@squad/sdk/ralph/claims');
      expectExports(mod, [
        'workKeyToString',
        'resolveExecutorIdentity',
        'NoopClaimProvider',
        'InMemoryClaimProvider',
        'InMemoryClaimStore',
        'DEFAULT_CLAIM_TTL_MS',
        'DEFAULT_CLAIM_SKEW_MARGIN_MS',
      ], '@squad/sdk/ralph/claims');
    });
  });

  describe('@squad/sdk/ralph/claims-git', () => {
    it('exports the Git-ref claim provider', async () => {
      const mod = await import('@squad/sdk/ralph/claims-git');
      expectExports(mod, [
        'GitRefClaimProvider',
        'GitClaimUnavailableError',
        'createExecFileGitTransport',
        'claimRefForKey',
        'decodeClaimRecord',
        'DEFAULT_CLAIM_REF_PREFIX',
        'FALLBACK_CLAIM_REF_PREFIX',
      ], '@squad/sdk/ralph/claims-git');
    });
  });

  // ─── Subpath: /runtime/* ───────────────────────────────────────────────

  describe('@squad/sdk/runtime/event-bus', () => {
    it('exports EventBus', async () => {
      const mod = await import('@squad/sdk/runtime/event-bus');
      expectExports(mod, ['EventBus'], '@squad/sdk/runtime/event-bus');
    });
  });

  // ─── SDK exports-map file resolution ───────────────────────────────────

  describe('SDK package.json exports map → file existence', () => {
    it('every exports-map entry points to an existing file', async () => {
      const fs = await import('node:fs');

      // In a workspace monorepo the SDK lives at packages/squad-sdk.
      // In CI / installed scenarios, find it under node_modules.
      const candidates = [
        resolve(process.cwd(), 'packages', 'squad-sdk'),
        resolve(process.cwd(), 'node_modules', '@squad', 'sdk'),
      ];
      const sdkRoot = candidates.find(
        (p) => existsSync(resolve(p, 'package.json')),
      );
      expect(sdkRoot, 'Could not locate SDK package.json').toBeDefined();

      const pkg = JSON.parse(
        fs.readFileSync(resolve(sdkRoot!, 'package.json'), 'utf8'),
      );
      const exportsMap = pkg.exports as Record<string, Record<string, string>>;
      const missing: string[] = [];

      for (const [subpath, targets] of Object.entries(exportsMap)) {
        if (typeof targets === 'string') {
          if (!existsSync(resolve(sdkRoot!, targets))) {
            missing.push(`${subpath} → ${targets}`);
          }
          continue;
        }
        for (const [condition, file] of Object.entries(targets)) {
          if (!existsSync(resolve(sdkRoot!, file))) {
            missing.push(`${subpath}[${condition}] → ${file}`);
          }
        }
      }

      expect(missing, `Missing files in SDK exports map:\n${missing.join('\n')}`).toEqual([]);
    });
  });
});
