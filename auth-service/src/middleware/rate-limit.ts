// ============================================================
// Rate Limiting Middleware
// Validates: Requirements 7.4
// ============================================================

import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface RateLimitConfig {
  /** Max requests per IP per window */
  perIpLimit: number;
  /** Max requests globally per window */
  globalLimit: number;
  /** Window duration in milliseconds */
  windowMs: number;
}

// ------------------------------------------------------------
// Default Configuration
// ------------------------------------------------------------

const DEFAULT_CONFIG: RateLimitConfig = {
  perIpLimit: 10,
  globalLimit: 100,
  windowMs: 60_000, // 1 minute
};

// ------------------------------------------------------------
// In-memory stores
// ------------------------------------------------------------

const ipStore = new Map<string, RateLimitEntry>();
let globalEntry: RateLimitEntry = { count: 0, resetAt: Date.now() + DEFAULT_CONFIG.windowMs };

/**
 * Reset expired entries periodically to prevent memory leaks.
 */
function cleanupExpiredEntries(): void {
  const now = Date.now();
  for (const [key, entry] of ipStore) {
    if (now >= entry.resetAt) {
      ipStore.delete(key);
    }
  }
}

// Cleanup every 5 minutes
setInterval(cleanupExpiredEntries, 5 * 60_000).unref();

// ------------------------------------------------------------
// Rate Limit Check
// ------------------------------------------------------------

function getOrCreateEntry(store: Map<string, RateLimitEntry>, key: string, windowMs: number): RateLimitEntry {
  const now = Date.now();
  let entry = store.get(key);

  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
    store.set(key, entry);
  }

  return entry;
}

// ------------------------------------------------------------
// Middleware Factory
// ------------------------------------------------------------

export function createRateLimitMiddleware(config: Partial<RateLimitConfig> = {}) {
  const cfg: RateLimitConfig = { ...DEFAULT_CONFIG, ...config };

  return function rateLimitMiddleware(
    request: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction,
  ): void {
    const now = Date.now();
    const ip = request.ip || request.headers['x-forwarded-for']?.toString() || 'unknown';

    // --- Global rate limit ---
    if (now >= globalEntry.resetAt) {
      globalEntry = { count: 0, resetAt: now + cfg.windowMs };
    }
    globalEntry.count++;

    if (globalEntry.count > cfg.globalLimit) {
      const retryAfter = Math.ceil((globalEntry.resetAt - now) / 1000);
      reply
        .status(429)
        .header('Retry-After', String(retryAfter))
        .send({
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many requests. Please try again later.',
          },
        });
      return;
    }

    // --- Per-IP rate limit ---
    const ipEntry = getOrCreateEntry(ipStore, ip, cfg.windowMs);
    ipEntry.count++;

    if (ipEntry.count > cfg.perIpLimit) {
      const retryAfter = Math.ceil((ipEntry.resetAt - now) / 1000);
      reply
        .status(429)
        .header('Retry-After', String(retryAfter))
        .send({
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many requests from this IP. Please try again later.',
          },
        });
      return;
    }

    done();
  };
}

/**
 * Reset all rate limit state (for testing).
 */
export function resetRateLimitState(): void {
  ipStore.clear();
  globalEntry = { count: 0, resetAt: Date.now() + DEFAULT_CONFIG.windowMs };
}
