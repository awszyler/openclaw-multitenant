"""
LiteLLM Proxy Lambda
====================

Minimal forwarder in front of OpenClaw containers. Its only job is to shield
OpenClaw from the real upstream api_key and base_url by resolving them at
request time from DynamoDB + Secrets Manager.

This path is used for `provider_type == 'litellm'` users only.
`provider_type == 'bedrock'` users connect to Bedrock directly from the Task
via the bedrock-runtime VPC Endpoint (IAM auth), bypassing this Lambda.

Responsibilities (kept):
  - Resolve user → provider → base_url + api_key
  - Inject Authorization: Bearer <api_key>
  - Rewrite body.model to the provider's target model name
  - Forward to upstream, return the response as-is

Explicitly NOT done here (by design):
  - Quota enforcement
  - Protocol conversion (Anthropic ↔ OpenAI)
  - Response manipulation
"""

import json
import os
import time
import urllib.request
import urllib.error
import traceback

import boto3

LITELLM_URL = os.environ.get('LITELLM_URL', '')
ALLOWED_PATHS = os.environ.get('ALLOWED_PATHS', '/v1/chat/completions').split(',')
USERS_TABLE = os.environ['USERS_TABLE']
PROVIDERS_TABLE = os.environ['PROVIDERS_TABLE']

dynamodb = boto3.resource('dynamodb')
users_table = dynamodb.Table(USERS_TABLE)
providers_table = dynamodb.Table(PROVIDERS_TABLE)
secrets_client = boto3.client('secretsmanager')

_user_cache = {}
USER_CACHE_TTL = 60

_secrets_cache = {}
SECRETS_CACHE_TTL = 300


def resolve_api_key(api_key_ref):
    """Dereference a Secrets Manager ARN/path. Plaintext passes through."""
    if not api_key_ref:
        return None
    if not (api_key_ref.startswith('arn:') or api_key_ref.startswith('openclaw/')):
        return api_key_ref

    now = time.time()
    cached = _secrets_cache.get(api_key_ref)
    if cached and cached['expires'] > now:
        return cached['value']

    try:
        resp = secrets_client.get_secret_value(SecretId=api_key_ref)
        value = resp['SecretString']
        _secrets_cache[api_key_ref] = {'value': value, 'expires': now + SECRETS_CACHE_TTL}
        return value
    except Exception as e:
        print(f'[WARN] Failed to resolve secret {api_key_ref}: {e}')
        return None


def get_user_config(user_id):
    """Return {model, base_url, api_key, status} for a user, or None if missing."""
    cache_key = f'user:{user_id}'
    now = time.time()
    cached = _user_cache.get(cache_key)
    if cached and cached['expires'] > now:
        return cached['data']

    user = users_table.get_item(Key={'user_id': user_id}).get('Item')
    if not user:
        return None

    provider = None
    user_model = user.get('model')
    if user_model:
        resp = providers_table.query(
            IndexName='litellm_model_name-index',
            KeyConditionExpression='litellm_model_name = :m',
            ExpressionAttributeValues={':m': user_model},
        )
        items = resp.get('Items', [])
        provider = items[0] if items else None

    # Fallback: any active default provider
    if not provider:
        resp = providers_table.scan(
            FilterExpression='is_default = :d AND #s = :a',
            ExpressionAttributeNames={'#s': 'status'},
            ExpressionAttributeValues={':d': True, ':a': 'active'},
        )
        items = resp.get('Items', [])
        provider = items[0] if items else None

    config = {
        'status': user.get('status', 'active'),
        'model': provider.get('litellm_model_id') or provider['litellm_model_name'] if provider else user_model,
        'base_url': provider.get('base_url') if provider else None,
        'api_key': resolve_api_key(provider.get('api_key')) if provider else None,
    }

    _user_cache[cache_key] = {'data': config, 'expires': now + USER_CACHE_TTL}
    return config


def json_response(status, payload):
    return {
        'statusCode': status,
        'body': json.dumps(payload),
        'headers': {'Content-Type': 'application/json'},
    }


def handler(event, _context):
    headers = event.get('headers', {})
    user_id = headers.get('x-openclaw-user-id', '')
    if not user_id:
        return json_response(401, {'error': 'Missing x-openclaw-user-id header'})

    path = event.get('path', '').replace('/llm', '', 1)
    if path not in ALLOWED_PATHS:
        return json_response(403, {'error': f'Path not allowed: {path}'})

    try:
        config = get_user_config(user_id)
    except Exception as e:
        print(f'[ERROR] get_user_config failed: {e}')
        return json_response(502, {'error': f'User lookup failed: {e}'})

    if not config:
        return json_response(502, {'error': 'User not found'})

    if config['status'] == 'suspended':
        return json_response(403, {'error': 'User suspended'})

    body = json.loads(event.get('body', '{}'))
    if config.get('model'):
        body['model'] = config['model']

    # Sanitize: some OpenAI-compatible proxies (e.g. brconnector) reject
    # assistant messages with content=null even though the OpenAI spec
    # allows it when tool_calls is present. Normalize to empty string.
    for msg in body.get('messages') or []:
        if msg.get('content') is None:
            msg['content'] = ''

    # Strip OpenAI-only keys that Bedrock / LiteLLM-to-Bedrock rejects.
    # openclaw sends these as part of the OpenAI-compatible request format,
    # but Bedrock's Converse API doesn't recognize them.
    for key in ('store', 'metadata', 'reasoning', 'service_tier'):
        body.pop(key, None)

    target_base = config.get('base_url') or LITELLM_URL
    if not target_base:
        return json_response(502, {'error': 'No upstream base_url configured'})

    target_url = f'{target_base}{path}'
    forward_headers = {'Content-Type': 'application/json', 'X-User-Id': user_id}
    if config.get('api_key'):
        forward_headers['Authorization'] = f'Bearer {config["api_key"]}'

    print(f'[DEBUG] user={user_id} model={body.get("model")} target={target_url} has_key={bool(config.get("api_key"))}')
    req = urllib.request.Request(
        target_url,
        data=json.dumps(body).encode(),
        headers=forward_headers,
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=110) as resp:
            return {'statusCode': resp.status, 'body': resp.read().decode()}
    except urllib.error.HTTPError as e:
        error_body = e.read().decode() if e.fp else ''
        print(f'[ERROR] HTTPError {e.code}: {error_body[:500]}')
        return json_response(502, {'error': f'Upstream {e.code}: {error_body[:200]}'})
    except Exception as e:
        print(f'[ERROR] {traceback.format_exc()}')
        return json_response(502, {'error': f'Upstream request failed: {e}'})
