# dsh-prompt-enhance v2 设计：无会话的结构化提示词增强

> 状态：已实现，随 v1.0.0 发布（2026-11-07）。本文保留为设计记录，描述的
> `P0`–`P2` 能力已在 `lib/` 中落地；实现细节以 README 与 `docs/audit.md` 为准。
> 读者：维护者与希望理解取舍的贡献者。
> 范围：`dsh-prompt-enhance` 插件 v2；替换 v1 的「新建 DSH 会话 + 文本拼装」实现。
> 部署环境：DSH Web profile，Node 20+。
> 公开说明：本文原始内部路径已脱敏为 `<repo>`、`<workspace>`、`<plugins>`、
> `<gateway>`、`$DSH_HOME` 等占位符。

---

## 1. 问题精确化

用户对 v1 的两条否证，拆成可检验的断言。**每条断言都给出 v1 的代码位置**，v2 的验收就是逐条把断言变成假。

| 编号 | 断言 | v1 的证据 | v2 的证伪条件 |
|---|---|---|---|
| A1 | 增强过程产生了一条可枚举的 DSH 会话 | `lib/index.js:235` 调 `sessionController.create({agentPreset})` | 全仓库 `grep -n "sessionController\.\(create\|prompt\|fork\)" lib/` 为空 |
| A2 | 该会话被持久化并进入工作区列表 | `lib/index.js:226-231` 用目标会话的 `workspaceId` 建会话；会话落盘见 `dsh-session/lib/types/index.d.ts:28`（`sessions: SessionStore`） | 跑完整流程后 `$DSH_HOME/sessions` 下文件数不变 |
| A3 | 上下文与粗糙提示词被拼成一条 user message | `lib/index.js:151-196`（`composeFirstMessage`）+ `:253-271`（`prompt({content:[{type:'text'}]})`） | `buildMessages()` 单测断言：消息数 ≥2、无 `<conversation>`/`<rough_prompt>` 标签、digest 块可 `JSON.parse` |
| A4 | 客户端靠**文本正则**发现增强会话 | `lib/client.js:370` 从 `result.text` 抓 `session-…` | 客户端不再解析任何命令结果文本（`grep -n "result.text" lib/client.js` 为空） |
| A5 | 客户端靠**代码围栏**从聊天里切最终提示词 | `lib/client.js:105-121`（`fencedPrompt`）、`:124-145`（`extractFinalPrompt`） | 最终提示词来自结构化字段 `prompt.markdown`，不再扫描消息内容 |

改写成两条设计命题：

1. **会话语义 ≠ DSH 会话**：多轮澄清需要的是「有序消息 + 轮次状态 + 取消 + 失败处理」，这几件事插件内存即可自持（`RunState`），不需要 `Session` 实体、不需要 log、不需要 agent preset。
2. **结构化参数 ≠ 拼字符串**：模型侧的输入输出用**分角色的消息**与**工具调用参数**承载；插件与客户端之间用 **JSON 契约**承载。任何「把 A、B、C 拼成一段话再塞进某条消息」的路径都不进入默认链路。

---

## 2. 设计原则

1. **零 DSH 会话**：不调用 `sessionController.create/prompt/fork`，不新增 preset 行；增强过程只存在于插件内存 + 客户端面板。会话列表、工作区、`$DSH_HOME/sessions` 不因 `/enhance` 增加任何条目。
2. **数据走带 schema 的通道**：模型侧用 `tools` 参数 + 工具结果，客户端↔宿主用 HTTP JSON；人只读最终 `prompt.markdown`。
3. **最少活动部件**：复用 `commands`（入口）、`webServer`（数据平面）、`sidebarRight`（面板）、`inputActions.setDraft()`（回写）；不自造 Remote 命名空间、不写 typert 元数据。
4. **状态权威在宿主，界面是可丢弃的视图**：面板刷新、换标签页、换浏览器都不改变事实；进程重启允许直接丢状态，但用户必须看到明确的可读提示。
5. **失败可读**：每个失败面有稳定错误码 + 中英文案；模型输出不合法时先纠错重试一次，仍失败才标记 `failed`。

---

## 3. 总体架构

### 3.1 职责边界

| 侧 | 负责 | 不负责 |
|---|---|---|
| 宿主 `lib/index.js` | 注册 `/enhance` 命令；折叠目标会话 digest；持有 `RunState` 表；调 `ctx.llm.stream`；校验模型输出；执行只读工具；提供 HTTP JSON 端点 | 渲染、提问卡片、草稿写入 |
| 浏览器 `lib/client.js` | 注册右侧栏 page tab；面板 UI（提问卡片、结果编辑、复制、插入）；轮询状态；调用 HTTP 端点；`inputActions.setDraft()` | 任何模型调用、任何上下文折叠、任何持久化 |
| DSH 宿主服务 | `commands` / `webServer` / `llm` / `web` / `fs` / `workingDirectory` / `sessions` | 不被插件修改 |

### 3.2 端到端时序

```
用户：/enhance 帮我做个记账工具（可留空）
  │
  │ ①  Composer ── commands/execute(sessionId, "/enhance …") ──▶ 宿主命令 handler
  │                                                                ├─ ctx.sessions.get(sessionId) → 活会话
  │                                                                ├─ visibleEvents(session) → buildDigest() → JSON
  │                                                                ├─ runs.seed(sessionId, {rough, digest, cwd})
  │                                                                └─ 立即返回（不等模型）
  │  ◀── command/done {kind:'success', text:'已打开提示词增强面板'} ─┘
  │
  │ ②  Client 监听 command/executed(name==='enhance', success)
  │       └─ ctx.sidebarRight.openTab('promptenhance')
  │
  │ ③  Panel ── POST /prompt-enhance/start {session} ──▶ Host
  │       Host：seed → RunState(phase=collecting) → ctx.llm.stream(req1)
  │  ◀── 200 {ok:true, state:{phase:'collecting'}}
  │
  │ ④  Panel 轮询 GET /prompt-enhance/state?session=…（700ms，仅 collecting/drafting 时）
  │       Host：模型调 ask_questions → 校验 → phase=questioning, questions=batch
  │  ◀── 200 {ok:true, state:{phase:'questioning', questions:{…}}}
  │
  │ ⑤  用户作答 → POST /prompt-enhance/answer {session,runId,batchId,answers[]}
  │       Host：answers 作为 tool result 追加 → ctx.llm.stream(req2) → phase=drafting
  │  ◀── 200 {ok:true, state:{phase:'drafting'}}
  │
  │ ⑥  模型调 deliver_prompt → 校验 → phase=ready
  │  ◀── 200 {ok:true, state:{phase:'ready', prompt:{title,markdown,assumptions}}}
  │
  │ ⑦  用户点「插入到输入框」
  │       Client：inputActions.setDraft(prompt.markdown)
  │       Client ── POST /prompt-enhance/take {session,runId} ──▶ Host：phase=inserted
  │
  └─ 用户取消 → POST /prompt-enhance/cancel → abort LLM → phase=cancelled
```

### 3.3 通道与权威

