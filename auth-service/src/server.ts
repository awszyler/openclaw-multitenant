// ============================================================
// Auth Service - Fastify Entry Point
// Validates: Requirements 7.2
// ============================================================

import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import { createRateLimitMiddleware } from './middleware/rate-limit.js';

// ------------------------------------------------------------
// Fastify Instance Creation
// ------------------------------------------------------------

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: true,
    trustProxy: true,
  });

  // ----------------------------------------------------------
  // CORS Support
  // ----------------------------------------------------------

  app.addHook('onRequest', async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    reply.header('Access-Control-Max-Age', '86400');
  });

  // ----------------------------------------------------------
  // Rate Limiting on auth routes
  // ----------------------------------------------------------

  const rateLimiter = createRateLimitMiddleware({
    perIpLimit: 10,
    globalLimit: 100,
    windowMs: 60_000,
  });

  app.addHook('onRequest', (request, reply, done) => {
    // Apply rate limiting only to /auth/* routes (not health check or admin)
    if (request.url.startsWith('/auth/')) {
      rateLimiter(request, reply, done);
    } else {
      done();
    }
  });

  // ----------------------------------------------------------
  // Global Error Handler
  // ----------------------------------------------------------

  app.setErrorHandler((error: Error, _request: FastifyRequest, reply: FastifyReply) => {
    app.log.error(error, 'Unhandled error');
    reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      },
    });
  });

  // ----------------------------------------------------------
  // Health Check
  // ----------------------------------------------------------

  app.get('/health', async () => {
    return { status: 'ok', service: 'auth-service' };
  });

  // ----------------------------------------------------------
  // Route Registration
  // ----------------------------------------------------------

  app.register(authRoutes);
  app.register(adminRoutes);

  return app;
}

// ------------------------------------------------------------
// App Instance
// ------------------------------------------------------------

export const app = buildApp();

// ------------------------------------------------------------
// Start Server (when run directly)
// ------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? '3000', 10);

app.listen({ port: PORT, host: '0.0.0.0' }).then((address) => {
  console.log(`Auth service listening on ${address}`);
}).catch((err) => {
  console.error('Failed to start auth service:', err);
  process.exit(1);
});
