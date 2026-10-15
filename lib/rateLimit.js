'use strict';

/** Minimal in-memory fixed-window rate limiter keyed by client IP. */
function rateLimit({ max, windowMs = 60 * 60 * 1000 }) {
  const hits = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
  }, windowMs);
  sweep.unref();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    let entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ error: 'Terlalu banyak pengiriman dari perangkat ini. Silakan coba lagi nanti.' });
    }
    next();
  };
}

module.exports = { rateLimit };
