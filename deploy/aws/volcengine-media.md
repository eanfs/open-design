# 火山 Agent Plan 媒体接入与验收（2026-09-07）

## 根因与修复

- 媒体提供商的 Base URL 被设置为完整的视频任务 URL，图片和视频适配器又追加接口路径。已备份后修正为 `https://ark.cn-beijing.volces.com/api/plan/v3`。
- Seedream 5.0 Lite 实测拒绝 `1024x1024`，错误要求至少 3,686,400 像素。适配器现在按 **别名解析后的模型** 选择尺寸，支持方形、横屏、竖屏及 4:3 / 3:4；旧模型原有尺寸保留。
- 代理向 daemon 注入服务认证令牌，媒体等待接口却把所有 Authorization 头当作 Agent 工具令牌，导致真实任务成功后查询返回 401。现在精确识别已有服务凭证，并继续执行常规项目授权；其他工具令牌仍校验有效期、端点及项目范围。
- 图片选项 `doubao-seedream-3-0-t2i-250415` 的已有别名指向 `doubao-seedream-5.0-lite`。视频的两个 2.0 选项分别映射到 `doubao-seedance-2.0`、`doubao-seedance-2.0-fast`。没有修改其他提供商的密钥。
- 线上标准版、Fast 版及 1.5 Pro 均返回 `UnsupportedModel`。接口、模型名已与官方示例核对；不能把查询任务列表成功当作视频生成权限成功。需要核对实际套餐/密钥权限，未购买或升级套餐。