| 段 | 通道 | 载荷 | 状态权威 |
|---|---|---|---|
| ① 入口 | `commands/execute`（宿主 `ctx.commands`，客户端 `ctx.remote.commands.execute`） | 命令行文本（仅粗糙提示词，≤8 KiB） | 宿主命令 handler |
| ② 打开面板 | 客户端事件 `command/executed` | 无（只读 `name`/`kind`） | 客户端 |
| ③④⑤⑥ | 自定义 HTTP 路由 `/prompt-enhance/*` | JSON | 宿主 `RunState` |
| 模型调用 | `ctx.llm.stream` | `system` + `messages` + `tools` | 宿主 |
| ⑦ 回写 | `inputActions.setDraft`（客户端本地） | 纯文本 | 客户端编辑器 |

---

## 4. 会话状态机

### 4.1 状态

| 状态 | 进入条件 | 允许动作 | 超时 / 清理 |
|---|---|---|---|
| `idle` | 没有 run（或已过期回收） | `start` | — |
| `collecting` | `POST /start` 取到 seed，第 1 次 LLM 调用在飞 | `cancel`、轮询 | 单次调用 ≤120 s → `failed` |
| `questioning` | 模型产出合法的 `ask_questions`（1–3 问） | `answer`、`cancel` | 15 min 未答 → `expired` |
| `drafting` | 收到 answers 后第 2 次及以后的调用在飞 | `cancel`、轮询 | 单次调用 ≤120 s → `failed` |
| `ready` | 模型产出合法的 `deliver_prompt` | `take`、`start(restart)`、`cancel` | 30 min → `expired` |
| `inserted` | `take` 成功 | 重新 `take`、`start(restart)` | 30 min → `expired` |
| `failed` | LLM 失败 / 两次校验失败 / 工具超限 | `start(restart)`、`cancel` | 30 min → `expired` |
| `cancelled` | 用户取消、或同会话启动新 run | `start(restart)` | 立即保留 5 min 供 UI 展示，然后回收 |
| `expired` | TTL 到点 | `start(restart)` | 先置 `expired` 保留 60 s 让 UI 读到，再回收 |

### 4.2 迁移表

```
idle        --start--------------------> collecting
collecting  --ask_questions-------------> questioning     (批量入队，phase 切换)
collecting  --deliver_prompt------------> ready
collecting  --llm_error / invalid×2-----> failed
questioning --answer(batchId 匹配)-------> drafting
questioning --cancel / 新 run / TTL------> cancelled / cancelled / expired
drafting    --ask_questions-------------> questioning
drafting    --deliver_prompt------------> ready
drafting    --llm_error / invalid×2-----> failed
ready       --take----------------------> inserted
ready       --restart-------------------> collecting
failed      --restart-------------------> collecting
cancelled   --restart-------------------> collecting
inserted    --restart-------------------> collecting
任意终态    --TTL-----------------------> expired（内存回收）
```

非法迁移一律 409 + 当前状态，不静默改写。

### 4.3 内存态 key、TTL、并发、重启

- **key**：`sessionId`（一个目标会话同时只有一个 run）。`runId` 是 `pe-<单调递增>`，用于拒绝过期请求。
- **seed 表**：`sessionId → {rough, digest, cwd, createdAt}`，TTL 120 s；`/start` 消费后删除。
- **run 表**：`sessionId → EnhanceRun`；活跃 run 上限 1/会话，全局上限 8（LRU 淘汰最旧终态）。
- **TTL**：见 4.1 表格；清扫器每 60 s 跑一次（`ctx.effect` 里 `setInterval`，卸载时清除）。
- **并发**：同一会话再次 `/enhance` → 旧 run `cancel()`（abort 在飞请求）+ 新 run；两个浏览器同时 `answer` → `batchId` 只有一个匹配，另一个得 409 `STALE_BATCH` 并附带当前 state。
- **进程重启**：内存清空。面板 `GET /state` 得 404 `NO_RUN`，UI 显示「增强会话已失效（宿主重启），请重新输入 /enhance」并提供一键把上次粗糙提示词放回输入框（若面板还持有）。

---

## 5. 数据契约

### 5.1 HTTP 端点

统一前缀 `/prompt-enhance`；全部 `POST` 只收 `application/json`，`GET /state` 除外。统一响应外壳：

```json
// 成功
{ "ok": true, "state": { } }
// 失败
{ "ok": false, "error": { "code": "STALE_BATCH", "message": "该问题批次已被回答", "retryable": false } }
```

**A. `POST /prompt-enhance/start`**

```json
{ "session": "session-9a75...", "restart": false }
```
- 幂等：会话已有活跃 run 时直接 200 返回现有 `state`（面板重开不重建）。
- `restart=true`：用内存里保留的 seed 重跑（`ready/inserted/failed/cancelled` 可用）；重建前先 abort 旧 run。
- 200：`{ok:true, state}`；404 `NO_SEED`（没有 `/enhance` 留下的 seed）；409 `RUN_ACTIVE`（`restart=true` 撞上另一个正在跑的调用）。

**B. `GET /prompt-enhance/state?session=<id>`**

- 200：`{ok:true, state}`；404 `NO_RUN`。

**C. `POST /prompt-enhance/answer`**

```json
{
  "session": "session-9a75...",
  "runId": "pe-3",
  "batchId": "b1",
  "answers": [
    { "questionId": "q1", "selected": ["o1"], "custom": null, "skipped": false },
    { "questionId": "q2", "selected": [], "custom": "用本地网页，不要命令行", "skipped": false }
  ]
}
```
- 200：`{ok:true, state}`；400 `INVALID_ANSWER`（数量/必填/未知 questionId）；404 `NO_RUN`；409 `STALE_BATCH` / `NOT_QUESTIONING`。

**D. `POST /prompt-enhance/cancel`**

```json
{ "session": "session-9a75...", "runId": "pe-3" }
```
- 200：`{ok:true, state}`；404 `NO_RUN`；409 `STALE_RUN`。

**E. `POST /prompt-enhance/take`**

```json
{ "session": "session-9a75...", "runId": "pe-3", "markdown": "（可选）面板里编辑后的正文" }
```
- 携带 `markdown` 时先把它写回 `prompt.markdown`（≤60000 字符，超出 400 `INVALID_BODY`），再标记 `inserted`，保证「再插入一次」与面板一致。
- 200：`{ok:true, prompt:{title,markdown,assumptions}, state}`；409 `NOT_READY`；404 `NO_RUN`。

### 5.2 RunState（`state` 字段）

```json
{
  "runId": "pe-3",
  "session": "session-9a75...",
  "phase": "questioning",
  "round": 2,
  "questions": {
    "batchId": "b1",
    "questions": [
      {
        "id": "q1",
        "header": "形态",
        "question": "这个记账工具你希望怎么用？",
        "multiSelect": false,
        "allowCustom": true,
        "options": [
          { "id": "o1", "label": "本地网页", "detail": "浏览器打开，后台读写本地 JSON", "recommended": true },
          { "id": "o2", "label": "命令行工具", "detail": "零依赖，最快跑通", "recommended": false }
        ]
      }
    ]
  },
  "prompt": null,
  "error": null,
  "truncated": false,
  "updatedAt": 1793890000000,
  "expiresAt": 1793890600000
}
```

规则：`questions` 仅在 `phase==='questioning'` 时非 null；`prompt` 仅在 `ready/inserted` 时非 null；`error` 仅在 `failed` 时非 null。

