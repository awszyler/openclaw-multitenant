// ============================================================
// Core Types and Interfaces for OpenClaw Admin Platform
// Validates: Requirements 2.1, 2.2, 2.3
// ============================================================

// ------------------------------------------------------------
// User Types
// ------------------------------------------------------------

/** User status enum */
export type UserStatus = 'active' | 'suspended' | 'deleted';

/** User plan enum */
export type UserPlan = 'free' | 'pro' | 'enterprise';

/** User quota configuration */
export interface Quota {
  max_monthly_tokens: number;
  max_concurrent_agents: number;
}

/** User entity matching Users Table schema */
export interface User {
  user_id: string;
  display_name: string;
  email?: string;
  status: UserStatus;
  model: string;
  allowed_models: string[];
  wecom_bot_id?: string;
  /** Channel type: wecom, teams, or none */
  channel_type?: ChannelType;
  /** Teams app ID (when channel_type is teams) */
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
  ecr_image: string;
  s3_state_path: string;
  created_at: string;
  last_active_at?: string;
  updated_at: string;
  updated_by: string;
}

/** Channel type enum */
export type ChannelType = 'wecom' | 'teams' | 'none';

/** Channel credentials — varies by channel type */
export interface ChannelConfig {
  channel_type: ChannelType;
  /** WeCom: bot ID */
  wecom_bot_id?: string;
  /** WeCom: bot secret */
  wecom_secret?: string;
  /** Teams: bot app ID */
  teams_app_id?: string;
  /** Teams: bot app password */
  teams_app_password?: string;
  /** Teams: tenant ID */
  teams_tenant_id?: string;
}

/** Request body for POST /api/users */
export interface CreateUserRequest {
  user_id: string;
  display_name: string;
  email?: string;
  skill_group: string;
  model: string;
  plan: UserPlan;
  quota?: Quota;
  allowed_models?: string[];
  channel?: ChannelConfig;
  ecr_image?: string;
  s3_state_path?: string;
}

/** Request body for PUT /api/users/:userId */
export interface UpdateUserRequest {
  display_name?: string;
  email?: string;
  skill_group?: string;
  allowed_models?: string[];
  channel?: ChannelConfig;
  ecr_image?: string;
  s3_state_path?: string;
}

// ------------------------------------------------------------
// Provider Types
// ------------------------------------------------------------

/** Provider type enum */
export type ProviderType = 'bedrock' | 'litellm';

/** Provider status enum */
export type ProviderStatus = 'active' | 'disabled';

/** Provider entity matching Providers Table schema */
export interface Provider {
  provider_id: string;
  provider_name: string;
  provider_type: ProviderType;
  /** Actual model identifier for API calls.
   *  Bedrock: "bedrock/anthropic.claude-opus-4-6-v1" (auto-prefixed)
   *  LiteLLM: "gpt-4o" or any model name the endpoint accepts */
  litellm_model_id: string;
  /** User-facing model alias used for model switching in the admin console */
  litellm_model_name: string;
  /** AWS region for Bedrock models (e.g., "us-east-1") */
  aws_region?: string;
  is_default: boolean;
  status: ProviderStatus;
  created_at: string;
  updated_at: string;
  /** API endpoint base URL (litellm type only) */
  base_url?: string;
  /** API key (litellm type only, stored masked in responses) */
  api_key?: string;
}

/** Request body for POST /api/providers */
export interface CreateProviderRequest {
  provider_name: string;
  provider_type: ProviderType;
  litellm_model_id: string;
  litellm_model_name: string;
  aws_region?: string;
  is_default?: boolean;
  base_url?: string;
  api_key?: string;
}

/** Request body for PUT /api/providers/:providerId */
export interface UpdateProviderRequest {
  provider_name?: string;
  provider_type?: ProviderType;
  litellm_model_id?: string;
  litellm_model_name?: string;
  aws_region?: string;
  is_default?: boolean;
  status?: ProviderStatus;
  base_url?: string;
  api_key?: string;
}

/** Result of a provider connectivity test */
export interface ProviderTestResult {
  success: boolean;
  latency_ms: number;
  model: string;
  error?: string;
}

// ------------------------------------------------------------
// Audit Log Types
// ------------------------------------------------------------

/** Audit log action enum */
export type AuditAction =
  | 'user.create'
  | 'user.update'
  | 'user.delete'
  | 'user.update_model'
  | 'user.update_status'
  | 'user.restart'
  | 'user.stop'
  | 'user.start'
  | 'provider.create'
  | 'provider.update'
  | 'provider.delete'
  | 'system.health_check';

/** Audit log target type enum */
export type AuditTargetType = 'user' | 'provider' | 'system';

/** Audit log entity matching Audit Logs Table schema */
export interface AuditLog {
  log_date: string;
  'timestamp#log_id': string;
  actor: string;
  action: AuditAction;
  target_type: AuditTargetType;
  target_id: string;
  detail: Record<string, unknown>;
  ip: string;
  created_at: string;
  expire_at: number;
}

// ------------------------------------------------------------
// Dashboard & System Types
// ------------------------------------------------------------

/** Dashboard aggregated data returned by GET /api/dashboard */
export interface DashboardData {
  total_users: number;
  active_users: number;
  running_containers: number;
  monthly_token_usage: number;
  available_models: number;
}

/** Health status for each subsystem */
export interface HealthStatus {
  dynamodb: 'healthy' | 'unhealthy';
  ecs: 'healthy' | 'unhealthy';
  s3: 'healthy' | 'unhealthy';
}

// ------------------------------------------------------------
// Auth Types
// ------------------------------------------------------------

/** Unified JWT payload for both global (Cognito) and china (Auth Service) modes */
export interface JwtPayload {
  sub: string;
  email: string;
  groups: string[];
}

// ------------------------------------------------------------
// Error Handling
// ------------------------------------------------------------

/** Error code enum covering all error scenarios */
export enum ErrorCode {
  // Authentication / Authorization
  MISSING_TOKEN = 'MISSING_TOKEN',
  INVALID_TOKEN = 'INVALID_TOKEN',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  INSUFFICIENT_PERMISSIONS = 'INSUFFICIENT_PERMISSIONS',

  // User management
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  USER_ALREADY_EXISTS = 'USER_ALREADY_EXISTS',
  USER_SUSPENDED = 'USER_SUSPENDED',

  // Model management
  MODEL_NOT_FOUND = 'MODEL_NOT_FOUND',
  MODEL_DISABLED = 'MODEL_DISABLED',
  MODEL_NOT_ALLOWED = 'MODEL_NOT_ALLOWED',
  PROVIDER_NOT_FOUND = 'PROVIDER_NOT_FOUND',
  PROVIDER_HAS_USERS = 'PROVIDER_HAS_USERS',

  // Quota
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',

  // System
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  UPSTREAM_ERROR = 'UPSTREAM_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
}

/** Custom application error with HTTP status code and error code */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;

    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/** HTTP error response format: { error: { code, message, details } } */
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
