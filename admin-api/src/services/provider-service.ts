// ============================================================
// Provider Management Service for OpenClaw Admin Platform
// Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
// ============================================================

import { ulid } from 'ulid';
import {
  SecretsManagerClient,
  CreateSecretCommand,
  UpdateSecretCommand,
  DeleteSecretCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  getItem,
  putItem,
  updateItem,
  deleteItem,
  scan,
  PROVIDERS_TABLE,
  USERS_TABLE,
} from '../lib/dynamo.js';
import {
  AppError,
  ErrorCode,
  type Provider,
  type CreateProviderRequest,
  type UpdateProviderRequest,
  type ProviderTestResult,
  type User,
} from '../lib/types.js';
import { writeAuditLog } from './audit-service.js';

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------

/** Provider with associated user count for list responses */
export interface ProviderWithCount extends Provider {
  user_count: number;
}

/** Result of a LiteLLM sync operation */
export interface SyncResult {
  added: string[];
  removed: string[];
  unchanged: string[];
}

// ------------------------------------------------------------
// Pure Logic (exported for property testing)
// ------------------------------------------------------------

/**
 * Pure function that counts the number of users associated with each provider.
 * A user is associated with a provider when the user's `model` field matches
 * the provider's `litellm_model_name`.
 *
 * @param providers - Array of providers to count users for
 * @param users - Array of all users
 * @returns Map from provider_id to user count
 */