### 5.3 问题 / 答案 / 提示词 schema

```jsonc
// Question
{
  "id": "q1",                 // ^[A-Za-z0-9_-]{1,16}$，一次 run 内唯一
  "header": "形态",            // 可选，≤12 字符
  "question": "…",            // 必填，1–200 字符
  "multiSelect": false,       // 可选，默认 false
  "allowCustom": true,        // 可选，默认 true
  "options": [                // 2–6 个；单选题至少 2 个
    { "id": "o1", "label": "…", "detail": "…", "recommended": true }
  ]
}

// Answer
{
  "questionId": "q1",
  "selected": ["o1"],         // 选项 id 数组；multiSelect=false 时 0/1 个
  "custom": null,             // 字符串或 null；与 selected 可同时存在（多选 + 补充）
  "skipped": false            // true 时不要求 selected/custom
}

// Prompt
{
  "title": "本地记账小工具",     // ≤80 字符
  "markdown": "## 目标\n…",     // 1–60000 字符，最终写入输入框的正文
  "assumptions": ["…"]         // 0–6 条，≤300 字符/条，仅展示不插入
}
```

### 5.4 工具 schema（模型侧）

`ask_questions`（`additionalProperties:false`）：

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["questions"],
  "properties": {
    "questions": {
      "type": "array", "minItems": 1, "maxItems": 3,
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["id", "question", "options"],
        "properties": {
          "id": { "type": "string", "pattern": "^[A-Za-z0-9_-]{1,16}$" },
          "header": { "type": "string", "maxLength": 12 },
          "question": { "type": "string", "minLength": 1, "maxLength": 200 },
          "multiSelect": { "type": "boolean" },
          "allowCustom": { "type": "boolean" },
          "options": {
            "type": "array", "minItems": 2, "maxItems": 6,
            "items": {
              "type": "object", "additionalProperties": false,
              "required": ["id", "label"],
              "properties": {
                "id": { "type": "string", "pattern": "^[A-Za-z0-9_-]{1,16}$" },
                "label": { "type": "string", "maxLength": 60 },
                "detail": { "type": "string", "maxLength": 200 },
                "recommended": { "type": "boolean" }
              }
            }
          }
        }
      }
    }
  }
}
```

`deliver_prompt`（`additionalProperties:false`）：

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["title", "markdown"],
  "properties": {
    "title": { "type": "string", "minLength": 1, "maxLength": 80 },
    "markdown": { "type": "string", "minLength": 1, "maxLength": 60000 },
    "assumptions": { "type": "array", "maxItems": 6, "items": { "type": "string", "maxLength": 300 } }
  }
}
```

### 5.5 digest 文档（模型输入的第二个 block）

```json
{
  "kind": "session-digest",
  "version": 1,
  "cwd": "repo",
  "turns": [
    { "user": "1+1 等于几？只回答数字", "assistant": "2" }
  ],
  "truncated": false,
  "omittedTurns": 0
}
```

### 5.6 上限与超限行为

| 载荷 | 上限 | 依据 | 超限行为 |
|---|---|---|---|
| HTTP 请求体 | 256 KiB | 本设计自定（路由自己读 body） | 413 `BODY_TOO_LARGE` |
| 命令行（粗糙提示词） | 8 KiB | 命令行无 schema 长度约束（`dsh-commands/lib/typert.host.js:93-104` 只有 `name`/`description`/`typeSymbol`）；传输上限极大（`dsh-client-connection/lib/index.js:30` = 300 MiB） | 命令返回 `kind:'error'`，提示拆分 |
| digest | 24000 字符 / 16 轮 | 本设计自定（v2 无压缩，见 7.5） | 从最旧轮次截断，置 `truncated:true` |
| 单次答案文本 | 8 KiB | 本设计自定 | 400 `INVALID_ANSWER` |
| 单 run 模型调用 | 6 次 | 本设计自定 | 强制 `deliver_prompt` 或 `failed` |
| 单 run 工具调用 | 12 次（P2） | 本设计自定 | 工具结果回灌 `TOOL_BUDGET_EXCEEDED`，模型只能收尾 |

---

## 6. 通信通道选型

### 6.1 三个候选

| | A. `commands/execute` | B. 自建 Typert Remote | C. `webServer` 自定义路由 |
|---|---|---|---|
| 新增协议 | 无 | 需要 typert 元数据 + 生成的 client 声明 | 一个 HTTP 路由 + JSON 编解码 |
| 客户端→宿主 | `ctx.remote.commands.execute(sessionId, line, …)`（先例 `dsh-client-ui-plan/lib/client.js:704`） | 生成的 `ctx.remote.<ns>.*` | `fetch('/prompt-enhance/…')` |
| 宿主→客户端 | 只有 `CommandExecution.result`（`text`/`code`） | 类型化返回值 / 流 | JSON / SSE |
| 结构化返回 | **不可行**：返回只能放在 `result.text`，而它会被渲染成聊天节点 | 可行 | 可行 |
| 副作用 | **每次调用写 `command/run` + `command/done` 两条持久事件**（`dsh-commands/lib/types/index.d.ts:117`），并渲染一行命令记录（`dsh-client-ui-chat/lib/client.js:9505-9519` 把 `outcome.text` 放进节点） | 无 | 无 |
| 载荷上限 | 受请求体上限约束（300 MiB，`dsh-client-connection/lib/index.js:30`），但载荷会进聊天记录 | 受各端 schema | 自己定（256 KiB） |
| 流式 | 无 | 支持 | SSE 可做 |
| 部署可行性 | 现成 | **阻塞**：部署只有 `dsh-typert-loader` / `-protocol` / `-registry`，没有生成器（`ls @deepseek-ai | grep typert`） | 现成：`ctx.webServer.register`（`dsh-host-webserver/lib/types/index.d.ts:174`），本机 `dsh-grokbot` 已在用（`<plugins>/dsh-plugin-bbws/lib/index.js:1049`） |

### 6.2 结论

- **P0 选 C**。A 被否的原因不是长度，而是**返回通道只有聊天文本**：问题批次、最终提示词都要变成 JSON 字符串显示在会话记录里，且每次答题都新增一行命令记录——这同时违反第 2 节原则 1（污染）与原则 2（结构化）。B 被否的原因是部署里没有 typert 生成器，手写生成物属于未受支持的版本脆弱路径。
- **A 保留为入口**：`/enhance` 命令本身仍是 A（用户可见、可发现、一次调用一行记录，与 v1 相同）；它只负责「取 seed」，不承载数据往返。
### 6.3 C 为什么必须、成本是什么

- **为什么必须**：A 的返回通道只有 `CommandResult.text`，而它会被渲染成聊天节点（`dsh-client-ui-chat/lib/client.js:9512-9518`），问题批次与答案无法避免地写进用户会话；B 需要部署里不存在的生成器。要同时满足「零会话」与「结构化数据」且不污染转写，只能加一个数据平面端点。
- **成本（约 120 行 + 3 个安全项）**：
  1. `ctx.webServer.tapIndex` 注入每进程随机 token 到索引页；面板请求带 `x-dsh-prompt-enhance-token`，不匹配 → 403。自定义路由不经过 DSH 的 `/api` 浏览器信任栅栏（`dsh-host-webserver` 自身“knows no harness concepts”，`dsh-host-webserver/README.md:12`），所以校验必须自己做。
  2. `Origin` 存在时必须等于请求的 `Host`（CSRF 兜底）；`Content-Type` 必须是 `application/json`；方法白名单 `POST`（`/start`,`/answer`,`/cancel`,`/take`）与 `GET`（`/state`）。
  3. 自读 body，硬上限 256 KiB；错误一律 JSON，不返回栈。
