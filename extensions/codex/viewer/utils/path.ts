export function formatHomePath(path: string, homePath = inferredHomePath(path)) {
  return homePath && path.startsWith(homePath) ? path.replace(homePath, '~') : path;
}

function inferredHomePath(path: string) {
  return /^(\/Users\/[^/]+|\/home\/[^/]+)(?:\/|$)/u.exec(path)?.[1] ?? null;
}
