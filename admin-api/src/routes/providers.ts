// ============================================================
// Provider Management Routes for OpenClaw Admin Platform
// Validates: Requirements 5.1-5.6
// ============================================================

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../middleware/auth.js';
import {
  createProvider,
  listProviders,
  updateProvider,
  deleteProvider,
  syncFromLiteLLM,
  testProvider,
  testProviderInline,
} from '../services/provider-service.js';
import {
  AppError,
  ErrorCode,
  type CreateProviderRequest,
  type UpdateProviderRequest,
  type ProviderType,
  type ProviderStatus,
} from '../lib/types.js';

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/** Extract actor (userId) from JWT payload injected by authMiddleware */
function getActor(request: FastifyRequest): string {
  return request.jwtPayload?.sub ?? 'unknown';
}

/** Extract client IP from request headers (X-Forwarded-For or socket) */
function getClientIp(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return request.ip ?? 'unknown';
}

/** Validate that a string field is non-empty */
function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError(
      400,
      ErrorCode.INTERNAL_ERROR,
      `Missing or invalid required field: ${fieldName}`,
    );
  }
  return value.trim();
}

// ------------------------------------------------------------
// Route Plugin
// ------------------------------------------------------------

export default async function providersRoutes(app: FastifyInstance): Promise<void> {
  // Apply authMiddleware to all routes in this plugin
  app.addHook('preHandler', authMiddleware);

  // ----------------------------------------------------------
  // GET /api/providers — List all providers with user counts
  // ----------------------------------------------------------
  app.get('/api/providers', async (request: FastifyRequest, _reply: FastifyReply) => {
    const providers = await listProviders();
    return providers;
  });

  // ----------------------------------------------------------
  // POST /api/providers — Create provider
  // ----------------------------------------------------------
  app.post(
    '/api/providers',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as Record<string, unknown> | undefined;
      if (!body || typeof body !== 'object') {
        throw new AppError(400, ErrorCode.INTERNAL_ERROR, 'Request body is required');
      }

      const createReq: CreateProviderRequest = {
        provider_name: requireString(body.provider_name, 'provider_name'),
        provider_type: requireString(body.provider_type, 'provider_type') as ProviderType,
        litellm_model_id: requireString(body.litellm_model_id, 'litellm_model_id'),
        litellm_model_name: requireString(body.litellm_model_name, 'litellm_model_name'),
        aws_region: typeof body.aws_region === 'string' ? body.aws_region : undefined,
        is_default: typeof body.is_default === 'boolean' ? body.is_default : undefined,
        base_url: typeof body.base_url === 'string' ? body.base_url : undefined,
        api_key: typeof body.api_key === 'string' ? body.api_key : undefined,
      };

      // Validate provider_type enum
      if (!['bedrock', 'litellm'].includes(createReq.provider_type)) {
        throw new AppError(
          400,
          ErrorCode.INTERNAL_ERROR,
          "Invalid provider_type. Must be 'bedrock' or 'litellm'",
        );
      }

      const actor = getActor(request);
      const ip = getClientIp(request);
      const provider = await createProvider(createReq, actor, ip);
      reply.status(201);
      return provider;
    },
  );

  // ----------------------------------------------------------
  // PUT /api/providers/:providerId — Update provider
  // ----------------------------------------------------------
  app.put(
    '/api/providers/:providerId',
    async (
      request: FastifyRequest<{ Params: { providerId: string } }>,
      _reply: FastifyReply,
    ) => {
      const { providerId } = request.params;
      const body = request.body as Record<string, unknown> | undefined;
      if (!body || typeof body !== 'object') {
        throw new AppError(400, ErrorCode.INTERNAL_ERROR, 'Request body is required');
      }

      const updateReq: UpdateProviderRequest = {};
      if (typeof body.provider_name === 'string') updateReq.provider_name = body.provider_name;
      if (typeof body.provider_type === 'string') {
        if (!['bedrock', 'litellm'].includes(body.provider_type)) {
          throw new AppError(
            400,
            ErrorCode.INTERNAL_ERROR,
            "Invalid provider_type. Must be 'bedrock' or 'litellm'",
          );
        }
        updateReq.provider_type = body.provider_type as ProviderType;
      }
      if (typeof body.litellm_model_id === 'string') updateReq.litellm_model_id = body.litellm_model_id;
      if (typeof body.litellm_model_name === 'string') updateReq.litellm_model_name = body.litellm_model_name;
      if (typeof body.aws_region === 'string') updateReq.aws_region = body.aws_region;
      if (typeof body.is_default === 'boolean') updateReq.is_default = body.is_default;
      if (typeof body.base_url === 'string') updateReq.base_url = body.base_url;
      if (typeof body.api_key === 'string') updateReq.api_key = body.api_key;
      if (typeof body.status === 'string') {
        if (!['active', 'disabled'].includes(body.status)) {
          throw new AppError(
            400,
            ErrorCode.INTERNAL_ERROR,
            "Invalid status. Must be 'active' or 'disabled'",
          );
        }
        updateReq.status = body.status as ProviderStatus;
      }

      const actor = getActor(request);
      const ip = getClientIp(request);
      const provider = await updateProvider(providerId, updateReq, actor, ip);
      return provider;
    },
  );

  // ----------------------------------------------------------
  // DELETE /api/providers/:providerId — Delete provider
  // ----------------------------------------------------------
  app.delete(
    '/api/providers/:providerId',
    async (
      request: FastifyRequest<{ Params: { providerId: string } }>,
      _reply: FastifyReply,
    ) => {
      const { providerId } = request.params;
      const actor = getActor(request);
      const ip = getClientIp(request);
      await deleteProvider(providerId, actor, ip);
      return { success: true };
    },
  );

  // ----------------------------------------------------------
  // GET /api/providers/sync — Sync from LiteLLM
  // ----------------------------------------------------------
  app.get('/api/providers/sync', async (_request: FastifyRequest, _reply: FastifyReply) => {
    const result = await syncFromLiteLLM();
    return result;
  });

  // ----------------------------------------------------------
  // POST /api/providers/test — Test provider connectivity (inline, before save)
  // ----------------------------------------------------------
  app.post('/api/providers/test', async (request: FastifyRequest, _reply: FastifyReply) => {
    const body = request.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object') {
      throw new AppError(400, ErrorCode.INTERNAL_ERROR, 'Request body is required');
    }

    const result = await testProviderInline({
      provider_type: requireString(body.provider_type, 'provider_type'),
      litellm_model_id: requireString(body.litellm_model_id, 'litellm_model_id'),
      litellm_model_name: requireString(body.litellm_model_name, 'litellm_model_name'),
      base_url: typeof body.base_url === 'string' ? body.base_url : undefined,
      api_key: typeof body.api_key === 'string' ? body.api_key : undefined,
      aws_region: typeof body.aws_region === 'string' ? body.aws_region : undefined,
    });
    return result;
  });

  // ----------------------------------------------------------
  // POST /api/providers/:providerId/test — Test existing provider connectivity
  // ----------------------------------------------------------
  app.post(
    '/api/providers/:providerId/test',
    async (request: FastifyRequest<{ Params: { providerId: string } }>, _reply: FastifyReply) => {
      const { providerId } = request.params;
      const result = await testProvider(providerId);
      return result;
    },
  );
}
