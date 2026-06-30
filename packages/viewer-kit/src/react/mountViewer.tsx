import { useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

export type MountViewerOptions = {
  /**
   * Stable viewer name (e.g. `'terminal'`). Drives the HMR root registry key
   * and the legacy untracked-root migration key, so it must be unique and
   * stable per viewer.
   */
  name: string;
  /**
   * Called once after the first mount, from inside an effect. Wire up the host
   * IPC bridge here (e.g. `initializeIpc`). Any return value is ignored.
   */
  initialize?: () => void;
  /** Root element id to mount into. Defaults to `'root'`. */
  rootElementId?: string;
};

type ViewerRootRegistry = Record<string, Root>;

declare global {
  interface Window {
    __remuxViewerRoots?: ViewerRootRegistry;
  }
}

function ViewerBootstrap({
  initialize,
  children,
}: {
  initialize?: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    // Mount-once: initialization is idempotent and keyed to the viewer root.
    initialize?.();
  }, []);

  return <>{children}</>;
}

/**
 * Mounts a Remux viewer. Encapsulates the bootstrap every viewer used to
 * duplicate: root lookup, an HMR-stable root registry, the dev-only legacy
 * untracked-root reload migration, `createRoot`/`render`, HMR dispose/unmount,
 * and a single post-mount `initialize` call.
 *
 * In dev (`import.meta.hot`) the React root is reused across hot updates via a
 * per-name registry on `window`. In production this is a plain create+render.
 */
export function mountViewer(node: ReactNode, options: MountViewerOptions): void {
  const { name, initialize, rootElementId = 'root' } = options;
  const migrationKey = `remux-${name}-root-lifecycle-v1`;

  const root = document.getElementById(rootElementId);
  if (!root) {
    throw new Error(`Remux ${name} root element (#${rootElementId}) was not found.`);
  }

  const registry = (window.__remuxViewerRoots ??= {});

  if (shouldReloadLegacyUntrackedRoot(root, registry, name, migrationKey)) {
    window.sessionStorage.setItem(migrationKey, 'done');
    window.location.reload();
    return;
  }

  const reactRoot = registry[name] ?? createRoot(root);
  registry[name] = reactRoot;

  reactRoot.render(<ViewerBootstrap initialize={initialize}>{node}</ViewerBootstrap>);

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      reactRoot.unmount();
      if (registry[name] === reactRoot) {
        delete registry[name];
      }
    });
  }
}

function shouldReloadLegacyUntrackedRoot(
  root: HTMLElement,
  registry: ViewerRootRegistry,
  name: string,
  migrationKey: string,
): boolean {
  return Boolean(
    import.meta.hot &&
      !registry[name] &&
      root.hasChildNodes() &&
      window.sessionStorage.getItem(migrationKey) !== 'done',
  );
}
