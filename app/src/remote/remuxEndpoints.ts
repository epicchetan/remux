export const defaultGuardianPort = 48124;

const configuredGuardianPort = Number.parseInt(
  process.env.EXPO_PUBLIC_REMUX_GUARDIAN_PORT ?? '',
  10,
);

export const guardianPort = Number.isInteger(configuredGuardianPort)
  && configuredGuardianPort > 0
  && configuredGuardianPort <= 65_535
  ? configuredGuardianPort
  : defaultGuardianPort;

/**
 * L0.5 is deliberately located without consulting the runtime: discovery
 * through the failed service would defeat the emergency path.
 */
export function guardianOrigin(runtimeOrigin: string) {
  const url = new URL(runtimeOrigin);
  url.port = String(guardianPort);
  return url.origin;
}
