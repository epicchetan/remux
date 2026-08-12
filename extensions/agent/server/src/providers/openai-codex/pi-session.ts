import {
  createAgentSession,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
} from '@earendil-works/pi-coding-agent';

export type ProviderPreflight = NonNullable<CreateAgentSessionOptions['providerPreflight']>;

export type RemuxAgentSessionOptions = Omit<CreateAgentSessionOptions, 'providerPreflight'> & {
  providerPreflight: ProviderPreflight;
};

/**
 * Keep the fail-closed provider boundary mandatory for every Pi session Remux creates.
 * The pinned Pi patch composes this gate after extension payload transforms.
 */
export function createRemuxAgentSession(
  options: RemuxAgentSessionOptions,
): Promise<CreateAgentSessionResult> {
  return createAgentSession(options);
}
