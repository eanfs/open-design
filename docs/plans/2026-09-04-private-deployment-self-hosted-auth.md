# 私有化部署 + 自建云端验证:方案调研与决策文档

> **状态**:DRAFT — 待 review
> **日期**:2026-09-04
> **范围**:open-design 仓库(`daemon` + `web` + 打包运行时)
> **用户诉求**:私有化部署整个产品,**不通过 `https://open-design.ai/cloud` 登录**,改用**自建云端验证**;以**纯 web 形态**部署到云端,实现 **UI 设计、生成 PPT、生成图片** 能力。
> **已确认**:不需要 desktop 客户端、不需要 Claude 登录、不需要多用户协作、不保留 AMR 云代理面。
> **调研方式**:多个 agent 并行核查仓库源码/文档(累计 900+ 次工具调用)+ 外部事实核查;结论均以 `file:line`(仓库相对路径)标注证据。

---

## 1. 背景与目标

OpenDesign 当前唯一的"云端登录"是 Vela/AMR 控制台(`open-design.ai/cloud`),登录走 `vela login` 设备授权流,并依赖云端控制面提供模型路由、计费/余额、工作区/团队协作。本调研回答三个问题:

1. 私有化部署**是否必须**依赖 open-design.ai 登录?
2. 不用官方登录时,"云端验证"能由谁承担?
3. 若要自建云端验证,各方案的改动面、能力边界与风险是什么?

**目标形态**:在自己部署的服务器/域名下运行 OpenDesign,用户验证不经过 open-design.ai;云端身份/权限/计费由自己控制。

**能力目标(2026-09-04 澄清)**:**纯 web 形态**,部署到云端即可实现三项能力——**UI 设计、生成 PPT(deck)、生成图片**。**不需要 desktop 客户端、不需要 Claude 登录**。三项能力各自依赖的模型通道见第 3 节。

---

## 2. 当前认证架构速览

### 2.1 登录链路:Vela/AMR 设备授权流

- 用户在 UI 选 AMR(云)代理时,daemon 拉起 `vela login` CLI 子进程走 OAuth **device flow**;daemon 只解析 CLI stdout 的 `Open this URL to continue: <url>` 与 `Code: <code>`(`apps/daemon/src/integrations/vela.ts:345`,spawn 在 `vela.ts:1265-1471`),然后轮询本地配置直到出现凭证。
- 凭证两种形态:
  - **文件型**:`~/.amr/config.json` 的 `profiles[<profile>].controlKey / runtimeKey / linkUrl / apiUrl / user`(`vela.ts:421-431`;目录可用 `AMR_HOME` 改)。
  - **env 型**:`VELA_CONTROL_KEY` / `VELA_RUNTIME_KEY` / `VELA_LINK_URL` / `VELA_API_URL`(`vela.ts:510-521`、`vela.ts:751-767`)。
- 认证目标由 `VELA_API_URL` 决定:只要 env 或已存 config 里有了该值,就不再注入默认的 `https://amr-api.open-design.ai`(`vela.ts:1534-1544`、`vela.ts:782-795`)。

### 2.2 控制面 → 两个下游面

登录后的控制面(amr-api)驱动两个面:

1. **AMR 云模型运行时** = vela CLI 的 ACP stdio 模式 + OpenRouter 兼容推理端点(`apps/daemon/src/runtimes/defs/amr.ts:26-33`)。只要同时有 `VELA_RUNTIME_KEY` + `VELA_LINK_URL`,`readVelaLoginStatus` 直接返回 `loggedIn: true, user: null`,**完全绕过设备授权**(`vela.ts:510-521`)。
2. **工作区/团队协作身份(B 集成)**:唯一替换缝是 `createWorkspaceContextProviderFromEnv`(`apps/daemon/src/collab/vela-workspace-context.ts:919`)——只有显式设 `OD_WORKSPACE_CONTEXT_SOURCE=vela` 才走真实 Vela provider(拉 `/api/v1/workspaces` 成员目录);**任何其他取值一律回落本地 dev stub**(`apps/daemon/src/collab/workspace-context.ts:325-347`)。

### 2.3 哪些是登录必需、哪些可关

- **登录只对 AMR 云模型通道与云端协作是必需的。**
- 本地 CLI agent(Claude Code / Codex / OpenCode 等 26 种)与 BYOK OpenAI 兼容代理(`/api/proxy/*`,`README.md:144`)完全免登录。
- onboarding 把 `amr/local/byok` 三选一放在登录之前(`apps/web/src/components/EntryShell.tsx:2828-2856`、`2915-2945`);登录重定向只在选中 AMR 代理时才触发(`EntryShell.tsx:668-683`、`App.tsx:1956-1971`)。
- 余额闸只对 AMR run 生效,本地 CLI/BYOK 显式豁免(`apps/web/src/components/ProjectView.tsx:6900-6904`、`6982`)。
- **结论:"不登录"完全可以,失去的只是云平台能力**(AMR 积分/余额、团队工作区、评论云同步、账号级消息中心)。

---

## 3. 纯 web 部署:能力与模型通道(不需要 desktop、不需要 Claude 登录)

### 3.1 关键事实

- **官方 Docker 镜像本身就是纯 web**:daemon 同时服务 web SPA(静态导出)与 API,浏览器直接访问,`deploy/README.md`。**desktop(Electron 壳)只是可选的本机客户端,私有化部署完全不需要它**。
- **UI 设计、PPT、图片生成都不依赖 open-design.ai,也不依赖 Claude 登录**。三者依赖的是 **agent 模型通道**(UI 设计/PPT)与 **媒体 provider**(图片),两条都可用 BYOK/自有 key/自建端点替代官方云。
- 官方 Docker 镜像**不打包** Claude/Codex 等 CLI 二进制(`deploy/README.md:91-93`),但这不影响纯 web 使用——agent 走 BYOK 代理,无需任何本地 CLI。

### 3.2 三项能力与模型通道映射

