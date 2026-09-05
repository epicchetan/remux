import { join } from 'node:path';

import {
  NATIVE_AGENT_LIMITS,
  parseNativeArtifactPutCommand,
  parseNativeArtifactReadCommand,
  type NativeArtifactPutCommand,
  type NativeArtifactPutResult,
  type NativeArtifactReadCommand,
  type NativeArtifactReadResult,
} from '../../../shared/native-agent-protocol.ts';
import { AgentArtifactStore } from '../storage/artifact-store.ts';
import type { AgentDataPaths } from '../storage/data-root.ts';
import { NativeAgentJournal, type ArtifactGrantScope } from './native-journal.ts';
import { NATIVE_ASSISTANT_PREVIEW_BYTES } from './native-output.ts';

export class NativeAgentArtifacts {
  private readonly journal: NativeAgentJournal;
  private readonly store: AgentArtifactStore;
  private readonly paths: AgentDataPaths;
  private readonly now: () => number;

  constructor(options: {
    journal: NativeAgentJournal;
    paths: AgentDataPaths;
    now?: () => number;
  }) {
    this.journal = options.journal;
    this.paths = options.paths;
    this.store = new AgentArtifactStore(options.paths);
    this.now = options.now ?? Date.now;
  }

  async put(unparsed: NativeArtifactPutCommand): Promise<NativeArtifactPutResult> {
    const input = parseNativeArtifactPutCommand(unparsed);
    return this.journal.runAsyncCommand(input.commandId, 'artifact.put', input, () =>
      this.putOwned(input));
  }

  private async putOwned(input: NativeArtifactPutCommand): Promise<NativeArtifactPutResult> {
    const claim = this.journal.claimCommand(input.commandId, 'artifact.put', input, this.now());
    if (claim.receipt.state === 'accepted') {
      return structuredClone(claim.receipt.result) as NativeArtifactPutResult;
    }
    if (claim.receipt.state !== 'received') {
      throw new Error(claim.receipt.errorMessage ?? `Artifact command ${input.commandId} cannot be replayed.`);
    }
    const decoded = decodeImageDataUrl(input.dataUrl);
    if (decoded.bytes.byteLength > NATIVE_AGENT_LIMITS.artifactBytes) {
      const message = `Image exceeds ${NATIVE_AGENT_LIMITS.artifactBytes} bytes.`;
      this.journal.rejectCommand(input.commandId, message, this.now());
      throw new Error(message);
    }
    this.journal.markCommandDispatching(input.commandId, this.now());
    try {
      const staged = await this.store.put(decoded.bytes, decoded.mimeType);
      const artifactId = staged.hash;
      this.journal.registerArtifact({
        artifactId,
        sha256: staged.hash,
        byteLength: staged.byteLength,
        mediaType: staged.mediaType,
        visibility: 'viewer',
        storagePath: staged.storagePath,
        createdAt: this.now(),
      });
      const result: NativeArtifactPutResult = {
        accepted: true,
        artifactId,
        mimeType: staged.mediaType,
        ...(input.name ? { name: input.name } : {}),
        byteLength: staged.byteLength,
      };
      this.journal.acceptCommand(input.commandId, result, this.now());
      return result;
    } catch (error) {
      this.journal.rejectCommand(input.commandId, messageOf(error), this.now());
      throw error;
    }
  }

  /** Imports a provider-native historical image into Remux's bounded artifact store. */
  async importImageDataUrl(scope: ArtifactGrantScope, dataUrl: string) {
    const decoded = decodeImageDataUrl(dataUrl);
    if (decoded.bytes.byteLength > NATIVE_AGENT_LIMITS.artifactBytes) {
      throw new Error(`Image exceeds ${NATIVE_AGENT_LIMITS.artifactBytes} bytes.`);
    }
    const staged = await this.store.put(decoded.bytes, decoded.mimeType);
    const createdAt = this.now();
    let artifact!: ReturnType<NativeAgentJournal['registerArtifact']>;
    this.journal.transaction(() => {
      artifact = this.journal.registerArtifact({
        artifactId: staged.hash, sha256: staged.hash, byteLength: staged.byteLength,
        mediaType: staged.mediaType, visibility: 'viewer', storagePath: staged.storagePath,
        createdAt,
      });
      this.journal.grantArtifact({ artifactId: staged.hash, ...scope,
        provenance: 'provider-history', sourceExecutionId: scope.executionId, createdAt });
    });
    return {
      artifactId: artifact.artifactId,
      mimeType: artifact.mediaType,
      byteLength: artifact.byteLength,
    };
  }

  async read(unparsed: NativeArtifactReadCommand): Promise<NativeArtifactReadResult> {
    const input = parseNativeArtifactReadCommand(unparsed);
    const artifact = this.requireViewerArtifact(input.artifactId);
    const requestedLength = Math.min(input.byteLength, 256 * 1024);
    const bytes = await this.store.readRange({
      hash: artifact.sha256,
      byteLength: artifact.byteLength,
      storagePath: artifact.storagePath,
    }, input.offset, requestedLength);
    return {
      artifactId: artifact.artifactId,
      mimeType: artifact.mediaType,
      totalByteLength: artifact.byteLength,
      offset: Math.min(input.offset, artifact.byteLength),
      byteLength: bytes.byteLength,
      base64: Buffer.from(bytes).toString('base64'),
    };
  }

