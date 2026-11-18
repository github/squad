#!/usr/bin/env node
/**
 * Generate the Squad Claude Code plugin (plugins/squad/) and its marketplace
 * (.claude-plugin/marketplace.json) from the Squad SDK (#2443).
 *
 * The SDK is the source of truth (packages/squad-sdk/src/client/adapters/claude-plugin.ts);
 * test/claude-plugin.test.ts asserts the committed tree equals the generated one. Run after
 * `npm run build` whenever the coordinator, skills, hooks or commands change:
 *
 *   node scripts/build-claude-plugin.mjs           # write plugins/squad/ and the marketplace
 *   node scripts/build-claude-plugin.mjs --check   # exit 1 if the committed plugin is stale
 *
 * The plugin version is the Squad CLI version (packages/squad-cli/package.json) unless
 * --version <v> is given.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK = path.join(ROOT, 'packages', 'squad-sdk', 'dist', 'client', 'adapters', 'claude-plugin.js');

if (!fs.existsSync(SDK)) {
  console.error(`build-claude-plugin: ${path.relative(ROOT, SDK)} is missing; run \`npm run build\` first.`);
  process.exit(1);
}
const { buildClaudePlugin, buildClaudeMarketplace, CLAUDE_PLUGIN_SOURCE_DIR, CLAUDE_PLUGIN_STATIC_FILES } = await import(pathToFileURL(SDK).href);

const args = process.argv.slice(2);
const check = args.includes('--check');
const vIdx = args.indexOf('--version');
const version =
  vIdx !== -1 && args[vIdx + 1]
    ? args[vIdx + 1]
    : JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', 'squad-cli', 'package.json'), 'utf8')).version;

const pluginDir = path.join(ROOT, CLAUDE_PLUGIN_SOURCE_DIR);
const files = buildClaudePlugin({
  version,
  templateSkillsDir: path.join(ROOT, 'packages', 'squad-cli', 'templates', 'skills'),
  license: fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8'),
});
const marketplacePath = path.join(ROOT, '.claude-plugin', 'marketplace.json');
const marketplace = buildClaudeMarketplace(version);

function listTree(dir, rel = '') {
  if (!fs.existsSync(path.join(dir, rel))) return [];
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listTree(dir, r));
    else out.push(r);
  }
  return out;
}

const wanted = new Map(files.map((f) => [f.path, f]));
// Binary files shipped as they are (the icon): copied from the repository, compared byte for byte.
const statics = Object.entries(CLAUDE_PLUGIN_STATIC_FILES).map(([rel, src]) => ({ rel, bytes: fs.readFileSync(path.join(ROOT, src)) }));
const stale = [];
for (const rel of listTree(pluginDir)) if (!wanted.has(rel) && !(rel in CLAUDE_PLUGIN_STATIC_FILES)) stale.push(rel);
const changed = [];
for (const f of files) {
  const abs = path.join(pluginDir, f.path);
  const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : undefined;
  if (current !== f.content) changed.push(f.path);
}
for (const { rel, bytes } of statics) {
  const abs = path.join(pluginDir, rel);
  if (!fs.existsSync(abs) || !fs.readFileSync(abs).equals(bytes)) changed.push(rel);
}
const marketplaceStale = !fs.existsSync(marketplacePath) || fs.readFileSync(marketplacePath, 'utf8') !== marketplace;

if (check) {
  const problems = [...changed.map((p) => `changed: ${p}`), ...stale.map((p) => `extra: ${p}`)];
  if (marketplaceStale) problems.push('changed: .claude-plugin/marketplace.json');
  // Marketplace installs clone the repository: a generated file git ignores never reaches users.
  const ignored = spawnSync('git', ['check-ignore', '--no-index', '--', ...[...files.map((f) => f.path), ...statics.map((x) => x.rel)].map((p) => path.join(CLAUDE_PLUGIN_SOURCE_DIR, p))], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  for (const p of (ignored.stdout || '').split('\n').filter(Boolean)) problems.push(`git-ignored: ${p}`);
  if (problems.length > 0) {
    console.error(`build-claude-plugin: ${CLAUDE_PLUGIN_SOURCE_DIR} is stale; run node scripts/build-claude-plugin.mjs\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`build-claude-plugin: ${CLAUDE_PLUGIN_SOURCE_DIR} is current (${files.length} files).`);
  process.exit(0);
}

for (const rel of stale) fs.rmSync(path.join(pluginDir, rel));
for (const f of files) {
  const abs = path.join(pluginDir, f.path);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, f.content, 'utf8');
  if (f.executable) fs.chmodSync(abs, 0o755);
}
for (const { rel, bytes } of statics) {
  const abs = path.join(pluginDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
}
fs.mkdirSync(path.dirname(marketplacePath), { recursive: true });
fs.writeFileSync(marketplacePath, marketplace, 'utf8');
console.log(
  `build-claude-plugin: wrote ${files.length + statics.length} files to ${CLAUDE_PLUGIN_SOURCE_DIR} (${changed.length} changed, ${stale.length} removed), version ${version}.`,
);