- 该路由与页面同源同端口，部署侧的 `dsh-gateway` 按 `req.url` 透传（`<gateway>/server.js:1149`），不需要额外代理配置。

- **升级到 B 的触发条件**（任一满足）：需要**流式**把 token 推给面板；需要跨进程/远程客户端（非本机浏览器）复用；需要严格类型化的多端点 RPC 且有生成器可用。
- **B 的验证步骤**（升级前必须先在 checkout 里过一遍）：① 确认 `dsh-typert-generator` 可安装且版本与 `dsh-typert-protocol` 匹配；② 用 `dsh-plugin-market/lib/typert.host.js` 作为模板，生成一个只含 `ping` 方法的命名空间；③ 在 profile 里挂载，验证客户端 `ctx.remote.<ns>.ping()` 返回；④ 验证 `@Remote` 流式方法在浏览器侧可用；⑤ 迁移 4 个端点，保留 C 作为回退开关一个版本。

---

## 7. 模型调用规格

### 7.1 请求形状

```js
const stream = ctx.llm.stream({
  provider,                 // 见 7.4
  model,
  system,                   // persona + 输出契约（7.2），单次调用固定
  messages,                 // RequestMessage[]（7.3），跨轮累积
  tools: [ASK_QUESTIONS, DELIVER_PROMPT, ...P2_TOOLS],
  maxTokens: 3000,
  signal,                   // AbortSignal.timeout(120_000)，取消时 abort
})
```

事实依据：`GenerateOptions` 字段定义见 `dsh-llm/lib/types/types.d.ts:506-548`；`tools` 是 `ToolSchema[]`（`dsh-llm/lib/types/types.d.ts:472-483`）；`purpose` 只接受 `'compaction' | 'session-title'`（`dsh-llm/lib/types/types.d.ts:547`），**本设计不设 purpose**。

`tools` 清单（按阶段启用，schema 与注册表由同一个 `buildTools()` 产出）：

| 工具 | 阶段 | 参数 |
|---|---|---|
| `deliver_prompt` | P0 | `{title, markdown, assumptions[]}`（5.4） |
| `ask_questions` | P1 | `{questions[1..3]}`（5.4） |
| `read_file` | P2 | `{path: string, offset?: int, limit?: int}` |
| `glob` | P2 | `{pattern: string, path?: string}` |
| `grep` | P2 | `{pattern: string, path?: string, ignoreCase?: bool}` |
| `web_search` | P2 | `{query: string}` |
| `web_fetch` | P2 | `{url: string}` |

### 7.2 `system` 内容（一次写死，约 900–1200 字）

固定段落顺序（都写在 system 里，不进入消息）：

1. 角色：提示词增强器，不执行任务。
2. 输入说明：第一条 user 消息是粗糙提示词；第二条 block 是 `session-digest` JSON（字段含义）。
3. 流程：信息不足 → 调 `ask_questions`（1–3 问，附推荐项，问用户真正需要决策的事，能自己查的不要问）；信息足够 → 调 `deliver_prompt`。
4. 硬约束：`deliver_prompt.markdown` 自包含（目标/背景/做什么/不做什么/验收/注意）、保留用户语言、不虚构需求、不写空话。
5. 输出纪律：**只允许**这两个工具之一，不要输出普通文本作为最终结果；同一轮不要既提问又交付。

### 7.3 `messages` 结构（关键：不拼字符串）

```jsonc
// 第 1 条 user：两个独立 content block，各自带 kind
[
  { "role": "user", "content": [
      { "type": "text", "text": "<用户粗糙提示词原文>" },
      { "type": "text", "text": "{\"kind\":\"session-digest\",\"version\":1,...}" }
  ]}
]

// 模型第一次调用 ask_questions 后，宿主追加：
{ "role": "assistant", "id": "pe-msg-2", "source": { "kind": "model", "provider": "deepseek", "model": "deepseek-flash" },
  "content": [ { "type": "tool-call", "id": "call_1", "name": "ask_questions", "arguments": "{\"questions\":[…]}" } ] }

// 用户作答后，宿主把答案作为**工具结果**回灌（不是再拼一段话）：
{ "role": "tool", "id": "pe-msg-3", "toolCallId": "call_1", "isError": false,
  "source": { "kind": "tool", "callId": "call_1" },
  "content": [ { "type": "text", "text": "{\"kind\":\"answers\",\"batchId\":\"b1\",\"answers\":[…]} " } ] }
```

要点：
- 粗糙提示词、digest、答案各自是**独立 block / 独立消息**，没有 `<rough_prompt>`、`<conversation>` 这类拼装标签。
- 答案走 `tool` 角色而不是「在 user 消息里叙述」，这是协议原生通道。
- `id` / `source` 是 `Message` 的必填字段（`dsh-llm/lib/types/message.d.ts:124-170`），品牌类型在运行时是空操作（`dsh-brand/lib/index.js:1-20`），因此用普通字符串即可；DeepSeek 适配器只在 assistant 消息上读 `source.kind`/`replayState`（`dsh-llm-deepseek/lib/index.js:1504-1515`），tool 消息只读 `toolCallId`/`isError`（`:1675-1682`）。

### 7.4 provider / model

- 默认：`await ctx.sessionController.modelCatalog()` 的 `default.provider/model/reasoningEffort`（类型 `ModelCatalog.default: ModelSelection`，`dsh-api-session-controller/lib/types/types.d.ts:142-148`；`ModelSelection` 见 `:92-96`）。注意该方法是异步的（`dsh-api-session-controller/lib/types/index.d.ts:117`）。
- 覆盖：插件 `config.provider` / `config.model` / `config.reasoningEffort`；两者必须同时给，且用 `ctx.llm.listModels(provider)`（`dsh-llm/lib/types/index.d.ts:170`）确认存在，否则回落默认并记一条 warn。
- 不按会话模型：增强器用轻量模型足够；这也是省 token 的一环。

### 7.5 预算、裁剪、超时

- digest：16 轮 / 24000 字符封顶（v1 是 24 轮 / 48000 且无压缩，见 `lib/index.js:20-21`）。超出时从最旧轮次丢，`truncated:true`，`omittedTurns:N`，并在 system 里预先说明「digest 可能被截断，缺少信息就问」。
- 消息总数：≤30 条；工具结果：单条 ≤4096 字符（读取文件被截断时附 `truncated:true`）。
- 单次调用：`maxTokens: 3000`，`AbortSignal.timeout(120_000)`；整个 run ≤ 6 次调用。
- token 计量：读 `usage` chunk 记到 run 上（仅日志，不展示费用）。

### 7.6 结构化输出与校验