| 能力 | 模型通道 | 配置方式 | 需要 Claude 登录? | 需要 open-design.ai? |
|---|---|---|---|---|
| **UI 设计** | agent runtime(**BYOK 代理**) | web Settings 填任意 OpenAI 兼容端点的 `baseUrl + apiKey`(DeepSeek / Qwen / vLLM / Ollama / 自建网关等) | ❌ | ❌ |
| **生成 PPT / deck** | agent 驱动 + daemon 侧导出(`deck-export.ts` / `export-cli-request.ts`) | 同上 BYOK;PPTX/HTML 导出在服务器完成,浏览器下载 | ❌ | ❌ |
| **生成图片** | **媒体 provider**(14+ 种,含可自建) | Settings → Media 选 provider 填 key(或 env 注入) | ❌ | ❌ |

### 3.3 关键证据(源码实读)

1. **agent 走 BYOK,零本地 CLI、零登录** —— daemon 内置 OpenAI 兼容代理路由 `apps/daemon/src/routes/chat.ts:984+`(`POST /api/proxy/{anthropic,openai,azure,google}/stream`);README.md:144:"No CLI installed? The BYOK proxy gives you the same loop (no process spawn)"。
2. **图片生成不依赖 OpenDesign Cloud** —— `apps/daemon/src/media/models.ts:33-52` 列出 14+ 个 provider,`vela`(OpenDesign Cloud)只是其中之一且默认隐藏(`settingsVisible: false`):
   - **`custom-image`**(`models.ts:42`):"Custom Image API: OpenAI-compatible images/generations + images/edits **(local or cloud)**",`supportsCustomModel: true` → **完全可自建**。
   - `openai` / `volcengine`(Seedream) / `grok` / `nanobanana`(Google) / `imagerouter` / `openrouter` / `fal` / `minimax` / `senseaudio` / `aihubmix` / `leonardo` —— 全部带自己的 key,`baseUrl` 可改。
3. **provider 凭证两种注入方式** —— `apps/daemon/src/media/config.ts:71-108`:env(`OD_CUSTOM_IMAGE_API_KEY`、`OD_OPENAI_API_KEY`、`OD_VOLCENGINE_API_KEY`、`OD_GROK_API_KEY`、`OD_OPENROUTER_API_KEY`...),或 web Settings → Media UI(`routes/media.ts` 的 `writeConfig`/`readMaskedConfig`)。

### 3.4 纯 web 私有化部署形态(零 desktop、零 Claude、零 open-design.ai)

```
浏览器 ──> 你的域名(反向代理,TLS)
              │  OD_API_TOKEN 保护
              ▼
        Docker 镜像(web + daemon 同源)
              │
              ├─ BYOK: /api/proxy/* → DeepSeek / Qwen / 自建网关   (UI 设计、PPT)
              └─ Media: custom-image / openai / volcengine / grok / fal...  (图片)
```

> 若**将来**想要原生桌面客户端指到该私有部署,那是可选增强,见第 11 节(第 11 节内容不阻塞纯 web 路线)。

---

## 4. 结论先行

**一句话结论:OpenDesign 私有化部署"不需要、也不建议"依赖 open-design.ai/cloud 登录——官方 Docker 镜像本身就不依赖登录即可运行核心功能。可以用「反向代理 + API Token」或「dev workspace provider 注入本地身份」把"云端验证"整体搬到自己这边;只有"多用户团队协作(成员/评论/资源分享)"才是当前产品形态下自托管做不到的硬缺口,因为官方 vela CLI 与 AMR 控制面都是闭源的(外部核查)。**

> **2026-09-04 已确认决策**:① 登录不经过 open-design.ai;② 不需要多用户团队协作;③ 不保留 AMR 云代理 UI 面(推荐);④ **以纯 web 部署为主,不需要 desktop / Claude 登录**。在此约束下,**方案 1 已足够**——见第 8、9 节。

三档方案取舍:

| 方案 | 改动量 | 云端验证由谁承担 | 协作能力 | 适用场景 | 主要代价 |
|---|---|---|---|---|---|
| **方案 1** 反向代理 + API Token | 零源码改动 | 反向代理/网关(自建) | 无(单机单身份) | 绝大多数私有化 | 单租户共享 token,无用户级身份 |
| **方案 2** dev workspace provider 注入本地身份 | 零到极小 | 本地 env/JSON 注入(`OD_DEV_WORKSPACE_CONTEXT`) | 单实例内本地"云身份"占位(身份/权限/计费),无跨节点同步 | 内网单实例、演示 | 身份是全局注入的,非按用户区分 |
| **方案 3** 完整自建控制面 | 大(需自研后端) | 自建 Vela 兼容控制面 + vela 等价 CLI | 可完整恢复(团队/评论/资源/计费) | 协作是硬需求且愿意投入 | vela CLI 闭源不可直接自托管,需重实现整套协议面 |

---

## 5. 方案对比

### 5.1 方案 1【推荐 / 零改动】反向代理 + API Token 作为"自建云端验证"

**思路**:把"谁验证用户"这一层从 open-design.ai 完全剥离——由自己的反向代理(或网关/SSO)承担验证,daemon 只认一把 `OD_API_TOKEN`。

