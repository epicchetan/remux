import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import type { BenchmarkScenario, PreparedFixtureManifest } from './contracts.ts';
import { run } from './process.ts';

const FIXED_GIT_ENV = {
  GIT_AUTHOR_NAME: 'Remux Benchmark',
  GIT_AUTHOR_EMAIL: 'benchmark@remux.invalid',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'Remux Benchmark',
  GIT_COMMITTER_EMAIL: 'benchmark@remux.invalid',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
};

export async function prepareFixture(
  scenario: BenchmarkScenario,
  dataRoot: string,
): Promise<{ manifest: PreparedFixtureManifest; manifestPath: string }> {
  const sourceHeadBefore = await gitOutput(scenario.sourceRepository, ['rev-parse', 'HEAD']);
  const sourceStatusBefore = await gitOutput(scenario.sourceRepository, ['status', '--porcelain=v1', '--untracked-files=all']);
  const baseTree = await gitOutput(scenario.sourceRepository, ['rev-parse', `${scenario.baseCommit}^{tree}`]);
  const referenceCommit = await gitOutput(scenario.sourceRepository, ['rev-parse', `${scenario.referenceCommit}^{commit}`]);
  const referenceTree = await gitOutput(scenario.sourceRepository, ['rev-parse', `${referenceCommit}^{tree}`]);
  const fixtureRoot = join(dataRoot, 'fixtures', scenario.fixtureId, baseTree);
  const templatePath = join(fixtureRoot, 'workspace');
  const manifestPath = join(fixtureRoot, 'fixture-manifest.json');

  const existing = await readJsonIfExists<PreparedFixtureManifest>(manifestPath);
  if (existing && await isValidTemplate(existing, scenario, baseTree)) {
    await assertSourceUnchanged(scenario.sourceRepository, sourceHeadBefore, sourceStatusBefore);
    return { manifest: existing, manifestPath };
  }

  await mkdir(dirname(fixtureRoot), { recursive: true });
  const temporaryRoot = await mkdtemp(join(dirname(fixtureRoot), `.${basename(fixtureRoot)}-`));
  const temporaryWorkspace = join(temporaryRoot, 'workspace');
  const archivePath = join(temporaryRoot, 'base.tar');
  try {
    await mkdir(temporaryWorkspace, { recursive: true });
    await mustRun('git', [
      '-C', scenario.sourceRepository,
      'archive', '--format=tar', `--output=${archivePath}`, scenario.baseCommit,
    ]);
    await mustRun('tar', ['-xf', archivePath, '-C', temporaryWorkspace]);
    await rm(archivePath, { force: true });

    const visibleInputs = await Promise.all(scenario.visibleInputs.map(async (input) => {
      const bytes = await visibleInputBytes(scenario, input);
      const destination = join(temporaryWorkspace, input.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
      return { ...input, sha256: sha256(bytes) };
    }));

    await mustRun('git', ['init', '--quiet', '--initial-branch=main'], { cwd: temporaryWorkspace });
    await mustRun('git', ['config', 'commit.gpgsign', 'false'], { cwd: temporaryWorkspace });
    await mustRun('git', ['add', '--all'], { cwd: temporaryWorkspace });
    await mustRun('git', ['commit', '--quiet', '--message', `Benchmark base: ${scenario.fixtureId}`], {
      cwd: temporaryWorkspace,
      env: { ...process.env, ...FIXED_GIT_ENV },
    });
    const templateTree = await gitOutput(temporaryWorkspace, ['rev-parse', 'HEAD^{tree}']);
    const remotes = await gitOutput(temporaryWorkspace, ['remote']);
    if (remotes) throw new Error(`Sanitized fixture unexpectedly contains remotes: ${remotes}`);
    const targetPresence = await run('git', ['cat-file', '-e', `${referenceCommit}^{commit}`], { cwd: temporaryWorkspace });
    if (targetPresence.code === 0) throw new Error('Hidden target commit leaked into the sanitized fixture object database.');
    await assertNoIdentifiers(temporaryWorkspace, [referenceCommit, ...scenario.sourceTurnIds]);

    const transcriptFiles = await Promise.all(scenario.sourceRollouts.map(async (path) => {
      const bytes = await readFile(path);
      return { path, sha256: sha256(bytes), bytes: bytes.length };
    }));
    const templateHead = await gitOutput(temporaryWorkspace, ['rev-parse', 'HEAD']);
    const manifest: PreparedFixtureManifest = {
      version: 3,
      fixtureId: scenario.fixtureId,
      createdAt: new Date().toISOString(),
      source: {
        repositoryPath: scenario.sourceRepository,
        headBefore: sourceHeadBefore,
        statusBefore: sourceStatusBefore,
        baseCommit: scenario.baseCommit,
        baseTree,
        referenceCommit,
        referenceTree,
        visibleInputs,
        transcriptFiles,
        sourceTurnIds: scenario.sourceTurnIds,
      },
      template: { path: templatePath, headCommit: templateHead, tree: templateTree },
      evaluation: {
        forbiddenPaths: scenario.forbiddenPaths,
        overlayPaths: scenario.evaluator.overlayPaths,
        overlayRewrites: scenario.evaluator.overlayRewrites,
        formatCommand: scenario.evaluator.formatCommand,
        behavioralCommand: scenario.evaluator.behavioralCommand,
      },
    };
    await writeFile(join(temporaryRoot, 'fixture-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    await rm(fixtureRoot, { recursive: true, force: true });
    await rename(temporaryRoot, fixtureRoot);
    await assertSourceUnchanged(scenario.sourceRepository, sourceHeadBefore, sourceStatusBefore);
    return { manifest, manifestPath };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function createRunWorkspace(
  manifest: PreparedFixtureManifest,
  runRoot: string,
) {
  const workspacePath = join(runRoot, 'workspace');
  await mkdir(runRoot, { recursive: true });
  await cp(manifest.template.path, workspacePath, { recursive: true, errorOnExist: true, force: false });
  const tree = await gitOutput(workspacePath, ['rev-parse', 'HEAD^{tree}']);
  if (tree !== manifest.template.tree) throw new Error('Copied benchmark workspace does not match its fixture tree.');
  return workspacePath;
}

export async function assertSourceUnchanged(repository: string, expectedHead: string, expectedStatus: string) {
  const [head, status] = await Promise.all([
    gitOutput(repository, ['rev-parse', 'HEAD']),
    gitOutput(repository, ['status', '--porcelain=v1', '--untracked-files=all']),
  ]);
  if (head !== expectedHead || status !== expectedStatus) {
    throw new Error(`Source repository changed while preparing the fixture (head ${head}, status ${JSON.stringify(status)}).`);
  }
}

async function isValidTemplate(
  manifest: PreparedFixtureManifest,
  scenario: BenchmarkScenario,
  expectedTree: string,
) {
  const expectedVisibleInputs = await Promise.all(scenario.visibleInputs.map(async (input) => ({
    ...input,
    sha256: sha256(await visibleInputBytes(scenario, input)),
  })));
  if (
    manifest.version !== 3 ||
    manifest.fixtureId !== scenario.fixtureId ||
    manifest.source.baseTree !== expectedTree ||
    manifest.source.referenceCommit !== await gitOutput(
      scenario.sourceRepository,
      ['rev-parse', `${scenario.referenceCommit}^{commit}`],
    ) ||
    JSON.stringify(manifest.source.visibleInputs) !== JSON.stringify(expectedVisibleInputs) ||
    JSON.stringify(manifest.evaluation.overlayPaths) !==
      JSON.stringify(scenario.evaluator.overlayPaths) ||
    JSON.stringify(manifest.evaluation.overlayRewrites ?? []) !==
      JSON.stringify(scenario.evaluator.overlayRewrites)
  ) return false;
  try {
    const [head, tree, status, remotes] = await Promise.all([
      gitOutput(manifest.template.path, ['rev-parse', 'HEAD']),
      gitOutput(manifest.template.path, ['rev-parse', 'HEAD^{tree}']),
      gitOutput(manifest.template.path, ['status', '--porcelain=v1', '--untracked-files=all']),
      gitOutput(manifest.template.path, ['remote']),
    ]);
    return head === manifest.template.headCommit && tree === manifest.template.tree && status === '' && remotes === '';
  } catch {
    return false;
  }
}

async function visibleInputBytes(
  scenario: BenchmarkScenario,
  input: BenchmarkScenario['visibleInputs'][number],
) {
  if (input.fixturePath) return readFile(input.fixturePath);
  return gitBytes(scenario.sourceRepository, ['show', `${input.sourceRef}:${input.sourcePath}`]);
}

async function assertNoIdentifiers(root: string, identifiers: string[]) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile() || (await stat(path)).size > 5 * 1024 * 1024) continue;
      const content = await readFile(path);
      for (const identifier of identifiers) {
        if (content.includes(Buffer.from(identifier))) {
          throw new Error(`Sanitized fixture leaks benchmark-only identifier ${identifier} in ${path}.`);
        }
      }
    }
  }
}

async function gitOutput(cwd: string, args: string[]) {
  const result = await run('git', args, { cwd });
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function gitBytes(cwd: string, args: string[]) {
  const result = await run('git', args, { cwd });
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim()}`);
  return Buffer.from(result.stdout);
}

async function mustRun(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const result = await run(file, args, options);
  if (result.code !== 0) throw new Error(`${file} ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result;
}

async function readJsonIfExists<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function sha256(value: Buffer | string) {
  return createHash('sha256').update(value).digest('hex');
}
