import { expect, test } from '@playwright/test';

import validArtifact from '../../../extensions/narrate/server/schemas/fixtures/narration-artifact-v4.valid.json' with { type: 'json' };
import {
  createNarrationClient,
  decodeNarrationStartResponse,
  NarrationProtocolError,
  type NarrationAudioCallbacks,
  type NarrationAudioDriver,
  type NarrationLifecycle,
  type NarrationLifecycleState,
  type NarrationReadResponse,
  type NarrationScheduler,
  type NarrationSourceDocument,
  type NarrationStartResponse,
  type NarrationTransport,
  type NarrationUpdatedNotification,
} from '../src';

const artifactKey = validArtifact.artifactKey;
const target = { messageId: 'assistant-1' };
const document: NarrationSourceDocument = {
  blocks: [{ highlightMode: 'text', id: 'md:0', kind: 'paragraph', text: 'Hello world.' }],
  offsetEncoding: 'utf16CodeUnit',
  schemaVersion: 1,
};

function progress(stage: 'planning' | 'ready' = 'ready') {
  const ready = stage === 'ready' ? 1 : 0;
  return {
    auditWindowsCompleted: ready,
    auditWindowsTotal: 1,
    transcriptWindowsCompleted: ready,
    transcriptWindowsTotal: 1,
    chunksCompleted: ready,
    chunksTotal: 1,
    sentences: ready,
    stage,
    words: ready * 2,
  };
}

function readyResponse(revision = '1'): NarrationStartResponse {
  return decodeNarrationStartResponse({
    artifactKey,
    resource: {
      artifactKey,
      complete: true,
      error: null,
      manifest: structuredClone(validArtifact),
      progress: progress(),
      revision,
      status: 'ready',
    },
    status: 'accepted',
  });
}

function preparingResponse(): NarrationStartResponse {
  return {
    artifactKey,
    resource: {
      artifactKey,
      complete: false,
      error: null,
      manifest: null,
      progress: progress('planning'),
      revision: '1',
      status: 'preparing',
    },
    status: 'accepted',
  };
}

class FakeAudio implements NarrationAudioDriver {
  callbacks: NarrationAudioCallbacks = noopAudioCallbacks;
  closeCalls = 0;
  pauseCalls = 0;
  playCalls = 0;
  prepareCalls = 0;
  rate = 1;
  playBehavior: 'buffering' | 'playing' = 'playing';
  seekCalls: Array<{ play: boolean; sample: number }> = [];

  close() { this.closeCalls += 1; }
  pause() {
    this.pauseCalls += 1;
    this.callbacks.onPaused();
  }
  async play() {
    this.playCalls += 1;
    this.callbacks.onSample(0);
    if (this.playBehavior === 'buffering') this.callbacks.onBuffering();
    else this.callbacks.onPlaying();
  }
  async prepare() {
    this.prepareCalls += 1;
    this.callbacks.onBuffering();
    return true;
  }
  async seek(_artifactKey: string, sample: number, play: boolean) {
    this.seekCalls.push({ play, sample });
    this.callbacks.onSample(sample);
    if (play) this.callbacks.onPlaying();
    else this.callbacks.onPaused();
    return true;
  }
  setCallbacks(callbacks: NarrationAudioCallbacks) { this.callbacks = callbacks; }
  setPlaybackRate(rate: 0.75 | 1 | 1.25 | 1.5 | 2) { this.rate = rate; }
  snapshot() { return { playCalls: this.playCalls }; }
}

class FakeLifecycle implements NarrationLifecycle {
  state: NarrationLifecycleState = 'active';
  listeners = new Set<(state: NarrationLifecycleState) => void>();
  resumeListeners = new Set<() => void>();
  subscriptions = 0;

