export class ArtifactIntegrityError extends Error {
  readonly code = 'durable_artifact_integrity';
  readonly reason: 'hash' | 'length' | 'missing' | 'path' | 'type';

  constructor(reason: ArtifactIntegrityError['reason']) {
    super('Durable artifact failed integrity verification.');
    this.name = 'ArtifactIntegrityError';
    this.reason = reason;
  }
}

export class DurableTranscriptSelectionError extends Error {
  readonly code = -32602;

  constructor(message: string) {
    super(message);
    this.name = 'DurableTranscriptSelectionError';
  }
}