1. 收集流里的 `block-end` chunk，取 `block.type === 'tool-call'` 的完整块（`StreamChunk` 定义 `dsh-llm/lib/types/types.d.ts:434-464`；`block-end` 携带完整 `ContentBlock`）。
2. `JSON.parse(arguments)`，失败 → 纠错重试一次。
3. 手写校验器（不引入 schema 库）逐字段校验 5.3/5.4：必填、长度、id 唯一、选项数、`deliver_prompt.markdown` 非空。
4. 失败重试：**必须回答该 tool-call**——追加一条 `tool` 消息 `{isError:true, content:[{type:'text',text:'{"kind":"format-error","message":"…具体哪条规则不过…"}'}]}`，然后重新 `stream`，同一 run 只重试一次；仍失败 → `failed`，`error.code='INVALID_MODEL_OUTPUT'`。
   - 不得用普通 user 消息代替：DeepSeek 适配器要求每个 assistant tool call **紧邻**一个 tool result，否则报 `INVALID_REQUEST`（`dsh-llm-deepseek/lib/index.js:1695-1709`：`tool calls need immediate results` / `history ends with unresolved tools`）。
5. `finish.reason` 处理：`error`/`aborted` 直接落 `failed`（failure 信息进 `error.message`）；`max-tokens` 视为一次失败并重试（把 maxTokens 提到 4000 重试一次）；`stop` 且无工具调用 → 走第 4 步的纠错（此时没有未决 tool call，可以直接追加 user 纠错消息）。
6. 一轮里有多个 tool call 时：**每个都必须有结果**。执行最后一个，其余用 `isError:true` 的工具结果回填（`{"kind":"ignored","reason":"one action per turn"}`），再继续。

---

## 8. 只读工具执行方案

模型可调用 5 个只读工具（P2 起）。全部在宿主执行，结果以 `tool` 消息回灌。

| 工具 | 实现 | 边界 | 上限 | 失败回灌 |
|---|---|---|---|---|
| `web_search` | `ctx.web.search({query, maxResults:5})`（`dsh-web/lib/types/index.d.ts:89`，请求体 `dsh-web/lib/types/types.d.ts:14-31`） | 无本地路径 | 5 条来源；结果 ≤4000 字符 | `{ok:false, code:'WEB_UNAVAILABLE'}`；无 provider 时降级为「该工具不可用」 |
| `web_fetch` | `ctx.web.fetch({url})`（`:98`） | 仅 http/https；非 2xx 是结果不是异常（`dsh-web/lib/types/types.d.ts:63-65`） | body ≤8000 字符 | `WEB_FETCH_FAILED` |
| `read_file` | `ctx.fs.resolve(path,{cwd})` + `fs.stat` + `fs.readText`（`dsh-fs/lib/types/index.d.ts:94/138/162`） | **只允许目标会话 cwd 内**：`fs.contains(cwdTarget, target)`（`:131`）为真，且拒绝符号链接逃逸（resolve 后复查） | 单文件 ≤128 KiB，按行偏移截断 | `PATH_DENIED` / `FILE_TOO_LARGE` / `NOT_FOUND` |
| `glob` | 自实现：`fs.listDir` 递归（`:208`） | 同 `read_file` | 深度 ≤6，条目 ≤2000，结果 ≤200 条 | 超限回灌 `TOO_MANY_ENTRIES` + 前 200 条 |
| `grep` | 自实现：glob 枚举 + `readText` + 行正则 | 同 `read_file`；跳过 >2 MiB 文件与二进制（NUL 探测） | 扫描 ≤2 MiB、命中 ≤100 行 | 超限回灌 `GREP_TRUNCATED` |

mini-loop：

```
let buffer = await stream(messages)          // 一次模型调用：解析 text / tool-call / finish
while (buffer.readToolCalls.length > 0) {    // 只读工具调用（不是 ask_questions / deliver_prompt）
  if (rounds >= 8 || calls + buffer.readToolCalls.length > 12) {
    for (const call of buffer.readToolCalls) messages.push(toolError(call.id, 'TOOL_BUDGET_EXCEEDED'))
    buffer = await stream(messages)          // 只剩收尾一条路
    break
  }
  for (const call of buffer.readToolCalls) { // 每个 call 都必须有 result
    const result = await runTool(call)        // 校验参数 → 边界检查 → 执行 → 截断
    messages.push(toolResult(call.id, result))
  }
  buffer = await stream(messages)
}
// buffer 里此时是 ask_questions / deliver_prompt / 纯文本（走 7.6 纠错）
```

沙箱说明：`ctx.fs` 的读取**不经过**工具的 sandbox 策略（策略只作用于 `writeText`/`editText` 的 `sandboxPolicy` 参数，见 `dsh-fs/lib/types/index.d.ts:221,235`），所以路径边界必须由插件自己守（上表的 `contains` + 逃逸复查）；这是硬性安全要求，不是可选优化。

降级：`ctx.fs` 缺失 → 只注册 `web_search`/`web_fetch`；`ctx.web` 缺失（或无 search/fetch provider）→ 只注册文件工具；两者都缺 → `tools` 只留 `ask_questions`/`deliver_prompt`。system 里同步删掉不可用工具的说明（工具说明与注册表由同一个 `buildTools()` 产出，避免“说得到但调不到”）。

---

## 9. UI 规格

### 9.1 面板位置

- 右侧栏 **page tab**：`kind: 'promptenhance'`，`multiple: false`，`id: 'dsh-prompt-enhance'`，不声明 `patterns`（page 类型按 kind 打开，`dsh-client-ui-sidebar-right/lib/types/client/tab-registry.d.ts:90-100`）。
- 打开：`ctx.sidebarRight.openTab('promptenhance')`（`.../service.d.ts:168`）。
- body 注册：`ctx.slots.register({ name:'sidebar.right.pane.tab', key:'dsh-prompt-enhance' }, Panel)`；该 slot 是 `scope:'session'`（`.../contract/slots.d.ts:53-58`），因此面板天然拿到 `sessionId` 与 `inputActions`，**不需要 SessionProvider、不需要 resource provider**。

### 9.2 视图状态

| 状态 | 展示 |
|---|---|
| 无 run / 404 | 空态：说明 + 「在输入框输入 `/enhance 你的粗糙提示词`」+（若有 seed）「继续上次」按钮 |
| `collecting` / `drafting` | 骨架屏 + 阶段文案 + 取消按钮 + 计时（「已思考 12s」） |
| `questioning` | 提问卡片（9.3） |
| `ready` / `inserted` | 结果区（9.4） |
| `failed` | 错误码 + 可读文案 + 「重试」（`start(restart:true)`） |
| `cancelled` | 灰色提示 + 「重新开始」 |
| `expired` | 过期提示 + 「重新开始」 |

### 9.3 提问卡片

- 一次最多 3 问，分页 `1 / 3`；**提交后才推进**（不会边答边发）。
- 单选：点击即选中；多选：勾选；推荐项置顶并带 `Recommended` 徽标，默认预选但**不自动提交**。
- 每题可 `Skip`（等价 `skipped:true`）；`allowCustom` 为真时提供自由输入框（多选可同时选+补充）。
- 必填校验：未答且未 Skip 时「提交」禁用，并滚动到第一个未答题。
- 键盘：Enter 提交/下一题，Shift+Enter 换行，Esc 关闭面板（不提交）。
- 提交失败（409/400）：保留草稿，顶部条显示错误，可重试。

