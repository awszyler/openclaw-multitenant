#!/bin/bash
# prepare-env.sh — Prepare an ARM64 Amazon Linux 2023 EC2 instance for OpenClaw China deployment.
#
# Run this script ONCE on a fresh EC2 instance before executing deploy-china.sh.
#
# Instance requirements:
#   - Type: m6g.xlarge or larger (ARM64 Graviton)
#   - AMI: Amazon Linux 2023 (ARM64)
#   - Disk: >= 50GB
#   - IAM Role: Admin access to the target China region
#   - Network: Public IP or NAT Gateway for internet access
#
# Usage:
#   ssh ec2-user@<instance-ip>
#   ./scripts/prepare-env.sh
set -euo pipefail

echo "============================================"
echo "  OpenClaw Environment Preparation"
echo "  Target: ARM64 Amazon Linux 2023"
echo "============================================"
echo ""

# ── Verify architecture ──────────────────────────────────────────────

ARCH=$(uname -m)
if [ "$ARCH" != "aarch64" ]; then
  echo "❌ This script requires ARM64 (aarch64). Current architecture: $ARCH"
  echo "   Please use an ARM64 Graviton instance (e.g. m6g.xlarge)."
  exit 1
fi

echo "[1/5] Installing system packages..."
sudo dnf install -y git docker jq zip unzip openssl

echo "[2/5] Configuring Docker..."
sudo systemctl start docker
sudo systemctl enable docker
sudo usermod -aG docker "$USER"

echo "[3/5] Configuring Docker mirror (China region acceleration)..."
sudo mkdir -p /etc/docker
echo '{"registry-mirrors": ["https://docker.1panel.live"]}' | sudo tee /etc/docker/daemon.json > /dev/null
sudo systemctl restart docker

echo "[4/5] Installing Node.js 20..."
# Use pre-downloaded binary if available (avoids slow NodeSource download in China)
if [ -f "$HOME/openclaw/tools/node-v20.20.2-linux-arm64.tar.xz" ]; then
  sudo tar -xJf "$HOME/openclaw/tools/node-v20.20.2-linux-arm64.tar.xz" -C /usr/local --strip-components=1
  echo "  Installed from local binary"
else
  # Fallback: try NodeSource (slow in China)
  curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
  sudo dnf install -y nodejs
fi

echo "[5/5] Verifying installation..."
echo ""
echo "  node:   $(node --version)"
echo "  npm:    $(npm --version)"
echo "  docker: $(docker --version)"
echo "  git:    $(git --version)"
echo "  aws:    $(aws --version)"
echo "  arch:   $(uname -m)"
echo ""

# ── Verify AWS credentials ───────────────────────────────────────────

if aws sts get-caller-identity > /dev/null 2>&1; then
  ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
  echo "  AWS Account: $ACCOUNT ✅"
else
  echo "  ⚠️  AWS credentials not configured. Ensure the instance has an IAM role attached."
fi

echo ""
echo "============================================"
echo "  ✅ Environment ready!"
echo ""
echo "  Next steps:"
echo "    1. Log out and log back in (for docker group to take effect)"
echo "       Or use: sg docker -c 'command' for immediate docker access"
echo ""
echo "    2. Upload project code from your local machine:"
echo "       local\$ tar czf openclaw.tar.gz --exclude='node_modules' \\"
echo "              --exclude='.git' --exclude='dist' --exclude='cdk.out' ."
echo "       local\$ scp openclaw.tar.gz ec2-user@<this-ip>:~/"
echo ""
echo "    3. Extract and deploy:"
echo "       mkdir -p ~/openclaw && tar xzf ~/openclaw.tar.gz -C ~/openclaw"
echo "       cd ~/openclaw"
echo "       ./scripts/deploy-china.sh --region cn-northwest-1 --stage dev"
echo "============================================"
