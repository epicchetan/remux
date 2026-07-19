import type {
  NarrationCancelParams,
  NarrationCancelResponse,
  NarrationReadParams,
  NarrationReadResponse,
  NarrationStartParams,
  NarrationStartResponse,
  NarrationUpdatedNotification,
} from './protocol';

export type NarrationTransport = {
  cancel(params: NarrationCancelParams): Promise<NarrationCancelResponse>;
  read(params: NarrationReadParams): Promise<NarrationReadResponse>;
  start(params: NarrationStartParams): Promise<NarrationStartResponse>;
  subscribeUpdated(listener: (event: NarrationUpdatedNotification) => void): () => void;
};