### 9.4 结果区

- `markdown` 用等宽字体、可编辑（textarea，切换「预览」时按纯文本渲染，不引入 Markdown 渲染器）。
- 主按钮「插入到输入框」；次按钮「复制」「重新生成」。
- `assumptions` 折叠在结果下方，**不插入**。

### 9.5 文案（`ctx.locale.register('promptEnhance', {zh, en})`）

| key | zh | en |
|---|---|---|
| `tab.title` | 提示词增强 | Prompt enhance |
| `empty.title` | 还没有增强任务 | No enhancement yet |
| `empty.hint` | 在输入框输入 `/enhance 你的粗糙提示词` | Type `/enhance <rough prompt>` in the composer |
| `phase.collecting` | 正在理解上下文… | Reading the context… |
| `phase.drafting` | 正在起草提示词… | Drafting the prompt… |
| `phase.questioning` | 需要你确认几个点 | A few questions |
| `phase.ready` | 提示词已就绪 | Prompt ready |
| `phase.failed` | 生成失败 | Generation failed |
| `hint.assumptions` | 关键假设（不会插入） | Key assumptions (not inserted) |
| `action.cancel` | 取消 | Cancel |
| `action.retry` | 重试 | Retry |
| `action.insert` | 插入到输入框 | Insert into composer |
| `action.copy` | 复制 | Copy |
| `action.regenerate` | 重新生成 | Regenerate |
| `action.skip` | 跳过 | Skip |
| `action.next` | 下一题 | Next |
| `action.submit` | 提交 | Submit |
| `hint.inserted` | 已插入到输入框 | Inserted into the composer |
| `error.NO_RUN` | 增强会话已失效（宿主重启） | Enhancement session expired (host restarted) |
| `error.NO_SEED` | 没有可继续的任务，请重新 /enhance | Nothing to continue — run /enhance again |
| `error.STALE_BATCH` | 这批问题已经被回答 | This batch was already answered |
| `error.LLM_FAILED` | 模型调用失败：{message} | Model call failed: {message} |
| `error.INVALID_MODEL_OUTPUT` | 模型输出不合法，已重试一次 | The model returned an invalid response |
| `error.NOT_READY` | 提示词还没生成完 | The prompt is not ready yet |
| `error.RUN_ACTIVE` | 已有正在进行的增强 | An enhancement is already running |
| `error.BODY_TOO_LARGE` | 提交内容过大 | Payload too large |

---

## 10. 插入回写

- **主路径**：面板是 `scope:'session'` 的 tab body，直接拿 `inputActions.setDraft(prompt.markdown)`（`dsh-client-ui-conversation/lib/types/client/contract/input.d.ts:240`）。不需要 v1 的隐藏桥。
- **兜底路径（P0 验证失败时）**：保留 v1 的 `conversation.input.dock` 桥（`.../contract/slots.d.ts:295-299`，list + session 作用域）+ 客户端 `pendingInsert: Map<sessionId, string>`；桥挂载时消费。
- **排队语义**：主路径没有排队——tab 只在所属会话显示时挂载，插入一定发生在该会话的编辑器上，若编辑器处于 `submitting` 等不可编辑阶段，`setDraft` 会抛/无效，此时 UI 回滚为「插入失败，请重试」，草稿不丢。
- **插入后**：`POST /take` 把 run 标记 `inserted`；**不清空**内存态（保留到 TTL，允许再次插入/重新生成）。宿主只保留本次 run 的对话消息与 `prompt`，不做任何持久化。
- 若用户在插入前改了 prompt（textarea 可编辑），插入的是**编辑后**的 `markdown`，同时把编辑后的文本写回 run（`take` 携带 `markdown`），保证「再插入一次」一致。

---

## 11. 删除清单与迁移

| # | 位置 | 动作 | 说明 |
|---|---|---|---|
| 1 | `cordis.patch.yml:14-59` | 删除 `preset-prompt-enhancer` 整行 | v2 不再需要 agent preset；persona 移入 `system` |
| 2 | `lib/index.js:17-18` | 删 `PRESET_ID` | 无 preset |
| 3 | `lib/index.js:23-26,280` | 删 `resultTextFor` | 不再用命令结果当发现通道 |
| 4 | `lib/index.js:145-196` | 删 `composeFirstMessage` | 拼装函数整体移除；对应测试一并删 |
| 5 | `lib/index.js:213-281` | 重写 `runEnhance` | 只做 seed：折叠 digest→存内存→返回短文本；删 `sessionController.create/prompt`、`workspaceRegistry`、`randomUUID` |
| 6 | `lib/index.js:15` | 删 `randomUUID` import | 改用 `crypto.randomUUID` 只在需要时引入 |
| 7 | `lib/index.js:29-143` | **保留** `visibleEvents` / `buildDigest`，迁到 `lib/digest.js` | 这两个逻辑与 v2 无关，是纯函数；输出改为 JSON 文档 |
| 8 | `lib/client.js:49-73` | 删资源地址构造/解析 | 无 resource provider |
| 9 | `lib/client.js:99-145` | 删 `fencedPrompt` / `extractFinalPrompt` | 不再从聊天内容切提示词 |
| 10 | `lib/client.js:205-249,276-343` | 删 `SessionProvider` + `conversation.content` + `resources.register` + tab 资源类型 | 改为 page tab |
| 11 | `lib/client.js:365-379` | 删 `command/executed` 的正则解析 | 改为「只判断 name 与 success，然后 openTab」 |
| 12 | `lib/client.js:75-95,251-272,389-395` | 隐藏桥降级为兜底（不删也行） | 主路径改用 `inputActions` |
| 13 | `test/digest.test.mjs:76-98` | 删 `composeFirstMessage` / `resultTextFor` 的断言 | 换成 `buildModelMessages` / 校验器 / 状态机的新测试 |
| 14 | `README.md` | 重写「工作方式/已知限制」 | 说明无会话、面板、HTTP 端点 |

**可复用**：digest 折叠（断言从 `surface.nodes` 取，`dsh-session/lib/types/index.d.ts:141`）、`sidebarRightTabs` 注册骨架、`setDraft` 插入、locale/样式、`visibleEvents` 的降级路径。

---

## 12. v1 vs v2 对照表