- **反向代理本身就是验证层**:代理在 `/api/*` 上注入 `Authorization: Bearer <OD_API_TOKEN>`;若代理已对每个请求做完完整鉴权(如对接企业 SSO),可设 `OPEN_DESIGN_DISABLE_API_AUTH=1`(compose 侧,映射 daemon env `OD_DISABLE_API_AUTH`),daemon 完全跳过 token 校验、信任"每个请求都已被代理认证"(`deploy/README.md:17-26`、`.env.example:9-27`)。这样"你的网关"就是"你的云端验证"——用户在网关注册/登录,由网关发 session,daemon 侧零感知。
- **安全地板**:daemon 绑定非 loopback(如 `OD_BIND_HOST=0.0.0.0`)时,既无 token 又未禁用鉴权,启动直接报错(`apps/daemon/src/server.ts:2888-2912`)——防裸奔硬约束。
- **多用户/组织边界的解释**:这一档的"多用户"体现在**代理层**(每个用户各自在代理登录、走各自 session),daemon 仍只有一把共享 token。**daemon 内部没有用户维度**——所有用户看到同一工作区、同一身份、共享配额,这是单租户共享 token 的本质局限(`deploy/README.md:60-64` 原文:single-tenant authentication, not user-level access control)。
- **需配套**:
  - 浏览器访问时 `OD_ALLOWED_ORIGINS`(compose 侧 `OPEN_DESIGN_ALLOWED_ORIGINS`)要显式列入你的域名/公网 IP;
  - 远程暴露必须 TLS(Bearer/Basic 明文离开 localhost 必须加密,`deploy/README.md:66-84`);
  - 内网自建模型网关(LiteLLM/Ollama 等 RFC1918 地址)需 `OD_ALLOWED_INTERNAL_HOSTS` 逐个主机白名单放行 SSRF 拦截(`README.md:401`)。

### 5.2 方案 2【最小改动】dev workspace provider + `OD_DEV_WORKSPACE_CONTEXT` 注入本地"云身份"

**思路**:把"云端身份/权限/计费"这一层用本地注入替代远程控制面——`OD_WORKSPACE_CONTEXT_SOURCE` 不设成 `vela`(默认即本地),`createWorkspaceContextProviderFromEnv` 落到 `createDevWorkspaceContextProvider`(`apps/daemon/src/collab/vela-workspace-context.ts:919`、`workspace-context.ts:325`)。

- **注入方式两条**:env JSON(`OD_DEV_WORKSPACE_CONTEXT`,`workspace-context.ts:339` 的 `readEnvContext`),或运行时 `PUT /api/workspace/context`(生产 vela provider 无 set 会 404,`apps/daemon/src/routes/collab-context.ts:1056`;dev provider 的 `set` 直接改内存上下文)。
- **载荷**:经 `parseWorkspaceCollabContext` 校验(`workspace-context.ts:251`),最小只需 `workspaceMemberId + workspaceType + role + memberStatus + lifecycleState`;`seatSummary`/`permissions` 由 contracts 的 `buildWorkspaceSeatSummary`/`buildWorkspacePermissions` 派生;可选 `billingState / planId / seatLimit / usedSeats / teamId / workspaceName`。这就是"本地云身份"的完整最小集——presence/sync/team-project/资源分享等 B 平面在这个身份下都能跑,只是身份是注入的、非按用户解析。
- **覆盖范围**:协作/计费占位;配合方案 1 的网关,适合"内网单实例 + 需要一点团队/工作区面子"的部署。**注意仍是全局单一身份,不是多用户**。
- **计费面可选**:dev provider 不含真实计费,UI 上的余额/套餐展示降级为 config-only(`apps/daemon/src/integrations/vela-wallet.ts:238-246` 未登录返回 signed_out snapshot,不影响核心功能)。

### 5.3 方案 3【完整自建控制面】`VELA_API_URL` / `VELA_WEB_URL` / vela CLI 指到自托管后端

**前提核查(外部事实)**:官方 vela CLI 是 npm 包 `@powerformer/vela-cli`(打包端通过 `optionalDependencies` 精确 pin,`tools/pack/src/vela-cli.ts:176`);license=UNLICENSED、无 README;powerformer GitHub org 公开仓库中**没有 vela CLI 或 AMR 后端源码**。因此"直接自托管官方 vela/AMR 控制面"**不可行**,必须自建等价物(或退回方案 1/2)。

若走完整自建,需要实现的协议面(全部有仓库侧接线点,可逐个替换):

1. **device flow**(供 `vela login`):device 授权(token_url/user_code/轮询)整体在闭源 CLI 内,daemon 只解析激活 URL 与用户码并轮询 `~/.amr/config.json`(`vela.ts:345`、`460`)。**自建可完全绕过它**:直接注入 `VELA_CONTROL_KEY` + `VELA_API_URL`(控制面身份)、`VELA_RUNTIME_KEY` + `VELA_LINK_URL`(推理端点),`readRawVelaControlApiContext` 优先读 env(`vela.ts:751`),无需任何登录 UI 即可让 status/wallet/workspace 面全部工作。
2. **控制面 HTTP 契约**(daemon 直连,`apps/daemon/src/collab/vela-workspace-context.ts:858` 的 `fetchVelaWorkspaceDirectory` 用 `Authorization: Bearer <controlKey>` GET `{apiUrl}/api/v1/workspaces`,期望 `{ items: [...] }`,字段映射见 `vela-workspace-context.ts:196`)。至少实现:
   - `GET /api/v1/me`
   - `GET /api/v1/workspaces`
   - `GET /api/v1/wallet/balance`(`vela-wallet.ts:137`)
   - `/api/v1/message-center/*`(`routes/vela.ts:627-651`)
   - `/api/v1/analytics/events`(`vela.ts:149`)
3. **message-center**:公版(免 key,`routes/vela.ts:627-636`)与认证版(需 controlKey,`638-651`)各一套,允许 `GET /messages`、`POST /read-all`、`POST /messages/:id/read`。
4. **vela CLI 等价物**(走 `VELA_BIN` 覆盖,`apps/daemon/src/runtimes/executables.ts:16` 的 `AGENT_BIN_ENV_KEYS['amr']='VELA_BIN'`;每次调用注入 `VELA_INVOCATION_SOURCE=open-design` 与 `VELA_WORKSPACE_ID`,`apps/daemon/src/integrations/vela-command.ts:153`)。需实现的子命令(全部 JSON 输出到 stdout):
   - `collab member register/list`、`collab comment push/pull`、`collab presence heartbeat/list/leave`(`vela-cli-collab-client.ts:53-178`)
   - `team-projects list/get/upsert/remove`、`resource shared`(`vela-cli-team-projects.ts:93-188`)
   - `resource push/head/pull/remove`、`resource pull-batch --requests-file -`(stdin 传 JSON,`vela-cli-resource-adapter.ts:186-301`、`389`)
   - `model preset`、`model list --all`(`amr.ts:573/588`)
   - `billing summary --format json`、`billing workspace-snapshot/workspace-balance`、`billing checkout`(`amr.ts:632`、`vela-billing.ts:90/119/198`)
