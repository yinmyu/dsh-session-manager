# Session Manager — design brief (shared context)

Goal: a DSH Web UI plugin with a **left sidebar entry** that opens a management panel for
**batch-managing history sessions**: multi-select, archive / unarchive, and **permanent delete**
(remove the session log from disk).

Target package dir: `/Users/ivanyin/dsh-plugins/session-manager` (installed into profile `desktop`
by the Lead with `plugin_manager install_bundle`).

## Architecture (fixed — do not change without telling the Lead)

* **Client half** (`client.js`, static `window.__ModuleLoader__` module, plain JS + React.createElement):
  * registers `sidebar.panellist` (id `session-manager`) → icon button in the left rail.
  * registers `main` (key `session-manager`) → the panel body (sidebar entry selects it).
  * reads the session list from the **live client stores** via the slot standard props
    (`useSessions` / `useWorkspaces`), i.e. the same data the sidebar itself renders.
  * archive / unarchive via the shipped client services `ctx.workspaces.archiveSession(id, {stopActivity:true})`
    and `ctx.workspaces.unarchiveSession(id)` (they update the client store and fire the host archive set).
  * permanent delete = archive first (stops activity + updates stores), then call the package's own
    Host HTTP endpoint (see contract) to remove the log from disk, then hide the deleted ids locally
    (the client session store has no "session deleted" push, so rows are filtered locally).
* **Host half** (`index.js`, ESM, `export function apply(ctx, config)`, `export const inject = [...]`):
  * registers exactly one web route that implements the JSON contract below. No Typert, no build step.
  * uses `ctx.get('sessionController').list(request, signal)` for a cross-check listing,
    `ctx.get('sessionPersistence').stat(id)` for the on-disk `location`, and `node:fs/promises`
    to delete it. Archives the session before deleting when needed.

Rationale for the route: a plain-JS bundle client half only gets `require` (React) — it has no
`host.call` RPC (that is the *dynamic* package path), and there is no shipped Remote that deletes a
session. A same-origin HTTP route registered on `ctx.webServer` is the sanctioned transport.

## Host HTTP contract (fixed)

`POST /plugins/session-manager/api` , JSON body, same-origin from the Web UI.

```json
{ "op": "delete", "sessionIds": ["session-...", "session-..."] }
```

Response `200`:

```json
{ "ok": true, "deleted": ["session-..."], "failed": [ { "sessionId": "session-...", "reason": "..." } ] }
```

Also implement (used for debugging / defensive fallback only):

* `{"op":"list"}` → `{ "ok": true, "items": [ { "sessionId", "title", "cwd", "updatedAt", "running", "blank", "archived" } ] }`
  (archived flag may be `false` if the archive set is not reachable from the host; client is authoritative for it)
* `{"op":"ping"}` → `{ "ok": true, "version": "1" }`

Bad JSON / unknown op → HTTP 400 with `{"ok":false,"reason":"..."}`. Never throw out of the handler.

## UI spec (client half)

Panel is a management list in the host's visual language (theme tokens `--dsw-alias-*` only, no literal
colors except artwork), dark+light safe, keyboard accessible:

* header: title （会话管理 / Sessions）, count summary, and a hint line.
* filter row: segmented filter 全部 / 未归档 / 已归档 + search box (title, cwd, id).
* list rows: checkbox, title (fallback `cwd` basename then id), relative time, badges
  (运行中 / 空白 / 子会话 / 已归档). Row click toggles selection.
* selection bar: 已选 N + actions 归档 / 取消归档 / 彻底删除 + 清除选择.
* 彻底删除 must be a two-step confirm inside the panel (irreversible); show the count.
* status line for progress/errors (e.g. 已归档 3 项 / 删除失败：…).
* all visible text through the Client locale service (zh + en).

## Facts already verified (don't re-derive)

* Slots: `sidebar.panellist` (list, registration `{id, order, label}`, props `{size, active}`) and
  `main` (keyed, key = the sidebar entry id; reserved key `conversation`).
* Client services available: `layout`, `locale`, `sessions`, `slots`, `theme`, `timer`,
  `uiWorkspace`, `workspaces`. `ctx.remote` exists but is Typert-generated (avoid).
* Host: there is **no** session delete API. `sessionPersistence` exposes `stat(id)` /
  `list()` with `SessionPersistenceSnapshot.location = {kind, path}`.
