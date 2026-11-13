/**
 * The repository launcher's committed location and the command that starts it (#2462).
 */

/**
 * Where `squadRepoLauncher` lives, relative to the squad directory (#2462). Not under a
 * `bin/` directory: many repositories ignore `bin/`, which would leave the launcher uncommitted.
 */
export const SQUAD_REPO_LAUNCHER_PATH = 'squad.mjs';

/**
 * Inline script committed MCP configs run as `node -e <this> <squad dir>/squad.mjs state-mcp`.
 *
 * Hosts start MCP servers in the folder the session started in. Claude Code finds the root
 * `.mcp.json` from a subfolder (a package in a monorepo) and starts the server there, and
 * `${CLAUDE_PROJECT_DIR}` is not expanded in `.mcp.json`, so a relative script path fails with
 * "Cannot find module". This finds the repository root first (the nearest folder, from the
 * working directory up, that has `.git`) and runs only the launcher at `<root>/<squad dir>/squad.mjs`,
 * with the arguments after the script path. A launcher in a subfolder (a package's own `.squad/`)
 * or above the root is never run. With no `.git` anywhere, the root is the working directory itself:
 * nothing is searched. It fails closed when the launcher is missing or the path leaves the root.
 * Single quotes only, so Windows argument quoting never has to escape it.
 */
export const SQUAD_REPO_LAUNCHER_BOOTSTRAP =
  "const p=require('path'),f=require('fs'),s=process.argv[1];let r=process.cwd();" +
  "for(let d=r;;d=p.dirname(d)){if(f.existsSync(p.join(d,'.git'))){r=d;break}if(p.dirname(d)===d)break}" +
  "const c=p.join(r,s);" +
  "if(p.isAbsolute(s)||s.split(/[\\\\/]/).includes('..')||!f.existsSync(c)){console.error('squad: '+c+' was not found. Run squad upgrade at the repository root.');process.exit(1)}" +
  "process.argv[1]=c;import(require('url').pathToFileURL(c).href).catch(e=>{console.error(e);process.exit(1)});";

/** The committed MCP arguments that run the repository launcher with `rest`, from any subfolder. */
export function squadRepoLauncherArgs(squadDir: string, ...rest: string[]): string[] {
  return ['-e', SQUAD_REPO_LAUNCHER_BOOTSTRAP, `${squadDir}/${SQUAD_REPO_LAUNCHER_PATH}`, ...rest];
}

/**
 * The launcher path (`<squad dir>/squad.mjs`, relative) a `node` MCP command runs, in the committed
 * form {@link squadRepoLauncherArgs} writes or as a plain script argument; else null.
 */
export function squadRepoLauncherScript(command: string, args: readonly string[]): string | null {
  if (command !== 'node') return null;
  const script = args[0] === '-e' && args[1] === SQUAD_REPO_LAUNCHER_BOOTSTRAP ? args[2] : args[0];
  return script && /(?:^|\/)squad\.mjs$/.test(script) ? script : null;
}