5. **注意独立的三个开关**:`OD_COLLAB_TRANSPORT` / `OD_TEAM_PROJECTS_TRANSPORT` / `OD_RESOURCE_TRANSPORT=vela-cli` 与 `OD_WORKSPACE_CONTEXT_SOURCE=vela` 相互独立(`vela-cli-collab-client.ts:246` 等),可按子面渐进替换;所有 provider 失败都降级 null→单机模式,绝不 throw。

**唯一天然绕不过的硬编码**:`AMR_API_UPSTREAM_ORIGIN = 'https://amr-api.open-design.ai'`(`apps/daemon/src/routes/vela.ts:63`)用于 `/api/integrations/vela/api-proxy/*` 代理(只放行 `/api/v1/*`,`vela.ts:254-339`),且登录回退代理也用它(`vela.ts:706`)。**无任何 env 覆盖**。自建时要么改这一行源码读 `VELA_API_URL`,要么在反代层把该前缀单独重写到你的控制面。**这是全仓唯一一处必须动源码(或反代补丁)的 amr-api 端点。**

---

## 6. 落地清单(三档)

### 6.1 档 1:纯 Docker 私有化(零源码改动,方案 1)

1. **环境**:`cd deploy && cp .env.example .env`;`openssl rand -hex 32` 生成 token 填入 `OD_API_TOKEN`(install.sh 会自动生成随机 token,`deploy/scripts/install.sh:411-421`)。
2. **暴露方式二选一**:
   - 本机 `http://127.0.0.1:7456` 直连;或
   - 反代 TLS + 注入 Bearer + 设 `OPEN_DESIGN_ALLOWED_ORIGINS=https://你的域名`(`.env.example:9-24`)。
3. **遥测全关**:不设 `POSTHOG_KEY`、`OPEN_DESIGN_TELEMETRY_RELAY_URL`、`LANGFUSE_*`,留空 `OPEN_DESIGN_AMR_ANALYTICS_URL`(`apps/daemon/src/analytics.ts:179-198`、`langfuse-trace.ts:424-473`);必要时设 `OPEN_DESIGN_VELA_TELEMETRY=off`。⚠️ **不存在 `OD_DISABLE_TELEMETRY` 这个 env**(确认无此变量),关闭逻辑是"不设 key 即 no-op + consent 门";fresh install 默认 `telemetry.metrics/content=true`,严格无外发需在 Settings→Privacy 关闭或把 `app-config.json` 的 telemetry 置 false(`apps/daemon/src/app-config.ts:714-722`)。
4. **模型**:不设任何 `VELA_*`,onboarding 选本地 CLI 或 BYOK;`DEEPSEEK/ANTHROPIC/OPENAI_API_KEY` 经 `.env` 注入(`deploy/README.md:53-58`)。⚠️ 官方 Docker 镜像**不打包** Claude/Codex 等 CLI 二进制(`deploy/README.md:91-93`);要本地 CLI 需 Linux 用 `docker-compose.linux.yml` 挂载宿主 CLI + `Dockerfile.local` 构建 glibc 兼容镜像(`deploy/docker-compose.linux.yml:1-64`);否则直接用 BYOK。
5. **数据**:`docker compose up -d --no-build`(镜像 `ghcr.io/nexu-io/od`,需 GHCR 可见性为 Public,`deploy/README.md:31-40`);数据卷 `open_design_data` 挂 `/app/.od`(`docker-compose.yml:22-31`),SQLite/app-config/制品全在里面(`apps/daemon/src/server.ts:1289-1361`、`3191`),**定期备份该卷即完成备份**。容器 uid=1001(`deploy/README.md:148-154`)。
6. **不做**的:不设 `OD_WORKSPACE_CONTEXT_SOURCE`(默认 dev provider)、不设 `OD_COLLAB_TRANSPORT` 等三个 `*_TRANSPORT=vela-cli`;容器内不跑 `vela login`。

**要改的源码:无。**

### 6.2 档 2:最小源码改动(方案 2,内网单实例本地云身份)

1. 在档 1 基础上,注入 `OD_DEV_WORKSPACE_CONTEXT`(JSON)或运行时 `PUT /api/workspace/context` 写入 workspace 身份(`apps/daemon/src/collab/workspace-context.ts:339`、`routes/collab-context.ts:1056`)。字段见 4.2 节。
2. **模型可更进一步**:设 `VELA_RUNTIME_KEY` + `VELA_LINK_URL` 指向自建 OpenAI 兼容网关(vLLM/Ollama/LiteLLM),登录状态即 `loggedIn: true`(`vela.ts:510-521`),AMR 云代理 UI 面可正常显示;⚠️ 模型目录需网关侧提供 vela 兼容的 models 目录(否则 AMR 路径 fail-closed 选不到模型,`amr.ts:573-616`、`667-701`;BYOK 无此限制)。
3. 内网网关需 `OD_ALLOWED_INTERNAL_HOSTS` 白名单(`README.md:401`;基于主机名、不支持 CIDR,`origin-validation.ts:51-90`)。
4. 若走 `OD_WORKSPACE_CONTEXT_SOURCE=vela` 指自建控制面:设 `VELA_API_URL=<自建>`、`VELA_CONTROL_KEY=<你的key>`、`OPEN_DESIGN_AMR_PROFILE=test`(**必须非 prod**,否则 web 控制台/定价链接钉死公开站点,`apps/web/src/runtime/amr-guidance.ts:68-84`)、`OD_VELA_WEB_URL=<你的控制台>`;需实现 `GET /api/v1/workspaces`(`vela-workspace-context.ts:858`)。⚠️ env 型会话 `user=null`(只有 control key,无用户级身份,`vela.ts:510-521`)。
5. **唯一必改源码(或反代补丁)**:`routes/vela.ts:63` 的 `AMR_API_UPSTREAM_ORIGIN` 改读 `VELA_API_URL`,或在反代把 `/api/integrations/vela/api-proxy/` 单独重写到自建控制面(web message-center 读路径走它)。

