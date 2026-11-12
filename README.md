# Session manager for DeepSeek Harness

A DeepSeek Harness (DSH) plugin that adds a **Session manager** entry to the left sidebar: list every
session with its durable size and a deletion-risk verdict, select many at once, and archive them,
move them to a 30-day recycle bin, or delete them — with one-click undo and a full audit trail.

The panel and its copy are bilingual (Chinese and English). The joke-naming mode in the panel title
switches feature names between an office-speak set (毕业办 / 办理毕业 / 返聘 / 销户 / 人才池) and a plain
professional set; the default is the plain set, and the choice is remembered per browser.

## What it does

| Capability | Detail |
| --- | --- |
| Bulk selection | Search by title, folder or id; filter by archive state and workspace; select many rows. |
| Deletion risk | Every row is judged by a **versioned policy document** (`policy/risk-policy.json`): warning (pinned / running / has derived sessions / active in the last 24 h), check first (active this week, log ≥ 20 MB), safe to remove (never used / produced by a subagent / archived and idle / idle for 7+ days). Only warnings carry a row marker, and the confirm sheet breaks the selection down by tier and names the warnings. |
| Archive | Batch archive / unarchive through the host's own workspace controller. |
| Recycle bin | Removals move the session directory to `<DSH_HOME>/trash/sessions/<id>/` with a sidecar recording origin and expiry. Restore, permanent delete, and "remove expired" live in the bin view. Retention defaults to 30 days (`trashRetentionDays`, `0` = keep forever). |
| Undo | Moving to the bin is immediately reversible from the status line. |
| Attachment cleanup | Images and files that a session used stay on disk after the session is gone. The cleanup action reclaims only objects that no surviving session (including trashed ones) references, verifies itself afterwards, and refuses to run when a reference document cannot be read. |
| Audit | Every destructive action appends a JSON line to `<DSH_HOME>/logs/session-manager.jsonl`, including the risk-policy version that produced the verdict. |

## Safety model

- A path is only ever touched when `sessionPersistence.stat(id)` reported it; a directory is removed
  only when its name is that session's id, otherwise the reported file alone.
- A running session is archived (activity stopped) and re-checked before anything moves.
- Every move is verified: the entry must hold a readable log and the original path must be free,
  otherwise the session is **put back** and the caller gets `trash-verify-failed`.
- Irreversible removals refuse to orphan a live session (`has-descendants`) unless the caller passes
  `force`; the recycle-bin confirm states the cost before it does.
- `delete`, `trash-restore`, `trash-purge` and the attachment cleanup are serialized in-process, so a
  cleanup can never race a restore.
- Both destructive routes sit behind the host's own trust fence (Host/Origin plus the browser session
  cookie).

## Install

Requires DeepSeek Harness with the Web UI (the plugin registers a sidebar panel and one same-origin
HTTP route).

**From this repository** — clone it and add the directory:

```bash
git clone https://github.com/yinmyu/dsh-session-manager.git
```

Then in DSH open **Plugins → Add plugin** and point it at the cloned directory. In a scripted
environment the equivalent is `plugin_manager` `install_bundle` with that absolute path.

**As a package** — once published, `pnpm add @yinmyu/dsh-session-manager` inside your DSH profile does
the same thing.

After installing, reload the page (the client half is a browser module) and open **Session manager** in
the left sidebar. The host half reloads only when the application restarts.

## Configuration

Optional, in the bundle row's `config`:

```yaml
- insert:
    - id: session-manager
      name: '@yinmyu/dsh-session-manager'
      config:
        auditLog: true          # default true
        maxConcurrency: 4       # 1..8, default 4
        trashRetentionDays: 30  # 0 keeps entries forever
```

## Development

No dependencies, no build step: `index.js` is the host plugin and `client.js` is the browser module.

```bash
npm test          # host protocol/safety suite + client logic suite (both self-contained)
```

`tools/host-smoke.mjs` runs the real route handler against fake services and only writes under
`tools/.smoke/`; `tools/client-smoke.mjs` drives the actual panel component with an emulated React so
copy, keyboard behaviour, request payloads and failure handling are covered in both locales.

Calibrating the deletion-risk policy against a real machine is a request, not a script:

```bash
curl -s -X POST -H 'content-type: application/json' --cookie "$COOKIE" \
  -d '{"op":"risk-stats"}' http://127.0.0.1:<dsh-port>/plugins/session-manager/api
```

It returns a histogram plus per-rule hit counts; pass a candidate policy as `{"op":"risk-stats","policy":{…}}`
to dry-run different thresholds without changing the shipped one.

## Layout

```
index.js                  host half: one same-origin route, recycle bin, attachment cleanup, risk evaluator
client.js                 client half: sidebar entry and panel (React via the host module table)
policy/risk-policy.json   versioned deletion-risk policy (rules, thresholds, unknown-fact guard)
cordis.patch.yml          bundle patch that inserts the loader row
locale/{en,zh}.json       display title, description and detail document
docs/                     detail document and its single preview image
tools/                    the two test suites
```

## 中文说明

在 DeepSeek Harness 左侧栏增加「会话管理」：批量选择会话，查看每条的删除风险（警告 / 谨慎 / 建议删除），
批量归档、移入 30 天回收站（可恢复、支持一键撤销）或彻底删除；另有附件清理，只回收不再被任何会话引用的
图片与文件，并在完成后自检。所有破坏性操作写入审计日志。

安装：`git clone` 后，在 DSH 的 **Plugins → Add plugin** 里选择本目录；或 `pnpm add @yinmyu/dsh-session-manager`。
安装后刷新页面即可看到左侧栏入口。详见 [CHANGELOG.md](CHANGELOG.md) 与 [DESIGN.md](DESIGN.md)。

## License

MIT — see [LICENSE](LICENSE).