* Session logs live under `~/.dsh/sessions/<cwd-slug>/<sessionId>/`.
* Extracted (readable) shipped sources: `/Users/ivanyin/dsh-work/src/dsh/node_modules/@deepseek-ai/`
  (grep only inside specific package dirs — a full-tree grep drowns in the pdf.js bundle).
  Bundle python: `/Users/ivanyin/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3`,
  node: `/Users/ivanyin/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`.
---

# v2 — engineering hardening (2026-11-11)

Motivation: v1 works, but a mature version must (a) tell the user what a deletion will actually
reclaim, (b) reclaim the real disk bulk (attachments, not logs), (c) make an irreversible action
auditable, (d) report machine-readable failures so the UI can localize them, and (e) not scale
linearly in wall-clock time for large batches.

## Protocol v2 (superset of v1; v1 shapes stay valid)

`POST /plugins/session-manager/api`, same auth fence, same JSON envelope. Ops:

```jsonc
// list — adds bytes (durable log size) per row
{ "op": "list" } -> { "ok": true, "items": [ { "sessionId", "title", "cwd", "updatedAt",
                        "running", "blank", "archived", "bytes" } ] }

// sizes — cheap map for the panel's size column and "selected size" totals
{ "op": "sizes" } -> { "ok": true, "sizes": { "<sessionId>": 123456 }, "scannedAt": 0 }

// delete — adds freedBytes + machine-readable failure codes
{ "op": "delete", "sessionIds": [ "…" ] } ->
  { "ok": true, "deleted": [ "…" ],
    "failed": [ { "sessionId": "…", "code": "not-found|running|no-location|io|invalid-id|archive-failed|unknown",
                  "reason": "human readable english" } ],
    "freedBytes": 123456,
    "auditLog": "/abs/path/to/logs/session-manager.jsonl" }   // null when auditing is disabled

// gc-preview / gc — reclaim attachments no surviving session references
{ "op": "gc-preview", "includeRequestImageCache": false } ->
  { "ok": true, "report": { "sessionsScanned": 104, "referencedImages": 0, "referencedFiles": 0,
      "groups": [ { "name": "objects", "files": 1587, "bytes": 519569408,
                    "deletableFiles": 1587, "deletableBytes": 519569408 } ],
      "deletableBytes": 0, "cacheFiles": 0, "cacheBytes": 0 } }
{ "op": "gc", "includeRequestImageCache": false, "dryRun": false } ->
  { "ok": true, "deletedFiles": 0, "freedBytes": 0, "groups": [ … ], "failed": [ { "path", "reason" } ],
    "auditLog": "/abs/path/to/logs/session-manager.jsonl" }  // null for dryRun

{ "op": "ping" } -> { "ok": true, "version": "2" }
```

### Attachment GC safety model (must be implemented exactly)

Store: `<DSH_HOME>/attachments/v1` (`DSH_HOME` = `$DSH_HOME` else `~/.dsh`).

* `objects/<2>/<sha256>` — normalized image attachments. Ids in a session log are `sha256:<64hex>`.
* `file-objects/<2>/<sha256>` and `files/<2>/<sha256>/<displayName>` — generic file attachments.
* `request-images/<2>/<hash>` — **pure derived cache** (a miss is re-encoded on demand), keyed by a
  request hash that is *not* the attachment id, so it cannot be mapped to references.

Algorithm:
1. Collect referenced digests: decompress and scan **every surviving session log**
   (`sessions/**/session.v*.jsonl[.zstd]`, streaming, no full-corpus retention) plus every
   `storages/session_projcache/sessions/*.json`, matching `sha256:[0-9a-f]{64}` and bare 64-hex
   basenames. A digest that appears anywhere is referenced.
2. Candidate groups = `objects`, `file-objects`, `files/<2>/<digest>/…` only. `request-images` is
   offered separately and deleted only with `includeRequestImageCache: true` (default false), because
   it is safe but costs a re-encode.
3. Never delete outside `<DSH_HOME>/attachments/v1`; never follow symlinks; never delete a directory
   that still holds files; ignore `tmp/`.
4. `gc-preview` never writes. `gc` with `dryRun: true` reports what it would delete.
5. Per-file failures are collected, not fatal; a partially deleted cache is always consistent
   because every store entry is content-addressed and independently valid.

### Audit trail

Deletion and GC append one JSON line each to `<DSH_HOME>/logs/session-manager.jsonl`:
`{ "time", "op", "sessions": [{ "sessionId", "title", "bytes" }], "freedBytes", "failed": n, "actor": "ui" }`.
Failures to write the log are logged once and never fail the request. The path is reported in the
panel's status detail so the user can find it.

### Options (read defensively from the bundle row `config`, no schema export)