export function countUsersPerProvider(
  providers: Pick<Provider, 'provider_id' | 'litellm_model_name'>[],
  users: Pick<User, 'model'>[],
): Map<string, number> {
  const counts = new Map<string, number>();

  for (const provider of providers) {
    const count = users.filter(
      (u) => u.model === provider.litellm_model_name,
    ).length;
    counts.set(provider.provider_id, count);
  }

  return counts;
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/** Mask an API key for safe display: show first 4 and last 4 chars */
export function maskApiKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

/** Strip sensitive fields from a provider for API responses */
function sanitizeProvider(provider: Provider): Provider {
  return {
    ...provider,
    api_key: maskApiKey(provider.api_key),
  };
}

// ------------------------------------------------------------
// Secrets Manager Helpers
// ------------------------------------------------------------

const secretsClient = new SecretsManagerClient({});
const STAGE = process.env.STAGE ?? 'dev';

/** Store provider API key in Secrets Manager, return the secret ARN */
async function storeProviderApiKey(providerId: string, apiKey: string): Promise<string> {
  const secretName = `openclaw/${STAGE}/providers/${providerId}/api-key`;
  try {
    const result = await secretsClient.send(new CreateSecretCommand({
      Name: secretName,
      SecretString: apiKey,
    }));
    return result.ARN ?? secretName;
  } catch (err) {
    if ((err as Error).name === 'ResourceExistsException') {
      const result = await secretsClient.send(new UpdateSecretCommand({
        SecretId: secretName,
        SecretString: apiKey,
      }));
      return result.ARN ?? secretName;
    }
    throw err;
  }
}

/** Delete provider API key from Secrets Manager */
async function deleteProviderApiKey(providerId: string): Promise<void> {
  const secretName = `openclaw/${STAGE}/providers/${providerId}/api-key`;
  try {
    await secretsClient.send(new DeleteSecretCommand({
      SecretId: secretName,
      ForceDeleteWithoutRecovery: true,
    }));
  } catch (err) {
    if ((err as Error).name !== 'ResourceNotFoundException') {
      console.error(`Failed to delete secret ${secretName}:`, err);
    }
  }
}

// ------------------------------------------------------------
// Provider Service Functions
// ------------------------------------------------------------

/**
 * Create a new provider.
 * Generates a ULID as provider_id, writes to Providers Table, writes audit log.
 *
 * @throws AppError 502 on DynamoDB failure
 */
export async function createProvider(
  request: CreateProviderRequest,
  actor: string,
  ip: string,
): Promise<Provider> {
  const now = new Date().toISOString();
  const providerId = ulid();

  // Store API key in Secrets Manager if provided
  let apiKeySecretArn: string | undefined;
  if (request.api_key) {
    apiKeySecretArn = await storeProviderApiKey(providerId, request.api_key);
  }

  const provider: Provider = {
    provider_id: providerId,
    provider_name: request.provider_name,
    provider_type: request.provider_type,
    litellm_model_id: request.litellm_model_id,
    litellm_model_name: request.litellm_model_name,
    aws_region: request.aws_region,
    is_default: request.is_default ?? false,
    status: 'active',
    created_at: now,
    updated_at: now,
    base_url: request.base_url,
    api_key: apiKeySecretArn, // Store ARN reference, not plaintext
  };

  await putItem(
    PROVIDERS_TABLE(),
    provider as unknown as Record<string, unknown>,
  );

  writeAuditLog(actor, 'provider.create', 'provider', providerId, {
    provider_name: request.provider_name,
    provider_type: request.provider_type,
    litellm_model_name: request.litellm_model_name,
  }, ip);

  // Return with masked key for display (show original key hint, not ARN)
  return sanitizeProvider({ ...provider, api_key: request.api_key });
}

/**
 * List all providers with associated user counts.
 * Scans Providers Table and Users Table, then computes user counts per provider.
 */
export async function listProviders(): Promise<ProviderWithCount[]> {
  const [providerResult, userResult] = await Promise.all([
    scan<Provider>(PROVIDERS_TABLE()),
    scan<User>(USERS_TABLE(), {
      filterExpression: '#status <> :deleted',
      expressionAttributeNames: { '#status': 'status' },
      expressionAttributeValues: { ':deleted': 'deleted' },
    }),
  ]);

  const providers = providerResult.items;
  const users = userResult.items;

  const userCounts = countUsersPerProvider(providers, users);

  return providers.map((p) => ({
    ...sanitizeProvider(p),
    user_count: userCounts.get(p.provider_id) ?? 0,
  }));
}

/**
 * Update a provider's configuration.
 *
 * @throws AppError 404 if provider not found
 */
export async function updateProvider(
  providerId: string,
  request: UpdateProviderRequest,
  actor: string,
  ip: string,
): Promise<Provider> {
  // Verify provider exists
  const existing = await getItem<Provider>(PROVIDERS_TABLE(), { provider_id: providerId });
  if (!existing) {
    throw new AppError(404, ErrorCode.PROVIDER_NOT_FOUND, `Provider '${providerId}' not found`);
  }

  // Build update expression dynamically from provided fields
  const expressionParts: string[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, unknown> = {};
  const changes: Record<string, unknown> = {};

  const updatableFields: Array<{ key: keyof UpdateProviderRequest; attr: string }> = [
    { key: 'provider_name', attr: 'provider_name' },
    { key: 'provider_type', attr: 'provider_type' },
    { key: 'litellm_model_id', attr: 'litellm_model_id' },
    { key: 'litellm_model_name', attr: 'litellm_model_name' },
    { key: 'aws_region', attr: 'aws_region' },
    { key: 'is_default', attr: 'is_default' },
    { key: 'status', attr: 'status' },
    { key: 'base_url', attr: 'base_url' },
  ];

  for (const { key, attr } of updatableFields) {
    if (request[key] !== undefined) {
      const nameAlias = `#${attr}`;
      const valueAlias = `:${attr}`;
      expressionParts.push(`${nameAlias} = ${valueAlias}`);
      expressionAttributeNames[nameAlias] = attr;
      expressionAttributeValues[valueAlias] = request[key];
      changes[attr] = { from: existing[attr as keyof Provider], to: request[key] };
    }
  }

  // Handle api_key separately — store in Secrets Manager
  if (request.api_key !== undefined) {
    const apiKeySecretArn = await storeProviderApiKey(providerId, request.api_key);
    expressionParts.push('#api_key = :api_key');
    expressionAttributeNames['#api_key'] = 'api_key';
    expressionAttributeValues[':api_key'] = apiKeySecretArn;
    changes['api_key'] = { from: '***', to: '***' };
  }

  // Always update updated_at
  const now = new Date().toISOString();
  expressionParts.push('#updated_at = :updated_at');
  expressionAttributeNames['#updated_at'] = 'updated_at';
  expressionAttributeValues[':updated_at'] = now;

  const updateExpression = `SET ${expressionParts.join(', ')}`;

  const updated = await updateItem<Provider>(
    PROVIDERS_TABLE(),
    { provider_id: providerId },
    updateExpression,
    expressionAttributeNames,
    expressionAttributeValues,
  );

  writeAuditLog(actor, 'provider.update', 'provider', providerId, changes, ip);

  return sanitizeProvider(updated ?? existing);
}

/**
 * Delete a provider.
 * Checks for associated users first — returns 409 with user list if any exist.
 *
 * @throws AppError 404 if provider not found
 * @throws AppError 409 if provider has associated users
 */
export async function deleteProvider(
  providerId: string,
  actor: string,
  ip: string,
): Promise<void> {
  // Verify provider exists
  const existing = await getItem<Provider>(PROVIDERS_TABLE(), { provider_id: providerId });
  if (!existing) {
    throw new AppError(404, ErrorCode.PROVIDER_NOT_FOUND, `Provider '${providerId}' not found`);
  }

  // Check for associated users
  const userResult = await scan<User>(USERS_TABLE(), {
    filterExpression: '#model = :model AND #status <> :deleted',
    expressionAttributeNames: {
      '#model': 'model',
      '#status': 'status',
    },
    expressionAttributeValues: {
      ':model': existing.litellm_model_name,
      ':deleted': 'deleted',
    },
  });

  if (userResult.items.length > 0) {
    const associatedUsers = userResult.items.map((u) => ({
      user_id: u.user_id,
      display_name: u.display_name,
    }));

    throw new AppError(
      409,
      ErrorCode.PROVIDER_HAS_USERS,
      `Provider '${providerId}' still has ${userResult.items.length} associated user(s)`,
      { users: associatedUsers },
    );
  }

  // Delete the provider
  await deleteItem(PROVIDERS_TABLE(), { provider_id: providerId });

  // Clean up API key from Secrets Manager
  await deleteProviderApiKey(providerId);

  writeAuditLog(actor, 'provider.delete', 'provider', providerId, {
    provider_name: existing.provider_name,
    litellm_model_name: existing.litellm_model_name,
  }, ip);
}

/**
 * Sync providers from LiteLLM service.
 * Fetches the model list from LiteLLM API and compares with Providers Table.
 *
 * This is a placeholder implementation — the actual LiteLLM endpoint URL
 * should come from environment variables in production.
 */
export async function syncFromLiteLLM(): Promise<SyncResult> {
  const litellmUrl = process.env.LITELLM_URL ?? 'http://localhost:4000';

  // Fetch models from LiteLLM
  let litellmModels: Array<{ model_name: string; litellm_params?: { model?: string } }> = [];
  try {
    const response = await fetch(`${litellmUrl}/models`);
    if (!response.ok) {
      throw new Error(`LiteLLM returned HTTP ${response.status}`);
    }
    const data = (await response.json()) as { data?: Array<{ model_name: string; litellm_params?: { model?: string } }> };
    litellmModels = data.data ?? [];
  } catch (error) {
    throw new AppError(
      502,
      ErrorCode.UPSTREAM_ERROR,
      `Failed to fetch models from LiteLLM: ${(error as Error).message}`,
    );
  }

  // Fetch existing providers
  const providerResult = await scan<Provider>(PROVIDERS_TABLE());
  const existingProviders = providerResult.items;

  const existingModelNames = new Set(existingProviders.map((p) => p.litellm_model_name));
  const litellmModelNames = new Set(litellmModels.map((m) => m.model_name));

  const added: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];

  // Models in LiteLLM but not in Providers Table
  for (const model of litellmModels) {
    if (!existingModelNames.has(model.model_name)) {
      added.push(model.model_name);
    } else {
      unchanged.push(model.model_name);
    }
  }

  // Models in Providers Table but not in LiteLLM
  for (const provider of existingProviders) {
    if (!litellmModelNames.has(provider.litellm_model_name)) {
      removed.push(provider.litellm_model_name);
    }
  }

  return { added, removed, unchanged };
}

/**
 * Test a provider's connectivity by sending a minimal chat completion request.
 *
 * For **bedrock** type: calls AWS Bedrock Converse API directly using IAM credentials.
 * For **litellm** type: sends a request to the provider's base_url with its api_key.
 *
 * @param providerId - Provider to test (reads config from DynamoDB)
 * @throws AppError 404 if provider not found
 */
export async function testProvider(providerId: string): Promise<ProviderTestResult> {
  const provider = await getItem<Provider>(PROVIDERS_TABLE(), { provider_id: providerId });
  if (!provider) {
    throw new AppError(404, ErrorCode.PROVIDER_NOT_FOUND, `Provider '${providerId}' not found`);
  }

  if (provider.provider_type === 'bedrock') {
    // Strip "bedrock/" prefix to get the raw model ID for the SDK
    const rawModelId = provider.litellm_model_id.replace(/^bedrock\//, '');
    return testBedrockModel(rawModelId, provider.aws_region ?? 'us-east-1', provider.litellm_model_name);
  }

  return testLitellmEndpoint(
    provider.base_url,
    provider.api_key,
    provider.litellm_model_id || provider.litellm_model_name,
    provider.litellm_model_name,
  );
}

/**
 * Test a provider's connectivity using inline parameters (before saving to DynamoDB).
 * Used by the "test before save" flow in the UI.
 */
export async function testProviderInline(params: {
  provider_type: string;
  litellm_model_id: string;
  litellm_model_name: string;
  base_url?: string;
  api_key?: string;
  aws_region?: string;
}): Promise<ProviderTestResult> {
  if (params.provider_type === 'bedrock') {
    const rawModelId = params.litellm_model_id.replace(/^bedrock\//, '');
    return testBedrockModel(rawModelId, params.aws_region ?? 'us-east-1', params.litellm_model_name);
  }

  return testLitellmEndpoint(
    params.base_url,
    params.api_key,
    params.litellm_model_id || params.litellm_model_name,
    params.litellm_model_name,
  );
}

// ── Internal test helpers ──

async function testBedrockModel(
  modelId: string,
  region: string,
  displayName: string,
): Promise<ProviderTestResult> {
  const start = Date.now();
  try {
    const { BedrockRuntimeClient, ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime');
    const client = new BedrockRuntimeClient({ region });
    const command = new ConverseCommand({
      modelId,
      messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
      inferenceConfig: { maxTokens: 5 },
    });
    await client.send(command);
    return { success: true, latency_ms: Date.now() - start, model: displayName };
  } catch (err) {
    const latency = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    // Provide friendly error messages for common Bedrock errors
    let friendlyError = message;
    if (message.includes('Could not resolve the foundation model')) {
      friendlyError = `Model "${modelId}" not found in region ${region}. Check the model ID and ensure it's enabled in your AWS account.`;
    } else if (message.includes('inference profile')) {
      friendlyError = `Model "${modelId}" requires an inference profile. Use the cross-region format, e.g. us.${modelId} or eu.${modelId}`;
    } else if (message.includes('AccessDeniedException') || message.includes('not authorized')) {
      friendlyError = `Access denied for model "${modelId}" in ${region}. Ensure the model is enabled in Bedrock console and IAM permissions are configured.`;
    } else if (message.includes('ExpiredTokenException') || message.includes('credentials')) {
      friendlyError = `AWS credentials invalid or expired. Check your AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN.`;
    }
    return { success: false, latency_ms: latency, model: displayName, error: friendlyError };
  }
}

async function testLitellmEndpoint(
  baseUrl: string | undefined,
  apiKey: string | undefined,
  modelId: string,
  displayName: string,
): Promise<ProviderTestResult> {
  const start = Date.now();
  if (!baseUrl) {
    return { success: false, latency_ms: 0, model: displayName, error: 'Missing API endpoint URL (base_url)' };
  }

  const targetUrl = `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 5 }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const latency = Date.now() - start;

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { success: false, latency_ms: latency, model: displayName, error: `HTTP ${response.status}: ${body.slice(0, 200)}` };
    }

    return { success: true, latency_ms: latency, model: displayName };
  } catch (err) {
    const latency = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    let friendlyError = message;
    if (message.includes('abort')) friendlyError = 'Request timed out (15s)';
    else if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) friendlyError = `Cannot connect to ${baseUrl}. Check the URL is correct and the service is running.`;
    return { success: false, latency_ms: latency, model: displayName, error: friendlyError };
  }
}
