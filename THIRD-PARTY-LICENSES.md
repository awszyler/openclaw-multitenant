# 第三方组件与许可证

本项目是一套**部署方案**，它编排下列第三方组件，但不包含它们的源码。这些组件均**不由本项目维护**，请以各自上游仓库的许可证为准。

## 运行时依赖的外部制品（不随本仓库分发）

以下三个二进制制品**不在本仓库内**，需要你自行获取（脚本会检查并给出提示）：

| 制品 | 来源 | 许可证 | 获取方式 |
|---|---|---|---|
| OpenClaw 容器镜像 | [openclaw/openclaw](https://github.com/openclaw/openclaw) | MIT | `docker save ghcr.io/openclaw/openclaw:2026.4.15 \| gzip > docker/base/openclaw-image.tar.gz` |
| `openclaw-plugin-wecom` | 第三方开源项目 | MIT | 自行构建后放到 `docker/base/wecom.tar.gz` |
| Node.js 20 (linux-arm64) | [nodejs.org](https://nodejs.org/) | MIT | 可选加速用；`scripts/prepare-env.sh` 在文件不存在时会回退到 NodeSource 安装 |

> `openclaw-plugin-wecom` 是第三方开源项目，**不由本项目、也不由任何云厂商维护、背书或支持**。

## 直接代码依赖

| 组件 | 用途 | 许可证 |
|---|---|---|
| [aws-cdk-lib](https://github.com/aws/aws-cdk) / constructs | 基础设施定义 | Apache-2.0 |
| [@aws-sdk/*](https://github.com/aws/aws-sdk-js-v3)（dynamodb / ecs / secrets-manager / bedrock-runtime / lib-dynamodb） | AWS API 调用 | Apache-2.0 |
| [fastify](https://github.com/fastify/fastify) / [@fastify/aws-lambda](https://github.com/fastify/aws-lambda-fastify) | HTTP 服务 | MIT |
| [aws-jwt-verify](https://github.com/awslabs/aws-jwt-verify) | Cognito JWT 校验 | Apache-2.0 |
| [jose](https://github.com/panva/jose) / [jsonwebtoken](https://github.com/auth0/node-jsonwebtoken) / [jwks-rsa](https://github.com/auth0/node-jwks-rsa) | JWT 处理 | MIT |
| [bcrypt](https://github.com/kelektiv/node.bcrypt.js) | 口令哈希 | MIT |
| [ulid](https://github.com/ulid/javascript) | 标识符生成 | MIT |
| [react](https://github.com/facebook/react) / react-dom / [react-router-dom](https://github.com/remix-run/react-router) | 前端框架 | MIT |
| [aws-amplify](https://github.com/aws-amplify/amplify-js) / @aws-amplify/auth | 前端认证 | Apache-2.0 |
| [i18next](https://github.com/i18next/i18next) / react-i18next | 国际化 | MIT |
| [lucide-react](https://github.com/lucide-icons/lucide) | 图标 | ISC |
| [vite](https://github.com/vitejs/vite) / @vitejs/plugin-react | 构建 | MIT |
| [tailwindcss](https://github.com/tailwindlabs/tailwindcss) / postcss / autoprefixer | 样式 | MIT |
| [typescript](https://github.com/microsoft/TypeScript) | 语言 | Apache-2.0 |
| [vitest](https://github.com/vitest-dev/vitest) / [fast-check](https://github.com/dubzzz/fast-check) / @testing-library/* / jsdom | 测试 | MIT |
| [esbuild](https://github.com/evanw/esbuild) | 打包 | MIT |
| [tsx](https://github.com/privatenumber/tsx) / [ts-node](https://github.com/TypeStrong/ts-node) | 开发时执行 | MIT |

`infra/lib/stacks/lambda/litellm-proxy/index.py` 只使用 Python 标准库（`json` / `os` / `time` / `urllib` / `traceback`），无第三方依赖。

以上许可证均与本项目的 MIT 许可证兼容。若发现遗漏或错误，欢迎提 issue 指正。
