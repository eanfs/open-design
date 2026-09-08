# 火山 Agent Plan 媒体接入与验收（2026-09-07）

> 更新（2026-09-08）：默认媒体链路已切换为火山 Seedream，见文末「Seedream 默认路由（v3/v4）」。

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

## Seedream 默认路由（2026-09-08，v3 / v4）

### 目标与决策

网页图片生成在项目未显式选模型时默认 `gpt-image-2`（vela/OpenAI，本部署未配置）导致 MEDIA_DISPATCH_FAILED。用户方向裁定：**不安装**官方 `byted-ark-seedream-skill` / `byted-ark-seedance-skill` 到 Pi（其默认优先执行自身脚本的规则与 OpenDesign 媒体契约唯一执行路径冲突），改为把能力收进 `od media generate` 的火山渲染器并把默认模型翻转为 Seedream（调度器唯一路径）。交付方式：在 v2 之上继续打热修复层，保留私有运行时层。

### 镜像与切换记录

- **v3** `389656352076.dkr.ecr.ap-southeast-1.amazonaws.com/apexai-opendesign:0.21.1-volcengine-20260907-v3@sha256:a9e2aa6326bd72cda495a2c673f35d3022bc45210fd2195f6b52ffd96427e0c8`：目录默认 flag 从 `vela/gpt-image-2` 移到 `doubao-seedream-3-0-t2i-250415`（daemon dist models.js + 两处 web chunk `0fb5ha4~sml8r.js`/`15_j4ackgjtzm.js`，fail-closed 精确替换）；daemon media-contract 无偏好默认句 `otherwise use gpt-image-2` → `doubao-seedream-3-0-t2i-250415 (Volcengine Seedream)`；`--resolution` 适用范围注释加入 Volcengine Seedream 2K/3K/4K；渲染器 size 调用改为三参（透传 ctx.resolution）。
- **v4** `389656352076.dkr.ecr.ap-southeast-1.amazonaws.com/apexai-opendesign:0.21.1-volcengine-20260908-v4@sha256:6744ec17a67638c70fc600a482cc5bfcb8187e46d28774e3e37a62b93dbd67f2`：真实调用发现 Ark 将裸 `2K` 档位视为方形输出（无视宽高比），故 helper 改为**保比例像素表**（2K/3K/4K × 16:9/9:16/4:3/3:4/方形，全部单元格已对 `doubao-seedream-5.0-lite` 实测 HTTP 200：如 16:9 → 2560x1440 / 3072x1728 / 4096x2304）。
- 切换 SSM 命令：v3 `039f7b9b-042d-46a5-ae0f-ad1d391f0455`（pull 失败后重跑 `4dd319c9-f070-43ce-9d72-5795f8178d90`，主机 docker 用实例角色 `aws ecr get-login-password` 登录后成功）；v4 `266f6535-5689-4c1b-93db-4ef842279c21`。环境备份：`.env.backup-media-defaults-20260908`（v3）、`.env.backup-media-defaults-20260908-v4`（v4），均 0600。
- 构建机：`172.16.12.183`（原生 arm64 Linux Docker；ECR 凭证已存于该机 `~/.docker/config.json`，过期则用部署身份 `aws ecr get-login-password | docker login` 刷新）。构建：`docker build --network=none --pull=false`，push 后独立 `aws ecr describe-images` 核对 digest。容器内运行 `node` 校验补丁文件（`verify-v3-image.cjs` 8 项断言全过；v4 helper 在镜像内 strip-types 生成 + `node --check`）。
- 回滚点：v4 → v3（或 v2）：恢复对应 `.env.backup-media-*`，`docker compose -f docker-compose.prod.yml up -d --no-build --no-deps open-design`，`nginx -s reload`。media-config.json 的 baseUrl/别名/密钥未因本改动变化，无需还原。

### 源码变更（未来全量构建生效）

- 默认目录：`apps/web/src/media/models.ts` 与 `apps/daemon/src/media/models.ts` 中 `default: true` 移到 `doubao-seedream-3-0-t2i-250415`（vela/gpt-image-2 条目保留可选）。`DEFAULT_IMAGE_MODEL` 随之推导。
- 提示词双实现：daemon `media-contract.ts`（无偏好默认句 + `--resolution` 适用范围注释）与 `packages/contracts/src/prompts/media-contract.ts`（resolution 适用范围文案）同步；短版确认无默认选择句、未发明；`system.ts` 的 `mediaDefaultsForRuntime` 仅限 amr 运行时，属 Vela 配置航道，未改。
- 尺寸 helper：`apps/daemon/src/media/volcengine-image-size.ts` 三参签名 + 保比例像素表；legacy 3.0 分支最优先（带档位仍 1024x1024）。
- 涉及测试全部更新（models 默认断言、system-prompt-matrix snapshot +80 字符、NewProjectPanel/home-media-surfaces 预期 imageModel、dispatcher 层 size 断言 2560x1440 等）。全仓 typecheck exit 0、guard exit 0；web 全量 7165 过 /3 失败（其中 2 个隔离重跑绿、1 个 FileViewer iframe 超时为与本次无关的既有抖动）。

### 验收证据（生产 v4，公网页面 + daemon 日志）

- 新建图片项目（composer type=图片，不改模型）发送纯提示词：Pi 计划文本“selected the default Seedream image generation model”，执行 `od media generate --model doubao-seedream-3-0-t2i-250415`；daemon `[media]` 日志 `model_id=doubao-seedream-3-0-t2i-250415, provider_id=volcengine, status=done`；UI 显示“图片已生成”，文件 `orange-kitten-studio.png` 160.5 KB（实际 2560x1440，JPEG 字节/PNG 后缀，沿用 v2 已知适配器差异）。
- 2K 请求（“重新生成一版 2K 分辨率”）：Pi 正确映射为 `--resolution 2K`；期间一次误选 `vela/seedream-5.0`、一次误选 senseaudio 目录项均得到结构化未配置错误（无 stub、无静默替换），最终以 Seedream 成功。v3 裸档位产出方形（Pi 自检发现并记录）；v4 后 API 任务 `bf3555ed-021b-4aa8-a73e-3466768e2c3c`（`--resolution 2K` + 16:9）18 秒 done，产物 `orange-kitten-studio-2k-v4.png` 109,408 B，实测 2560x1440（保比例 2K）。
- 显式选择未配置模型：与上述两次误选同路径，得到结构化 provider 错误，证明显式选择不被静默替换。
- 视频默认：目录默认仍为 `doubao-seedance-2-0-260128`（未改动）；Seedance 套餐权限为既有外部边界，真实视频验收仍待套餐/密钥。
- 大尺寸档位实测（直连 Ark，`doubao-seedream-5.0-lite`）：2560x1440、3072x1728、3840x2160、4096x2304、3072x3072、4096x3072、4096x4096、3840x2880、1440x2560 全部 HTTP 200（SSM 命令 `79e5b7d9`… 起多轮，探针脚本即用即删）。
