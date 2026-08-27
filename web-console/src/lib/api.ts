// ============================================================
// API Client Wrapper
// Validates: Requirements 9.1
// ============================================================
// Wraps fetch with automatic Bearer token injection and unified error handling.

import { getToken, getRuntimeConfig } from './auth';

// API base URL — loaded from runtime config, defaults to '' (same-origin via CloudFront)
let _apiBase: string | null = null;

async function getApiBase(): Promise<string> {
  if (_apiBase !== null) return _apiBase;
  const config = await getRuntimeConfig();
  _apiBase = config.apiBaseUrl ?? '';
  return _apiBase;
}

// ---- Types (mirrored from admin-api for frontend use) ----

export type UserStatus = 'active' | 'suspended' | 'deleted';
export type UserPlan = 'free' | 'pro' | 'enterprise';
export type ProviderType = 'bedrock' | 'litellm';
export type ProviderStatus = 'active' | 'disabled';

export interface Quota {
  max_monthly_tokens: number;
  max_concurrent_agents: number;
}

export interface User {
  user_id: string;
  display_name: string;
  email?: string;
  status: UserStatus;
  model: string;
  allowed_models: string[];
  wecom_bot_id?: string;
  channel_type?: 'wecom' | 'teams' | 'none';
  teams_app_id?: string;
  config_version: number;
  plan: UserPlan;
  quota: Quota;
  usage_month: string;
  usage_tokens: number;
  task_arn?: string;
  task_status?: string;
  task_ip?: string;
  task_health?: string;
  skill_group: string;
  created_at: string;
  last_active_at?: string;
  updated_at: string;
}

export interface Provider {
  provider_id: string;
  provider_name: string;
  provider_type: ProviderType;
  litellm_model_id: string;
  litellm_model_name: string;
  aws_region?: string;
  is_default: boolean;
  status: ProviderStatus;
  created_at: string;
  updated_at: string;
  base_url?: string;
  api_key?: string;
}

export interface ProviderWithCount extends Provider {
  user_count: number;
}

export interface ProviderTestResult {
  success: boolean;
  latency_ms: number;
  model: string;
  error?: string;
}

export interface AuditLog {
  log_date: string;
  'timestamp#log_id': string;
  actor: string;
  action: string;
  target_type: string;
  target_id: string;
  detail: Record<string, unknown>;
  ip: string;
  created_at: string;
}

export interface DashboardData {
  total_users: number;
  active_users: number;
  running_containers: number;
  monthly_token_usage: number;
  available_models: number;
}

export interface HealthStatus {
  dynamodb: 'healthy' | 'unhealthy';
  ecs: 'healthy' | 'unhealthy';
  s3: 'healthy' | 'unhealthy';
}

// ---- Error handling ----

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

// ---- Core fetch wrapper ----

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  let token: string;
  try {
    token = await getToken();
  } catch (err) {
    // getToken() failed — session not ready or expired
    console.error('getToken() failed:', err);
    throw new ApiError(401, 'NO_SESSION', 'Failed to get auth token');
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...(options.headers as Record<string, string> ?? {}),
  };

  // Only set Content-Type for requests with a body
  if (options.body) {
    headers['Content-Type'] = 'application/json';
  }

  const apiBase = await getApiBase();
  const resp = await fetch(`${apiBase}${path}`, {
    ...options,
    headers,
  });

  if (resp.status === 401) {
    // Token invalid or expired — don't redirect here, let the caller handle it
    throw new ApiError(401, 'UNAUTHORIZED', 'Session expired');
  }

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({ error: { code: 'UNKNOWN', message: resp.statusText } }));
    const err = body.error ?? { code: 'UNKNOWN', message: resp.statusText };
    throw new ApiError(resp.status, err.code, err.message);
  }

  // Handle 204 No Content
  if (resp.status === 204) {
    return undefined as T;
  }

  return resp.json();
}

// ---- User API ----

export async function listUsers(): Promise<User[]> {
  return apiFetch<User[]>('/api/users');
}

export async function getUser(userId: string): Promise<User> {
  return apiFetch<User>(`/api/users/${encodeURIComponent(userId)}`);
}