**要改的源码:仅 `apps/daemon/src/routes/vela.ts:63`(把上游参数化)。**

### 6.3 档 3:完整自建控制面(方案 3)

1. 部署自建控制面服务,实现:device-auth(可选,可用 env 凭证绕过)、`/api/v1/me`、`/api/v1/workspaces`、`/api/v1/collab/events`(hub 订阅,`apps/daemon/src/server.ts:5717`、`hub-events-subscriber.ts:3`)、`/api/v1/message-center/*`、`/api/v1/wallet/balance`、`/api/v1/analytics/events`。
2. **源码改动**:`routes/vela.ts:63` 上游参数化;可选把 attribution/marketplace/telemetry 默认域名统一参数化(`routes/attribution.ts:16/95/274` 走 `OD_ATTRIBUTION_LEDGER_URL`、`plugins/marketplaces.ts:77-89`、`integrations/telemetry-relay.ts:1-19`)。⚠️ **marketplace 的覆盖变量名在调研中存在两处不一致(`OD_MARKETPLACE_REGISTRY_PATH` vs `OD_MARKETPLACE_REGISTRY_BASE_URL`),需进一步核实确切变量名**。
3. **自建控制台**(open-design.ai/cloud 对等物):用非 prod profile + `OD_VELA_WEB_URL`(`vela-console-origin.ts:8-64`;prod profile 下 web 钉死公开定价/控制台链接,`amr-guidance.ts:77-79`,所以必须非 prod);打包期经 `OD_VELA_WEB_URL_PROD|_TEST|_FEATURE_TEST|_LOCAL` 写入 `open-design-config.json`(`tools/pack/src/config/index.ts:259-288`、`apps/packaged/src/config.ts:26-78`)。
4. **自建更新源**:用 `tools-serve` 起 updater fixture(`tools/serve/AGENTS.md:8`),配 `OD_UPDATE_METADATA_URL` / `OD_UPDATE_DOWNLOAD_ROOT` / `OD_UPDATE_CHANNEL`(`apps/desktop/src/main/updater/config.ts:41/117-119/222`)。
5. 可选自建 PostHog(`POSTHOG_KEY`+`POSTHOG_HOST`,`analytics.ts:42`)与 Langfuse(或 `OPEN_DESIGN_TELEMETRY_RELAY_URL` 指自建中继)。
6. 每节点接入反向代理(TLS + Bearer 注入 + `OD_ALLOWED_ORIGINS` + SSRF 白名单);desktop 打包端经 `workspaceTeamTransportEnv` 自动注入 `OD_WORKSPACE_CONTEXT_SOURCE=vela` + 三个 `*_TRANSPORT=vela-cli` + `OD_VELA_WEB_URL`(`apps/packaged/src/workspace-team.ts:15-43`,且要求 profile∈{feature-test,prod,test} 且有 velaWebUrl 才生效)。

**建议路径:先做档 2 验证 env-only 子集,再决定是否投入完整后端。**

---

## 7. 风险与缺口

1. **单 token 无多租户**(方案 1 的根本局限):一把 `OD_API_TOKEN` 是单租户共享凭证,无用户注册/会话/配额/权限体系,仓库无任何 OIDC/SSO/SAML/LDAP 支持(`deploy/README.md:60-64`;grep 命中的 `mcp-oauth.ts` 是 MCP 服务器 OAuth,与用户登录无关)。"多用户"只能靠代理层会话解决,daemon 内部仍是一个身份。方案 2 的 dev provider 同样是全局单一身份。
2. **vela 不自托管时的协作缺失**(方案 1/2 的代价):团队工作区/成员/邀请/席位计费依赖 `OD_WORKSPACE_CONTEXT_SOURCE=vela` 的云端 B 目录;不设则整个 B 平面休眠,评论云同步/公开链接发布直接 no-op(`apps/daemon/src/collab/collab-cloud-service.ts:6-9`、`routes/collab-sync.ts:578-582` "Publishing a public link needs a signed-in workspace")。且官方文档确认 prod profile 对公网生产环境显式关闭 Workspace Team transport(`docs/deployment/workspace-team-rollout.md:37-54`,缺 prod URL 时 fail-closed)——也就是说即使自托管,团队协作也是当前产品形态下最不成熟的一块。独立评论 relay(`OD_COLLAB_CLOUD_URL`+`OD_COLLAB_CLOUD_TOKEN`,`collab-cloud.ts:28-40`)是**可自托管的独立通道**,可作跨 daemon 评论的备选,但与 open-design.ai 登录无关、不设即离线。
3. **遥测关闭后的影响**:按档 1 清单全关后,剩余外发面极少——`captureSafety`(崩溃/稳定性事件)故意绕过 consent 门(`apps/daemon/src/analytics.ts:224-230`),属工程惯例;`OPEN_DESIGN_VELA_TELEMETRY` 默认开、但只有存在 `VELA_CONTROL_KEY` 时才真正外发到 amr-api(`langfuse-trace.ts:487-525`),不登录即无此流量。整体可控。
4. **硬编码域名清单**:除 `routes/vela.ts:63`(api-proxy 上游,无覆盖)外,`download.open-design.ai`(attribution,可覆盖)、`telemetry.open-design.ai`(可覆盖)、`us.i.posthog.com`(可覆盖)、`open-design.ai/marketplace`(URL 规范化)、`open-design.ai/cloud`(控制台链接,`OD_VELA_WEB_URL` 可注入但 prod profile 钉死)、`repo-assets.open-design.ai`(样式目录预览图,**未发现 env 覆盖,纯可选素材**)——全部为可选增强,均非登录必需。
5. **版本升级链路**:镜像用 `ghcr.io/nexu-io/od:<version>` 钉版本(`deploy/README.md:31`),更新走 `update.sh`(`deploy/scripts/update.sh:116-152`)。desktop 打包形态才有 `OD_UPDATE_*` 自建更新源链路;纯 Docker 部署直接换镜像即可,数据卷沿用。⚠️ 升级前确认新版对 `app-config.json`/SQLite schema 的兼容;自建控制面(方案 3)若随版本迭代需同步维护协议契约,升级成本最高。
6. **AMR 模型目录依赖**:AMR 路径 `supportsCustomModel: false`、`fallbackModels` 为空(fail-closed),模型必须来自 vela 实时目录(`amr.ts:667-701`);自建网关必须能返回 vela 兼容 models 目录,否则 AMR 路径选不到模型。BYOK 路径无此限制。
7. **connector 端点(Composio/GitHub OAuth)要求 daemon 侧看到 loopback 来源**:Linux 用 `docker-compose.linux.yml` 的 host 网络,macOS/Windows 用 loopback 反代(`deploy/.env.example:16-24`)。

