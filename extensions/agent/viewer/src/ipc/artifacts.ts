import { rpc } from '@remux/viewer-kit/ipc';

import {
  AGENT_METHODS,
  type ArtifactReadParams,
  type ArtifactReadResult,
} from '../../../shared/protocol';

export function readArtifactRange(params: ArtifactReadParams) {
  return rpc.query<ArtifactReadResult>(AGENT_METHODS.artifactRead, params);
}
