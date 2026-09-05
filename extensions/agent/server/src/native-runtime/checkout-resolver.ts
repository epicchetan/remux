import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ResolvedCheckout = { checkoutKey: string; launchCwd: string };
export type CheckoutResolution =
  | { state: 'resolved'; value: ResolvedCheckout }
  | { state: 'indeterminate'; reason: string };
export type CheckoutResolver = (configuredCwd: string) => Promise<CheckoutResolution>;

export function createCheckoutResolver(dependencies: {
  realpath?: (path: string) => Promise<string>;
  git?: (cwd: string, env: NodeJS.ProcessEnv) => Promise<{ stdout: string }>;
} = {}): CheckoutResolver {
  const resolveRealpath = dependencies.realpath ?? ((path: string) => realpath(path));
  const git = dependencies.git ?? (async (cwd, env) => execFileAsync(
    'git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      timeout: 5_000, maxBuffer: 64 * 1024, encoding: 'utf8', env,
    }));
  return async (configuredCwd) => {
  if (!configuredCwd || configuredCwd.includes('\0') || Buffer.byteLength(configuredCwd) > 16 * 1024) {
    return { state: 'indeterminate', reason: 'Configured cwd is invalid.' };
  }
  let launchCwd: string;
  try {
    launchCwd = await resolveRealpath(configuredCwd);
  } catch (error) {
    return { state: 'indeterminate', reason: messageOf(error) };
  }
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C', LANG: 'C' };
    delete env['GIT_DIR'];
    delete env['GIT_WORK_TREE'];
    delete env['GIT_COMMON_DIR'];
    delete env['GIT_CEILING_DIRECTORIES'];
    const { stdout } = await git(launchCwd, env);
    const reported = stdout.endsWith('\r\n') ? stdout.slice(0, -2)
      : stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
    if (!reported || !isAbsolute(reported)) {
      return { state: 'indeterminate', reason: 'Git returned an invalid worktree top-level.' };
    }
    const top = await resolveRealpath(reported);
    const child = relative(top, launchCwd);
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      return { state: 'indeterminate', reason: 'Resolved cwd is outside the reported Git worktree.' };
    }
    return { state: 'resolved', value: { checkoutKey: `git-worktree:${top}`, launchCwd } };
  } catch (error) {
    const stderr = typeof error === 'object' && error && 'stderr' in error ? String(error.stderr) : '';
    const details = typeof error === 'object' && error ? error as {
      code?: unknown; killed?: unknown; signal?: unknown;
    } : {};
    if ((details.code === 128 || details.code === '128') && details.killed !== true && !details.signal &&
        /fatal: not a git repository \(or any of the parent directories\): \.git/u.test(stderr)) {
      return { state: 'resolved', value: { checkoutKey: `non-git:${launchCwd}`, launchCwd } };
    }
    return { state: 'indeterminate', reason: messageOf(error) };
  }
  };
}

export const resolveCheckout = createCheckoutResolver();

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