---

## 8. 明确推荐

**首选「纯 web 方案 1」**(基于已确认决策,见第 9 节):**官方 Docker 镜像 + 反向代理承担用户验证 + `OD_API_TOKEN` 保护 daemon + agent 走 BYOK(任意 OpenAI 兼容端点)+ 图片走媒体 provider(自建 `custom-image` 或商业 API 带 key)+ 不保留 AMR 云代理面 + 遥测全关**。这套组合**零源码改动**(不用 AMR 云代理与消息中心,连 `routes/vela.ts:63` 都不用碰),浏览器访问你的域名即可完成 **UI 设计、PPT、图片生成**,登录不经过 open-design.ai。

- 已确认**纯 web 部署、不需要 desktop、不需要 Claude 登录**(第 2 节)——desktop 改造(第 11 节)仅在需要原生桌面客户端时才做,不阻塞主路线。
- 已确认**不用多用户团队协作** → 方案 2 的 `OD_DEV_WORKSPACE_CONTEXT` 注入、方案 3 的自建控制面**均非必需**;`OD_WORKSPACE_CONTEXT_SOURCE` 保持默认(dev provider)即可,协作平面自然休眠。
- 已确认**不保留 AMR 云代理 UI 面** → 无需 `VELA_*` 环境变量、无需自建 OpenAI 兼容网关、无需 vela 兼容 models 目录;模型访问只保留 本地 CLI + BYOK 两条免登录通道。
- 唯一可选的源码改动:把 onboarding 的 AMR"云代理"卡片隐藏,让用户**点不到** open-design.ai 登录/充值入口(目前无配置开关,需改 `apps/web/src/components/EntryShell.tsx`,约 3713-3744 行)与相关 AMR 引导卡片(`amr-guidance.ts` 的 AMR_CONSOLE_URL)。不做也安全——只要用户不选"云代理",AMR 通道不会触发。

仅当**将来**需要多用户团队协作或云模型托管时,才回头评估方案 2/3(详见第 5 节与第 7 节风险)。

---

## 9. 决策记录与待确认事项

### 9.1 已确认决策(2026-09-04)

| # | 决策 | 结论 | 影响 |
|---|---|---|---|
| 1 | "云端验证"的含义 | **登录不经过 open-design.ai**;在自建反向代理/网关上完成用户验证 | 反向代理层承担用户维度(方案 1);daemon 内部无用户维度,可接受 |
| 2 | 是否需要多用户团队协作 | **不需要**(成员目录、评论云同步、资源分享) | 协作平面休眠;方案 2/3 均非必需 |
| 3 | 是否保留 AMR 云代理 UI 面 | **不保留**(已确认;AMR 是全产品唯一通向 open-design.ai 登录/充值的通道) | 模型只走本地 CLI/BYOK;需要源码改动隐藏 onboarding AMR 卡片(见第 10 节) |
| 4 | 部署形态 | **纯 web 为主;不需要 desktop、不需要 Claude 登录**;目标能力 = UI 设计 / PPT / 图片生成 | 见第 3 节;desktop 改造(第 11 节)仅在需要原生客户端时再做 |

### 9.2 剩余待确认

| # | 待确认 | 影响 |
|---|---|---|
| 4 | **marketplace 覆盖变量名**待核实:`OD_MARKETPLACE_REGISTRY_PATH` vs `OD_MARKETPLACE_REGISTRY_BASE_URL`。 | 仅走完整自建控制面时需确认;当前方案 1 不涉及。 |
| 5 | **遥测策略**:是否要求"完全无外发"(含崩溃/稳定性事件 `captureSafety`,它故意绕过 consent 门)? | 完全无外发需额外源码改动或网络层阻断;当前方案 1 已把常规遥测关掉(`POSTHOG_KEY`/`OPEN_DESIGN_TELEMETRY_RELAY_URL`/`LANGFUSE_*` 留空)。 |

---

## 10. 不保留 AMR:实施选项

**范围评估**(2026-09-04 实测):AMR 面在 web 端跨约 40 个文件——`EntryShell.tsx`(184 处引用)、`InlineModelSwitcher.tsx`(182)、`SettingsDialog.tsx`(162)、`App.tsx`(120)、`ChatPane.tsx`(79)、`ProjectView.tsx`(64)等。**彻底剥离 = 大规模功能移除 + 19 个 i18n locale 全量同步,会产生与上游的持续分叉,不推荐。**

### 10.1 推荐:轻量屏蔽(3 处定向改动,贴近上游、可维护)

1. **默认执行方式改为本地/BYOK**:`apps/web/src/components/EntryShell.tsx:2131` 的 `useState<'amr' | 'local' | 'byok'>('amr')` 默认值改 `'local'`(或 `'byok'`)——新用户不再默认落在"云代理"上。
2. **隐藏 onboarding 的 AMR"云代理"卡片**:同文件 ~3713-3744 的三选一 `Button` 对 `modelSource==='amr'` 的条件渲染改为按部署配置隐藏(例如新增 `OD_HIDE_AMR=1` 部署开关,或直接移除该卡片),让该入口对用户不可见。
3. **部署侧配合(必做)**:不设任何 `VELA_*`、不设 `OD_WORKSPACE_CONTEXT_SOURCE=vela` → daemon 侧 AMR 通道天然不激活;官方 Docker 镜像不含 vela 二进制,即使被选中也无法完成登录。

