#!/usr/bin/env node
/**
 * Rewrite Squad's distribution identities across the tracked tree.
 *
 * Reads scripts/release/distribution-identity.json and replaces every retired
 * identity passed with --from (default: every `legacy` entry) by its `current`
 * value. npm names are rewritten in all the forms the tree uses: plain specs,
 * subpaths, regex-escaped and Windows paths, URL-encoded registry paths,
 * path.join() segments and `npm pack` tarball file names.
 *
 * Historical records (changelogs, blog posts, internal launch notes, live team
 * state, published-artifact evidence) are left untouched on purpose, and so are
 * the compatibility shims that must keep recognizing the retired names.
 *
 *   node scripts/rename-distribution-identity.mjs            # report only (exit 1 if anything remains)
 *   node scripts/rename-distribution-identity.mjs --write    # apply
 *   node scripts/rename-distribution-identity.mjs --write --from @squad/cli
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IDENTITY_PATH = path.join(ROOT, 'scripts', 'release', 'distribution-identity.json');

/** Paths that record history or must keep recognizing retired identities. */
export const PRESERVED_PATHS = [
  /(^|\/)CHANGELOG\.md$/,
  /^docs\/src\/content\/blog\//,
  /^docs\/_internal\//,
  /^\.squad\//,
  /^\.github\/aw\//,
  /^test-fixtures\/spec\/suite-v0\.2\/preview-tarball-matrix\.json$/,
  /^test-fixtures\/spec\/suite-v0\.2\/upgrade-matrix\.json$/,
  /^scripts\/release\/distribution-identity\.json$/,
  /^scripts\/rename-distribution-identity\.mjs$/,
  /^packages\/squad-cli\/src\/cli\/core\/package-identity\.ts$/,
  /^docs\/src\/content\/docs\/get-started\/package-rename\.md$/,
  /^test\/package-identity\.test\.ts$/,
  /^\.changeset\//,
  // Samples pinned to an already-published SDK release (^0.8.0) keep the name it was published under.
  /^samples\/(?:cost-aware-router|autonomous-pipeline)\//,
];

/** Migration instructions must keep naming the retired package (e.g. `npm uninstall -g <old>`). */
export const KEEP_LINE = /\b(?:npm uninstall|pnpm remove|yarn global remove) -g\b|\byarn global remove\b|\bUpgrading from\b/i;

const BINARY_EXT = /\.(png|jpe?g|gif|ico|webp|svg|woff2?|ttf|eot|zip|tgz|gz|exe|dll|pdf|mp4|mov|wasm)$/i;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function splitNpmName(name) {
  const m = /^(@[^/]+)\/(.+)$/.exec(name);
  if (!m) throw new Error(`Expected a scoped npm name, got ${name}`);
  return { scope: m[1], bare: m[2] };
}

/** Build [regex, replacement] pairs for one npm identity change. */
export function npmRules(from, to) {
  const f = splitNpmName(from);
  const t = splitNpmName(to);
  const rules = [];
  // Separator spellings found in source, tests, docs and workflows; longest first.
  const seps = ['[\\\\/]', '\\\\/', '\\/', '\\\\', '\\', '%2F', '%2f', '/'];
  for (const sep of seps) {
    rules.push([
      new RegExp(`${escapeRe(f.scope)}${escapeRe(sep)}${escapeRe(f.bare)}(?![A-Za-z0-9_])`, 'g'),
      `${t.scope}${sep}${t.bare}`,
    ]);
  }
  // path.join('node_modules', '@scope', 'name') segments.
  rules.push([
    new RegExp(`(['"\`])${escapeRe(f.scope)}\\1(\\s*,\\s*)(['"\`])${escapeRe(f.bare)}\\3`, 'g'),
    `$1${t.scope}$1$2$3${t.bare}$3`,
  ]);
  // `npm pack` tarball names: @scope/name -> scope-name-<version>.tgz
  rules.push([
    new RegExp(`(?<![@A-Za-z0-9_-])${escapeRe(f.scope.slice(1))}-${escapeRe(f.bare)}(?=-(?:\\d|\\$|\\\\\\$|\\*))`, 'g'),
    `${t.scope.slice(1)}-${t.bare}`,
  ]);
  return rules;
}

