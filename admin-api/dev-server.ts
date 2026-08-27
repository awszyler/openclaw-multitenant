/**
 * Local development server for admin-api.
 *
 * - Runs Fastify on port 3001 (matches web-console vite proxy)
 * - Bypasses JWT auth (injects a mock admin user)
 * - Uses in-memory storage instead of DynamoDB
 *
 * Usage:
 *   cd admin-api && npm run dev
 */

// ── Set env vars BEFORE any imports ──
process.env.DEV_MODE = 'true';
process.env.DEPLOYMENT_MODE = 'dev';
process.env.USERS_TABLE = 'openclaw-users-dev';
process.env.PROVIDERS_TABLE = 'openclaw-providers-dev';
process.env.AUDIT_LOGS_TABLE = 'openclaw-audit-logs-dev';
process.env.ECS_CLUSTER = 'openclaw-dev';
process.env.STAGE = 'dev';

// ── Seed sample data ──
import { seedDevData } from './src/lib/dynamo.js';

seedDevData('openclaw-providers-dev', [
  {
    provider_id: 'prov-bedrock-001',
    provider_name: 'Claude 3.5 Sonnet (Bedrock)',
    provider_type: 'bedrock',
    litellm_model_id: 'bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0',
    litellm_model_name: 'claude-3.5-sonnet',
    aws_region: 'us-east-1',
    model_ids: ['claude-3.5-sonnet'],
    is_default: true,
    status: 'active',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    provider_id: 'prov-litellm-001',
    provider_name: 'GPT-4o (OpenAI)',
    provider_type: 'litellm',
    litellm_model_id: 'gpt-4o',
    litellm_model_name: 'gpt-4o',
    base_url: 'https://api.openai.com',
    // 本地 mock 数据，故意不使用 sk- 前缀，避免被误认成真实凭证
    api_key: 'dummy-not-a-real-key',
    model_ids: ['gpt-4o'],
    is_default: false,
    status: 'active',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
], 'provider_id');

seedDevData('openclaw-users-dev', [
  {
    user_id: 'demo-user',
    display_name: 'Demo User',
    email: 'demo@example.com',
    status: 'active',
    model: 'claude-3.5-sonnet',
    allowed_models: ['claude-3.5-sonnet', 'gpt-4o'],
    skill_group: 'general',
    plan: 'pro',
    config_version: 1,
    quota: { max_monthly_tokens: 1000000, max_concurrent_agents: 5 },
    usage_month: '2026-04',
    usage_tokens: 12345,
    ecr_image: 'openclaw-general:latest',
    s3_state_path: 's3://bucket/demo-user/state/',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    updated_by: 'admin',
  },
], 'user_id');

// ── Override auth middleware via env var (auth.ts checks DEPLOYMENT_MODE) ──
// We set DEPLOYMENT_MODE=dev, but the auth middleware doesn't know about 'dev'.
// Instead, we'll patch the resetVerifier and use a custom approach.
// The simplest: just import buildApp and add a preHandler that injects jwtPayload.

import { buildApp } from './src/server.js';
import { resetVerifier } from './src/middleware/auth.js';

// Reset the verifier so it doesn't try to create a Cognito verifier
resetVerifier();

const app = buildApp();

// Override: add a first preHandler that injects dev credentials
// This runs before the auth middleware, which will see jwtPayload already set.
// But actually auth middleware always runs and will fail without Cognito config.
// Better approach: we need to intercept. Let's just start a fresh Fastify instance.

import Fastify from 'fastify';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { AppError, ErrorCode } from './src/lib/types.js';
import usersRoutes from './src/routes/users.js';
import providersRoutes from './src/routes/providers.js';
import dashboardRoutes from './src/routes/dashboard.js';
import auditLogsRoutes from './src/routes/audit-logs.js';

// Patch: override authMiddleware export. Since ES modules are frozen,
// we set an env var that auth.ts can check.
process.env.AUTH_BYPASS = 'true';

const devApp = Fastify({ logger: true });

// CORS
devApp.addHook('onRequest', async (_request: FastifyRequest, reply: FastifyReply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (_request.method === 'OPTIONS') reply.status(204).send();
});

// Error handler
devApp.setErrorHandler((error: Error, _request: FastifyRequest, reply: FastifyReply) => {
  if (error instanceof AppError) {
    reply.status(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } });
    return;
  }
  devApp.log.error(error);
  reply.status(500).send({ error: { code: ErrorCode.INTERNAL_ERROR, message: error.message } });
});

// Health
devApp.get('/api/health', async () => ({ status: 'ok', mode: 'dev' }));

// Current user info (role based on username in Bearer token)
import { authMiddleware } from './src/middleware/auth.js';
devApp.get('/api/me', { preHandler: authMiddleware }, async (request) => {
  const payload = request.jwtPayload;
  return {
    sub: payload?.sub ?? '',
    email: payload?.email ?? '',
    role: payload?.groups?.includes('openclaw-admins') ? 'admin' : 'viewer',
  };
});

// Routes — but we need to skip the authMiddleware inside them.
// The route plugins add authMiddleware as preHandler. Since our global preHandler
// already sets jwtPayload, the authMiddleware will try to verify the 'dev-token'
// and fail. We need to make authMiddleware skip when AUTH_BYPASS is set.

// Register routes
devApp.register(usersRoutes);
devApp.register(providersRoutes);
devApp.register(dashboardRoutes);
devApp.register(auditLogsRoutes);

devApp.listen({ port: 3001, host: '0.0.0.0' }, (err, address) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`\n🚀 Admin API dev server running at ${address}`);
  console.log('   Auth: username-based (login as "admin" for full access, anything else for read-only)');
  console.log('   Storage: in-memory');
  console.log('   Sample data: 2 providers, 1 user');
  console.log('\n   Start web-console: cd web-console && npm run dev\n');
});