export async function createUser(data: {
  user_id: string;
  display_name: string;
  email?: string;
  skill_group: string;
  model: string;
  plan: UserPlan;
  quota?: Quota;
  allowed_models?: string[];
  channel?: {
    channel_type: 'wecom' | 'teams' | 'none';
    wecom_bot_id?: string;
    wecom_secret?: string;
    teams_app_id?: string;
    teams_app_password?: string;
    teams_tenant_id?: string;
  };
}): Promise<User> {
  return apiFetch<User>('/api/users', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateUser(userId: string, data: {
  display_name?: string;
  email?: string;
  skill_group?: string;
  allowed_models?: string[];
}): Promise<User> {
  return apiFetch<User>(`/api/users/${encodeURIComponent(userId)}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteUser(userId: string): Promise<void> {
  await apiFetch<{ success: boolean }>(`/api/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  });
}

export async function updateUserModel(userId: string, model: string): Promise<User> {
  return apiFetch<User>(`/api/users/${encodeURIComponent(userId)}/model`, {
    method: 'PUT',
    body: JSON.stringify({ model }),
  });
}

export async function updateUserPlan(userId: string, plan: UserPlan, quota?: Quota): Promise<User> {
  return apiFetch<User>(`/api/users/${encodeURIComponent(userId)}/plan`, {
    method: 'PUT',
    body: JSON.stringify({ plan, quota }),
  });
}

export async function updateUserStatus(userId: string, status: 'active' | 'suspended'): Promise<User> {
  return apiFetch<User>(`/api/users/${encodeURIComponent(userId)}/status`, {
    method: 'PUT',
    body: JSON.stringify({ status }),
  });
}

export async function startContainer(userId: string): Promise<{ taskArn: string }> {
  return apiFetch<{ taskArn: string }>(`/api/users/${encodeURIComponent(userId)}/start`, {
    method: 'POST',
  });
}

export async function stopContainer(userId: string): Promise<void> {
  await apiFetch<{ success: boolean }>(`/api/users/${encodeURIComponent(userId)}/stop`, {
    method: 'POST',
  });
}

export async function restartContainer(userId: string): Promise<{ taskArn: string }> {
  return apiFetch<{ taskArn: string }>(`/api/users/${encodeURIComponent(userId)}/restart`, {
    method: 'POST',
  });
}

// ---- Provider API ----

export async function listProviders(): Promise<ProviderWithCount[]> {
  return apiFetch<ProviderWithCount[]>('/api/providers');
}

export async function createProvider(data: {
  provider_name: string;
  provider_type: ProviderType;
  litellm_model_id: string;
  litellm_model_name: string;
  aws_region?: string;
  is_default?: boolean;
  base_url?: string;
  api_key?: string;
}): Promise<Provider> {
  return apiFetch<Provider>('/api/providers', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateProvider(providerId: string, data: {
  provider_name?: string;
  provider_type?: ProviderType;
  litellm_model_id?: string;
  litellm_model_name?: string;
  aws_region?: string;
  is_default?: boolean;
  status?: ProviderStatus;
  base_url?: string;
  api_key?: string;
}): Promise<Provider> {
  return apiFetch<Provider>(`/api/providers/${encodeURIComponent(providerId)}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteProvider(providerId: string): Promise<void> {
  await apiFetch<{ success: boolean }>(`/api/providers/${encodeURIComponent(providerId)}`, {
    method: 'DELETE',
  });
}

export async function syncProviders(): Promise<{ added: number; updated: number; removed: number }> {
  return apiFetch<{ added: number; updated: number; removed: number }>('/api/providers/sync');
}

export async function testProviderInline(data: {
  provider_type: string;
  litellm_model_id: string;
  litellm_model_name: string;
  base_url?: string;
  api_key?: string;
  aws_region?: string;
}): Promise<ProviderTestResult> {
  return apiFetch<ProviderTestResult>('/api/providers/test', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function testProviderById(providerId: string): Promise<ProviderTestResult> {
  return apiFetch<ProviderTestResult>(`/api/providers/${encodeURIComponent(providerId)}/test`, {
    method: 'POST',
  });
}

// ---- Dashboard API ----

export async function getDashboard(): Promise<DashboardData> {
  return apiFetch<DashboardData>('/api/dashboard');
}

// ---- Audit Logs API ----

export async function getAuditLogs(params?: {
  startDate?: string;
  endDate?: string;
  action?: string;
  actor?: string;
  target_id?: string;
}): Promise<AuditLog[]> {
  const searchParams = new URLSearchParams();
  if (params?.startDate) searchParams.set('startDate', params.startDate);
  if (params?.endDate) searchParams.set('endDate', params.endDate);
  if (params?.action) searchParams.set('action', params.action);
  if (params?.actor) searchParams.set('actor', params.actor);
  if (params?.target_id) searchParams.set('target_id', params.target_id);

  const qs = searchParams.toString();
  return apiFetch<AuditLog[]>(`/api/audit-logs${qs ? `?${qs}` : ''}`);
}

// ---- System API ----

export async function getHealthStatus(): Promise<HealthStatus> {
  return apiFetch<HealthStatus>('/api/system/health');
}

// ---- Current User API ----

export type UserRole = 'admin' | 'viewer';

export interface CurrentUser {
  sub: string;
  email: string;
  role: UserRole;
}

export async function getCurrentUser(): Promise<CurrentUser> {
  return apiFetch<CurrentUser>('/api/me');
}
