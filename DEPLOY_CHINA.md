# OpenClaw 中国区部署操作手册

> 区域: cn-north-1 (北京)

---

## 部署步骤

### 第 1 步：启动构建机

在 AWS 中国区控制台创建 EC2 实例：

| 配置项 | 推荐值 |
|--------|-----|
| 实例类型 | `m6g.xlarge`（ARM64 Graviton2） |
| AMI | Amazon Linux 2023 (ARM64) |
| 磁盘 | 50GB gp3 |
| IAM Role | 见下方「构建机权限」——**不要用 `AdministratorAccess`** |
| 安全组 | **不开任何入站端口**，通过 SSM Session Manager 登录 |
| 网络 | **私有子网 + NAT 网关**，不分配公网 IP |

#### 构建机权限

构建机需要 CDK bootstrap、ECR 推送、CloudFormation 部署等权限，范围确实较宽，但**不等于需要 `AdministratorAccess`**。建议：

- 附加 `AmazonSSMManagedInstanceCore`（SSM 登录必需）
- 部署权限用一个**独立的、仅限本项目资源前缀**的自定义策略，或使用 CDK 的 `--role-arn` 指定专门的部署角色
- 部署完成后**立即分离部署策略或终止构建机** —— 它是一次性的

> ⚠️ 如果你只是想快速验证方案，用宽权限 + 公网 SSH 当然更省事。但请**不要把这种配置带到生产环境**：构建机持有可以创建任意资源的凭证，暴露在公网上等于把整个账号暴露出去。本手册按安全默认值编写。

### 第 2 步：上传部署包

构建机没有公网 IP，通过 S3 中转（不用 `scp`）：

```bash
# 本地：上传到你自己的 S3 桶
aws s3 cp openclaw-china-deploy.tar.gz s3://<your-bucket>/ --region cn-north-1
```

### 第 3 步：准备环境

用 SSM Session Manager 登录（不需要开放 22 端口、不需要密钥对）：

```bash
aws ssm start-session --target <instance-id> --region cn-north-1
```

登录后执行：

```bash
aws s3 cp s3://<your-bucket>/openclaw-china-deploy.tar.gz ~/ --region cn-north-1
mkdir -p ~/openclaw && tar xzf ~/openclaw-china-deploy.tar.gz -C ~/openclaw
cd ~/openclaw
./scripts/prepare-env.sh
```

脚本会自动安装 Node.js 20、Docker、Git 等依赖并配置 Docker 镜像加速器。

> 本仓库**不包含** OpenClaw 容器镜像、WeCom 插件、Node.js 二进制这三个制品，需自行准备，见 [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md)。`deploy-china.sh` 会在缺失时提示获取方式。

**执行完后必须重新登录**（让 Docker 组权限生效）：

```bash
exit
aws ssm start-session --target <instance-id> --region cn-north-1
```

### 第 4 步：执行部署

```bash
cd ~/openclaw
nohup ./scripts/deploy-china.sh --region cn-north-1 --stage dev > ~/deploy.log 2>&1 &
echo "部署已在后台启动，PID: $!"
```

查看部署进度：

```bash
tail -f ~/deploy.log
```

> 即使 SSH 断开，部署也会继续执行。重新连接后用 `tail -f ~/deploy.log` 查看进度。

脚本会自动完成：
1. 构建应用代码（admin-api、web-console、auth-service）
2. 构建并推送 Docker 镜像（auth、sidecar、base、app）
3. CDK Bootstrap
4. 部署 8 个 CloudFormation Stack
5. 初始化认证服务密钥
6. 创建初始管理员账号

部署完成后会输出：
```
✅ Deployment Complete!

  Console:    https://xxxxxx.cloudfront.cn/console/
  Admin API:  https://xxxxxx.execute-api.cn-north-1.amazonaws.com.cn/dev/
  CloudFront: xxxxxx.cloudfront.cn

  ✅ Admin user created
     username: admin
     password: <部署时随机生成，仅此一次显示>
     ⚠️  This is shown ONCE and is not stored anywhere. Copy it now.
     ⚠️  First login will require a password change.
```

> 初始管理员密码在部署时随机生成，**只输出一次、不存盘**。请立刻复制保存。
> 非中国区（Cognito 模式）不由 CDK 创建用户，见 README 的「创建初始管理员」一节。

### 第 5 步：验证部署