  /** Stores authoritative terminal assistant text behind the viewer's bounded range API. */
  async sealAssistantText(turnId: string, text: string) {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.byteLength <= NATIVE_ASSISTANT_PREVIEW_BYTES) {
      if (this.journal.turn(turnId)?.assistantArtifactId) {
        this.journal.setTurnAssistantArtifact(turnId, null, this.now());
      }
      return undefined;
    }
    const staged = await this.store.put(bytes, 'text/plain; charset=utf-8');
    const turn = this.journal.turn(turnId);
    if (!turn) throw new Error(`Turn ${turnId} does not exist for assistant sealing.`);
    const createdAt = this.now();
    let artifact!: ReturnType<NativeAgentJournal['registerArtifact']>;
    this.journal.transaction(() => {
      artifact = this.journal.registerArtifact({ artifactId: staged.hash, sha256: staged.hash,
        byteLength: staged.byteLength, mediaType: staged.mediaType, visibility: 'viewer',
        storagePath: staged.storagePath, createdAt });
      this.journal.setTurnAssistantArtifact(turnId, artifact.artifactId, createdAt);
      this.journal.grantArtifact({ artifactId: artifact.artifactId,
        conversationId: turn.conversationId, executionId: turn.executionId,
        provenance: 'execution-output', sourceTurnId: turnId,
        sourceExecutionId: turn.executionId, createdAt });
    });
    return artifact;
  }

  /** Stores an exact provider patch without embedding it in the event journal. */
  async sealDiffText(scope: ArtifactGrantScope & { turnId?: string }, diff: string) {
    const bytes = Buffer.from(diff, 'utf8');
    if (bytes.byteLength === 0) throw new Error('Cannot seal an empty diff artifact.');
    if (bytes.byteLength > NATIVE_AGENT_LIMITS.artifactBytes) {
      throw new Error(`Diff exceeds ${NATIVE_AGENT_LIMITS.artifactBytes} bytes.`);
    }
    const staged = await this.store.put(bytes, 'text/x-diff; charset=utf-8');
    const createdAt = this.now();
    const sourceTurn = scope.turnId ? this.journal.turn(scope.turnId) : undefined;
    const validTurnId = sourceTurn?.conversationId === scope.conversationId &&
      sourceTurn.executionId === scope.executionId ? scope.turnId : undefined;
    let artifact!: ReturnType<NativeAgentJournal['registerArtifact']>;
    this.journal.transaction(() => {
      artifact = this.journal.registerArtifact({ artifactId: staged.hash, sha256: staged.hash,
        byteLength: staged.byteLength, mediaType: staged.mediaType, visibility: 'viewer',
        storagePath: staged.storagePath, createdAt });
      this.journal.grantArtifact({ artifactId: staged.hash, conversationId: scope.conversationId,
        executionId: scope.executionId, provenance: 'execution-output',
        ...(validTurnId ? { sourceTurnId: validTurnId } : {}),
        sourceExecutionId: scope.executionId, createdAt });
    });
    return artifact;
  }

  /** Reads an already-authorized text artifact after validating its immutable object. */
  private async readTextArtifact(artifactId: string) {
    const artifact = this.requireViewerArtifact(artifactId);
    if (!artifact.mediaType.startsWith('text/')) {
      throw new Error(`Artifact ${artifactId} is not text.`);
    }
    const bytes = await this.store.read({
      hash: artifact.sha256,
      byteLength: artifact.byteLength,
      storagePath: artifact.storagePath,
    });
    return {
      text: Buffer.from(bytes).toString('utf8'),
      mimeType: artifact.mediaType,
      byteLength: artifact.byteLength,
      sha256: artifact.sha256,
    };
  }

  async readTextArtifactForScope(
    scope: ArtifactGrantScope,
    artifactId: string,
    exactOwnedTurnId?: string,
  ) {
    const exactTurn = exactOwnedTurnId ? this.journal.turn(exactOwnedTurnId) : undefined;
    const legacyAssistant = exactTurn?.conversationId === scope.conversationId &&
      exactTurn.executionId === scope.executionId && exactTurn.assistantArtifactId === artifactId;
    if (!legacyAssistant && !this.journal.artifactGrantedTo(scope, artifactId)) {
      throw new Error(`Artifact ${artifactId} is outside the provider execution scope.`);
    }
    return this.readTextArtifact(artifactId);
  }

  resolveLocalImage(scope: ArtifactGrantScope, artifactId: string, expectedMimeType: string) {
    const artifact = this.requireViewerArtifact(artifactId);
    if (!this.journal.artifactGrantedTo(scope, artifactId)) {
      throw new Error(`Image artifact ${artifactId} is outside the provider execution scope.`);
    }
    if (artifact.mediaType !== expectedMimeType || !artifact.mediaType.startsWith('image/')) {
      throw new Error(`Artifact ${artifactId} is not the expected image type.`);
    }
    return join(this.paths.artifacts, artifact.storagePath);
  }

  private requireViewerArtifact(artifactId: string) {
    const artifact = this.journal.artifact(artifactId);
    if (!artifact || artifact.visibility !== 'viewer') {
      throw new Error(`Viewer artifact ${artifactId} does not exist.`);
    }
    return artifact;
  }
}

function decodeImageDataUrl(dataUrl: string) {
  const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/u.exec(dataUrl);
  if (!match) throw new Error('Image must be a valid base64 data URL.');
  const bytes = Buffer.from(match[2]!, 'base64');
  if (bytes.byteLength === 0) throw new Error('Image data URL is empty.');
  return { mimeType: match[1]!, bytes };
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