  snapshot() { return { state: this.state }; }
  subscribe(listener: (state: NarrationLifecycleState) => void) {
    this.subscriptions += 1;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  subscribeResume(listener: () => void) {
    this.subscriptions += 1;
    this.resumeListeners.add(listener);
    return () => this.resumeListeners.delete(listener);
  }
  emit(state: NarrationLifecycleState) {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
  resume() {
    this.state = 'active';
    for (const listener of this.resumeListeners) listener();
  }
}

class FakeScheduler implements NarrationScheduler {
  time = 0;
  timers = new Map<number, () => void>();
  nextHandle = 1;

  clearTimeout(handle: unknown) { this.timers.delete(handle as number); }
  now() { return this.time; }
  setTimeout(callback: () => void, delayMs: number) {
    const handle = this.nextHandle++;
    this.time += delayMs;
    this.timers.set(handle, callback);
    return handle;
  }
  runAll() {
    const callbacks = [...this.timers.values()];
    this.timers.clear();
    for (const callback of callbacks) callback();
  }
}

class FakeTransport implements NarrationTransport {
  cancels: string[] = [];
  events: string[] = [];
  reads: NarrationReadResponse[] = [];
  starts: Array<NarrationStartResponse | Error | Promise<NarrationStartResponse>> = [readyResponse()];
  listeners = new Set<(event: NarrationUpdatedNotification) => void>();
  subscriptions = 0;

  async cancel(params: { artifactKey: string }) {
    this.events.push(`cancel:${params.artifactKey}`);
    this.cancels.push(params.artifactKey);
    return { artifactKey: params.artifactKey, status: 'accepted' as const };
  }
  async read(params: { artifactKey: string }) {
    this.events.push(`read:${params.artifactKey}`);
    return this.reads.shift() ?? { resource: null, status: 'notModified' as const };
  }
  async start() {
    this.events.push('start');
    const response = this.starts.shift() ?? readyResponse();
    if (response instanceof Error) throw response;
    return await response;
  }
  subscribeUpdated(listener: (event: NarrationUpdatedNotification) => void) {
    this.subscriptions += 1;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  update() {
    for (const listener of this.listeners) listener({ artifactKey });
  }
}

function harness(options: {
  initialRate?: number | null;
  lifecycleState?: NarrationLifecycleState;
  playBehavior?: FakeAudio['playBehavior'];
} = {}) {
  const audio = new FakeAudio();
  audio.playBehavior = options.playBehavior ?? 'playing';
  const lifecycle = new FakeLifecycle();
  lifecycle.state = options.lifecycleState ?? 'active';
  const scheduler = new FakeScheduler();
  const transport = new FakeTransport();
  const claims: Array<typeof target> = [];
  const preferenceWrites: number[] = [];
  let releases = 0;
  const client = createNarrationClient<typeof target>({
    audio,
    follow: {
      claim: (claimed) => claims.push(claimed),
      release: () => { releases += 1; },
    },
    lifecycle,
    preferences: {
      readPlaybackRate: () => options.initialRate ?? null,
      writePlaybackRate: (rate) => preferenceWrites.push(rate),
    },
    scheduler,
    transport,
  });
  return {
    audio,
    claims,
    client,
    lifecycle,
    preferenceWrites,
    releases: () => releases,
    scheduler,
    transport,
  };
}

test('starts, installs a ready artifact, and becomes playing only through audio callbacks', async () => {
  const { audio, claims, client } = harness();
  await client.store.getState().start({ document, target });

  const state = client.store.getState();
  expect(audio.playCalls).toBe(1);
  expect(state.phase).toBe('playing');
  expect(state.currentBlockId).toBe('md:0');
  expect(state.target).toEqual(target);
  expect(claims).toEqual([target]);
});

test('installs an artifact as ready without implicit playback while backgrounded', async () => {
  const { audio, client } = harness({ lifecycleState: 'background' });
  await client.store.getState().start({ document, target });
  expect(client.store.getState().phase).toBe('ready');
  expect(audio.playCalls).toBe(0);
});

test('keeps buffering truthful until the audio driver reports playing', async () => {
  const { audio, client } = harness({ playBehavior: 'buffering' });
  await client.store.getState().start({ document, target });
  expect(client.store.getState().phase).toBe('buffering');
  audio.callbacks.onPlaying();
  expect(client.store.getState().phase).toBe('playing');
});

test('surfaces terminal server failure without trying to load audio', async () => {
  const { audio, client, transport } = harness();
  transport.starts = [{
    artifactKey,
    resource: {
      artifactKey,
      complete: false,
      error: 'Synthesis failed',
      manifest: null,
      progress: progress('planning'),
      revision: '2',
      status: 'failed',
    },
    status: 'accepted',
  }];
  await client.store.getState().start({ document, target });
  expect(client.store.getState()).toMatchObject({
    error: 'Synthesis failed',
    phase: 'failed',
    status: 'failed',
  });
  expect(audio.playCalls).toBe(0);
});

test('seeks by block and publishes cue and focus state independently of the DOM', async () => {
  const { audio, client } = harness({ lifecycleState: 'background' });
  await client.store.getState().start({ document, target });
  await client.store.getState().seekToBlock('md:0');
  expect(audio.prepareCalls).toBe(1);
  expect(audio.seekCalls).toEqual([{ play: false, sample: 0 }]);
  expect(client.store.getState().focusIntent?.reason).toBe('explicitSeekInPlace');
});

test('retains play intent while seeking during playback and clears cues on natural end', async () => {
  const { audio, client } = harness();
  await client.store.getState().start({ document, target });
  await client.store.getState().seekToBlock('md:0');
  expect(audio.seekCalls).toEqual([{ play: true, sample: 0 }]);
  audio.callbacks.onEnded();
  expect(client.store.getState()).toMatchObject({
    currentBlockId: null,
    currentBlockIndex: -1,
    currentSentence: null,
    currentWordCue: null,
    phase: 'paused',
  });
});

test('keeps media failure nonplaying and explicitly retryable', async () => {
  const { audio, client } = harness();
  await client.store.getState().start({ document, target });
  audio.callbacks.onError('Narration audio could not be loaded');
  expect(client.store.getState()).toMatchObject({
    error: 'Narration audio could not be loaded',
    phase: 'ready',
  });
});

test('reference-counts attachment and pauses on background without auto-resuming', async () => {
  const { audio, client, lifecycle, transport } = harness();
  const detachFirst = client.attach();
  const detachSecond = client.attach();
  expect(lifecycle.subscriptions).toBe(2);
  expect(transport.subscriptions).toBe(1);

  await client.store.getState().start({ document, target });
  lifecycle.emit('background');
  expect(audio.pauseCalls).toBe(1);
  expect(client.store.getState().phase).toBe('paused');
  lifecycle.resume();
  expect(client.store.getState().phase).toBe('paused');

  detachFirst();
  expect(lifecycle.listeners.size).toBe(1);
  detachSecond();
  expect(lifecycle.listeners.size).toBe(0);
  expect(transport.listeners.size).toBe(0);
});

test('serializes cancellation of an active job before a replacement start', async () => {
  const { client, transport } = harness();
  transport.starts = [preparingResponse(), readyResponse('2')];
  transport.reads = [{ resource: null, status: 'missing' }];
  await client.store.getState().start({ document, target });
  await client.store.getState().start({ document, target: { messageId: 'assistant-2' } });
  expect(transport.events).toEqual([
    'start',
    `cancel:${artifactKey}`,
    `read:${artifactKey}`,
    'start',
  ]);
  expect(client.store.getState().target).toEqual({ messageId: 'assistant-2' });
});

test('cancels a job accepted after local cancel and ignores its late state', async () => {
  const { client, transport } = harness();
  let resolveStart!: (response: NarrationStartResponse) => void;
  const delayedStart = new Promise<NarrationStartResponse>((resolve) => { resolveStart = resolve; });
  transport.starts = [delayedStart];
  transport.reads = [{ resource: null, status: 'missing' }];
  const starting = client.store.getState().start({ document, target });
  await Promise.resolve();
  const cancelling = client.store.getState().cancel();
  resolveStart(preparingResponse());
  await Promise.all([starting, cancelling]);
  expect(transport.cancels).toEqual([artifactKey]);
  expect(client.store.getState().phase).toBe('idle');
});

test('ignores older resource revisions and uses notifications plus one polling timer', async () => {
  const { client, scheduler, transport } = harness();
  transport.starts = [preparingResponse()];
  await client.store.getState().start({ document, target });
  expect(scheduler.timers.size).toBe(1);
  const detach = client.attach();
  transport.reads = [{ resource: readyResponse('5').resource, status: 'ok' }];
  transport.update();
  await expect.poll(() => client.store.getState().resourceRevision).toBe('5');
  transport.reads = [{ resource: readyResponse('4').resource, status: 'ok' }];
  await client.store.getState().refresh();
  expect(client.store.getState().resourceRevision).toBe('5');
  transport.reads = [{
    resource: {
      ...preparingResponse().resource,
      error: 'duplicate revision must not win',
      revision: '5',
      status: 'failed',
    },
    status: 'ok',
  }];
  await client.store.getState().refresh();
  expect(client.store.getState().status).toBe('ready');
  expect(scheduler.timers.size).toBe(0);
  detach();
});

test('validates, persists, and retains playback rate across local close', async () => {
  const { audio, client, preferenceWrites } = harness({ initialRate: 1.25 });
  expect(client.store.getState().playbackRate).toBe(1.25);
  client.store.getState().setPlaybackRate(3);
  expect(client.store.getState().playbackRate).toBe(1.25);
  client.store.getState().setPlaybackRate(1.5);
  expect(audio.rate).toBe(1.5);
  expect(preferenceWrites).toEqual([1.5]);
  client.store.getState().close();
  expect(client.store.getState().playbackRate).toBe(1.5);
});

test('claims, releases, suspends, and re-enables follow through the viewer port', async () => {
  const { claims, client, releases } = harness({ lifecycleState: 'background' });
  await client.store.getState().start({ document, target });
  client.store.getState().toggleFollow();
  expect(releases()).toBeGreaterThan(0);
  client.store.getState().toggleFollow();
  expect(claims.at(-1)).toEqual(target);
  client.store.getState().suspendFollowByUser();
  expect(client.store.getState()).toMatchObject({
    followEnabled: false,
    followSuspendedByUser: true,
  });
});

test('recovers one missing resource by replaying the exact source request', async () => {
  const { client, transport } = harness();
  transport.starts = [preparingResponse(), readyResponse('1')];
  transport.reads = [{ resource: null, status: 'missing' }];
  await client.store.getState().start({ document, target });
  await client.store.getState().refresh();
  expect(transport.events.filter((event) => event === 'start')).toHaveLength(2);
  expect(client.store.getState().phase).toBe('playing');
});

test('turns malformed transport responses into stable failed state', async () => {
  const { client, transport } = harness();
  transport.starts = [new NarrationProtocolError('start status is invalid')];
  await client.store.getState().start({ document, target });
  expect(client.store.getState()).toMatchObject({
    error: 'Invalid narration response: start status is invalid',
    phase: 'failed',
    status: 'failed',
  });
});

test('destroy fences subsequent audio and transport callbacks', async () => {
  const { audio, client } = harness({ lifecycleState: 'background' });
  await client.store.getState().start({ document, target });
  const before = client.store.getState().phase;
  client.destroy();
  audio.callbacks.onPlaying();
  audio.callbacks.onSample(100);
  expect(client.store.getState().phase).toBe(before);
  expect(client.store.getState().currentSample).toBe(0);
});

const noopAudioCallbacks: NarrationAudioCallbacks = {
  onBuffering: () => undefined,
  onEnded: () => undefined,
  onError: () => undefined,
  onPaused: () => undefined,
  onPlaying: () => undefined,
  onSample: () => undefined,
};