可选追加(防残留入口引向 open-design.ai):`apps/web/src/runtime/amr-guidance.ts:22-25` 的 `AMR_CONSOLE_URL`(`https://open-design.ai/amr/dashboard`)置空或改自建地址;并随之隐藏其引用面(`AmrLoginPill`、`chat.amrCard.*`/`chat.amrError.*` 文案等)。

### 10.2 不推荐:彻底移除(约 40 web 文件 + 19 locale)

仅当目标是**长期独立 fork**(不跟随上游升级)时才考虑。升级/合入上游时每次都要重新处理这些改动,维护成本高。当前私有化部署不需要。

### 10.3 效果

轻量屏蔽后,私有化部署的 UI 对用户呈现:**执行方式只有「本地」与「BYOK」,不存在任何 OpenDesign Cloud 入口**;AMR 相关的登录/充值引导、余额闸、低余额弹窗在未被选中的前提下不会触发;整个产品不再出现通向 open-design.ai 的交互路径。

---

## 11. 可选:原生 desktop 客户端连接私有部署(仅在需要桌面端时)

> **定位**:纯 web 路线(第 2 节)已满足全部能力目标,本节**不阻塞主路线**。仅当你**需要原生桌面客户端**指向私有部署时执行。改动集中在 5 个文件,**web 侧零改动**。

### 11.1 现状架构(desktop 是"必须本地"的硬链路)

打包入口 `apps/packaged/src/index.ts` 的 `main()` 在 `app.whenReady()` 后无条件做四件事:

1. **拉起本地 daemon + web 两个 sidecar**:`startPackagedSidecars`(`index.ts:285`,无任何跳过条件)。
2. **`od://` 协议代理指向本地 web**:`registerOdProtocol(() => sidecars.currentWebUrl())`(`index.ts:338`),把 `od://app/<path>` 改写到本地 web 的 `http://127.0.0.1:<port>`(`protocol.ts:51-64`),经 main 进程 `net.fetch` 中转。
3. **renderer 入口 = `od://app/`**:`discoverWebUrl()` 返回 `od://app/`(`index.ts:372-374`);desktop runtime 里 `window.loadURL(url)`(`runtime.ts:2962-2977`)。
4. **main 进程 fetch 直连本地 daemon**:`discoverDaemonUrl()` 返回 `sidecars.daemon.url`(`index.ts:379-381`)。

**桌面鉴权(HMAC)**:每次启动 mint 进程级 secret,经 sidecar IPC 注册给本地 daemon(`index.ts:1054-1066`)。**普通 /api 请求今天完全不鉴权**——daemon 的 API-token 中间件对 loopback peer 直接放行(`server.ts:2969`)。

> 仓库现状确认:**没有任何"跳过本地 sidecar / 连远程 server"的既有模式或开关**(检索 `OD_SERVER/OD_REMOTE/OD_BASE_URL` 等无命中)。必须新增一条独立分支。

### 11.2 推荐路线 = "完全远程"

以 `OD_REMOTE_URL` 存在为触发开关,打包入口**跳过本地 sidecar**,主窗口直接 `loadURL(https://你的域名/)`,`discoverDaemonUrl` 同指远程;鉴权用 `OD_API_TOKEN` 经 **webRequest(renderer)+ 主进程 fetch** 双路注入 Bearer。

| 路线 | 结论 |
|---|---|
| **A. 完全远程(推荐)** | renderer 与 API 同源免 CORS;cookie/SSO 登录才成立;避免本地 daemon/web 空转 |
| B. 保留本地 sidecar 仅 URL 指远程 | 改动最小但 od:// 存不下远程 cookie → SSO 失效、WS 不保证、数据混淆;仅调试过渡 |
| C. 本地起 web、daemon 连远程 | 不成立——单镜像 web 与 daemon 同进程同源拆不开 |

### 11.3 分步实现

1. **配置项**:`OD_REMOTE_URL`(远程 https 基址,存在即触发远程模式)+ `OD_API_TOKEN`(运行时 env 注入,**禁止 bake 进包**,参考 `server.ts:1731`)。config 落点:`RawPackagedConfig`/`PackagedConfig` 加 `remoteUrl`(`apps/packaged/src/config.ts:26-78`),resolve 时 `env.OD_REMOTE_URL ?? raw.remoteUrl`。
2. **跳过本地 sidecar**(`apps/packaged/src/index.ts`):跳过 `startPackagedSidecars`(`:285`),造 stub handle 满足 `PackagedSidecarHandle`(`daemon/web:{url: remoteUrl}`、`currentWebUrl: () => remoteUrl`);`discoverWebUrl`/`discoverDaemonUrl` 返回 remoteUrl(`:372-381`);`registerDesktopAuth` 改 no-op 返回 false(`:382-394`,失败仅 warn 不致命 `index.ts:683-689`);跳过 `claimPackagedDownloadAttribution`(`:323-330`);`beforeShutdown` 不再 `sidecars.close()`;单实例锁/launcher/命名空间路径保留。
3. **鉴权注入**:renderer 走 `session.defaultSession.webRequest.onBeforeSendHeaders` 注入 `Authorization: Bearer <token>`;主进程 fetch(`readAppConfigFromDaemon` 等 `index.ts:330-359`、observability `runtime.ts:1985`、updater 读 `/api/app-config` `index.ts:975-982`)抽 `getRemoteAuthHeader()` 统一带。备选 `app.on('login')` Basic 回填(对 XHR 401 不可靠,不主推)。
4. **od:// 兜底**(`apps/packaged/src/protocol.ts`):子窗口仍放行 `od:`(`runtime.ts:1610-1638`),保留 `registerOdProtocol(() => remoteUrl)`;`fetchOdTargetOnce` 增加可选 authorization 注入(`protocol.ts:187-196`);**Origin 重写**——od:// 请求带 `Origin: od://app`,远程 `isAllowedBrowserOrigin` 只认 http/https(`origin-validation.ts:176-191`)必 403,需改写为 remoteUrl 的 origin 或删除。
5. **失效特性降级**:
   - 本地文件夹导入 → 自然降级(远程 `fs.realpath` 400 folder not found,`import-export-routes.ts:274-288`);
   - `shell:open-path` → 禁用(服务器路径本地打开无意义,`runtime.ts:2209-2236`);
   - updater → 远程模式设 `OD_UPDATE_ENABLED='0'` 关闭(`updater/config.ts:33/165-166`);想要自有源可配 `OD_UPDATE_METADATA_URL`;
   - 邀请 deeplink → 禁用(云协作专属,`invite-deeplink-core.ts:167-210`);
   - artifact/PDF/deck/frame 导出 → 触发链路休眠(本地 daemon 派发,`index.ts:856-865`),渲染能力仍可用;
   - splash/崩溃恢复/design-browser → 原样可用(纯本地 OS 级)。

