// ============================================================
// openclaw.json Config Builder
//
// Builds the per-user openclaw.json config based on the user's
// assigned provider. Two provider types are supported:
//
//   - litellm: Traffic routed through local proxy → Internal ALB
//              → LiteLLM Proxy Lambda. Provider config points to
//              127.0.0.1:9090/llm/v1, Lambda resolves base_url and
//              api_key on each request.
//
//   - bedrock: Direct connection from the Task to AWS Bedrock
//              via VPC Endpoint, using the Task Role (aws-sdk auth
//              chain). No local proxy, no Lambda, no api_key.
// ============================================================

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { scan, PROVIDERS_TABLE } from '../lib/dynamo.js';
import type { Provider, User, ChannelConfig } from '../lib/types.js';

const secretsClient = new SecretsManagerClient({});
const STAGE = process.env.STAGE ?? 'dev';

/**
 * Look up the provider row whose litellm_model_name matches the given model.
 * Returns undefined if no match (caller decides how to degrade).
 */
export async function findProviderByModel(model: string): Promise<Provider | undefined> {
  const result = await scan<Provider>(PROVIDERS_TABLE(), {
    filterExpression: 'litellm_model_name = :m',
    expressionAttributeValues: { ':m': model },
  });
  return result.items[0];
}

/**
 * Inputs needed to render an openclaw.json document. Kept explicit so this
 * module stays pure-ish and easy to test.
 */
export interface OpenclawConfigInput {
  userId: string;
  model: string;
  provider?: Provider;
  channelType?: User['channel_type'];
  wecomBotId?: string;
  teamsAppId?: string;
}

/**
 * Build the models.providers block for an openclaw.json config.
 * Returns { providers, defaultModel } — caller wires them into the full doc.
 */
