// ============================================================
// User Management Service for OpenClaw Admin Platform
// Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6,
//            3.10, 3.11, 4.1, 4.3, 4.4, 13.1, 14.1
// ============================================================

import {
  SecretsManagerClient,
  CreateSecretCommand,
  DeleteSecretCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  getItem,
  putItem,
  updateItem,
  scan,
  USERS_TABLE,
  PROVIDERS_TABLE,
} from '../lib/dynamo.js';
import {
  AppError,
  ErrorCode,
  type User,
  type CreateUserRequest,
  type UpdateUserRequest,
  type UserStatus,
  type UserPlan,
  type Quota,
  type Provider,
} from '../lib/types.js';
import { writeAuditLog } from './audit-service.js';
import { startContainer, stopContainer, restartContainer, getContainerStatus } from './ecs-service.js';
import { buildConfigForCreate, buildConfigForUser, findProviderByModel } from './openclaw-config.js';

// ------------------------------------------------------------
// AWS Clients
// ------------------------------------------------------------

const secretsClient = new SecretsManagerClient({});

const STAGE = process.env.STAGE ?? 'dev';
const REGION = process.env.AWS_REGION ?? 'ap-northeast-2';
const ACCOUNT_ID = process.env.AWS_ACCOUNT_ID ?? '';
const ECS_CLUSTER = process.env.ECS_CLUSTER ?? `openclaw-${STAGE}`;
const DATA_BUCKET = process.env.DATA_BUCKET ?? `openclaw-data-${STAGE}-${ACCOUNT_ID}`;

// ------------------------------------------------------------
// Sensitive Field Masking
// ------------------------------------------------------------

/** Fields that should be masked in API responses */
const SENSITIVE_FIELDS = new Set([
  'wecom_secret',
  'llm_api_key',
  'api_key',
  'secret',
  'password',
  'token',
  'access_token',
  'refresh_token',
]);

/**
 * Mask sensitive fields in an object, replacing their values with '***'.
 * Operates on a shallow copy — does not mutate the original.
 */
export function maskSensitiveFields<T extends Record<string, unknown>>(obj: T): T {
  const masked = { ...obj };
  for (const key of Object.keys(masked)) {
    if (SENSITIVE_FIELDS.has(key)) {
      (masked as Record<string, unknown>)[key] = '***';
    }
  }
  return masked;
}

// ------------------------------------------------------------
// User Service Functions
// ------------------------------------------------------------

/**
 * Create a new user.
 * Steps: write Users Table → store credentials in Secrets Manager →
 *        generate proxy-managed openclaw.json → call ECS RunTask → audit log.
 *
 * @throws AppError 409 if userId already exists
 */
export async function createUser(
  request: CreateUserRequest,
  actor: string,
  ip: string,
): Promise<User> {
  const now = new Date().toISOString();

  const user: User = {
    user_id: request.user_id,
    display_name: request.display_name,
    email: request.email,
    status: 'active',
    model: request.model,
    allowed_models: request.allowed_models ?? [request.model],
    wecom_bot_id: request.channel?.channel_type === 'wecom' ? request.channel.wecom_bot_id : undefined,
    channel_type: request.channel?.channel_type ?? 'none',
    teams_app_id: request.channel?.channel_type === 'teams' ? request.channel.teams_app_id : undefined,
    config_version: 1,
    plan: request.plan,
    quota: request.quota ?? { max_monthly_tokens: 0, max_concurrent_agents: 1 },
    usage_month: now.slice(0, 7), // YYYY-MM
    usage_tokens: 0,
    skill_group: request.skill_group,
    ecr_image:
      request.ecr_image ??
      `${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/openclaw-${request.skill_group}:latest`,
    s3_state_path:
      request.s3_state_path ?? `s3://${DATA_BUCKET}/${request.user_id}/state/`,
    created_at: now,
    updated_at: now,
    updated_by: actor,
  };

  // 1. Write to Users Table (allow re-creation of soft-deleted users)
  try {
    await putItem(
      USERS_TABLE(),
      user as unknown as Record<string, unknown>,
      'attribute_not_exists(user_id) OR #status = :deleted',
      { '#status': 'status' },
      { ':deleted': 'deleted' },
    );
  } catch (error) {
    if ((error as Error).name === 'ConditionalCheckFailedException') {
      throw new AppError(
        409,
        ErrorCode.USER_ALREADY_EXISTS,
        `User '${request.user_id}' already exists`,
      );
    }
    throw error;
  }

  // 2. Store channel credentials in Secrets Manager
  if (request.channel && request.channel.channel_type !== 'none') {
    try {
      await storeChannelSecrets(request.user_id, request.channel);
    } catch (error) {
      console.error('Failed to store channel secrets:', error);
    }
  }

  // 3. Generate openclaw.json config (provider-type aware)
  const { openclawConfigB64, bedrockRegion } = await buildConfigForCreate(
    request.user_id,
    request.model,
    request.channel,
  );

  // 4. Start ECS container
  try {
    const taskArn = await startContainer(request.user_id, {
      ecrImage: user.ecr_image,
      skillGroup: user.skill_group,
      s3StatePath: user.s3_state_path,
      openclawConfigB64,
      bedrockRegion,
    });
    user.task_arn = taskArn;
    user.task_status = 'PROVISIONING';
  } catch (error) {
    console.error(`Failed to start container for user '${request.user_id}':`, error);
    // Don't fail user creation — container can be started later manually
    user.task_status = 'FAILED';
  }

  // 5. Write audit log
  writeAuditLog(actor, 'user.create', 'user', request.user_id, {
    display_name: request.display_name,
    model: request.model,
    plan: request.plan,
    skill_group: request.skill_group,
    channel_type: request.channel?.channel_type ?? 'none',
  }, ip);

  return maskSensitiveFields(user as unknown as Record<string, unknown>) as unknown as User;
}