* `auditLog`: boolean, default `true`.
* `maxConcurrency`: integer 1..8, default `4` — bounds parallel per-session archive/stat/remove work.
* Unknown keys are ignored; invalid values fall back to the default.

## UI v2

* Size column per row; the selection bar shows the selected total (e.g. `已选 12 项 · 约 8.4 MB`).
* Delete status reports freed bytes; failures are localized from `failed[].code`
  (`not-found` → the row had no log left, hidden after the attempt).
* A toolbar action `清理残留附件` appears only when the preview is non-zero: preview shows the safe
  size and the optional cache size, a checkbox toggles the cache, then the irreversible confirm.
* Batches keep bounded concurrency and progress; the panel never blocks on one slow session.

---

# v3 — 回收站与批量筛选（2026-11-11/12）

动机：v2 把删除做得可追踪、可回收附件，但**仍然是不可恢复的**——这是这个插件最大的产品风险。
v3 把「彻底删除」改成两段式：先移入回收站（默认保留 30 天，可恢复），到期才真正删除；回收站内
可以手动恢复或永久清除。同时补上按工作区的筛选（批量管理一个项目下的会话）。

## Protocol v3（在 v2 之上）

### 1. `delete` 语义变更（默认不销毁）

```jsonc
{ "op": "delete", "sessionIds": ["…"], "permanent": false } ->
  { "ok": true,
    "trashed": ["…"],            // 移入回收站（默认路径）
    "deleted": ["…"],            // 仅在 permanent:true 时非空
    "failed": [ { "sessionId", "code", "reason" } ],
    "trashedBytes": 1234,        // 移入回收站的数据量（未释放）
    "freedBytes": 0,             // 真正释放的字节（permanent 时才有值）
    "auditLog": "/abs/path/session-manager.jsonl" }
```

失败码在 v2 基础上新增：`trash-move-failed`、`trash-entry-exists`、`not-in-trash`、
`restore-target-exists`、`purge-failed`。

### 2. 回收站接口

```jsonc
{ "op": "trash-list" } -> { "ok": true, "retentionDays": 30, "totalBytes": 0,
  "items": [ { "sessionId", "title", "bytes", "trashedAt", "expiresAt", "expiresInDays", "originalPath" } ] }

{ "op": "trash-restore", "sessionIds": ["…"] } -> { "ok": true, "restored": ["…"], "failed": [ … ] }

{ "op": "trash-purge", "sessionIds": ["…"] }            // 指定条目永久删除
{ "op": "trash-purge", "expiredOnly": true }             // 只清已过期
{ "op": "trash-purge", "all": true }                     // 清空
  -> { "ok": true, "purged": ["…"], "freedBytes": 0, "failed": [ … ], "auditLog": "…" }
```

### 3. 存储布局与约束

- 条目目录：`<DSH_HOME>/trash/sessions/<sessionId>/`，把会话目录整体移入（同一文件系统内 rename；
  `EXDEV` 时退化为递归复制后删除）。
- 元数据：条目目录内 `.dsh-trash.json`：`{ "schema": 1, "sessionId", "originalPath", "trashedAt",
  "expiresAt", "title", "bytes" }`。删除条目目录即删除元数据，不需要第二份索引。
- 移动前仍然只信任 `sessionPersistence.stat()` 报告的路径，并按 v2 的目录归属规则确认。
- 回收站里已存在同名 id 时**拒绝覆盖**（`trash-entry-exists`）。
- `trash-restore` 重建父级 slug 目录；目标已存在则拒绝（`restore-target-exists`）；恢复后删除侧车文件。
- 过期清理**只**由三处触发：插件激活时、每小时一次的定时器（随插件卸载释放）、以及显式的
  `trash-purge`。**读操作与无关写操作绝不销毁数据**：`trash-list` 只报告（过期条目显示 0 天），
  `trash-restore` 与 `delete` 不顺手清理——否则一次「恢复」可能把自己的目标清掉。`trashRetentionDays` 配置：默认 30，`0` = 永久保留，非法值回落默认。
- **附件 GC 必须把回收站里的日志也算作引用来源**：否则恢复回来的会话会变成"图片不见了"。
- 审计：`{op:"trash"|"restore"|"purge"}` 各写一条，含会话 id/标题/字节。

### 4. 面板（UI v3）

- 删除确认文案改为「移入回收站 · N 天内可恢复」，主按钮「移入回收站」；成功状态显示移动量与可恢复提示。
- 新增第四个筛选段「回收站」：列出条目（标题、大小、剩余天数），选择后可「恢复」「彻底删除」（二次确认），
  工具栏提供「清空已过期」。
