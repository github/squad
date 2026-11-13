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
 * "Cannot find module". This walks up from that folder, stopping at the repository root (the first
 * folder with `.git`), and runs the launcher it finds with the arguments after the script path.
 * Single quotes only, so Windows argument quoting never has to escape it.
 */
export const SQUAD_REPO_LAUNCHER_BOOTSTRAP =
  "const p=require('path'),f=require('fs'),s=process.argv[1];" +
  'for(let d=process.cwd();;d=p.dirname(d)){const c=p.join(d,s);' +
  "if(f.existsSync(c)){process.argv[1]=c;import(require('url').pathToFileURL(c).href).catch(e=>{console.error(e);process.exit(1)});break}" +
  "if(p.dirname(d)===d||f.existsSync(p.join(d,'.git'))){console.error('squad: '+s+' was not found in '+process.cwd()+' or a parent folder up to the repository root. Run squad upgrade at the repository root.');process.exit(1)}}";

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
