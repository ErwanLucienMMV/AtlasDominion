// Bounds work even when a client disconnects: release only when the handler settles.
export function boundedHandler(handler, maximum = 32) {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Invalid HTTP concurrency limit');
  let active = 0;
  return async function (req, res) {
    if (active >= maximum) return res.status(429).json({ code: 'RESOURCE_EXHAUSTED' });
    active++;
    try { return await handler.call(this, req, res); }
    finally { active--; }
  };
}

export function hardenHttpServer(server) {
  server.maxConnections = 128;
  server.maxRequestsPerSocket = 100;
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  server.keepAliveTimeout = 5000;
  // Inactivity closes sockets, but does not claim to cancel application work.
  server.setTimeout(30000, socket => socket.destroy());
}
