#!/bin/bash
# deploy-china.sh — One-click deployment for OpenClaw in AWS China regions.
#
# Before running this script:
#   1. Launch an ARM64 (Graviton) EC2 instance with Amazon Linux 2023
#   2. Run ./scripts/prepare-env.sh to install all prerequisites
#   3. Re-login to the instance (for docker group to take effect)
#   4. Ensure docker/base/wecom.tar.gz is in place
#
# Usage:
#   ./scripts/deploy-china.sh --region cn-northwest-1 --stage dev
#   ./scripts/deploy-china.sh --region cn-north-1 --stage dev
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-cn-northwest-1}"
STAGE="dev"

while [[ $# -gt 0 ]]; do
  case $1 in
    --region) REGION="$2"; shift 2 ;;
    --stage) STAGE="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ "$REGION" != cn-* ]]; then
  echo "❌ This script is for China regions only (cn-north-1, cn-northwest-1). Got: $REGION"
  exit 1
fi

export AWS_DEFAULT_REGION="$REGION"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export CDK_DEFAULT_ACCOUNT="$ACCOUNT_ID"
export CDK_DEFAULT_REGION="$REGION"
ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com.cn"
SCRIPT_DIR="$(dirname "$0")"
PROJECT_ROOT="$(realpath "$SCRIPT_DIR/..")"

echo "============================================"
echo "  OpenClaw China Deployment"
echo "  Region:  $REGION"
echo "  Stage:   $STAGE"
echo "  Account: $ACCOUNT_ID"
echo "============================================"

# ── Step 1: Verify prerequisites ──────────────────────────────────────

echo ""
echo "[1/8] Verifying prerequisites..."

command -v node >/dev/null || { echo "❌ node not found"; exit 1; }
command -v docker >/dev/null || { echo "❌ docker not found"; exit 1; }
command -v aws >/dev/null || { echo "❌ aws not found"; exit 1; }

if [ ! -f "$PROJECT_ROOT/docker/base/wecom.tar.gz" ]; then
  echo "❌ docker/base/wecom.tar.gz not found. Place it before running this script."
  exit 1
fi

if [ ! -f "$PROJECT_ROOT/docker/base/openclaw-image.tar.gz" ]; then
  echo "❌ docker/base/openclaw-image.tar.gz not found."
  echo "   Export it from a machine with ghcr.io access:"
  echo "   docker pull --platform linux/arm64 ghcr.io/openclaw/openclaw:2026.4.15"
  echo "   docker save ghcr.io/openclaw/openclaw:2026.4.15 | gzip > docker/base/openclaw-image.tar.gz"
  exit 1
fi

# Verify Docker is running
docker info >/dev/null 2>&1 || {
  echo "❌ Docker is not running or current user has no access."
  echo "   Run: sudo systemctl start docker && sudo usermod -aG docker \$USER"
  exit 1
}

echo "  ✅ All prerequisites met"

# ── Step 2: Build application code ───────────────────────────────────

echo ""
echo "[2/8] Building application code..."

(cd "$PROJECT_ROOT/infra" && npm install --silent)
(cd "$PROJECT_ROOT/admin-api" && npm install --silent && npm run build)
(cd "$PROJECT_ROOT/web-console" && npm install --silent && npm run build)
(cd "$PROJECT_ROOT/auth-service" && npm install --silent && npm run build)

echo "  ✅ All apps built"

# ── Step 3: Build and push Docker images ─────────────────────────────

echo ""
echo "[3/8] Building and pushing Docker images..."

# ECR Login
aws ecr get-login-password --region "$REGION" | \
  docker login --username AWS --password-stdin "$ECR_REGISTRY" 2>/dev/null

# Pre-pull base images (ensures Docker mirror is used; BuildKit skips mirrors)
echo "  Pulling base images via mirror..."
docker pull node:20-slim
docker pull amazonlinux:2023

# Auth Service image
echo "  Building openclaw-auth..."
aws ecr create-repository --repository-name openclaw-auth --region "$REGION" \
  --image-scanning-configuration scanOnPush=true >/dev/null 2>&1 || true
docker build -t "${ECR_REGISTRY}/openclaw-auth:latest" "$PROJECT_ROOT/auth-service/"
echo "  Pushing openclaw-auth..."
docker push "${ECR_REGISTRY}/openclaw-auth:latest"
echo "  ✅ openclaw-auth pushed"

# Sidecar image
echo "  Building openclaw-sidecar..."
aws ecr create-repository --repository-name openclaw-sidecar --region "$REGION" \
  --image-scanning-configuration scanOnPush=true >/dev/null 2>&1 || true

SIDECAR_EXISTS=$(aws ecr describe-images --repository-name openclaw-sidecar \
  --image-ids imageTag=latest --region "$REGION" 2>/dev/null && echo "yes" || echo "no")

