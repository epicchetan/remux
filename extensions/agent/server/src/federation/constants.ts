export const FEDERATION_SERVER_NAME = 'remux-federation';

export const FEDERATION_TOOLS = [
  'remux_list_agents',
  'remux_spawn_agent',
  'remux_send_message',
  'remux_wait_agent',
  'remux_interrupt_agent',
  'remux_close_agent',
] as const;

/**
 * Foreground federation is intentionally allowed to cover substantial native
 * implementation turns. Provider clients still own cancellation; this is only
 * the hard wall-clock ceiling for one MCP tool call.
 */
export const FEDERATION_TOOL_TIMEOUT_MS = 4 * 60 * 60 * 1_000;

/** Frequent enough to keep intermediaries and native MCP clients observably alive. */
export const FEDERATION_PROGRESS_INTERVAL_MS = 15_000;
