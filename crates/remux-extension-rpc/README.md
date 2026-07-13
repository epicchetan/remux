# remux-extension-rpc

Small extension-side helper for Remux's duplex newline JSON-RPC transport.

It correlates requests emitted by an extension server with responses returned
on that server's stdin. It deliberately does not own extension lifecycle,
process spawning, manifests, or application protocol types.
