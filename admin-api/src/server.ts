// ============================================================
// Fastify Entry Point & Lambda Handler for OpenClaw Admin API
// Validates: Requirements 11.1
// ============================================================

import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import awsLambdaFastify from '@fastify/aws-lambda';
import { AppError, ErrorCode, type ErrorResponse } from './lib/types.js';
import { authMiddleware } from './middleware/auth.js';
import usersRoutes from './routes/users.js';
import providersRoutes from './routes/providers.js';
import dashboardRoutes from './routes/dashboard.js';
import auditLogsRoutes from './routes/audit-logs.js';
import authProxyRoutes from './routes/auth-proxy.js';

// ------------------------------------------------------------
// Fastify Instance Creation
// ------------------------------------------------------------

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: true,
  });

  // ----------------------------------------------------------
  // CORS Support (manual headers)
  // ----------------------------------------------------------

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = request.headers.origin ?? '*';
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    reply.header('Access-Control-Max-Age', '86400');

    // Handle preflight requests
    if (request.method === 'OPTIONS') {
      reply.status(204).send();
    }
  });

  // ----------------------------------------------------------
  // Global Error Handler
  // ----------------------------------------------------------

  app.setErrorHandler((error: Error, _request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof AppError) {
      const body: ErrorResponse = {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details && { details: error.details }),
        },
      };
      reply.status(error.statusCode).send(body);
      return;
    }

    // Unknown / unexpected errors → 500 INTERNAL_ERROR
    app.log.error(error, 'Unhandled error');
    const body: ErrorResponse = {
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        message: 'An unexpected error occurred',
      },
    };
    reply.status(500).send(body);
  });

  // ----------------------------------------------------------
  // Health Check (always available, no auth required)
  // ----------------------------------------------------------

  app.get('/api/health', async () => {
    return { status: 'ok' };
  });

  // ----------------------------------------------------------
  // Current User Info
  // ----------------------------------------------------------

  app.get('/api/me', { preHandler: authMiddleware }, async (request) => {
    const payload = request.jwtPayload;
    return {
      sub: payload?.sub ?? '',
      email: payload?.email ?? '',
      role: payload?.groups?.includes('openclaw-admins') ? 'admin' : 'viewer',
    };
  });

  // ----------------------------------------------------------
  // Route Registration
  // Routes are registered here as they are implemented in
  // later tasks (6.3, 7.2, 8.1, 8.2). Each route module
  // exports a Fastify plugin that is registered below.
  // ----------------------------------------------------------

  // Route modules registered as Fastify plugins
  app.register(authProxyRoutes);  // Must be before authMiddleware-protected routes
  app.register(usersRoutes);
  app.register(providersRoutes);
  app.register(dashboardRoutes);
  app.register(auditLogsRoutes);

  return app;
}

// ------------------------------------------------------------
// App Instance (shared for Lambda handler and testing)
// ------------------------------------------------------------

export const app = buildApp();

// ------------------------------------------------------------
// Lambda Handler (via @fastify/aws-lambda)
// ------------------------------------------------------------

export const handler = awsLambdaFastify(app);