/**
 * List all users. Scans Users Table and returns masked user list.
 * Excludes soft-deleted users by default.
 */
export async function listUsers(
  _actor: string,
  _ip: string,
): Promise<User[]> {
  const result = await scan<User>(USERS_TABLE(), {
    filterExpression: '#status <> :deleted',
    expressionAttributeNames: { '#status': 'status' },
    expressionAttributeValues: { ':deleted': 'deleted' },
  });

  const users = result.items;

  // Batch-enrich with real-time ECS container status
  const taskArns = users.map((u) => u.task_arn).filter((arn): arn is string => !!arn && arn !== 'None');
  if (taskArns.length > 0) {
    try {
      const statuses = await getContainerStatus(taskArns);
      const statusMap = new Map(statuses.map((s) => [s.taskArn, s]));
      const updatePromises: Promise<void>[] = [];
      for (const user of users) {
        if (user.task_arn) {
          const cs = statusMap.get(user.task_arn);
          if (cs) {
            // If status changed from what's in DynamoDB, update it async
            if (cs.lastStatus !== user.task_status || cs.privateIp !== user.task_ip) {
              user.task_status = cs.lastStatus;
              user.task_ip = cs.privateIp;
              user.task_health = cs.healthStatus;
              updatePromises.push(
                updateItem(
                  USERS_TABLE(),
                  { user_id: user.user_id },
                  'SET #ts = :ts, #tip = :tip',
                  { '#ts': 'task_status', '#tip': 'task_ip' },
                  { ':ts': cs.lastStatus, ':tip': cs.privateIp ?? '' },
                ).then(() => undefined).catch(() => undefined),
              );
            } else {
              user.task_status = cs.lastStatus;
              user.task_ip = cs.privateIp;
              user.task_health = cs.healthStatus;
            }
          }
        }
      }
      // Fire-and-forget DynamoDB updates
      if (updatePromises.length > 0) {
        Promise.all(updatePromises).catch(() => {});
      }
    } catch {
      // Don't fail list if ECS describe fails
    }
  }

  return users.map(
    (u) => maskSensitiveFields(u as unknown as Record<string, unknown>) as unknown as User,
  );
}

/**
 * Get a single user by userId.
 * Queries Users Table and enriches with ECS container real-time status.
 *
 * @throws AppError 404 if user not found
 */
export async function getUser(
  userId: string,
  _actor: string,
  _ip: string,
): Promise<User> {
  const user = await getItem<User>(USERS_TABLE(), { user_id: userId });

  if (!user) {
    throw new AppError(404, ErrorCode.USER_NOT_FOUND, `User '${userId}' not found`);
  }

  // Enrich with ECS real-time status
  if (user.task_arn) {
    try {
      const statuses = await getContainerStatus([user.task_arn]);
      if (statuses.length > 0) {
        user.task_status = statuses[0].lastStatus;
        user.task_ip = statuses[0].privateIp;
        user.task_health = statuses[0].healthStatus;
      }
    } catch {
      // Don't fail getUser if ECS describe fails
    }
  }

  return maskSensitiveFields(user as unknown as Record<string, unknown>) as unknown as User;
}

/**
 * Update user basic information.
 *
 * @throws AppError 404 if user not found
 */
