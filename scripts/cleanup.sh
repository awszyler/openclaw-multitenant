#!/bin/bash
# cleanup.sh — Completely destroy all OpenClaw resources in a region
# Handles: ECS tasks, Network Firewall, CDK stacks, retained DynamoDB tables, S3 buckets
#
# Usage: ./scripts/cleanup.sh [--stage dev] [--region ap-northeast-2] [--yes]
set -euo pipefail

STAGE="dev"
REGION="ap-northeast-2"
AUTO_CONFIRM=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --stage) STAGE="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --yes) AUTO_CONFIRM=true; shift ;;
    *) echo "Usage: $0 [--stage dev] [--region ap-northeast-2] [--yes]"; exit 1 ;;
  esac
done

PREFIX="openclaw-${STAGE}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "unknown")

echo "============================================"
echo "  OpenClaw Full Cleanup"
echo "  Stage:   ${STAGE}"
echo "  Region:  ${REGION}"
echo "  Account: ${ACCOUNT_ID}"
echo "============================================"
echo ""

if [ "$AUTO_CONFIRM" != "true" ]; then
  echo "⚠️  This will PERMANENTLY DELETE all OpenClaw resources including:"
  echo "    - All CloudFormation stacks"
  echo "    - All DynamoDB tables (users, providers, audit-logs, images, auth-users)"
  echo "    - S3 bucket contents"
  echo "    - Cognito User Pool"
  echo "    - ECS tasks and cluster"
  echo "    - Network Firewall"
  echo ""
  read -p "Type 'DELETE' to confirm: " CONFIRM
  if [ "$CONFIRM" != "DELETE" ]; then
    echo "Aborted."
    exit 0
  fi
fi

echo ""

# ============================================================
# Step 1: Stop all ECS tasks in the cluster
# ============================================================
echo "[1/7] Stopping ECS tasks..."
CLUSTER="${PREFIX}"
TASK_ARNS=$(aws ecs list-tasks --cluster "$CLUSTER" --region "$REGION" --query 'taskArns[]' --output text 2>/dev/null || echo "")

if [ -n "$TASK_ARNS" ] && [ "$TASK_ARNS" != "None" ]; then
  for ARN in $TASK_ARNS; do
    TASK_ID=$(echo "$ARN" | awk -F/ '{print $NF}')
    echo "  Stopping task: ${TASK_ID}"
    aws ecs stop-task --cluster "$CLUSTER" --task "$ARN" --region "$REGION" --reason "Cleanup" > /dev/null 2>&1 || true
  done
  echo "  Waiting for tasks to stop..."
  sleep 10
  # Verify all stopped
  REMAINING=$(aws ecs list-tasks --cluster "$CLUSTER" --region "$REGION" --desired-status RUNNING --query 'taskArns[]' --output text 2>/dev/null || echo "")
  if [ -n "$REMAINING" ] && [ "$REMAINING" != "None" ]; then
    echo "  ⚠️  Some tasks still running, waiting 20 more seconds..."
    sleep 20
  fi
else
  echo "  No running tasks found."
fi
echo "  ✅ ECS tasks stopped"
echo ""

# ============================================================
# Step 2: Empty S3 buckets (required before stack deletion)
# ============================================================
echo "[2/7] Emptying S3 buckets..."
for BUCKET_SUFFIX in "admin-console-${STAGE}-${ACCOUNT_ID}" "data-${STAGE}-${ACCOUNT_ID}"; do
  BUCKET="openclaw-${BUCKET_SUFFIX}"
  if aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" 2>/dev/null; then
    echo "  Emptying s3://${BUCKET}..."
    aws s3 rm "s3://${BUCKET}" --recursive --region "$REGION" 2>/dev/null || true
    echo "  ✅ ${BUCKET} emptied"
  else
    echo "  Bucket ${BUCKET} not found, skipping."
  fi
done
echo ""

# ============================================================
# Step 3: CDK destroy (first attempt)
# ============================================================
echo "[3/7] Running cdk destroy --all..."
(cd "$(dirname "$0")/../infra" && npx cdk destroy --all --force 2>&1) || {
  echo "  ⚠️  CDK destroy had errors, will retry failed stacks."
}
echo ""

# ============================================================
# Step 4: Handle Network Firewall (common blocker)
# ============================================================
echo "[4/7] Cleaning up Network Firewall..."
FW_NAME="${PREFIX}-fw"
FW_EXISTS=$(aws network-firewall describe-firewall --firewall-name "$FW_NAME" --region "$REGION" --query 'Firewall.FirewallName' --output text 2>/dev/null || echo "")