if [ "$SIDECAR_EXISTS" = "no" ]; then
  cat > /tmp/Dockerfile.sidecar << 'EOF'
FROM amazonlinux:2023
RUN dnf install -y awscli-2 python3 curl --allowerasing && dnf clean all
ENTRYPOINT ["sh", "-c"]
EOF
  docker build -t "${ECR_REGISTRY}/openclaw-sidecar:latest" -f /tmp/Dockerfile.sidecar /tmp
  echo "  Pushing openclaw-sidecar..."
  docker push "${ECR_REGISTRY}/openclaw-sidecar:latest"
  rm -f /tmp/Dockerfile.sidecar
  echo "  ✅ openclaw-sidecar pushed"
else
  echo "  ⏭  openclaw-sidecar already exists"
fi

# Base + App images (local build — China cannot pull from ghcr.io/Docker Hub)
echo "  Building openclaw-base..."
aws ecr create-repository --repository-name openclaw-base --region "$REGION" \
  --image-scanning-configuration scanOnPush=true >/dev/null 2>&1 || true
aws ecr create-repository --repository-name openclaw-general --region "$REGION" \
  --image-scanning-configuration scanOnPush=true >/dev/null 2>&1 || true

# Load pre-exported openclaw base image (from ghcr.io, exported via docker save)
if [ -f "$PROJECT_ROOT/docker/base/openclaw-image.tar.gz" ]; then
  docker load < "$PROJECT_ROOT/docker/base/openclaw-image.tar.gz"
  # Tag so Dockerfile FROM can find it
  docker tag ghcr.io/openclaw/openclaw:2026.4.15 openclaw/openclaw:2026.4.15 2>/dev/null || true
  echo "  ✅ openclaw base image loaded from tar.gz"
else
  echo "  ⚠️  openclaw-image.tar.gz not found, attempting docker pull..."
  docker pull openclaw/openclaw:2026.4.15 || {
    echo "  ❌ Cannot pull openclaw/openclaw:2026.4.15"
    echo "     Place docker/base/openclaw-image.tar.gz (exported via: docker save ghcr.io/openclaw/openclaw:2026.4.15 | gzip > openclaw-image.tar.gz)"
    exit 1
  }
fi

docker build -t "${ECR_REGISTRY}/openclaw-base:latest" "$PROJECT_ROOT/docker/base/"
echo "  Pushing openclaw-base..."
docker push "${ECR_REGISTRY}/openclaw-base:latest"
echo "  ✅ openclaw-base pushed"

# App image (FROM openclaw-base)
echo "  Building openclaw-general..."
docker build -t "${ECR_REGISTRY}/openclaw-general:latest" \
  --build-arg BASE_IMAGE="${ECR_REGISTRY}/openclaw-base:latest" \
  --build-arg SKILL_GROUP=general \
  "$PROJECT_ROOT/docker/"
echo "  Pushing openclaw-general..."
docker push "${ECR_REGISTRY}/openclaw-general:latest"
echo "  ✅ openclaw-general pushed"

echo "  ✅ All images ready"

# ── Step 4: CDK Bootstrap ────────────────────────────────────────────

echo ""
echo "[4/8] CDK Bootstrap..."

(cd "$PROJECT_ROOT/infra" && npx cdk bootstrap "aws://${ACCOUNT_ID}/${REGION}" 2>&1 | tail -3)

echo "  ✅ Bootstrap complete"

# ── Step 5: Deploy infrastructure ────────────────────────────────────

echo ""
echo "[5/8] Deploying infrastructure (8 stacks)..."

(cd "$PROJECT_ROOT/infra" && npx cdk deploy --all --require-approval never \
  -c region="$REGION" -c stage="$STAGE" 2>&1 | grep -E '(✅|❌)' || true)

# Verify all stacks deployed
STACK_COUNT=$(aws cloudformation list-stacks --region "$REGION" \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query "length(StackSummaries[?starts_with(StackName,\`openclaw-${STAGE}\`)])" --output text)

if [ "$STACK_COUNT" -lt 8 ]; then
  echo "  ⚠️  Only $STACK_COUNT/8 stacks deployed. Check CloudFormation console for errors."
  aws cloudformation list-stacks --region "$REGION" \
    --stack-status-filter CREATE_FAILED ROLLBACK_COMPLETE \
    --query "StackSummaries[?starts_with(StackName,\`openclaw-${STAGE}\`)].StackName" --output text
  exit 1
fi

echo "  ✅ All 8 stacks deployed"

# ── Step 6: Initialize Auth Service keys ─────────────────────────────

echo ""
echo "[6/8] Initializing Auth Service RS256 keys..."

openssl genrsa -out /tmp/auth-private.pem 2048 2>/dev/null
openssl rsa -in /tmp/auth-private.pem -pubout -out /tmp/auth-public.pem 2>/dev/null

