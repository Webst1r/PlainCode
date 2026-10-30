'use strict';
/**
 * rateLimit.js — "N free runs per day per visitor", kept in memory.
 *
 * Trade-off: memory resets when the server restarts and isn't shared between
 * multiple servers. For a real launch, move this into Redis or Supabase.
 */

function today() {
  return new Date().toISOString().slice(0, 10); // e.g. "2026-10-30" (UTC)
}

function createLimiter(limitPerDay) {
  const seen = new Map(); // key -> { day, count }

  function entry(key) {
    const current = seen.get(key);
    if (!current || current.day !== today()) {
      const fresh = { day: today(), count: 0 };
      seen.set(key, fresh);
      return fresh;
    }
    return current;
  }

  return {
    limit: limitPerDay,
    remaining: (key) => Math.max(0, limitPerDay - entry(key).count),
    /** Try to use one run. Returns false if the visitor is out of runs. */
    consume(key) {
      const e = entry(key);
      if (e.count >= limitPerDay) return false;
      e.count += 1;
      return true;
    },
    /** Give a run back (used when our server fails, so users aren't charged for errors). */
    refund(key) {
      const e = entry(key);
      e.count = Math.max(0, e.count - 1);
    },
    /** Drop yesterday's entries so the Map doesn't grow forever. */
    sweep() {
      for (const [key, e] of seen) if (e.day !== today()) seen.delete(key);
    },
  };
}

module.exports = { createLimiter };
