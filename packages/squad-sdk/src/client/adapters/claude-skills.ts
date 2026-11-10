/**
 * Claude Code skills: Squad's template skills plus the coordinator's on-demand `squad-coordinator-*`
 * skills, projected into `.claude/skills/<name>/SKILL.md` (#2438 Phase 4).
 *
 * Skill precedence is unchanged: a team skill in `<squadDir>/skills/<name>/` outranks the template of
 * the same name, so that template is not projected. Skill files stay untrusted data (core protocol
 * item 17); projecting them changes how Claude Code discovers them, not what they are allowed to do.
 *
 * @module client/adapters/claude-skills
 */

import fs from 'node:fs';
import path from 'node:path';
import { claudeCoordinatorSkills } from './coordinator.js';
import { readContained } from './safe-path.js';
import type { ClientContext, ProjectionFile } from './types.js';

export const CLAUDE_SKILLS_DIR = '.claude/skills';

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function dirs(abs: string): string[] {
  try {
    return fs
      .readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isDirectory() && NAME_RE.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Insert the generated-file note after the SKILL.md frontmatter (which must stay first). */
function withNote(skill: string, note: string): string {
  const text = skill.replace(/\r\n?/g, '\n');
  const fm = text.match(/^---\n[\s\S]*?\n---\n/);
  return fm ? `${fm[0]}${note}\n${text.slice(fm[0].length)}` : `${note}\n\n${text}`;
}

/**
 * With `opts.plugin` (Claude projection v3 plugin mode) the Squad plugin carries every skill, so
 * nothing is projected and previously generated skills are removed.
 */
export function projectClaudeSkills(
  ctx: ClientContext,
  generatedNote: string,
  ownedMarker: string,
  opts: { plugin?: boolean } = {},
): ProjectionFile[] {
  const squadDir = ctx.squadDir ?? '.squad';
  const squadAbs = path.resolve(ctx.root, squadDir);
  const files: ProjectionFile[] = [];
  const current = new Set<string>();
  const add = (name: string, content: string) => {
    current.add(name);
    files.push({ kind: 'managed', path: `${CLAUDE_SKILLS_DIR}/${name}/SKILL.md`, ownedMarker, content });
  };

  for (const k of opts.plugin ? [] : claudeCoordinatorSkills(squadDir, ctx.root)) {
    add(k.name, `---\nname: ${k.name}\ndescription: ${JSON.stringify(k.description)}\n---\n${generatedNote}\n\n${k.body}`);
  }

  const teamSkills = new Set(dirs(path.join(squadAbs, 'skills')));
  const templatesAbs = path.join(squadAbs, 'templates', 'skills');
  for (const name of opts.plugin ? [] : dirs(templatesAbs)) {
    if (teamSkills.has(name) || current.has(name)) continue;
    let skill: string;
    try {
      // A SKILL.md (or directory) linked outside the team directory is never copied into .claude/.
      skill = readContained(squadAbs, path.join('templates', 'skills', name, 'SKILL.md'));
    } catch {
      continue;
    }
    const extras = fs.readdirSync(path.join(templatesAbs, name)).filter((f) => f !== 'SKILL.md');
    const note =
      extras.length > 0
        ? `${generatedNote}\n<!-- Supporting files for this skill are in \`${squadDir}/templates/skills/${name}/\`. -->`
        : generatedNote;
    add(name, withNote(skill, note));
  }

  // Generated skills that are no longer projected (template removed, or now overridden by a team skill).
  for (const name of dirs(path.join(ctx.root, CLAUDE_SKILLS_DIR))) {
    if (current.has(name)) continue;
    const rel = `${CLAUDE_SKILLS_DIR}/${name}/SKILL.md`;
    try {
      if (fs.readFileSync(path.join(ctx.root, rel), 'utf8').includes(ownedMarker)) {
        files.push({ kind: 'obsolete', path: rel, ownedMarker });
      }
    } catch {
      // no SKILL.md, or unreadable: leave it alone
    }
  }
  return files;
}