| 维度 | v1 | v2 | 评价 |
|---|---|---|---|
| 会话是否落库 | 是（顶层 Session，进列表/工作区） | 否（插件内存 `RunState`） | **净收益**：直接消灭否证 1，也免掉 preset、会话标题、上下文压缩等连带问题 |
| 上下文传递 | 一条巨型 user message（`<target_context>`+`<conversation>`+`<rough_prompt>`） | 两个独立 block（rough / digest JSON）+ 答案走 tool result | **净收益**：可解析、可截断、可测试 |
| 提问实现 | 原生 `ask_user_question`（依赖 DSH 会话与卡片） | 自建卡片 + `ask_questions` 工具 | **代价**：多写一套卡片 UI 与校验；换来不依赖会话、可控制每题结构与上限 |
| 流式输出 | 原生聊天流式 | P0/P1 非流式 + 轮询；P3 可选 SSE | **代价**：首字延迟从「即时」变成「整段」，用骨架屏+阶段文案兜底 |
| 上下文压缩 | 宿主 compaction 负责 | 无压缩，纯截断 | **代价**：超长会话的摘要质量下降；用 16 轮/24k 上限 + 明确告知模型 |
| 工作区污染 | 有 | 无 | **净收益**（否证 1） |
| 活动部件 | 命令 + preset + 会话 + 资源 provider + 原生聊天 + 隐藏桥 | 命令（入口）+ 一个 HTTP 路由 + page tab + 面板 + `setDraft` | **净收益**：少 preset 行、resource provider、内嵌对话工厂三个注册；隐藏桥降级为兜底不常驻；多 1 个 HTTP 路由 |
| 失败面 | 会话创建/preset 激活/首条消息/围栏解析/正则解析 | 命令、HTTP、LLM、校验、工具、面板 | **代价**：失败点更靠内，但**每个失败都有稳定错误码**；少了 preset 与围栏两个「配置/约定」型失败 |

---

## 13. 分阶段计划

> 每阶段独立验收；回滚方式统一为：`cp -a` 快照目录（P0 前先做 `<repo>.bak-v1`），恢复后重启 `dsh web`（bundle 的 patch 与客户端 bundle 都是启动时加载）。

### P0 单轮结构化生成 + 面板 + 插入（1–2 天）

**改动面**：`lib/index.js`（命令只留 seed）、新增 `lib/digest.js`、`lib/runs.js`、`lib/http.js`、`lib/llm.js`（仅 `deliver_prompt`）、`lib/client.js`（重写为 page tab + 面板）、`cordis.patch.yml`（删 preset 行）、`test/structure.test.mjs`。

**验收**：
1. `/enhance 用 Node 写一个 CLI 斐波那契工具` → 右侧栏出现面板，10–60 s 内展示可编辑的最终提示词。
2. 点「插入到输入框」→ 目标会话草稿变成该文本。
3. 会话列表与 `$DSH_HOME/sessions` 无新增。
4. 无 `ask_questions`（P0 只注册 `deliver_prompt`），信息不足时模型直接给一版带假设的提示词（可接受）。

**验证方法**：
- `grep -n "sessionController\.\(create\|prompt\|fork\)" lib/` 必须为空。
- 运行前后 `find $DSH_HOME/sessions -name '*.jsonl.zstd' | wc -l` 相等。
- 单测：`buildModelMessages()` 产出 2 个 block；`JSON.parse(block2)` 的 `kind==='session-digest'`；block1 严格等于输入。
- 手工断网/改错 model → 面板显示 `LLM_FAILED` 且草稿不丢。

**回滚**：恢复 `.bak-v1`，`plugin_manager` 重新安装链接目录，重启 `dsh web`。

### P1 多轮提问卡片（1–2 天）

**改动面**：`lib/llm.js`（加 `ask_questions` 解析）、`lib/runs.js`（`questioning` 状态与批次）、`lib/http.js`（`answer`/`cancel`）、`lib/client.js`（卡片、分页、提交）、`test/state.test.mjs`。

**验收**：
1. 粗糙提示词含糊时，模型 1–3 问，推荐项置顶，可 Skip、可自定义，提交后进入下一轮。
2. 连续两轮提问后必须能交付（`round ≤ 3` 时 system 强制）。
3. 两个浏览器面板看到同一状态；第二个提交者得到 409 + 当前状态。

**验证方法**：单测覆盖 `answer` 校验（数量/必填/未知 id/超限）、`batchId` 竞态；手测「答题 → 第二轮 → 交付」。

**回滚**：删除 `ask_questions` 注册与卡片组件，退回 P0（模型只有 `deliver_prompt`）。

### P2 只读工具 mini-loop（2–3 天）

**改动面**：新增 `lib/tools.js`（glob/grep/read/fs 边界）、`lib/llm.js`（工具轮）、system 里工具说明、`test/tools.test.mjs`。

**验收**：
1. 模型能读目标会话 cwd 内文件、glob、grep；路径逃逸被拒并回灌 `PATH_DENIED`。
2. 工具调用 ≤12 次后强制收尾；单次结果 ≤4 KiB。
3. 无 `ctx.web` provider 时，`web_search` 返回 `WEB_UNAVAILABLE` 而不是崩溃。

**验证方法**：单测伪造 `fs`/`web` 服务；集成测试用 `<workspace>/...` 真目录；`grep -n "readText" lib/tools.js` 确认每次读取前有 `contains` 校验。

**回滚**：`tools: []`，system 去掉工具段（一个 config 开关 `features.tools=false`）。

### P3 打磨（1 天）

**改动面**：`lib/client.js`（SSE 或更细的轮询、错误文案、键盘）、`lib/runs.js`（TTL/清扫/上限）、locale 补齐、README。

**验收**：取消 <1 s 生效；TTL 到点面板转 `expired`；中英文切换无漏翻；错误码都有对应文案。

**验证方法**：手动触发每个错误码（改 config 指向不存在模型、kill 宿主中途、伪造 409）。

**回滚**：P3 只改面板与清扫器，回退到 P2 的 `lib/client.js`/`lib/runs.js` 快照即可，不涉及通道与契约。

---

## 14. 风险与未决问题

| # | 问题 | 结论未定的原因 | 在 checkout 里怎么验证 | 验证失败时的退路 |
|---|---|---|---|---|
| 1 | **命令载荷上限** | `commands/execute` 的 `line` 没有 schema 长度（`dsh-commands/lib/typert.host.js:93-104` 只标 `name`/`description`/`typeSymbol`），真实约束在传输层 | 读 `dsh-client-connection/lib/index.js:30` 的 `DEFAULT_MAX_REQUEST_BODY_BYTES`（300 MiB），再用超长 `/enhance` 行实测一次 | 命令只收 ≤8 KiB；超长让用户改用面板输入 |
| 2 | **客户端调用 `commands/execute` 的鉴权路径** | 先例是 `dsh-client-ui-plan/lib/client.js:704`，但那是内置包；插件调用的权限模型未逐条核对 | 用最小插件在浏览器里 `ctx.remote.commands.execute(sessionId,'/enhance x',[])`，看是否 401/403 | 面板改用 HTTP 启动（`/start` 带 rough），命令仅作 UI 入口 |
| 3 | **`ctx.fs` 是否对所有插件可见** | 服务存在（`dsh-fs/lib/types/index.d.ts:17`），但 `inject: ['fs']` 在 Web 组合下是否满足未实测 | 在插件里 `ctx.inject(['fs'], …)` 打日志，观察是否执行 | 只保留 web 工具；文件能力标注「未提供」 |
| 4 | **手写 `tool` 消息能否被适配器接受** | `Message` 要求 `id`/`source`（`dsh-llm/lib/types/message.d.ts:124-170`），品牌是运行时空操作（`dsh-brand/lib/index.js:1-20`），DeepSeek 适配器只读 `toolCallId`（`dsh-llm-deepseek/lib/index.js:1675-1682`），但其它 provider 未验证 | 单测构造 `{role:'tool',toolCallId,content:[{type:'text'}],source:{kind:'tool',callId}}` 调 `ctx.llm.stream`，看是否报 `INVALID_REQUEST` | 退回「答案作为 user 文本块」的降级路径，并在文档标注为降级（不是默认） |
| 5 | **非流式 30 s 的体验** | 网关 `requestTimeout=0`（`<gateway>/server.js:1513`），但移动网络/中间代理可能 60 s 断 | 用手机走网关跑一次 P0，观察是否断连 | 开 `POST /start` 立即返回 + 轮询（本设计已经是这样），仅当单次模型调用超过 60 s 时加 SSE |
| 6 | **多浏览器/多标签行为** | 宿主内存是唯一权威，但两个标签都可能提交 | 两个 Chrome profile 同时开同一会话，交替提交答案 | 以 `batchId` + `runId` 做 CAS：先到者生效，后到者 409 并返回当前 state；不做合并、不做最后一次写入覆盖 |
| 7 | **面板 `inputActions` 是否一定存在** | slot 是 `scope:'session'`（`.../contract/slots.d.ts:53-58`），标准 props 是否含 `inputActions` 需运行时确认 | P0 里 `console.log(Object.keys(props))`，或在面板里 try/catch 调 `setDraft` | 启用兜底桥（v1 已验证） |
| 8 | **`modelCatalog()` 的 `default` 可能不存在** | 无任何 routable provider 时 `default` 可能为空 | 在无 API key 的 profile 里调用一次 | 面板显示 `NO_MODEL`，提示去设置里配置密钥 |
| 9 | **`ask_questions` 与 `deliver_prompt` 同时被调** | 模型可能一轮里给两个工具调用 | 单测构造两个 `block-end` tool-call | 执行最后一个，其余用 `isError` 工具结果回填（协议要求每个 call 都有 result），记 warn |
| 10 | **HTTP 路由与 DSH 自带路由冲突** | `/prompt-enhance` 目前未被占用，但未来可能 | `ctx.webServer.register` 重复路径抛错（`dsh-host-webserver/lib/index.js:328`），启动日志可见 | 换前缀 `/pe-api`；前缀写进常量集中管理 |