### 11.4 需改源码文件清单

**必须改**:`apps/packaged/src/index.ts`(远程分支)、`apps/packaged/src/config.ts`(remoteUrl)、`apps/desktop/src/main/index.ts`(remote 选项 + 主进程 fetch 带 token)、`apps/desktop/src/main/runtime.ts`(webRequest 注入)、`apps/packaged/src/protocol.ts`(od:// 兜底 Bearer + Origin 重写)

**建议改**:`tools/pack/src/config/index.ts`(bake `OD_REMOTE_URL`,token 不 bake)、打包测试用例

**可选(二期)**:web Settings 加"远程服务器地址 + Token"配置入口

### 11.5 风险与边界

- **鉴权测试的坑**:daemon 对 loopback peer 豁免(`server.ts:2969`)——**本地用 127.0.0.1 起假远程根本测不到鉴权,必须用非 loopback 地址**。
- cookie/SSO 登录必须走"直接 https + webRequest"路线(od:// 路径与 renderer cookie jar 不共享)。
- 完全远程 = 网络依赖,断网不可用——与"本地优先"架构本质不同,需需求层面确认。

### 11.6 验证方式

1. **本地假远程**:`pnpm --filter @open-design/web build` 产出 web/out,`OD_BIND_HOST=0.0.0.0 OD_API_TOKEN=...` 起 daemon(或 `docker compose up`);**用非 loopback 地址访问**(局域网 IP:7456)。
2. **打包验证**:`OD_REMOTE_URL=https://<host> pnpm tools-pack mac build --to all` 后 install;或运行时注入 env。验证:启动后 ps 无本地 sidecar 子进程、窗口直接加载远程、聊天/项目可用。
3. **测试矩阵**:token 对/错、远程不可达(走 did-fail-load 重试,`runtime.ts:2962-2997`)、updater 菜单隐藏、import 远程 400 报错、子窗口 od: 兜底。

---

## 附录:证据索引

本报告引用集中以下文件(均为仓库相对路径),行号详见正文:

- `deploy/README.md`、`deploy/.env.example`、`deploy/docker-compose.yml`、`deploy/docker-compose.linux.yml`、`deploy/scripts/install.sh`、`deploy/scripts/update.sh`
- `apps/daemon/src/routes/vela.ts`、`apps/daemon/src/integrations/vela.ts`、`apps/daemon/src/integrations/vela-wallet.ts`、`apps/daemon/src/integrations/vela-command.ts`、`apps/daemon/src/integrations/vela-console-origin.ts`
- `apps/daemon/src/collab/vela-workspace-context.ts`、`apps/daemon/src/collab/workspace-context.ts`、`apps/daemon/src/collab/collab-cloud-service.ts`、`apps/daemon/src/collab/vela-cli-*.ts`、`apps/daemon/src/collab/collab-cloud.ts`
- `apps/daemon/src/runtimes/defs/amr.ts`、`apps/daemon/src/runtimes/executables.ts`、`apps/daemon/src/runtimes/amr-model-probe.ts`
- `apps/daemon/src/analytics.ts`、`apps/daemon/src/langfuse-trace.ts`、`apps/daemon/src/app-config.ts`、`apps/daemon/src/server.ts`
- `apps/daemon/src/origin-validation.ts`、`apps/daemon/src/api-token-auth.ts`、`apps/daemon/src/routes/collab-context.ts`、`apps/daemon/src/routes/collab-sync.ts`、`apps/daemon/src/routes/attribution.ts`
- `apps/web/src/components/EntryShell.tsx`、`apps/web/src/components/ProjectView.tsx`、`apps/web/src/runtime/amr-guidance.ts`、`apps/web/src/App.tsx`
- `apps/packaged/src/workspace-team.ts`、`apps/packaged/src/config.ts`、`apps/packaged/src/index.ts`、`apps/packaged/src/protocol.ts`、`apps/packaged/src/sidecars.ts`、`tools/pack/src/vela-cli.ts`、`tools/pack/src/config/index.ts`
- `apps/desktop/src/main/index.ts`、`apps/desktop/src/main/runtime.ts`、`apps/desktop/src/main/updater/config.ts`、`apps/desktop/src/main/invite-deeplink-core.ts`
- `apps/daemon/src/media/models.ts`(媒体 provider 目录)、`apps/daemon/src/media/config.ts`(provider 凭证 env 注入)、`apps/daemon/src/routes/media.ts`、`apps/daemon/src/routes/chat.ts`(/api/proxy/* BYOK 路由)、`apps/daemon/src/deck-export.ts`、`apps/daemon/src/export-cli-request.ts`
- `plugins/marketplaces.ts`、`docs/deployment/workspace-team-rollout.md`、`README.md`