- 新增按工作区筛选（数据来自 `useWorkspaces` 快照，按 cwd 匹配），与搜索/归档筛选可组合。
- 清理残留附件仍保持独立动作；其预览扫描必须包含回收站里的引用（与服务端规则一致）。

## v3 实现说明（与最初草案的差异，记录以便维护）

- `trash-purge` **不做**请求前的过期清扫：过期选择本身就是它的职责，先清扫会让「清空已过期」总是报 0。
  清扫只发生在 `trash-list`（面板入口，看到的就是最新状态）与 `delete`（回收前先腾掉过期条目）。
- 恢复/清除的审计行写入条目的标题与字节数（在目录消失前读取侧车），而不是只有 id。
- 过期清扫同时由激活、请求与每小时定时器触发；定时器安装失败只降级为「无定时清扫」，不影响路由挂载
  （真实 Cordis 探针覆盖了这个降级路径）。
- 回收站条目的 `.dsh-trash.json` 不参与会话日志匹配规则（`SESSION_LOG_NAME`），因此不会污染引用扫描。

---

# v4 架构：删除风险 = 策略数据 + 纯求值器 + 唯一裁决方

## 问题（不是阈值，是结构）
v0.5.0 把三档判定写进了客户端 bundle：阈值是魔法数字、判定逻辑与渲染耦合、只能靠一次性脚本校准，而且同一套"什么算旧、什么算活跃"的判断已经在 Host 的审计/GC/回收站里各有一份近似实现——两端各写一遍必然漂移。真实数据立刻暴露后果：第一版把 111 个会话里的 97 个判成"谨慎"，等于没分层。

## 结构
- `policy/risk-policy.json`：`schemaVersion` / `policyVersion` / `tiers` / `rules[{id,tier,reason,priority,when}]` / `fallback` / `guards.unknownFactTier`。规则是声明式谓词（`{fact,op,value}`、`and`），求值器只实现算子（`isTrue/isFalse/eq/gte/lt`）。改阈值只改这个文件并升 `policyVersion`。
- Host 求值（`evaluateRisk`）：按优先级排序，最高优先级命中决定档位，同档命中合并为原因（运维一次看到"置顶 · 运行中 · 有 2 个派生会话"）。返回 `{tier, reasons, ruleIds, degraded}`。
- 事实装配（`collectRiskFacts`）：只由 Host 提供——pin/归档状态（workspaceRegistry）、运行/空白/来源/派生计数（sessionController.list）、日志字节（sessionPersistence.stat）。客户端不产生事实。
- 接口：`{op:"risk"}`（裁决 + `policyVersion`）、`{op:"risk-stats", policy?}`（直方图/规则命中/降级/样例，候选策略 dry-run）。删除类审计记录 `riskPolicy` 版本。
- 客户端职责边界：取裁决、渲染（角标/原因/分档行/按档选中）。**没有裁决就不判断**：不猜档位、不推荐、不显示分档行。

## 安全不变量（有测试）
1. 结构性事实（置顶/运行中/有派生会话）永远压过行为性事实，与时间无关；
2. 缺失事实不得等于"安全"：比胜出规则更高的规则若因事实缺失无法判定，低风险降级为"谨慎"并标记 `degraded`；
3. 谓词未知 ≠ 谓词为假（`unknown` 是一等结果）；
4. 策略非法（重复 id、未知档位、无规则）在加载与校准时都拒绝；校准请求的错误是 400 而不是 500；
5. 分布守卫：谨慎/警告两档各自不超过语料的 70%，建议删除档不低于 20%。

## 为什么客户端不共享求值器
客户端半部是静态 `window.__ModuleLoader__` 模块，只能 `require('react')`，不能 import 本包的共享模块；把策略再写一遍就是漂移的根源。因此裁决只在 Host，客户端拿裁决渲染——这也顺带解决了"客户端看不到 pin/归档/附件大小"的事实缺口。

## 尚未做（下一步）
- 策略可被用户覆盖：把 `policyVersion` + 覆盖片段放进 bundle 行 `config`，加载时与随包策略做确定性合并（现在是替换文件，升级会覆盖）。
- 面板内展示 `policyVersion` 与"为什么这一档"的完整解释（目前只有 tooltip 原因与审计版本）。
- 把 Host 侧其他策略常量（`GC_PROTECT_RECENT_MS`、回收站保留期）也纳入同一份策略文档，形成单一的"策略面"。
