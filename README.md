# openclaw-multitenant

> 在 AWS 上部署**多租户** [OpenClaw](https://github.com/openclaw/openclaw)：每用户独立 Fargate 容器、出口域名白名单、企业微信渠道，并支持 AWS **中国区**（cn-north-1 / cn-northwest-1）。
> Multi-tenant OpenClaw on AWS with per-user Fargate isolation, egress domain allowlisting, and WeCom channel — including AWS China regions.

## 免责声明

- 这是一个**个人项目**，**不是 AWS 官方产品或解决方案**，不代表任何雇主的立场，不提供官方支持。
- 与上游 [OpenClaw](https://github.com/openclaw/openclaw) 项目**无隶属关系**。本仓库只是一套部署方案，不包含 OpenClaw 源码。
- 按 MIT 许可证「原样」提供，自行评估风险后使用。生产环境部署前请自行做安全评审。

## 这个项目解决什么

想给一个团队提供 OpenClaw，但不希望所有人共用一个容器、共用一份凭证、共用一个出网通道。本方案给出的路线是：

- **每用户一个 Fargate 容器**，通过管理台按需拉起／回收，不同用户的工作区互不可见
- **出口收敛**：容器跑在私有子网，出网走 NAT + 域名白名单，而不是任意公网访问
- **统一的模型接入层**：LiteLLM 代理，模型／凭证由管理员集中配置，用户不接触上游 API Key
- **企业微信渠道**：用户在企微里直接对话，不需要终端
- **中国区可部署**：镜像加速、cn 分区 endpoint 适配、IAM 上传证书 + CloudFront 自定义域名等差异都已处理

### 与同类方案的差异

| 方案 | 隔离方式 |
|---|---|
| 本项目 | ECS Fargate，每用户一个 task |
| [aws-samples/sample-multi-tenant-openclaw-on-firecracker](https://github.com/aws-samples/sample-multi-tenant-openclaw-on-firecracker) | Firecracker microVM |

Fargate 路线的取舍：运维面更小、不用自己管宿主机，代价是冷启动更慢、单容器成本更高。需要更强隔离边界或更快启动，可以看上面那个 Firecracker 方案。

## 架构

```
企业微信 / 浏览器
      │
      ▼
  CloudFront ──► Web Console (React)
      │
      ├──► Admin API (Fastify on Lambda) ──► DynamoDB / ECS RunTask
      │
      └──► 认证（两种模式，见下）
                  │
                  ▼
    私有子网 ┌──────────────────────────────────┐
            │  Fargate task (user A)           │
            │  Fargate task (user B)   …       │
            └────────────────┬─────────────────┘
                             │ NAT + Network Firewall 域名白名单
                             ▼
                   LiteLLM 代理 ──► 模型端点
```

**认证的两种模式差异较大，不是同一套组件换个后端**：

| | 全球区（`deploymentMode=global`） | 中国区（`china`） |
|---|---|---|
| 身份来源 | Cognito User Pool | 自建 auth-service + DynamoDB（中国区无 Cognito） |
| 前端登录 | `aws-amplify/auth` 直连 Cognito | 调用 auth-service |
| Admin API 校验 | `aws-jwt-verify` 校验 Cognito JWT | 校验 auth-service 签发的 RS256 JWT |
| 是否部署 auth-service | **不部署** | ECS Fargate 常驻（`desiredCount: 2`）+ 内部 ALB |

CDK 的 stack 划分：

| Stack | 中国区 | 全球区 | 说明 |
|---|:-:|:-:|---|
| `network` `data` `security` `proxy` `compute` `admin` `ingress` `cdn` | ✅ | ✅ | 8 个公共 stack |
| `bedrock-logs` | — | ✅ | Bedrock 调用日志。**中国区没有 Bedrock，故跳过** |

即：中国区 8 个，全球区 9 个。

### 组成

| 目录 | 内容 | 运行形态 |
|---|---|---|
| `infra/` | CDK 基础设施定义 | — |
| `admin-api/` | 管理 API（用户／模型／审计） | Lambda（`@fastify/aws-lambda`） |
| `auth-service/` | 认证服务（**仅中国区部署**） | ECS Fargate 常驻 |
| `web-console/` | 管理控制台 | React + Vite，静态托管于 CloudFront |
| `docker/` | 容器构建（base / app / sidecar / auth） | — |
| `scripts/` | 部署与清理脚本 | — |

`deploymentMode` 由区域自动推导（`cn-north-1` / `cn-northwest-1` → `china`，其余 → `global`），也可用 `-c deploymentMode=` 覆盖。

## 部署

- **AWS 中国区**（cn-north-1 / cn-northwest-1）：有脚本化流程，见 **[DEPLOY_CHINA.md](DEPLOY_CHINA.md)**
- **全球区**：CDK 完整支持（`deploymentMode=global`，认证走 Cognito），但**没有部署脚本** —— `scripts/deploy-china.sh` 会主动拒绝非中国区。请按下面的手工步骤执行。

### 全球区手工部署（已在 ap-southeast-2 实测通过）

```bash
git clone https://github.com/<owner>/openclaw-multitenant.git
cd openclaw-multitenant

# 1. 安装依赖（四个子项目各自独立）
for d in infra admin-api auth-service web-console; do (cd $d && npm ci); done

# 2. 构建 CDK 需要的资产（缺这一步 cdk synth 会报 CannotFindAsset）
(cd admin-api   && npm run build)   # Lambda 代码
(cd web-console && npm run build)   # 控制台静态资源

# 3. Bootstrap（每个账号+区域一次）
cd infra
npx cdk bootstrap aws://<ACCOUNT_ID>/<REGION> -c region=<REGION> -c stage=<STAGE>

# 4. 部署全部 stack（约 20 分钟：NAT、Network Firewall、CloudFront 较慢）
npx cdk deploy --all --require-approval never -c region=<REGION> -c stage=<STAGE>
```

部署完成后取关键输出：

```bash
aws cloudformation describe-stacks --stack-name openclaw-<STAGE>-admin --region <REGION> \
  --query 'Stacks[0].Outputs[?OutputKey==`CognitoUserPoolId`||OutputKey==`CognitoClientId`||OutputKey==`AdminApiEndpoint`].[OutputKey,OutputValue]' --output table

aws cloudformation describe-stacks --stack-name openclaw-<STAGE>-cdn --region <REGION> \
  --query 'Stacks[0].Outputs[?OutputKey==`ConsoleUrl`].OutputValue' --output text
```

健康检查：`curl "<AdminApiEndpoint>api/health"` 应返回 `{"status":"ok"}`。

> 说明：用户容器镜像（`openclaw-general`）不是部署 stack 的前提 —— task definition 对镜像是延迟解析的，全部 stack 可以在没推镜像的情况下部署完成。但**实际拉起用户容器**需要先把镜像推到 ECR。

### 创建初始管理员

**CDK 刻意不创建任何用户**，凭证完全不经过 CloudFormation。部署后自己执行（以下命令已实测）：

```bash
REGION=<REGION>; STAGE=<STAGE>
UP=$(aws cloudformation describe-stacks --stack-name openclaw-$STAGE-admin --region $REGION \
  --query 'Stacks[0].Outputs[?OutputKey==`CognitoUserPoolId`].OutputValue' --output text)

# 生成一个随机初始密码（排除易混字符，满足用户池策略：>=8 位、含大小写与数字）
ADMIN_PW="$(LC_ALL=C tr -dc 'A-HJ-NP-Za-km-z2-9' </dev/urandom | head -c 20)"
echo "初始密码（只显示这一次，请立即保存）: $ADMIN_PW"

aws cognito-idp admin-create-user --user-pool-id "$UP" --username admin \
  --temporary-password "$ADMIN_PW" --message-action SUPPRESS \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true \
  --region $REGION

aws cognito-idp admin-add-user-to-group --user-pool-id "$UP" --username admin \
  --group-name openclaw-admins --region $REGION
```

用户创建后状态为 `FORCE_CHANGE_PASSWORD`，首次登录会强制改密码。

### 清理

```bash
cd infra && npx cdk destroy --all -c region=<REGION> -c stage=<STAGE>
```

Cognito 用户池的 `removalPolicy` 是 `RETAIN`，destroy 后需要手工删除；ECR 仓库与上传的证书同样需手工清理。

### 需要自行准备的三个制品

本仓库**不分发**以下二进制，脚本会在缺失时提示获取方式（详见 [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md)）：

| 制品 | 获取方式 |
|---|---|
| `docker/base/openclaw-image.tar.gz` | `docker save ghcr.io/openclaw/openclaw:2026.4.15 \| gzip > docker/base/openclaw-image.tar.gz` |
| `docker/base/wecom.tar.gz` | 自行构建第三方 `openclaw-plugin-wecom`（社区有多个实现，例如 [sunnoy/openclaw-plugin-wecom](https://github.com/sunnoy/openclaw-plugin-wecom)），打包后放到该路径 |
| `tools/node-v20.*-linux-arm64.tar.xz` | 可选，仅用于加速中国区安装；缺失时脚本回退到 NodeSource |

## 安全说明

### 初始管理员凭证

**凭证不经过 CloudFormation** —— 不进模板、不进 stack 输出、不进本仓库。两种模式：

- **中国区**：`deploy-china.sh` 在部署时生成随机密码并**只打印一次**（不存盘），请立即保存
- **全球区**：CDK 不创建任何用户，部署后按 [创建初始管理员](#创建初始管理员) 自己执行一条命令，密码自己生成、自己保管

两种模式下用户初始状态都是 `FORCE_CHANGE_PASSWORD`，首次登录强制改密。

### 部署者需要自己评估的事

本项目提供的是一套架构骨架，下列事项**不在**方案的保证范围内，请自行评估：

- **构建机权限**：CDK bootstrap + 多 stack 部署需要较宽的权限。`DEPLOY_CHINA.md` 给出的是最小权限 + SSM 登录的推荐配置；不要用 `AdministratorAccess` + 公网 SSH 上生产
- **容器内的命令执行**：OpenClaw 本身可以执行命令、读写文件。每用户独立容器限制了横向影响，但**容器内**的能力边界由上游 OpenClaw 与你的 skill 配置决定
- **出口白名单的维护**：域名白名单需要随你启用的功能更新，放得过宽等于没有
- **多租户边界**：本方案在容器与网络层做隔离；数据层的隔离取决于你如何配置每用户的 S3 前缀与 DynamoDB 分区键

## 开发

```bash
# 每个子项目独立安装 + 类型检查
for d in infra admin-api auth-service web-console; do (cd $d && npm ci && npx tsc --noEmit); done

# 构建
(cd admin-api && npm run build)     # esbuild → dist/index.js
(cd web-console && npm run build)   # vite → dist/
```

### 已知问题

- **没有测试**：四个子项目都配了 vitest、`test` 脚本和 `fast-check` 依赖，但**测试文件数为 0**，所以 `npm test` 会以「No test files found」退出码 1 结束。这是待补的工作，不是配置错误。
- `npx cdk synth` / `deploy` 需要先构建 `admin-api` 与 `web-console`（Lambda 资产指向 `admin-api/dist`，控制台资源指向 `web-console/dist`），否则报 `CannotFindAsset`。`deploy-china.sh` 内部顺序是对的，手工部署请按上面「全球区手工部署」的步骤 2 执行。
- 全球区没有部署脚本，只有手工步骤（见上）。

## 许可证

MIT，见 [LICENSE](LICENSE)。第三方组件许可见 [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md)。
