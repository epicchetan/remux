// PDF uses the authenticated raw route. Keep other host pages and remote
// navigation blocked; raw responses carry the runtime's sandbox CSP.
export function viewerFramePolicy(origin: string) {
  return `frame-src blob: ${new URL('/remux/fs/raw', origin).href}; object-src 'none'`;
}
