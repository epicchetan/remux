// React entrypoints for the viewer kit. Imports React, so this subpath is kept
// separate from the React-free host bridge (/host, /ipc, /fs, /route).
export { mountViewer } from './mountViewer';
export type { MountViewerOptions } from './mountViewer';
