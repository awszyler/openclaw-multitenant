// ============================================================
// User Management Routes for OpenClaw Admin Platform
// Validates: Requirements 3.1-3.11
// ============================================================

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../middleware/auth.js';
import {
  createUser,
  listUsers,
  getUser,
  updateUser,
  deleteUser,
  updateUserStatus,
  updateUserModel,
  updateUserPlan,
} from '../services/user-service.js';
import {
  startContainer,
  stopContainer,
  restartContainer,
  getContainerStatus,
  type StartContainerConfig,
} from '../services/ecs-service.js';
import { writeAuditLog } from '../services/audit-service.js';
import { buildConfigForUser } from '../services/openclaw-config.js';
import { getItem, USERS_TABLE } from '../lib/dynamo.js';
import {
  AppError,
  ErrorCode,
  type CreateUserRequest,
  type UpdateUserRequest,
  type UserStatus,
  type UserPlan,
  type Quota,
  type User,
} from '../lib/types.js';

// ------------------------------------------------------------
// Helpers (route-local)
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

export default async function usersRoutes(app: FastifyInstance): Promise<void> {
  // Apply authMiddleware to all routes in this plugin
  app.addHook('preHandler', authMiddleware);

  // ----------------------------------------------------------
  // GET /api/users — List all users
  // ----------------------------------------------------------
  app.get('/api/users', async (request: FastifyRequest, _reply: FastifyReply) => {
    const actor = getActor(request);
    const ip = getClientIp(request);
    const users = await listUsers(actor, ip);
    return users;
  });

  // ----------------------------------------------------------
  // GET /api/users/:userId — Get user details
  // ----------------------------------------------------------
  app.get(
    '/api/users/:userId',
    async (
      request: FastifyRequest<{ Params: { userId: string } }>,
      _reply: FastifyReply,
    ) => {
      const { userId } = request.params;
      const actor = getActor(request);
      const ip = getClientIp(request);
      const user = await getUser(userId, actor, ip);
      return user;
    },
  );

  // ----------------------------------------------------------
  // POST /api/users — Create user
  // ----------------------------------------------------------
  app.post(
    '/api/users',
    async (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      const body = request.body as Record<string, unknown> | undefined;
      if (!body || typeof body !== 'object') {
        throw new AppError(400, ErrorCode.INTERNAL_ERROR, 'Request body is required');
      }

      // Validate required fields
      const createReq: CreateUserRequest = {
        user_id: requireString(body.user_id, 'user_id'),
        display_name: requireString(body.display_name, 'display_name'),
        email: typeof body.email === 'string' ? body.email : undefined,
        skill_group: requireString(body.skill_group, 'skill_group'),
        model: requireString(body.model, 'model'),
        plan: requireString(body.plan, 'plan') as UserPlan,
        quota: body.quota as Quota | undefined,
        allowed_models: Array.isArray(body.allowed_models) ? body.allowed_models as string[] : undefined,
        channel: body.channel as CreateUserRequest['channel'],
        ecr_image: typeof body.ecr_image === 'string' ? body.ecr_image : undefined,
        s3_state_path: typeof body.s3_state_path === 'string' ? body.s3_state_path : undefined,
      };

      // Validate plan enum
      if (!['free', 'pro', 'enterprise'].includes(createReq.plan)) {
        throw new AppError(400, ErrorCode.INTERNAL_ERROR, "Invalid plan. Must be 'free', 'pro', or 'enterprise'");
      }

      const actor = getActor(request);
      const ip = getClientIp(request);
      const user = await createUser(createReq, actor, ip);
      reply.status(201);
      return user;
    },
  );

  // ----------------------------------------------------------
  // PUT /api/users/:userId — Update user info
  // ----------------------------------------------------------
  app.put(
    '/api/users/:userId',
    async (
      request: FastifyRequest<{ Params: { userId: string }; Body: UpdateUserRequest }>,
      _reply: FastifyReply,
    ) => {
      const { userId } = request.params;
      const body = request.body as Record<string, unknown> | undefined;
      if (!body || typeof body !== 'object') {
        throw new AppError(400, ErrorCode.INTERNAL_ERROR, 'Request body is required');
      }

      const updateReq: UpdateUserRequest = {};
      if (typeof body.display_name === 'string') updateReq.display_name = body.display_name;
      if (typeof body.email === 'string') updateReq.email = body.email;
      if (typeof body.skill_group === 'string') updateReq.skill_group = body.skill_group;
      if (Array.isArray(body.allowed_models)) updateReq.allowed_models = body.allowed_models as string[];
      if (body.channel && typeof body.channel === 'object') updateReq.channel = body.channel as UpdateUserRequest['channel'];
      if (typeof body.ecr_image === 'string') updateReq.ecr_image = body.ecr_image;
      if (typeof body.s3_state_path === 'string') updateReq.s3_state_path = body.s3_state_path;

      const actor = getActor(request);
      const ip = getClientIp(request);
      const user = await updateUser(userId, updateReq, actor, ip);
      return user;
    },
  );

  // ----------------------------------------------------------
  // DELETE /api/users/:userId — Delete user (soft)
  // ----------------------------------------------------------
  app.delete(
    '/api/users/:userId',
    async (
      request: FastifyRequest<{ Params: { userId: string } }>,
      _reply: FastifyReply,
    ) => {
      const { userId } = request.params;
      const actor = getActor(request);
      const ip = getClientIp(request);
      await deleteUser(userId, actor, ip);
      return { success: true };
    },
  );

  // ----------------------------------------------------------
  // PUT /api/users/:userId/model — Change user model
  // ----------------------------------------------------------
  app.put(
    '/api/users/:userId/model',
    async (
      request: FastifyRequest<{ Params: { userId: string }; Body: { model: string } }>,
      _reply: FastifyReply,
    ) => {
      const { userId } = request.params;
      const body = request.body as Record<string, unknown> | undefined;
      if (!body || typeof body !== 'object') {
        throw new AppError(400, ErrorCode.INTERNAL_ERROR, 'Request body is required');
      }

      const model = requireString(body.model, 'model');
      const actor = getActor(request);
      const ip = getClientIp(request);
      const user = await updateUserModel(userId, model, actor, ip);
      return user;
    },
  );

  // ----------------------------------------------------------
  // PUT /api/users/:userId/plan — Change user plan
  // ----------------------------------------------------------
  app.put(
    '/api/users/:userId/plan',
    async (
      request: FastifyRequest<{
        Params: { userId: string };
        Body: { plan: string; quota?: Quota };
      }>,
      _reply: FastifyReply,
    ) => {
      const { userId } = request.params;
      const body = request.body as Record<string, unknown> | undefined;
      if (!body || typeof body !== 'object') {
        throw new AppError(400, ErrorCode.INTERNAL_ERROR, 'Request body is required');
      }

      const plan = requireString(body.plan, 'plan') as UserPlan;
      if (!['free', 'pro', 'enterprise'].includes(plan)) {
        throw new AppError(400, ErrorCode.INTERNAL_ERROR, "Invalid plan. Must be 'free', 'pro', or 'enterprise'");
      }

      const quota = body.quota as Quota | undefined;
      const actor = getActor(request);
      const ip = getClientIp(request);
      const user = await updateUserPlan(userId, plan, quota, actor, ip);
      return user;
    },
  );

  // ----------------------------------------------------------
  // PUT /api/users/:userId/status — Change user status
  // ----------------------------------------------------------
  app.put(
    '/api/users/:userId/status',
    async (
      request: FastifyRequest<{
        Params: { userId: string };
        Body: { status: UserStatus };
      }>,
      _reply: FastifyReply,
    ) => {
      const { userId } = request.params;
      const body = request.body as Record<string, unknown> | undefined;
      if (!body || typeof body !== 'object') {
        throw new AppError(400, ErrorCode.INTERNAL_ERROR, 'Request body is required');
      }

      const status = requireString(body.status, 'status') as UserStatus;
      if (!['active', 'suspended'].includes(status)) {
        throw new AppError(
          400,
          ErrorCode.INTERNAL_ERROR,
          "Invalid status. Must be 'active' or 'suspended'",
        );
      }

      const actor = getActor(request);
      const ip = getClientIp(request);
      const user = await updateUserStatus(userId, status, actor, ip);
      return user;
    },
  );

  // ----------------------------------------------------------
  // POST /api/users/:userId/restart — Restart container
  // ----------------------------------------------------------
  app.post(
    '/api/users/:userId/restart',
    async (
      request: FastifyRequest<{ Params: { userId: string } }>,
      _reply: FastifyReply,
    ) => {
      const { userId } = request.params;
      const actor = getActor(request);
      const ip = getClientIp(request);

      // Fetch user to get current task_arn and container config
      const user = await getItem<User>(USERS_TABLE(), { user_id: userId });
      if (!user) {
        throw new AppError(404, ErrorCode.USER_NOT_FOUND, `User '${userId}' not found`);
      }

      if (!user.task_arn) {
        throw new AppError(
          400,
          ErrorCode.INTERNAL_ERROR,
          `User '${userId}' has no running container to restart`,
        );
      }

      const { openclawConfigB64, bedrockRegion } = await buildConfigForUser(user);
      const config: StartContainerConfig = {
        ecrImage: user.ecr_image,
        skillGroup: user.skill_group,
        s3StatePath: user.s3_state_path,
        openclawConfigB64,
        bedrockRegion,
      };

      const taskArn = await restartContainer(userId, user.task_arn, config);

      writeAuditLog(actor, 'user.restart', 'user', userId, {
        old_task_arn: user.task_arn,
        new_task_arn: taskArn,
      }, ip);

      return { taskArn };
    },
  );

  // ----------------------------------------------------------
  // POST /api/users/:userId/stop — Stop container
  // ----------------------------------------------------------
  app.post(
    '/api/users/:userId/stop',
    async (
      request: FastifyRequest<{ Params: { userId: string } }>,
      _reply: FastifyReply,
    ) => {
      const { userId } = request.params;
      const actor = getActor(request);
      const ip = getClientIp(request);

      const user = await getItem<User>(USERS_TABLE(), { user_id: userId });
      if (!user) {
        throw new AppError(404, ErrorCode.USER_NOT_FOUND, `User '${userId}' not found`);
      }

      if (!user.task_arn) {
        throw new AppError(
          400,
          ErrorCode.INTERNAL_ERROR,
          `User '${userId}' has no running container to stop`,
        );
      }

      await stopContainer(userId, user.task_arn);

      writeAuditLog(actor, 'user.stop', 'user', userId, {
        task_arn: user.task_arn,
      }, ip);

      return { success: true };
    },
  );

  // ----------------------------------------------------------
  // POST /api/users/:userId/start — Start container
  // ----------------------------------------------------------
  app.post(
    '/api/users/:userId/start',
    async (
      request: FastifyRequest<{ Params: { userId: string } }>,
      _reply: FastifyReply,
    ) => {
      const { userId } = request.params;
      const actor = getActor(request);
      const ip = getClientIp(request);

      const user = await getItem<User>(USERS_TABLE(), { user_id: userId });
      if (!user) {
        throw new AppError(404, ErrorCode.USER_NOT_FOUND, `User '${userId}' not found`);
      }

      // Guard: prevent starting a new container if one is already running or starting
      if (user.task_arn && user.task_status) {
        const activeStatuses = ['PROVISIONING', 'PENDING', 'ACTIVATING', 'RUNNING', 'DEPROVISIONING'];
        if (activeStatuses.includes(user.task_status)) {
          throw new AppError(
            409,
            ErrorCode.INTERNAL_ERROR,
            `User '${userId}' already has a container in '${user.task_status}' state. Stop it first or wait for it to finish.`,
          );
        }
      }

      const { openclawConfigB64, bedrockRegion } = await buildConfigForUser(user);
      const config: StartContainerConfig = {
        ecrImage: user.ecr_image,
        skillGroup: user.skill_group,
        s3StatePath: user.s3_state_path,
        openclawConfigB64,
        bedrockRegion,
      };

      const taskArn = await startContainer(userId, config);

      writeAuditLog(actor, 'user.start', 'user', userId, {
        task_arn: taskArn,
      }, ip);

      return { taskArn };
    },
  );
}
