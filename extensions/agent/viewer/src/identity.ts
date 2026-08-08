import { v4 as uuidv4 } from 'uuid';

export const AGENT_DRAFT_OPERATION_STORAGE_KEY = 'remux.agent.draft-operation.v1';

export function createViewerUuid() {
  return uuidv4();
}

export function loadOrCreateDraftOperationId() {
  const stored = readStoredDraftOperationId();
  if (stored) return stored;
  return replaceDraftOperationId();
}

export function replaceDraftOperationId() {
  const operationId = createViewerUuid();
  try {
    window.sessionStorage.setItem(AGENT_DRAFT_OPERATION_STORAGE_KEY, operationId);
  } catch {
    // The in-memory owner still preserves the ID for this mounted draft.
  }
  return operationId;
}

export function activateDraftOperationId(operationId: string) {
  if (!isViewerUuid(operationId)) return replaceDraftOperationId();
  try {
    window.sessionStorage.setItem(AGENT_DRAFT_OPERATION_STORAGE_KEY, operationId);
  } catch {
    // The in-memory owner still preserves the route-provided ID.
  }
  return operationId;
}

export function isViewerUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

export function confirmDraftOperationId(operationId: string) {
  try {
    if (window.sessionStorage.getItem(AGENT_DRAFT_OPERATION_STORAGE_KEY) === operationId) {
      window.sessionStorage.removeItem(AGENT_DRAFT_OPERATION_STORAGE_KEY);
    }
  } catch {
    // Storage availability does not change an already-confirmed operation.
  }
}

function readStoredDraftOperationId() {
  try {
    const value = window.sessionStorage.getItem(AGENT_DRAFT_OPERATION_STORAGE_KEY);
    return isViewerUuid(value) ? value : null;
  } catch {
    return null;
  }
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