---

## 15. 明确不做

- 不新建/复用任何 DSH Session，不碰 `sessionController.create/prompt/fork`；除 `/enhance` 命令自身由宿主追加的两条 `command/run`/`command/done` 外，不写任何 session 事件。
- 不新增 agent preset、不改 `cordis.patch.yml` 的 preset 段（P0 会删掉它）。
- 不引入 typert Remote（除非第 6.2 的升级条件被触发，且生成器可用）。
- 不做上下文压缩/摘要（只截断，且把截断事实告诉模型）。
- 不持久化增强历史（进程重启即丢，UI 明确提示）。
- 不接管原生 `ask_user_question`，也不在增强流程里调用它。
- 不做流式 token 渲染（P3 仅在必要时加 SSE）。
- 不给模型任何写文件/执行命令的能力（只读工具 + 白名单路径）。
- 不改 DSH 核心包，不 monkey-patch 任何服务。

---

## 附录 A：`ctx.*` / `remote.*` 调用清单与依据

| 调用 | 用途 | 依据 |
|---|---|---|
| `ctx.commands.register({name,description,input,handler})` | 注册 `/enhance` | `dsh-commands/lib/types/index.d.ts:38-53`（`CommandDefinition`） |
| `invocation.agent` / `invocation.rawInput` | 目标会话与粗糙提示词 | `dsh-commands/lib/types/index.d.ts:19-36`（`CommandInvocation`） |
| `ctx.sessions.get(id)` | 取活会话 | `dsh-session/lib/types/index.d.ts:28`（`SessionStore`） |
| `session.surface.nodes` / `session.snapshotEvents()` | 模型可见事件 | `dsh-session/lib/types/index.d.ts:141,224` |
| `ctx.workingDirectory.get(session)` | 目标 cwd | `dsh-working-directory/lib/types/index.d.ts:64` |
| `ctx.logger(name)` | 插件日志 | 与 v1 相同用法（`lib/index.js:203`），Cordis 标准 |
| `ctx.webServer.register({kind:'prefix',path,handler})` | 数据平面 | `dsh-host-webserver/lib/types/index.d.ts:32-40,174` |
| `ctx.webServer.tapIndex(fn)` | 注入面板 token | `dsh-host-webserver/lib/types/index.d.ts:198` |
| `ctx.webServer.getOrigin()` | 生成同源校验基准 | `dsh-host-webserver/lib/types/index.d.ts:167` |
| `ctx.llm.stream(options)` | 模型调用 | `dsh-llm/lib/types/index.d.ts:115`；`GenerateOptions` `dsh-llm/lib/types/types.d.ts:506-548` |
| `ctx.llm.listModels(provider)` | 校验覆盖模型 | `dsh-llm/lib/types/index.d.ts:170` |
| `ctx.sessionController.modelCatalog()` | 默认模型 | `dsh-api-session-controller/lib/types/index.d.ts:117` |
| `ctx.web.search({query,maxResults})` / `ctx.web.fetch({url})` | 联网工具 | `dsh-web/lib/types/index.d.ts:89,98` |
| `ctx.fs.resolve/stat/readText/listDir/contains` | 文件工具 | `dsh-fs/lib/types/index.d.ts:94,138,162,208,131` |
| `ctx.remote.commands.execute(id,line,attachments,signal)` | 客户端触发命令（仅入口） | `dsh-commands/lib/typert.remote-client.d.ts:12`；先例 `dsh-client-ui-plan/lib/client.js:704` |
| `ctx.sidebarRightTabs.register(definition)` | 注册 page tab | `dsh-client-ui-sidebar-right/lib/types/client/tab-registry.d.ts:75-119` |
| `ctx.sidebarRight.openTab(kind,options)` | 打开面板 | `.../lib/types/client/service.d.ts:168` |
| `ctx.slots.register({name:'sidebar.right.pane.tab',key},Body)` | 面板 body | `.../lib/types/client/contract/slots.d.ts:53-58` |
| `inputActions.setDraft(text)` | 插入草稿 | `dsh-client-ui-conversation/lib/types/client/contract/input.d.ts:240` |
| `ctx.on('command/executed', …)` | 命令完成后开面板 | `dsh-client-ui-commands/lib/types/client/service.d.ts:40` |
| `ctx.locale.register/bind` | 双语文案 | `dsh-client-locale` 服务（v1 已用，`lib/client.js:361-363`） |
| `ctx.inject([...], cb)` | 等待 `fs`/`webServer` 等可选服务 | `dsh-cordis` 标准 API（v1 用于 `resources`/`sidebarRightTabs`，`lib/client.js:381`） |
| `ctx.slots.inject(name, cb)` | 兜底桥注册 | `dsh-client-ui-slots` 标准 API（v1 用法 `lib/client.js:389-395`） |
| `ctx.effect(fn)` | 资源生命周期 | Cordis 标准（v1 已用） |

---

**如果只做 P0，最小可交付是什么**：`/enhance <粗糙提示词>` 只做一次结构化模型调用（仅 `deliver_prompt` 工具），结果在右侧栏面板里可编辑预览，点插入写回输入框；全程不产生任何 DSH 会话、不拼接上下文文本、不依赖 preset。P0 的验收线是 13.1 的四条断言，P1/P2/P3 均是它的增量。