export function buildModelsBlock(
  model: string,
  provider: Provider | undefined,
): { providers: Record<string, unknown>; defaultModel: string } {
  if (provider?.provider_type === 'bedrock') {
    // Bedrock models are declared statically. Strip any "bedrock/" prefix we may
    // have stored for LiteLLM-style routing — OpenClaw's native SDK wants the
    // raw Bedrock model ID (e.g. "us.anthropic.claude-opus-4-6-v1:0").
    const rawModelId = provider.litellm_model_id.replace(/^bedrock\//, '');
    const region = provider.aws_region ?? 'us-east-1';

    // Determine if this specific model supports extended thinking.
    // Only Anthropic Claude 3.7+ models support it on Bedrock.
    // OpenClaw PR #22513 defaults reasoning=on when model metadata has
    // reasoning:true, which overrides thinkingDefault. We must explicitly
    // set reasoning:false on the model definition for non-Claude models.
    const thinkingCapable = /\bclaude\b/i.test(rawModelId);

    return {
      providers: {
        'amazon-bedrock': {
          baseUrl: `https://bedrock-runtime.${region}.amazonaws.com`,
          api: 'bedrock-converse-stream',
          auth: 'aws-sdk',
          models: [
            {
              id: rawModelId,
              name: provider.litellm_model_name,
              ...(!thinkingCapable && { reasoning: false }),
            },
          ],
        },
      },
      defaultModel: `amazon-bedrock/${rawModelId}`,
    };
  }

  // LiteLLM path (default / fallback): the local credential proxy owns
  // base_url + api_key resolution, so the container only needs a stable
  // loopback endpoint.
  //
  // `api: "openai-chat-completions"` is critical: without it, OpenClaw
  // treats unknown provider ids (like our made-up "openai-compatible") as
  // Anthropic-messages and POSTs to /v1/messages — LiteLLM then tries to
  // translate that into an OpenAI completion request for the target model,
  // mangles the body, and the upstream (e.g. brconnector) returns 400.
  // Forcing the transport to traditional /v1/chat/completions keeps the
  // request shape LiteLLM and every OpenAI-compatible backend expects.
  return {
    providers: {
      'openai-compatible': {
        baseUrl: 'http://127.0.0.1:9090/llm/v1',
        api: 'openai-completions',
        apiKey: 'proxy-managed',
        models: [{ id: model, name: model }],
      },
    },
    defaultModel: `openai-compatible/${model}`,
  };
}

/**
 * Load channel credentials from Secrets Manager for an existing user.
 * Returns a minimal shape used by the channels/plugins blocks.
 */
async function loadChannelSecrets(userId: string, channelType: User['channel_type']): Promise<{
  wecomSecret?: string;
  teamsPassword?: string;
  teamsTenantId?: string;
}> {
  if (channelType === 'wecom') {
    try {
      const resp = await secretsClient.send(
        new GetSecretValueCommand({ SecretId: `openclaw/${STAGE}/${userId}/wecom` }),
      );
      const parsed = JSON.parse(resp.SecretString ?? '{}');
      return { wecomSecret: parsed.secret ?? 'proxy-managed' };
    } catch {
      return { wecomSecret: 'proxy-managed' };
    }
  }

  if (channelType === 'teams') {
    try {
      const resp = await secretsClient.send(
        new GetSecretValueCommand({ SecretId: `openclaw/${STAGE}/${userId}/teams` }),
      );
      const parsed = JSON.parse(resp.SecretString ?? '{}');
      return {
        teamsPassword: parsed.appPassword ?? 'proxy-managed',
        teamsTenantId: parsed.tenantId ?? '',
      };
    } catch {
      return { teamsPassword: 'proxy-managed', teamsTenantId: '' };
    }
  }

  return {};
}

/**
 * Emit the channels / plugins / tools / commands blocks for a given channel.
 * Kept in one place so the create and restart paths stay in sync.
 */
function buildChannelBlocks(params: {
  channelType?: User['channel_type'];
  wecomBotId?: string;
  wecomSecret?: string;
  teamsAppId?: string;
  teamsPassword?: string;
  teamsTenantId?: string;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  if (params.channelType === 'wecom' && params.wecomBotId) {
    out['plugins'] = {
      allow: ['wecom'],
      entries: { wecom: { enabled: true } },
      installs: {
        wecom: {
          source: 'clawhub',
          spec: 'clawhub:@sunnoy/wecom@3.0.0',
          installPath: '/home/node/.openclaw/extensions/wecom',
          version: '3.0.0',
          clawhubUrl: 'https://clawhub.ai',
          clawhubPackage: '@sunnoy/wecom',
          clawhubFamily: 'code-plugin',
          clawhubChannel: 'community',
        },
      },
    };
    out['channels'] = {
      wecom: {
        enabled: true,
        botId: params.wecomBotId,
        secret: params.wecomSecret ?? 'proxy-managed',
        dmPolicy: 'open',
        allowFrom: ['*'],
      },
    };
    out['tools'] = { exec: { host: 'gateway', security: 'full', ask: 'off' } };
    out['commands'] = { native: 'auto', nativeSkills: 'auto', restart: false, ownerDisplay: 'raw' };
  } else if (params.channelType === 'teams' && params.teamsAppId) {
    out['plugins'] = { entries: { msteams: { enabled: true } } };
    out['channels'] = {
      msteams: {
        enabled: true,
        appId: params.teamsAppId,
        appPassword: params.teamsPassword ?? 'proxy-managed',
        tenantId: params.teamsTenantId ?? '',
      },
    };
  }

  return out;
}

/**
 * Build the full openclaw.json document for a user. Used by both the create
 * flow (channel secrets come from the request body) and the restart flow
 * (secrets come from Secrets Manager).
 */
export function buildOpenclawConfig(
  input: OpenclawConfigInput,
  channelSecrets: {
    wecomSecret?: string;
    teamsPassword?: string;
    teamsTenantId?: string;
  },
): Record<string, unknown> {
  const { providers, defaultModel } = buildModelsBlock(input.model, input.provider);

  // Only Anthropic Claude (3.7+) and DeepSeek-R1 support extended thinking
  // on Bedrock. All other models (Nova, Llama, Mistral, Titan, Cohere, etc.)
  // will reject requests containing reasoning content blocks.
  //
  // OpenClaw defaults thinking to "low" for models it considers
  // reasoning-capable, so we must explicitly disable it for everything else.
  //
  // DeepSeek-R1 always has reasoning on (can't be toggled), so no config needed.
  const thinkingCapablePattern = /\bclaude\b/i;
  const supportsThinking =
    thinkingCapablePattern.test(input.model) ||
    (input.provider?.litellm_model_id && thinkingCapablePattern.test(input.provider.litellm_model_id));

  const agentDefaults: Record<string, unknown> = {
    model: defaultModel,
    sandbox: { mode: 'off' },
  };
  if (!supportsThinking) {
    agentDefaults['thinkingDefault'] = 'off';
  }

  const config: Record<string, unknown> = {
    models: { providers },
    agents: {
      defaults: agentDefaults,
    },
    skills: { load: { watch: true } },
    gateway: {
      mode: 'local',
      controlUi: { dangerouslyAllowHostHeaderOriginFallback: true },
    },
  };

  Object.assign(
    config,
    buildChannelBlocks({
      channelType: input.channelType,
      wecomBotId: input.wecomBotId,
      teamsAppId: input.teamsAppId,
      ...channelSecrets,
    }),
  );

  return config;
}

/**
 * Create-path convenience: build config using secrets supplied in the request
 * (no Secrets Manager lookup).
 */
export async function buildConfigForCreate(
  userId: string,
  model: string,
  channel: ChannelConfig | undefined,
): Promise<{
  openclawConfigB64: string;
  bedrockRegion?: string;
}> {
  const provider = await findProviderByModel(model);

  const config = buildOpenclawConfig(
    {
      userId,
      model,
      provider,
      channelType: channel?.channel_type,
      wecomBotId: channel?.channel_type === 'wecom' ? channel.wecom_bot_id : undefined,
      teamsAppId: channel?.channel_type === 'teams' ? channel.teams_app_id : undefined,
    },
    {
      wecomSecret: channel?.channel_type === 'wecom' ? channel.wecom_secret : undefined,
      teamsPassword: channel?.channel_type === 'teams' ? channel.teams_app_password : undefined,
      teamsTenantId: channel?.channel_type === 'teams' ? channel.teams_tenant_id : undefined,
    },
  );

  return {
    openclawConfigB64: Buffer.from(JSON.stringify(config)).toString('base64'),
    bedrockRegion: provider?.provider_type === 'bedrock' ? provider.aws_region : undefined,
  };
}

/**
 * Restart/start-path convenience: build config for an existing user record,
 * pulling channel secrets from Secrets Manager. Returns both the encoded
 * openclaw.json and the resolved bedrock region (undefined for litellm users),
 * so callers can inject AWS_REGION into the task overrides.
 */
export async function buildConfigForUser(user: User): Promise<{
  openclawConfigB64: string;
  bedrockRegion?: string;
}> {
  const provider = await findProviderByModel(user.model);
  const channelSecrets = await loadChannelSecrets(user.user_id, user.channel_type);

  const config = buildOpenclawConfig(
    {
      userId: user.user_id,
      model: user.model,
      provider,
      channelType: user.channel_type,
      wecomBotId: user.wecom_bot_id,
      teamsAppId: user.teams_app_id,
    },
    channelSecrets,
  );

  return {
    openclawConfigB64: Buffer.from(JSON.stringify(config)).toString('base64'),
    bedrockRegion: provider?.provider_type === 'bedrock' ? provider.aws_region : undefined,
  };
}