```bash
# 检查所有 Stack 状态
aws cloudformation list-stacks --region cn-north-1 \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query 'StackSummaries[?starts_with(StackName,`openclaw`)].{Name:StackName,Status:StackStatus}' \
  --output table

# 检查认证服务
aws ecs describe-services --cluster openclaw-dev --services openclaw-auth-dev \
  --region cn-north-1 --query 'services[0].{desired:desiredCount,running:runningCount}'
# 预期: desired=2, running=2

# 检查 Admin API
ADMIN_API=$(aws cloudformation describe-stacks --stack-name openclaw-dev-admin \
  --region cn-north-1 \
  --query 'Stacks[0].Outputs[?OutputKey==`AdminApiEndpoint`].OutputValue' --output text)
curl -s "${ADMIN_API}api/health"
# 预期: {"status":"ok"}
```

---

## 配置自定义域名

### 第 6 步：上传 SSL 证书到 IAM

```bash
aws iam upload-server-certificate \
  --server-certificate-name openclaw-china-cert \
  --certificate-body file://cert.pem \
  --private-key file://key.pem \
  --certificate-chain file://chain.pem \
  --path /cloudfront/ \
  --region cn-north-1

# 记录证书 ID
CERT_ID=$(aws iam list-server-certificates --path-prefix /cloudfront/ \
  --query 'ServerCertificateMetadataList[-1].ServerCertificateId' --output text)
echo "Certificate ID: $CERT_ID"
```

### 第 7 步：更新 CloudFront 配置

```bash
cd ~/openclaw/infra

npx cdk deploy openclaw-dev-cdn --require-approval never \
  -c region=cn-north-1 \
  -c stage=dev \
  -c customDomain=your-domain.cn \
  -c iamCertificateId=$CERT_ID
```

> 将 `your-domain.cn` 替换为你的 ICP 备案域名。

### 第 8 步：配置 DNS 解析

在域名 DNS 管理面板中添加 CNAME 记录：

| 记录类型 | 主机记录 | 记录值 |
|---------|---------|--------|
| CNAME | 你的域名（或子域名） | 部署输出的 CloudFront 域名（`xxxxxx.cloudfront.cn`） |

DNS 生效后即可通过 `https://your-domain.cn/console/` 访问管理控制台。

---

## 使用指南

### 首次登录

1. 浏览器访问 `https://your-domain.cn/console/`
2. 输入初始凭证：用户名 `admin`，密码为部署输出里那个随机生成的值
3. 系统会要求修改密码，设置新密码后进入控制台

### 添加 LLM 模型

1. 进入「模型管理」→「添加模型」
2. 填写：

| 字段 | 值 |
|------|-----|
| Provider Type | `litellm` |
| Model ID | LiteLLM 端点支持的模型名（如 `deepseek-v3`） |
| Base URL | LiteLLM 端点地址 |
| API Key | 对应的 API Key |

> Model ID 必须是 LiteLLM 端点 `/v1/models` 接口返回的模型名。
> 验证：`curl <Base URL>/v1/models -H "Authorization: Bearer <API Key>"`

### 创建用户

1. 进入「用户管理」→「创建用户」
2. 填写用户 ID、选择模型、配置企微渠道信息
3. 系统会自动启动用户容器（1-2 分钟后就绪）

---

## 运维操作

### 重启认证服务

```bash
aws ecs update-service --cluster openclaw-dev --service openclaw-auth-dev \
  --force-new-deployment --region cn-north-1
```

### 查看认证服务日志

```bash
aws logs tail /openclaw/dev/auth-service --follow --region cn-north-1
```

### 查看用户容器日志

```bash
TASK_ID=$(aws ecs list-tasks --cluster openclaw-dev --region cn-north-1 \
  --desired-status RUNNING --query 'taskArns[0]' --output text | awk -F/ '{print $NF}')
aws logs get-log-events --region cn-north-1 \
  --log-group-name "/openclaw/dev/main" \
  --log-stream-name "app/openclaw/$TASK_ID" \
  --limit 50 --query 'events[].message' --output json
```

### 环境清理

```bash
cd ~/openclaw/infra
npx cdk destroy --all -c region=cn-north-1 -c stage=dev
```

> 清理后需手动删除：
> - Secrets Manager 中的密钥（`openclaw/dev/admin/auth-keys`）
> - ECR 仓库（openclaw-auth、openclaw-sidecar、openclaw-base、openclaw-general）
> - IAM 上传的 SSL 证书