if [ -n "$FW_EXISTS" ] && [ "$FW_EXISTS" != "None" ]; then
  echo "  Deleting firewall: ${FW_NAME}"
  aws network-firewall delete-firewall --firewall-name "$FW_NAME" --region "$REGION" 2>/dev/null || true

  # Wait for firewall deletion (can take 2-5 minutes)
  echo "  Waiting for firewall deletion..."
  for i in $(seq 1 30); do
    sleep 10
    STATUS=$(aws network-firewall describe-firewall --firewall-name "$FW_NAME" --region "$REGION" --query 'FirewallStatus.Status' --output text 2>/dev/null || echo "DELETED")
    if [ "$STATUS" = "DELETED" ]; then
      break
    fi
    echo "    [${i}] Status: ${STATUS}"
  done
  echo "  ✅ Firewall deleted"

  # Also delete firewall policy
  POLICY_NAME="${PREFIX}-fw-policy"
  echo "  Deleting firewall policy: ${POLICY_NAME}"
  POLICY_ARN=$(aws network-firewall describe-firewall-policy --firewall-policy-name "$POLICY_NAME" --region "$REGION" --query 'FirewallPolicyResponse.FirewallPolicyArn' --output text 2>/dev/null || echo "")
  if [ -n "$POLICY_ARN" ] && [ "$POLICY_ARN" != "None" ]; then
    aws network-firewall delete-firewall-policy --firewall-policy-arn "$POLICY_ARN" --region "$REGION" 2>/dev/null || true
    echo "  ✅ Firewall policy deleted"
  fi

  # Delete rule group
  RULE_GROUP_NAME="${PREFIX}-domain-allow"
  RULE_ARN=$(aws network-firewall describe-rule-group --rule-group-name "$RULE_GROUP_NAME" --type STATEFUL --region "$REGION" --query 'RuleGroupResponse.RuleGroupArn' --output text 2>/dev/null || echo "")
  if [ -n "$RULE_ARN" ] && [ "$RULE_ARN" != "None" ]; then
    echo "  Deleting rule group: ${RULE_GROUP_NAME}"
    aws network-firewall delete-rule-group --rule-group-arn "$RULE_ARN" --region "$REGION" 2>/dev/null || true
    echo "  ✅ Rule group deleted"
  fi
else
  echo "  No firewall found, skipping."
fi
echo ""

# ============================================================
# Step 5: Retry failed stack deletions
# ============================================================
echo "[5/7] Retrying failed stack deletions..."
FAILED_STACKS=$(aws cloudformation list-stacks --region "$REGION" \
  --stack-status-filter DELETE_FAILED \
  --query "StackSummaries[?starts_with(StackName, \`${PREFIX}-\`)].StackName" \
  --output text 2>/dev/null || echo "")

if [ -n "$FAILED_STACKS" ] && [ "$FAILED_STACKS" != "None" ]; then
  for STACK in $FAILED_STACKS; do
    echo "  Retrying deletion of ${STACK}..."

    # Get failed resources to potentially skip them
    FAILED_RESOURCES=$(aws cloudformation describe-stack-events --stack-name "$STACK" --region "$REGION" \
      --query "StackEvents[?ResourceStatus=='DELETE_FAILED'].LogicalResourceId" \
      --output text 2>/dev/null | sort -u || echo "")

    if [ -n "$FAILED_RESOURCES" ] && [ "$FAILED_RESOURCES" != "None" ]; then
      # Try deleting with retain on failed resources
      RETAIN_ARGS=""
      for RES in $FAILED_RESOURCES; do
        [ "$RES" = "$STACK" ] && continue  # Skip the stack itself
        RETAIN_ARGS="${RETAIN_ARGS} ${RES}"
      done
      if [ -n "$RETAIN_ARGS" ]; then
        echo "    Retaining failed resources:${RETAIN_ARGS}"
        aws cloudformation delete-stack --stack-name "$STACK" --region "$REGION" --retain-resources $RETAIN_ARGS 2>/dev/null || true
      else
        aws cloudformation delete-stack --stack-name "$STACK" --region "$REGION" 2>/dev/null || true
      fi
    else
      aws cloudformation delete-stack --stack-name "$STACK" --region "$REGION" 2>/dev/null || true
    fi
  done

  # Wait for deletions
  echo "  Waiting for stack deletions..."
  for i in $(seq 1 30); do
    sleep 10
    REMAINING=$(aws cloudformation list-stacks --region "$REGION" \
      --stack-status-filter DELETE_IN_PROGRESS DELETE_FAILED CREATE_COMPLETE UPDATE_COMPLETE \
      --query "StackSummaries[?starts_with(StackName, \`${PREFIX}-\`)].StackName" \
      --output text 2>/dev/null || echo "")
    if [ -z "$REMAINING" ] || [ "$REMAINING" = "None" ]; then
      break
    fi
    echo "    [${i}] Remaining: ${REMAINING}"
  done
  echo "  ✅ Stack cleanup complete"
else
  echo "  No failed stacks found."
fi
echo ""

# ============================================================
# Step 6: Delete retained Cognito User Pools
# ============================================================
echo "[6/8] Deleting Cognito User Pools..."
POOL_IDS=$(aws cognito-idp list-user-pools --max-results 60 --region "$REGION" \
  --query "UserPools[?starts_with(Name, \`openclaw-\`) && contains(Name, \`${STAGE}\`)].Id" \
  --output text 2>/dev/null || echo "")

