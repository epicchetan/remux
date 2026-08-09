import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export async function run(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; maxBuffer?: number } = {},
) {
  try {
    const result = await execFile(file, args, {
      cwd: options.cwd,
      env: options.env,
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      encoding: 'utf8',
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr } satisfies CommandResult;
  } catch (error) {
    const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message,
    } satisfies CommandResult;
  }
}

export function runStreaming(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr += text;
      process.stderr.write(text);
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
