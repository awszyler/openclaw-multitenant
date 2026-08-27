#!/bin/bash
set -e

OPENCLAW_HOME="/home/node/.openclaw"
USER_ID="${OPENCLAW_USER_ID:-default}"
SKILL_GROUP="${SKILL_GROUP:-general}"

echo "[entrypoint] Starting OpenClaw for user=${USER_ID} skill_group=${SKILL_GROUP}"

# 1. Restore user state from S3 (if available)
if [ -n "$SESSION_BUCKET" ]; then
  echo "[entrypoint] Syncing state from s3://${SESSION_BUCKET}/${USER_ID}/state/"
  aws s3 sync "s3://${SESSION_BUCKET}/${USER_ID}/state/" "$OPENCLAW_HOME/" --quiet 2>/dev/null || true
fi

# 2. Copy skill group files
if [ -d /opt/openclaw-skills ]; then
  mkdir -p "$OPENCLAW_HOME/skills"
  cp -r /opt/openclaw-skills/* "$OPENCLAW_HOME/skills/" 2>/dev/null || true
fi

# 3. Generate openclaw.json with proxy-managed credentials
# WeCom and channel config injected via environment variables
WECOM_BOT_ID="${WECOM_BOT_ID:-}"
WECOM_SECRET="${WECOM_SECRET:-}"
GATEWAY_TOKEN="${GATEWAY_TOKEN:-$(openssl rand -hex 24)}"

cat > "$OPENCLAW_HOME/openclaw.json" <<EOF
{
  "models": {
    "mode": "merge",
    "providers": {
      "openai-compatible": {
        "baseUrl": "http://127.0.0.1:9090/llm/v1",
        "apiKey": "proxy-managed"
      }
    }
  },
  "agents": {
    "defaults": {
      "sandbox": { "mode": "off" },
      "compaction": { "mode": "safeguard" },
      "maxConcurrent": 4
    }
  },
  "tools": {
    "exec": {
      "host": "gateway",
      "security": "full",
      "ask": "off"
    }
  },
  "commands": {
    "native": "auto",
    "nativeSkills": "auto",
    "restart": true,
    "ownerDisplay": "raw"
  },
  "channels": {
    "wecom": {
      "enabled": ${WECOM_ENABLED:-true},
      "botId": "${WECOM_BOT_ID}",
      "secret": "${WECOM_SECRET}",
      "dmPolicy": "open",
      "allowFrom": ["*"]
    }
  },
  "gateway": {
    "mode": "local",
    "auth": {
      "mode": "token",
      "token": "${GATEWAY_TOKEN}"
    }
  },
  "plugins": {
    "allow": ["wecom"],
    "entries": {
      "wecom": {
        "enabled": true
      }
    },
    "installs": {
      "wecom": {
        "source": "clawhub",
        "spec": "clawhub:@sunnoy/wecom@3.0.0",
        "installPath": "${OPENCLAW_HOME}/extensions/wecom",
        "version": "3.0.0",
        "clawhubUrl": "https://clawhub.ai",
        "clawhubPackage": "@sunnoy/wecom",
        "clawhubFamily": "code-plugin",
        "clawhubChannel": "community"
      }
    }
  },
  "skills": {
    "load": { "watch": false }
  }
}
EOF

# 4. Start credential proxy in background (if PROXY_RULES available)
if [ -n "$INTERNAL_ALB_URL" ]; then
  echo "[entrypoint] Starting credential proxy on 127.0.0.1:9090"
  node -e "
    const http = require('http');
    const https = require('https');
    const url = require('url');
    const rules = [
      { prefix: '/llm', target: '${INTERNAL_ALB_URL}/llm' },
      { prefix: '/app', target: '${INTERNAL_ALB_URL}/app' },
    ];
    http.createServer((req, res) => {
      const rule = rules.find(r => req.url.startsWith(r.prefix));
      if (!rule) { res.writeHead(403); res.end('Forbidden'); return; }
      const target = rule.target + req.url.slice(rule.prefix.length);
      const parsed = new URL(target);
      const opts = { hostname: parsed.hostname, port: parsed.port || 443, path: parsed.pathname + parsed.search, method: req.method, headers: { ...req.headers, host: parsed.host, 'x-openclaw-user-id': '${USER_ID}' } };
      delete opts.headers['content-length'];
      const proxy = (parsed.protocol === 'https:' ? https : http).request(opts, upstream => { res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res); });
      req.pipe(proxy);
      proxy.on('error', e => { res.writeHead(502); res.end(e.message); });
    }).listen(9090, '127.0.0.1');
    console.log('[proxy] Listening on 127.0.0.1:9090');
  " &
fi

# 5. Background S3 sync (every 60s)
if [ -n "$SESSION_BUCKET" ]; then
  (while true; do
    sleep 60
    aws s3 sync "$OPENCLAW_HOME/" "s3://${SESSION_BUCKET}/${USER_ID}/state/" \
      --exclude "*.sock" --exclude "*.pid" --quiet 2>/dev/null || true
  done) &
fi

# 6. Start OpenClaw Gateway (listen on 0.0.0.0:3000 inside container)
exec node /app/dist/index.js gateway --port 3000 --bind lan