export async function updateUser(
  userId: string,
  request: UpdateUserRequest,
  actor: string,
  ip: string,
): Promise<User> {
  // Verify user exists
  const existing = await getItem<User>(USERS_TABLE(), { user_id: userId });
  if (!existing) {
    throw new AppError(404, ErrorCode.USER_NOT_FOUND, `User '${userId}' not found`);
  }

  // Build update expression dynamically from provided fields
  const expressionParts: string[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, unknown> = {};
  const changes: Record<string, unknown> = {};

  const updatableFields: Array<{ key: keyof UpdateUserRequest; attr: string }> = [
    { key: 'display_name', attr: 'display_name' },
    { key: 'email', attr: 'email' },
    { key: 'skill_group', attr: 'skill_group' },
    { key: 'allowed_models', attr: 'allowed_models' },
    { key: 'ecr_image', attr: 'ecr_image' },
    { key: 's3_state_path', attr: 's3_state_path' },
  ];

  for (const { key, attr } of updatableFields) {
    if (request[key] !== undefined) {
      const nameAlias = `#${attr}`;
      const valueAlias = `:${attr}`;
      expressionParts.push(`${nameAlias} = ${valueAlias}`);
      expressionAttributeNames[nameAlias] = attr;
      expressionAttributeValues[valueAlias] = request[key];
      changes[attr] = { from: existing[attr as keyof User], to: request[key] };
    }
  }

  // Always update updated_at and updated_by
  const now = new Date().toISOString();
  expressionParts.push('#updated_at = :updated_at');
  expressionAttributeNames['#updated_at'] = 'updated_at';
  expressionAttributeValues[':updated_at'] = now;

  expressionParts.push('#updated_by = :updated_by');
  expressionAttributeNames['#updated_by'] = 'updated_by';
  expressionAttributeValues[':updated_by'] = actor;

  const updateExpression = `SET ${expressionParts.join(', ')}`;

  const updated = await updateItem<User>(
    USERS_TABLE(),
    { user_id: userId },
    updateExpression,
    expressionAttributeNames,
    expressionAttributeValues,
  );

  // Write audit log
  writeAuditLog(actor, 'user.update', 'user', userId, changes, ip);

  const result = updated ?? existing;
  return maskSensitiveFields(result as unknown as Record<string, unknown>) as unknown as User;
}

/**
 * Soft-delete a user: set status to 'deleted', stop ECS container, write audit log.
 *
 * @throws AppError 404 if user not found
 */
export async function deleteUser(
  userId: string,
  actor: string,
  ip: string,
): Promise<void> {
  const existing = await getItem<User>(USERS_TABLE(), { user_id: userId });
  if (!existing) {
    throw new AppError(404, ErrorCode.USER_NOT_FOUND, `User '${userId}' not found`);
  }

  const now = new Date().toISOString();

  await updateItem(
    USERS_TABLE(),
    { user_id: userId },
    'SET #status = :status, #updated_at = :updated_at, #updated_by = :updated_by',
    {
      '#status': 'status',
      '#updated_at': 'updated_at',
      '#updated_by': 'updated_by',
    },
    {
      ':status': 'deleted',
      ':updated_at': now,
      ':updated_by': actor,
    },
  );

  // Stop ECS container if running
  if (existing.task_arn) {
    try {
      await stopContainer(userId, existing.task_arn);
    } catch {
      // Don't fail delete if container stop fails
    }
  }

  writeAuditLog(actor, 'user.delete', 'user', userId, {
    previous_status: existing.status,
  }, ip);
}

/**
 * Update user status (active / suspended).
 *
 * @throws AppError 404 if user not found
 */
export async function updateUserStatus(
  userId: string,
  status: UserStatus,
  actor: string,
  ip: string,
): Promise<User> {
  const existing = await getItem<User>(USERS_TABLE(), { user_id: userId });
  if (!existing) {
    throw new AppError(404, ErrorCode.USER_NOT_FOUND, `User '${userId}' not found`);
  }

  const now = new Date().toISOString();

  const updated = await updateItem<User>(
    USERS_TABLE(),
    { user_id: userId },
    'SET #status = :status, #updated_at = :updated_at, #updated_by = :updated_by',
    {
      '#status': 'status',
      '#updated_at': 'updated_at',
      '#updated_by': 'updated_by',
    },
    {
      ':status': status,
      ':updated_at': now,
      ':updated_by': actor,
    },
  );

  writeAuditLog(actor, 'user.update_status', 'user', userId, {
    from: existing.status,
    to: status,
  }, ip);

  const result = updated ?? existing;
  return maskSensitiveFields(result as unknown as Record<string, unknown>) as unknown as User;
}

/**
 * Update user model.
 * Validates: model exists in Providers Table and is active,
 *            model is in user's allowed_models list.
 * Increments config_version on success.
 *
 * @throws AppError 404 if user not found
 * @throws AppError 400 if model not found or disabled
 * @throws AppError 403 if model not in allowed_models
 */
export async function updateUserModel(
  userId: string,
  model: string,
  actor: string,
  ip: string,
): Promise<User> {
  // 1. Verify user exists
  const existing = await getItem<User>(USERS_TABLE(), { user_id: userId });
  if (!existing) {
    throw new AppError(404, ErrorCode.USER_NOT_FOUND, `User '${userId}' not found`);
  }

  // 2. Validate model exists in Providers Table and is active
  const providerResult = await scan<Provider>(PROVIDERS_TABLE(), {
    filterExpression: 'litellm_model_name = :model',
    expressionAttributeValues: { ':model': model },
  });

  const provider = providerResult.items[0];
  if (!provider) {
    throw new AppError(
      400,
      ErrorCode.MODEL_NOT_FOUND,
      `Model '${model}' not found in providers`,
    );
  }

  if (provider.status !== 'active') {
    throw new AppError(
      400,
      ErrorCode.MODEL_DISABLED,
      `Model '${model}' is currently disabled`,
    );
  }

  // 3. If the model is not yet in the user's allowed_models, add it automatically.
  //    An admin explicitly switching a user's model implies they want it allowed.
  const updatedAllowedModels = existing.allowed_models.includes(model)
    ? existing.allowed_models
    : [...existing.allowed_models, model];

  // 4. Update model, allowed_models, and increment config_version
  const now = new Date().toISOString();
  const newConfigVersion = (existing.config_version ?? 0) + 1;

  const updated = await updateItem<User>(
    USERS_TABLE(),
    { user_id: userId },
    'SET #model = :model, #allowed_models = :allowed_models, #config_version = :config_version, #updated_at = :updated_at, #updated_by = :updated_by',
    {
      '#model': 'model',
      '#allowed_models': 'allowed_models',
      '#config_version': 'config_version',
      '#updated_at': 'updated_at',
      '#updated_by': 'updated_by',
    },
    {
      ':model': model,
      ':allowed_models': updatedAllowedModels,
      ':config_version': newConfigVersion,
      ':updated_at': now,
      ':updated_by': actor,
    },
  );

  // 5. Determine whether a container restart is required.
  //    litellm→litellm: Lambda proxy resolves model dynamically, no restart needed.
  //    bedrock→bedrock: model ID + region are baked into openclaw.json, restart required.
  //    cross-type (litellm↔bedrock): config shape changes entirely, restart required.
  const oldProvider = await findProviderByModel(existing.model);
  const newProvider = providerResult.items[0];
  const oldType = oldProvider?.provider_type ?? 'litellm';
  const newType = newProvider?.provider_type ?? 'litellm';
  const needsRestart = oldType !== newType          // cross-type switch
    || newType === 'bedrock';                        // bedrock→bedrock: config is static

  let restarted = false;
  if (needsRestart && existing.task_arn) {
    try {
      const fresh = { ...existing, model };
      const { openclawConfigB64, bedrockRegion } = await buildConfigForUser(fresh);
      await restartContainer(userId, existing.task_arn, {
        ecrImage: existing.ecr_image,
        skillGroup: existing.skill_group,
        s3StatePath: existing.s3_state_path,
        openclawConfigB64,
        bedrockRegion,
      });
      restarted = true;
    } catch (err) {
      // Don't roll back the model change — the next manual restart will pick it up.
      console.error(`[updateUserModel] restart failed for ${userId}:`, err);
    }
  }

  // 6. Write audit log
  const allowedModelsChanged = updatedAllowedModels.length !== existing.allowed_models.length;
  writeAuditLog(actor, 'user.update_model', 'user', userId, {
    from: existing.model,
    to: model,
    config_version: newConfigVersion,
    from_provider_type: oldType,
    to_provider_type: newType,
    container_restarted: restarted,
    ...(allowedModelsChanged && { allowed_models_added: model }),
  }, ip);

  const result = updated ?? existing;
  return maskSensitiveFields(result as unknown as Record<string, unknown>) as unknown as User;
}

/**
 * Update user plan and quota.
 *
 * @throws AppError 404 if user not found
 */
export async function updateUserPlan(
  userId: string,
  plan: UserPlan,
  quota: Quota | undefined,
  actor: string,
  ip: string,
): Promise<User> {
  const existing = await getItem<User>(USERS_TABLE(), { user_id: userId });
  if (!existing) {
    throw new AppError(404, ErrorCode.USER_NOT_FOUND, `User '${userId}' not found`);
  }

  const now = new Date().toISOString();
  const expressionParts = [
    '#plan = :plan',
    '#updated_at = :updated_at',
    '#updated_by = :updated_by',
  ];
  const expressionAttributeNames: Record<string, string> = {
    '#plan': 'plan',
    '#updated_at': 'updated_at',
    '#updated_by': 'updated_by',
  };
  const expressionAttributeValues: Record<string, unknown> = {
    ':plan': plan,
    ':updated_at': now,
    ':updated_by': actor,
  };

  const changes: Record<string, unknown> = {
    plan: { from: existing.plan, to: plan },
  };

  if (quota !== undefined) {
    expressionParts.push('#quota = :quota');
    expressionAttributeNames['#quota'] = 'quota';
    expressionAttributeValues[':quota'] = quota;
    changes['quota'] = { from: existing.quota, to: quota };
  }

  const updateExpression = `SET ${expressionParts.join(', ')}`;

  const updated = await updateItem<User>(
    USERS_TABLE(),
    { user_id: userId },
    updateExpression,
    expressionAttributeNames,
    expressionAttributeValues,
  );

  writeAuditLog(actor, 'user.update', 'user', userId, changes, ip);

  const result = updated ?? existing;
  return maskSensitiveFields(result as unknown as Record<string, unknown>) as unknown as User;
}

// ------------------------------------------------------------
// Pure Validation Logic (extracted for testability)
// ------------------------------------------------------------

/**
 * Result of model switch validation.
 * Either a success with the new config_version, or a failure with error details.
 */
export type ModelSwitchResult =
  | { success: true; newConfigVersion: number }
  | { success: false; errorCode: ErrorCode; statusCode: number; message: string };

/**
 * Pure validation function for model switch.
 * Validates that:
 *   (a) the target model exists in the providers list
 *   (b) the target model's status is 'active'
 *
 * On success, returns the new config_version (current + 1).
 * On failure, returns the appropriate error code and HTTP status.
 *
 * Note: allowed_models is no longer checked here because the admin flow
 * auto-adds the target model to allowed_models when switching.
 *
 * This function is side-effect-free and testable without DynamoDB.
 */
export function validateModelSwitch(
  targetModel: string,
  providers: Pick<Provider, 'litellm_model_name' | 'status'>[],
  _userAllowedModels: string[],
  currentConfigVersion: number,
): ModelSwitchResult {
  // (a) Check model exists in providers
  const provider = providers.find((p) => p.litellm_model_name === targetModel);
  if (!provider) {
    return {
      success: false,
      errorCode: ErrorCode.MODEL_NOT_FOUND,
      statusCode: 400,
      message: `Model '${targetModel}' not found in providers`,
    };
  }

  // (b) Check model status is active
  if (provider.status !== 'active') {
    return {
      success: false,
      errorCode: ErrorCode.MODEL_DISABLED,
      statusCode: 400,
      message: `Model '${targetModel}' is currently disabled`,
    };
  }

  // All checks passed
  return {
    success: true,
    newConfigVersion: currentConfigVersion + 1,
  };
}

// ------------------------------------------------------------
// Internal Helpers
// ------------------------------------------------------------

/**
 * Store channel credentials in Secrets Manager based on channel type.
 */
async function storeChannelSecrets(
  userId: string,
  channel: import('../lib/types.js').ChannelConfig,
): Promise<void> {
  if (channel.channel_type === 'wecom' && channel.wecom_bot_id && channel.wecom_secret) {
    const secretName = `openclaw/${STAGE}/${userId}/wecom`;
    await secretsClient.send(
      new CreateSecretCommand({
        Name: secretName,
        SecretString: JSON.stringify({ botId: channel.wecom_bot_id, secret: channel.wecom_secret }),
      }),
    ).catch((err) => {
      if ((err as Error).name === 'ResourceExistsException') return;
      throw err;
    });
  }

  if (channel.channel_type === 'teams' && channel.teams_app_id && channel.teams_app_password) {
    const secretName = `openclaw/${STAGE}/${userId}/teams`;
    await secretsClient.send(
      new CreateSecretCommand({
        Name: secretName,
        SecretString: JSON.stringify({
          appId: channel.teams_app_id,
          appPassword: channel.teams_app_password,
          tenantId: channel.teams_tenant_id,
        }),
      }),
    ).catch((err) => {
      if ((err as Error).name === 'ResourceExistsException') return;
      throw err;
    });
  }
}