官方参考：[视觉模型接入](https://docs.volcengine.com/docs/82379/2375486?lang=zh)、[套餐支持模型](https://docs.volcengine.com/docs/82379/2366394?lang=zh)。官方表中 Seedance 2.0 系列需要 Large / Max；本次未能通过已过期的本地 SSO 独立读取套餐档位。

## 代码与部署边界

- 最新远程 `main`：`45dadb1f8df9526d82965bda79e362f2f1ccac38`，已从相同 SHA 的本地对象取得完整最新快照。原 `develop` 工作区未改动。
- 生产基础版本：OpenDesign 0.21.1，ARM64，原镜像包含 OpenCode / Pi 私有运行时层。
- 部署仍为新加坡 EC2 上的 Nginx 代理与 daemon 容器，应用服务以 `1001:1001` 运行。
- 本次只发布媒体修复层，没有将 `main` 其他差异全量升级到生产，没有数据库迁移。
- 持久数据配置遵循根 [AGENTS.md 的 Daemon data directory contract](../../AGENTS.md)。运行路径以现有容器 Mounts、Compose labels 和环境变量的实际值为准，不引入第二套数据根。

修复镜像：

`389656352076.dkr.ecr.ap-southeast-1.amazonaws.com/apexai-opendesign:0.21.1-volcengine-20260907-v2@sha256:86d50644cd115938fc4b2747057c708592cd491e20a282ac044a937ab997dd46`

此次切换 SSM 命令：`e850ca89-c3ef-4808-9eea-f463c955339c`，状态 Success；上一版环境备份为 `.env.backup-media-20260907-v2`，首次备份为 `.env.backup-media-20260907`。

原镜像摘要：`sha256:5d4b6dd3d6f9bce2c262d3daddee981234a82503c415f87d10226533d153ad48`。

## 复现构建

正常源码构建直接编译图片尺寸 helper。为了保持现有私有运行时版本，本次热修复使用固定基础镜像与 fail-closed 补丁脚本。构建上下文必须显式准备；不能直接以 `deploy/aws` 作为上下文：

1. 在仓库根创建临时上下文：`AOD_MEDIA_CONTEXT=$(mktemp -d)`。
2. `cp deploy/aws/Dockerfile.volcengine-media "$AOD_MEDIA_CONTEXT/Dockerfile"`
3. `cp deploy/aws/apply-volcengine-image-size.ts "$AOD_MEDIA_CONTEXT/"`
4. `cp apps/daemon/src/media/volcengine-image-size.ts "$AOD_MEDIA_CONTEXT/"`
5. 在具有原生 ARM64 Docker 和基础镜像的构建机执行：`docker build --network=none --pull=false -t "$AOD_MEDIA_IMAGE" "$AOD_MEDIA_CONTEXT"`。
6. 推送到现有 ECR 仓库，并独立读取 ECR digest 核对。运行实例仅有 ECR 拉取权限；发布使用部署身份，不扩大实例角色权限。若通过 SSM 传递临时发布令牌，必须使用现有 KMS 的 SecureString、临时 Docker 配置目录，并在发布后删除两者。本次均已清理。

## 切换与回滚

- 切换前检查 `/api/active` 无运行任务；备份当前 Compose 环境文件和媒体配置，备份含密钥时使用 `0600`。
- 修改现有环境文件的 `OPEN_DESIGN_IMAGE` 为经过核验的完整 tag + digest，只重建 Compose 的 `open-design` 服务。
- daemon 健康检查成功后，对 `open-design-auth-proxy` 执行 `nginx -s reload`，刷新上游解析。
- 回滚：恢复原环境文件备份，执行 `docker compose -f docker-compose.prod.yml up -d --no-build --no-deps open-design`，再重载代理。镜像回滚不要求还原已修正的 Base URL；恢复错误地址会重新破坏媒体请求。

## 验证证据

- 24 项定向测试通过：图片相关 18 项，媒体任务路由 6 项。覆盖尺寸下限/比例、旧模型兼容、dispatcher 的别名/HTTP 请求体/文件落盘，以及服务 Bearer/Basic、工具令牌有效期、端点权限和跨项目访问限制。路由测试使用隔离临时数据目录；本机监听需在允许网络的执行环境运行。
- 新 helper 的严格 TypeScript 检查通过，补丁后的生产 JS 语法检查通过；全仓依赖离线安装因缓存不全失败，未宣称全仓 typecheck/build 通过。
- 修复镜像通过真实 `generateMedia` 调用得到图片 `volcengine-image-check.png`，65062 字节，`providerId=volcengine`、`providerError=null`、`usedStubFallback=false`。
- 公网接口提交图片任务 `fb3fde78-37cf-45a5-a845-503e7611e64d`，28 秒完成，文件 `volcengine-http-image-check.png` 共 79,294 字节；provider 无错误、无 stub 回退。实际文件为 2048 × 2048 JPEG（原适配器未统一扩展名/响应 MIME），浏览器可以展示；未据此声称 PNG 编码已验收。
- 验收项目：`aod-media-check-20260907`（火山图片与视频接入验收 2026-09-07）。
- 生产容器 Image ID：`sha256:98b6d3c1a91f88b8142e64dc5780649c87e08e6ff28789297296684fe3117c6c`；健康接口成功，公网首页 HTTP 200。
- v2 部署后，公网 `POST /api/media/tasks/fb3fde78-37cf-45a5-a845-503e7611e64d/wait` 返回 HTTP 200、`status=done`；项目产物读取返回 HTTP 200，健康检查返回 HTTP 200。
- 视频验收任务 `7a201cbb-fe10-4ae6-8850-f7b2a6df1c4c`：`failed / UnsupportedModel`，没有生成成功的视频产物。

## 额外发现与未完成边界

- 当前公网代理在未携带 Cookie / Authorization 的请求中，也会注入后端服务令牌。本次带站点 Origin 的请求可发起真实生成并读取产物，说明仅 Origin 检查不足以控制生成额度的使用。未擅自改变现有访问策略；应确认入口需要哪些用户的身份认证。
- 视频配置已接通正确 Agent Plan API，但视频生成未通过，不能报告图片与视频均已交付。需要账号具备官方对应视频套餐权益，或提供具备 Seedance 视频权限的密钥，再执行实际生成验收。
