const { readFileSync, readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');
const { spawn } = require('node:child_process');

const rootDir = join(__dirname, '..');
const extensionsDir = join(rootDir, 'extensions');
const watchers = [];
let shuttingDown = false;

for (const entry of readdirSync(extensionsDir)) {
  const extensionDir = join(extensionsDir, entry);
  if (!statSync(extensionDir).isDirectory()) {
    continue;
  }

  const packageJsonPath = join(extensionDir, 'package.json');
  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch {
    continue;
  }

  if (!packageJson?.scripts?.watch || typeof packageJson.name !== 'string') {
    continue;
  }

  watchers.push({
    cwd: extensionDir,
    name: packageJson.name,
  });
}

if (watchers.length === 0) {
  console.log('No extension viewer watch scripts found.');
  process.exit(0);
}

const children = watchers.map((watcher) => {
  const child = spawn('npm', ['run', 'watch'], {
    cwd: watcher.cwd,
    env: process.env,
    stdio: 'inherit',
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.error(`${watcher.name} watch exited${signal ? ` with signal ${signal}` : ` with code ${code}`}`);
    shutdown(code || 1);
  });

  return child;
});

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));

function shutdown(code) {
  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
  setTimeout(() => process.exit(code), 50);
}