/** Homebrew tap `owner/homebrew-name` plus its `brew tap owner/name` and `owner/name/<cask>` short forms. */
export function homebrewRules(from, to) {
  const fm = /^([^/]+)\/homebrew-(.+)$/.exec(from);
  const tm = /^([^/]+)\/homebrew-(.+)$/.exec(to);
  if (!fm || !tm) throw new Error(`Expected owner/homebrew-name taps, got ${from} -> ${to}`);
  const fShort = `${fm[1]}/${fm[2]}`;
  const tShort = `${tm[1]}/${tm[2]}`;
  return [
    [new RegExp(escapeRe(from), 'g'), to],
    [new RegExp(`(brew tap\\s+)${escapeRe(fShort)}(?![A-Za-z0-9_/-])`, 'g'), `$1${tShort}`],
    [new RegExp(`(--cask\\s+)${escapeRe(fShort)}/`, 'g'), `$1${tShort}/`],
  ];
}

export function wingetRules(from, to) {
  return [[new RegExp(`(?<![A-Za-z0-9_.-])${escapeRe(from)}(?![A-Za-z0-9_-])`, 'g'), to]];
}

export function loadIdentity(file = IDENTITY_PATH) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** All rename rules implied by the identity file, optionally limited to the given retired names. */
export function buildRules(identity, onlyFrom = []) {
  const want = (name) => onlyFrom.length === 0 || onlyFrom.includes(name);
  const rules = [];
  for (const entry of Object.values(identity.npm)) {
    for (const old of entry.legacy) if (want(old) && old !== entry.current) rules.push(...npmRules(old, entry.current));
  }
  for (const old of identity.homebrew.tap.legacy) {
    if (want(old) && old !== identity.homebrew.tap.current) rules.push(...homebrewRules(old, identity.homebrew.tap.current));
  }
  for (const old of identity.winget.identifier.legacy) {
    if (want(old) && old !== identity.winget.identifier.current) rules.push(...wingetRules(old, identity.winget.identifier.current));
  }
  return rules;
}

/** Generated blocks rendered from preserved evidence (see scripts/render-upgrade-matrix.mjs). */
export const KEEP_BLOCKS = [/<!-- UPGRADE-MATRIX:START -->[\s\S]*?<!-- UPGRADE-MATRIX:END -->/g];

export function applyRules(text, rules) {
  const kept = [];
  const keep = (s) => `\u0000KEEP${kept.push(s) - 1}\u0000`;
  let masked = text;
  for (const re of KEEP_BLOCKS) masked = masked.replace(re, keep);
  let out = masked
    .split('\n')
    .map((line) => (KEEP_LINE.test(line) ? keep(line) : line))
    .join('\n');
  for (const [re, replacement] of rules) out = out.replace(re, replacement);
  return out.replace(/\u0000KEEP(\d+)\u0000/g, (_, i) => kept[Number(i)]);
}

export function isPreserved(file) {
  return PRESERVED_PATHS.some((re) => re.test(file));
}

function main(argv) {
  const write = argv.includes('--write');
  const onlyFrom = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--from' && argv[i + 1]) onlyFrom.push(argv[++i]);
  const rules = buildRules(loadIdentity(), onlyFrom);
  if (rules.length === 0) {
    console.log('No retired identities to rewrite.');
    return 0;
  }
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  const changed = [];
  for (const file of files) {
    if (isPreserved(file) || BINARY_EXT.test(file)) continue;
    const abs = path.join(ROOT, file);
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue;
    const next = applyRules(text, rules);
    if (next !== text) {
      changed.push(file);
      if (write) writeFileSync(abs, next);
    }
  }
  for (const file of changed) console.log(`${write ? 'rewrote' : 'would rewrite'} ${file}`);
  console.log(`${changed.length} file(s) ${write ? 'rewritten' : 'still reference retired identities'}.`);
  return write || changed.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