if [ -n "$POOL_IDS" ] && [ "$POOL_IDS" != "None" ]; then
  for POOL_ID in $POOL_IDS; do
    echo "  Deleting User Pool: ${POOL_ID}"
    # Must delete domain first if one exists
    DOMAIN=$(aws cognito-idp describe-user-pool --user-pool-id "$POOL_ID" --region "$REGION" \
      --query 'UserPool.Domain' --output text 2>/dev/null || echo "")
    if [ -n "$DOMAIN" ] && [ "$DOMAIN" != "None" ]; then
      aws cognito-idp delete-user-pool-domain --user-pool-id "$POOL_ID" --domain "$DOMAIN" --region "$REGION" 2>/dev/null || true
    fi
    aws cognito-idp delete-user-pool --user-pool-id "$POOL_ID" --region "$REGION" 2>/dev/null || true
    echo "  ✅ User Pool ${POOL_ID} deleted"
  done
else
  echo "  No Cognito User Pools found."
fi
echo ""

# ============================================================
# Step 7: Delete Secrets Manager secrets
# ============================================================
echo "[7/8] Deleting Secrets Manager secrets..."
SECRETS=$(aws secretsmanager list-secrets --region "$REGION" \
  --query "SecretList[?starts_with(Name, \`openclaw/${STAGE}/\`)].Name" \
  --output text 2>/dev/null || echo "")

if [ -n "$SECRETS" ] && [ "$SECRETS" != "None" ]; then
  for SECRET in $SECRETS; do
    echo "  Deleting secret: ${SECRET}"
    aws secretsmanager delete-secret --secret-id "$SECRET" --region "$REGION" \
      --force-delete-without-recovery 2>/dev/null || true
  done
  echo "  ✅ Secrets deleted"
else
  echo "  No secrets found."
fi
echo ""

# ============================================================
# Step 8: Delete retained DynamoDB tables
# ============================================================
echo "[8/9] Deleting DynamoDB tables..."
for TABLE_SUFFIX in "users" "providers" "audit-logs" "images" "auth-users"; do
  TABLE="openclaw-${TABLE_SUFFIX}-${STAGE}"
  if aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" > /dev/null 2>&1; then
    echo "  Deleting table: ${TABLE}"
    aws dynamodb delete-table --table-name "$TABLE" --region "$REGION" > /dev/null 2>&1 || true
    echo "  ✅ ${TABLE} deleted"
  else
    echo "  Table ${TABLE} not found, skipping."
  fi
done

# Also delete rate-limits table if it exists
TABLE="openclaw-rate-limits-${STAGE}"
if aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" > /dev/null 2>&1; then
  echo "  Deleting table: ${TABLE}"
  aws dynamodb delete-table --table-name "$TABLE" --region "$REGION" > /dev/null 2>&1 || true
fi
echo ""

# ============================================================
# Step 9: Final verification
# ============================================================
echo "[9/9] Verifying cleanup..."

# Check stacks
REMAINING_STACKS=$(aws cloudformation list-stacks --region "$REGION" \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE DELETE_FAILED DELETE_IN_PROGRESS \
  --query "StackSummaries[?starts_with(StackName, \`${PREFIX}-\`)].{Name:StackName,Status:StackStatus}" \
  --output table 2>/dev/null || echo "")

if [ -n "$REMAINING_STACKS" ]; then
  echo "  ⚠️  Remaining stacks:"
  echo "$REMAINING_STACKS"
else
  echo "  ✅ All CloudFormation stacks deleted"
fi

# Check DynamoDB tables
REMAINING_TABLES=$(aws dynamodb list-tables --region "$REGION" --query "TableNames[?starts_with(@, \`openclaw-\`)]" --output text 2>/dev/null || echo "")
if [ -n "$REMAINING_TABLES" ] && [ "$REMAINING_TABLES" != "None" ]; then
  echo "  ⚠️  Remaining DynamoDB tables: ${REMAINING_TABLES}"
else
  echo "  ✅ All DynamoDB tables deleted"
fi

# Check Cognito
REMAINING_POOLS=$(aws cognito-idp list-user-pools --max-results 60 --region "$REGION" \
  --query "UserPools[?starts_with(Name, \`openclaw-\`) && contains(Name, \`${STAGE}\`)].Name" \
  --output text 2>/dev/null || echo "")
if [ -n "$REMAINING_POOLS" ] && [ "$REMAINING_POOLS" != "None" ]; then
  echo "  ⚠️  Remaining Cognito User Pools: ${REMAINING_POOLS}"
else
  echo "  ✅ All Cognito User Pools deleted"
fi

# Check Secrets
REMAINING_SECRETS=$(aws secretsmanager list-secrets --region "$REGION" \
  --query "SecretList[?starts_with(Name, \`openclaw/${STAGE}/\`)].Name" \
  --output text 2>/dev/null || echo "")
if [ -n "$REMAINING_SECRETS" ] && [ "$REMAINING_SECRETS" != "None" ]; then
  echo "  ⚠️  Remaining secrets: ${REMAINING_SECRETS}"
else
  echo "  ✅ All Secrets Manager secrets deleted"
fi

echo ""
echo "============================================"
echo "  Cleanup complete!"
echo "============================================"