python3 -c "
import json
with open('/tmp/auth-private.pem') as f: priv = f.read()
with open('/tmp/auth-public.pem') as f: pub = f.read()
with open('/tmp/auth-secret.json', 'w') as f:
    json.dump({'privateKey': priv, 'publicKey': pub}, f)
"

aws secretsmanager put-secret-value \
  --secret-id "openclaw/${STAGE}/admin/auth-keys" \
  --secret-string file:///tmp/auth-secret.json \
  --region "$REGION" >/dev/null

rm -f /tmp/auth-private.pem /tmp/auth-public.pem /tmp/auth-secret.json

# Restart Auth Service to pick up keys
aws ecs update-service --cluster "openclaw-${STAGE}" --service "openclaw-auth-${STAGE}" \
  --force-new-deployment --region "$REGION" >/dev/null

echo "  ✅ Auth keys initialized, service restarting"

# ── Step 7: Create initial admin user ────────────────────────────────

echo ""
echo "[7/8] Creating initial admin user..."

# Generate a random initial password at deploy time.
# Do NOT hardcode a default here: this repository is public, so a fixed value
# would mean every deployment ships with the same publicly-known admin password.
# Override with ADMIN_PASSWORD=... if you need a specific value (e.g. in CI).
ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(LC_ALL=C tr -dc 'A-HJ-NP-Za-km-z2-9' </dev/urandom | head -c 20)}"

if [ ${#ADMIN_PASSWORD} -lt 12 ]; then
  echo "❌ Failed to generate an initial admin password" >&2
  exit 1
fi

# Pass the password via the environment, not string-interpolated into the
# node -e source: interpolation would break on quotes and leak the value into
# the process list.
(cd "$PROJECT_ROOT/auth-service" && ADMIN_PASSWORD="$ADMIN_PASSWORD" node -e "
const bcrypt = require('bcrypt');
const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
const item = JSON.stringify({
  user_id: {S: 'admin'},
  email: {S: 'admin@openclaw.local'},
  password_hash: {S: hash},
  groups: {L: [{S: 'openclaw-admins'}]},
  force_change_pwd: {BOOL: true},
  created_at: {S: new Date().toISOString()},
  updated_at: {S: new Date().toISOString()}
});
require('fs').writeFileSync('/tmp/admin-item.json', item);
")

aws dynamodb put-item --table-name "openclaw-auth-users-${STAGE}" \
  --item file:///tmp/admin-item.json --region "$REGION"
rm -f /tmp/admin-item.json

echo "  ✅ Admin user created"
echo "     username: admin"
echo "     password: ${ADMIN_PASSWORD}"
echo "     ⚠️  This is shown ONCE and is not stored anywhere. Copy it now."
echo "     ⚠️  First login will require a password change."

# ── Step 8: Wait for services and output summary ─────────────────────

echo ""
echo "[8/8] Waiting for Auth Service to stabilize..."

for i in $(seq 1 20); do
  RUNNING=$(aws ecs describe-services --cluster "openclaw-${STAGE}" \
    --services "openclaw-auth-${STAGE}" --region "$REGION" \
    --query 'services[0].runningCount' --output text 2>/dev/null)
  if [ "$RUNNING" = "2" ]; then
    echo "  ✅ Auth Service healthy (2/2 tasks running)"
    break
  fi
  sleep 15
done

# ── Summary ──────────────────────────────────────────────────────────

echo ""
echo "============================================"
echo "  ✅ Deployment Complete!"
echo "============================================"
echo ""

CF_DOMAIN=$(aws cloudformation describe-stacks --stack-name "openclaw-${STAGE}-cdn" \
  --region "$REGION" --query 'Stacks[0].Outputs[?OutputKey==`DistributionDomain`].OutputValue' --output text)
ADMIN_API=$(aws cloudformation describe-stacks --stack-name "openclaw-${STAGE}-admin" \
  --region "$REGION" --query 'Stacks[0].Outputs[?OutputKey==`AdminApiEndpoint`].OutputValue' --output text)
CONSOLE_URL=$(aws cloudformation describe-stacks --stack-name "openclaw-${STAGE}-cdn" \
  --region "$REGION" --query 'Stacks[0].Outputs[?OutputKey==`ConsoleUrl`].OutputValue' --output text)

echo "  Console:    ${CONSOLE_URL}"
echo "  Admin API:  ${ADMIN_API}"
echo "  CloudFront: ${CF_DOMAIN}"
echo "  Webhook:    https://${CF_DOMAIN}/webhook/{channel}"
echo ""
echo "  Login:      admin / ${ADMIN_PASSWORD} (change on first login)"
echo ""
echo "  Next steps:"
echo "    1. Login to Console and change admin password"
echo "    2. Add LiteLLM model provider"
echo "    3. Create users"
echo "    4. (Optional) Configure ICP domain + IAM certificate"
echo "============================================"
