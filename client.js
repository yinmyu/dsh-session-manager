/**
 * Session Manager — the Web UI half of @local/dsh-session-manager.
 *
 * A sidebar entry in the left rail (`sidebar.panellist`, id `session-manager`)
 * opens a management panel in the centre column (`main`, key `session-manager`)
 * that batch-manages history sessions: multi-select, archive / unarchive, and a
 * two-step permanent delete that removes the session log from disk.
 *
 * Data is read from the live client stores through the slot's standard props,
 * which are the same projections the sidebar itself renders:
 *
 *   useSessions((state) => state.byId)              // Record<sessionId, SessionSummary>
 *     row fields used here: id, displayTitle, title?, cwd?, updatedAt, running,
 *     blank, origin?, parentId?. `displayTitle` is the host's own
 *     title → folder-name → id derivation (client session-controller
 *     `projectList()`), so row titles match the sidebar's.
 *   useSessions((state) => state.phase)             // 'pending' | 'ready'
 *   useWorkspaces((state) => state.archivedSessionIds)  // string[]
 *
 * Archive / unarchive go through the injected callbacks, which use the shipped
 * client service `workspaces.archiveSession(id, {stopActivity: true})` /
 * `workspaces.unarchiveSession(id)`; both install the returned archive set into
 * the store, so the panel follows without polling.
 *
 * Permanent delete archives first (so a running session is stopped instead of
 * refused), then calls this bundle's own Host route (see DESIGN.md):
 *
 *   POST /plugins/session-manager/api  {"op":"delete","sessionIds":[...]}
 *   → {"ok":true,"deleted":[...],"freedBytes":…,
 *      "failed":[{"sessionId":…,"code":…,"reason":…}]}
 *
 * v2 adds durable sizes and attachment cleanup on the same route:
 *
 *   {"op":"sizes"}        → {"ok":true,"sizes":{"<id>":bytes}}
 *   {"op":"gc-preview"}   → {"ok":true,"report":{…}}
 *   {"op":"gc"}           → {"ok":true,"deletedFiles":n,"freedBytes":n,…}
 *
 * The client session store has no "session deleted" push, so ids the Host
 * reports as deleted — and ids whose log is already gone (`not-found`) — are
 * hidden locally for the rest of the app session. A Host that still answers v1
 * (no sizes / no failure codes / no gc) degrades: the rows show no size, the
 * cleanup action never appears, and failures fall back to their raw reason.
 *
 * Everything visible is routed through the Client locale service (zh is the
 * primary locale, en is complete), and every style value is a --dsw-alias-* /
 * --dsw-radius-* / --dsw-focus-ring-* theme token, so the panel follows the
 * host's light and dark themes.
 */
window.__ModuleLoader__.load({
  id: '@yinmyu/dsh-session-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Sidebar list id; also the `main` cell key the sidebar selects. */
    const PANEL_ID = 'session-manager';
    /** Locale namespace owned by this bundle. */
    const NS = 'sessionManager';
    /** Same-origin Host route registered by this bundle's index.js. */
    const API_PATH = '/plugins/session-manager/api';
    /** Rows rendered in one pass; search narrows a larger history. */
    const MAX_ROWS = 300;

    /* ------------------------------------------------------------------ */
    /* Locale                                                              */
    /* ------------------------------------------------------------------ */

    const DICTS = {
      en: {
        'panel.label': 'Session manager',
        'panel.title': 'Session manager',
        'panel.introOne': '{total} sessions',
        'panel.introArchived': '{count} archived',
        'panel.introRunning': '{count} running',
        'panel.introSize': '{size} on disk',
        'panel.intro': '{total} sessions',
        'panel.hint': 'Select sessions to archive or remove them in batches.',
        'panel.hintTrash': 'Removed sessions go to the recycle bin first and can be restored for {days} days.',
        'filter.aria': 'Filter sessions',
        'filter.all': 'All',
        'filter.active': 'Active',
        'filter.archived': 'Archived',
        'filter.trash': 'Recycle bin',
        'search.aria': 'Search sessions',
        'search.placeholder': 'Search titles, folders, or IDs',
        'list.selectAll': 'Select all',
        'list.selectAllAria': 'Select every session in this list',
        'list.count': '{shown} of {total} shown',
        'list.truncated': 'Showing the newest {count}. Search to reach older sessions.',
        'list.loading': 'Loading…',
        'list.empty': 'No sessions yet.',
        'list.emptyFiltered': 'No session matches these filters.',
        'row.selectAria': 'Select {title}',
        'badge.running': 'Running',
        'badge.blank': 'Empty',
        'badge.child': 'Child',
        'badge.archived': 'Archived',
        'risk.title': 'Deletion risk',
        'risk.low': 'Safe to remove',
        'risk.medium': 'Check first',
        'risk.high': 'Keep an eye on',
        'risk.reason.blank': 'never used',
        'risk.reason.subagent': 'produced by a subagent',
        'risk.reason.archivedIdle': 'archived and idle for 30+ days',
        'risk.reason.pinned': 'pinned',
        'risk.reason.running': 'running right now',
        'risk.reason.children': '{count} sessions derive from it',
        'risk.reason.recent24h': 'active in the last 24 hours',
        'risk.reason.recent7d': 'active in the last 7 days',
        'risk.reason.stale': 'no activity for 7+ days',
        'risk.reason.large': '{size} of log',
        'risk.reason.other': 'has content',
        'risk.rowTitle': 'Deletion risk: {reasons}',
        'risk.summaryLow': 'Safe to remove: {count} — {reasons}',
        'risk.summaryMedium': 'Check first: {count}',
        'risk.summaryHigh': 'Keep an eye on: {count} — {names}',
        'risk.summaryHighMore': 'and {count} more',
        'risk.selectLow': '{count} can be removed safely',
        'risk.selectLowAria': 'Select the sessions that are safe to remove',
        'risk.breakdown': '{tiers} of {total} selected',
        'risk.none': 'Nothing selected needs special care.',
        'selection.count': '{count} selected',
        'selection.size': '{count} selected · {size}',
        'selection.sizeLower': '{count} selected',
        'action.archive': 'Archive',
        'action.unarchive': 'Unarchive',
        'action.delete': 'Move to recycle bin',
        'action.restore': 'Restore',
        'action.undo': 'Undo',
        'vocab.toStandard': 'Plain names',
        'vocab.toJargon': 'Office-speak',
        'vocab.aria': 'Switch how features are named',
        'action.back': 'All sessions',
        'action.purge': 'Delete permanently',
        'action.purgeExpired': 'Remove expired',
        'action.clear': 'Clear selection',
        'trash.empty': 'The recycle bin is empty.',
        'trash.emptyHint': 'Removed sessions stay here for {days} days and are then deleted automatically.',
        'trash.emptyHintForever': 'Removed sessions stay here until you delete them.',
        'trash.emptyHintUnknown': 'Removed sessions are deleted when their retention ends.',
        'trash.expiresIn': '{days} days left',
        'trash.expired': 'Due now',
        'trash.kept': 'Kept',
        'trash.intro': '{count} · {size}',
        'trash.retention': 'Kept {days} days',
        'confirm.trashTitle': 'Move to recycle bin',
        'confirm.trashBody': '{count} sessions move to the recycle bin and can be restored for {days} days.',
        'confirm.trashBodyUnknown': '{count} sessions move to the recycle bin and can be restored during the retention period.',
        'confirm.trash': 'Move to recycle bin',
        'confirm.purgeTitle': 'Delete permanently',
        'confirm.purgeBody': '{count} sessions leave the recycle bin for good. This cannot be undone.',
        'confirm.purge': 'Delete permanently',
        'confirm.purgeDescendants': '{entries} of them still have {count} derived sessions',
        'files.question': 'Also delete the files uploaded or created in this conversation',
        'files.detail': 'Uploaded attachments: {attachments} ({attachmentExclusive} used only here) · Files it wrote: {paths} ({pathExclusive} written only here)',
        'files.shared': 'Anything another session still uses is kept. Deletion cannot be undone.',
        'files.pathsTitle': 'Files that would be deleted:',
        'files.none': 'This conversation has no files of its own.',
        'files.removed': 'deleted {count} files',
        'confirm.title': 'Delete permanently',
        'confirm.body': '{count} session logs are removed from disk. This cannot be undone.',
        'confirm.delete': 'Delete permanently',
        'confirm.cancel': 'Cancel',
        'status.trashing': 'Moving {done} of {total}…',
        'status.trashed': 'Moved {count} to the recycle bin · {size}',
        'status.trashedNoSize': 'Moved {count} to the recycle bin',
        'status.restoring': 'Restoring {done} of {total}…',
        'status.restored': 'Restored {count}',
        'status.purging': 'Deleting {done} of {total}…',
        'status.purged': 'Deleted {count} permanently · {size} freed',
        'status.purgedNoSize': 'Deleted {count} permanently',
        'status.archiving': 'Archiving {done} of {total}…',
        'status.unarchiving': 'Unarchiving {done} of {total}…',
        'status.deleting': 'Deleting {done} of {total}…',
        'status.archived': 'Archived {count}',
        'status.unarchived': 'Unarchived {count}',
        'status.deleted': 'Deleted {count} permanently · {size} freed',
        'status.deletedNoSize': 'Deleted {count} permanently',
        'status.gone': '{count} sessions had no log left and were removed from the list',
        'status.partial': '{failed} of {total} could not finish: {reason}',
        'status.failed': '{reason}',
        'fail.code.not-found': 'That session has no log any more',
        'fail.code.running': 'This session is still running — try again once it stops',
        'fail.code.no-location': 'The session log has no known location',
        'fail.code.io': 'The disk could not be read or written — try again',
        'fail.code.invalid-id': 'That session ID is not valid',
        'fail.code.archive-failed': 'The session could not be stopped — try again',
        'workspace.all': 'All workspaces',
        'workspace.aria': 'Filter by workspace',
        'fail.code.trash-move-failed': 'It could not be moved to the recycle bin',
        'fail.code.trash-entry-exists': 'The recycle bin already holds that session',
        'fail.code.not-in-trash': 'It is no longer in the recycle bin',
        'fail.code.restore-target-exists': 'Its original folder is occupied again',
        'fail.code.purge-failed': 'It could not be deleted',
        'fail.code.trash-verify-failed': 'The move did not verify, so it was put back',
        'fail.code.restore-verify-failed': 'It came back, but the log could not be confirmed',
        'fail.code.has-descendants': 'Other sessions still derive from it',
        'fail.code.unknown': 'Something went wrong — try again',
        'fail.detail': '{label}',
        'size.bytes': '{n} {unit}',
        'size.unknown': '—',
        'size.aria': 'Log size',
        'action.gc': 'Clean up unused attachments',
        'action.gcSize': 'Clean up unused attachments · {size}',
        'gc.notice': '{size} of images and files are no longer used by any session.',
        'gc.noticeAction': 'Clean up',
        'gc.preparing': 'Checking attachments…',
        'gc.title': 'Clean up unused attachments',
        'gc.scanned': 'Checked {sessions} sessions; they still use {images} images and {files} files.',
        'gc.safe': 'Can be removed: {files} files · {size}',
        'gc.safeNone': 'Nothing to remove.',
        'gc.includeCache': 'Also clear the image cache ({files} files · {size}); it is rebuilt on demand',
        'gc.includeCacheEmpty': 'The image cache is empty',
        'gc.body': 'Removing a session leaves its images and files on disk. This cleans up only what no session uses any more, so no existing session is affected.',
        'gc.confirm': 'Clean up {size}',
        'gc.audit': 'Recorded in {path}',
        'gc.auditHint': 'Recorded in the audit log in your Harness folder.',
        'status.gcRunning': 'Cleaning up attachments…',
        'status.gcDone': 'Removed {files} files · {size} freed',
        'status.gcNothing': 'Nothing to clean up.',
        'status.gcPartial': '{failed} files could not be removed: {reason}',
        'status.gcUnverified': 'Removed {files} files · {size} freed, but {count} attachments this history names are still missing',
        'gc.unresolved': '{count} attachments in your history no longer have files on disk. They are not the result of this cleanup.',
        'gc.unresolvedAria': 'Attachments with no file on disk',
        'error.http': 'The session service is not reachable right now — refresh and try again.',
        'error.badPayload': 'The session service returned something unexpected — try again.',
        'error.noService': 'Archiving is not available in this setup.',
        'error.render': 'This panel could not be shown ({message})',
        'time.now': 'now',
        'time.minutes': '{n} min',
        'time.hours': '{n} h',
        'time.days': '{n} d',
        'time.ago': '{t} ago',
        'time.absolute': '{date} {time}',
        'time.clock': '{h}:{i}',
        'date.ymd': '{y}-{m}-{d}',
        'progress.aria': 'Batch progress',
      },
      zh: {
        'panel.label': '会话管理',
        'panel.title': '会话管理',
        'panel.introOne': '{total} 个会话',
        'panel.introArchived': '已归档 {count}',
        'panel.introRunning': '运行中 {count}',
        'panel.introSize': '共 {size}',
        'panel.intro': '{total} 个会话',
        'panel.hint': '选中会话后，可以批量归档或删除。',
        'panel.hintTrash': '删除的会话会先放入回收站，{days} 天内都能恢复。',
        'filter.aria': '筛选会话',
        'filter.all': '全部',
        'filter.active': '未归档',
        'filter.archived': '已归档',
        'filter.trash': '回收站',
        'search.aria': '搜索会话',
        'search.placeholder': '搜索标题、目录或 ID',
        'list.selectAll': '全选',
        'list.selectAllAria': '选择当前列表中的全部会话',
        'list.count': '显示 {shown} / 共 {total} 个',
        'list.truncated': '只显示最近的 {count} 个，用搜索可以找到更早的。',
        'list.loading': '正在载入…',
        'list.empty': '还没有任何会话。',
        'list.emptyFiltered': '没有符合条件的会话。',
        'row.selectAria': '选择 {title}',
        'badge.running': '运行中',
        'badge.blank': '空白',
        'badge.child': '子会话',
        'badge.archived': '已归档',
        'risk.title': '删除风险',
        'risk.low': '建议删除',
        'risk.medium': '谨慎',
        'risk.high': '警告',
        'risk.reason.blank': '从未使用',
        'risk.reason.subagent': '由子代理产生',
        'risk.reason.archivedIdle': '已归档且 30 天以上无活动',
        'risk.reason.pinned': '已置顶',
        'risk.reason.running': '正在运行',
        'risk.reason.children': '有 {count} 个会话由它派生',
        'risk.reason.recent24h': '24 小时内有过活动',
        'risk.reason.recent7d': '7 天内有过活动',
        'risk.reason.stale': '7 天以上没有活动',
        'risk.reason.large': '日志 {size}',
        'risk.reason.other': '有内容',
        'risk.rowTitle': '删除风险：{reasons}',
        'risk.summaryLow': '建议删除 {count} 项（{reasons}）',
        'risk.summaryMedium': '谨慎 {count} 项',
        'risk.summaryHigh': '警告 {count} 项（{names}）',
        'risk.summaryHighMore': '等 {count} 项',
        'risk.selectLow': '有 {count} 项可放心删除',
        'risk.selectLowAria': '选中可以放心删除的会话',
        'risk.breakdown': '已选 {total} 项：{tiers}',
        'risk.none': '所选项目都不需要特别留意。',
        'selection.count': '已选 {count} 项',
        'selection.size': '已选 {count} 项 · {size}',
        'selection.sizeLower': '已选 {count} 项',
        'action.archive': '归档',
        'action.unarchive': '取消归档',
        'action.delete': '移入回收站',
        'action.restore': '恢复',
        'action.undo': '撤销',
        'vocab.toStandard': '标准用语',
        'vocab.toJargon': '阿里黑话',
        'vocab.aria': '切换功能名称的叫法',
        'action.back': '全部会话',
        'action.purge': '彻底删除',
        'action.purgeExpired': '清理已到期',
        'action.clear': '清除选择',
        'trash.empty': '回收站是空的。',
        'trash.emptyHint': '删除的会话会在这里保留 {days} 天，之后自动清除。',
        'trash.emptyHintForever': '删除的会话会一直保留，直到你手动清除。',
        'trash.emptyHintUnknown': '删除的会话会在保留期结束后自动清除。',
        'trash.expiresIn': '{days} 天后清除',
        'trash.expired': '即将清除',
        'trash.kept': '长期保留',
        'trash.intro': '{count} 项 · {size}',
        'trash.retention': '保留 {days} 天',
        'confirm.trashTitle': '移入回收站',
        'confirm.trashBody': '{count} 个会话会移到回收站，{days} 天内可以恢复。',
        'confirm.trashBodyUnknown': '{count} 个会话会移到回收站，保留期内可以恢复。',
        'confirm.trash': '移入回收站',
        'confirm.purgeTitle': '彻底删除',
        'confirm.purgeBody': '{count} 个会话将从回收站永久移除，无法恢复。',
        'confirm.purge': '彻底删除',
        'confirm.purgeDescendants': '其中 {entries} 项仍有 {count} 个派生会话',
        'files.question': '同时删除在此对话中上传或创建的文件',
        'files.detail': '上传的附件 {attachments} 个（其中 {attachmentExclusive} 个仅本对话引用）· 创建的文件 {paths} 个（其中 {pathExclusive} 个仅本对话写过）',
        'files.shared': '被其他会话共用的文件会保留；删除后不可恢复。',
        'files.pathsTitle': '将被删除的文件：',
        'files.none': '这个对话没有自己的文件。',
        'files.removed': '同时删除 {count} 个文件',
        'confirm.title': '彻底删除',
        'confirm.body': '{count} 个会话的日志会从磁盘移除，无法恢复。',
        'confirm.delete': '彻底删除',
        'confirm.cancel': '取消',
        'status.trashing': '正在移入回收站 {done}/{total}',
        'status.trashed': '已移入回收站 {count} 项 · {size}',
        'status.trashedNoSize': '已移入回收站 {count} 项',
        'status.restoring': '正在恢复 {done}/{total}',
        'status.restored': '已恢复 {count} 项',
        'status.purging': '正在删除 {done}/{total}',
        'status.purged': '已彻底删除 {count} 项 · 释放 {size}',
        'status.purgedNoSize': '已彻底删除 {count} 项',
        'status.archiving': '正在归档 {done}/{total}',
        'status.unarchiving': '正在取消归档 {done}/{total}',
        'status.deleting': '正在删除 {done}/{total}',
        'status.archived': '已归档 {count} 项',
        'status.unarchived': '已取消归档 {count} 项',
        'status.deleted': '已彻底删除 {count} 项 · 释放 {size}',
        'status.deletedNoSize': '已彻底删除 {count} 项',
        'status.gone': '{count} 个会话已没有日志，已从列表移除',
        'status.partial': '{failed} 项未完成：{reason}',
        'status.failed': '{reason}',
        'fail.code.not-found': '这个会话已经没有日志了',
        'fail.code.running': '会话还在运行，停止后再试一次',
        'fail.code.no-location': '找不到会话日志的位置',
        'fail.code.io': '磁盘读写失败，请稍后重试',
        'fail.code.invalid-id': '会话标识无效',
        'fail.code.archive-failed': '没能停止会话，稍后再试',
        'fail.code.trash-move-failed': '没能移入回收站',
        'fail.code.trash-entry-exists': '回收站里已有同名条目',
        'fail.code.not-in-trash': '它已经不在回收站里了',
        'fail.code.restore-target-exists': '原来的目录被占用了',
        'workspace.all': '全部工作区',
        'workspace.aria': '按工作区筛选',
        'fail.code.purge-failed': '没能删除',
        'fail.code.trash-verify-failed': '移动校验没通过，已放回原处',
        'fail.code.restore-verify-failed': '已移回，但没能确认日志存在',
        'fail.code.has-descendants': '仍有会话由它派生',
        'fail.code.unknown': '出了点问题，请重试',
        'fail.detail': '{label}',
        'size.bytes': '{n} {unit}',
        'size.unknown': '—',
        'size.aria': '日志大小',
        'action.gc': '清理未使用的附件',
        'action.gcSize': '清理未使用的附件 · {size}',
        'gc.notice': '有 {size} 图片与附件已不再被任何会话使用。',
        'gc.noticeAction': '清理',
        'gc.preparing': '正在检查附件…',
        'gc.title': '清理未使用的附件',
        'gc.scanned': '已检查 {sessions} 个会话，仍在使用 {images} 张图片、{files} 个文件。',
        'gc.safe': '可清理 {files} 个文件 · {size}',
        'gc.safeNone': '没有可清理的附件。',
        'gc.includeCache': '同时清理图片缓存（{files} 个文件 · {size}），之后会自动重建',
        'gc.includeCacheEmpty': '图片缓存已经空了',
        'gc.body': '删除会话时，它用过的图片和附件仍留在磁盘上。这里只清理没有任何会话再引用的部分，不会影响现有会话。',
        'gc.confirm': '清理 {size}',
        'gc.audit': '记录已写入 {path}',
        'gc.auditHint': '操作记录已写入你的 Harness 目录。',
        'status.gcRunning': '正在清理附件…',
        'status.gcDone': '已清理 {files} 个文件 · 释放 {size}',
        'status.gcNothing': '没有需要清理的附件。',
        'status.gcPartial': '{failed} 个文件没能删除：{reason}',
        'status.gcUnverified': '已清理 {files} 个文件 · 释放 {size}，但历史里仍有 {count} 个附件找不到文件',
        'gc.unresolved': '历史里有 {count} 个附件已经没有对应文件了。它们不是这次清理造成的。',
        'gc.unresolvedAria': '找不到文件的附件',
        'error.http': '暂时连不上会话服务，刷新页面后再试。',
        'error.badPayload': '会话服务返回了意外结果，请重试。',
        'error.noService': '当前配置不支持归档。',
        'error.render': '这一页暂时显示不出来（{message}）',
        'time.now': '刚刚',
        'time.minutes': '{n} 分钟',
        'time.hours': '{n} 小时',
        'time.days': '{n} 天',
        'time.ago': '{t}前',
        'time.absolute': '{date} {time}',
        'time.clock': '{h}:{i}',
        'date.ymd': '{y}-{m}-{d}',
        'progress.aria': '批量操作进度',
      },
    };

    /** Dictionary used only when the locale seat is missing (defensive). */
    function systemDict() {
      try {
        const language = typeof navigator === 'object' && navigator !== null && typeof navigator.language === 'string'
          ? navigator.language.toLowerCase()
          : 'en';
        return language.indexOf('zh') === 0 ? DICTS.zh : DICTS.en;
      } catch (error) {
        return DICTS.en;
      }
    }

    /** Plugin-scope text: the locale seat first, then the bundled dictionary. */
    function notice(bind, key, params) {
      if (typeof bind === 'function') {
        let text;
        try {
          text = bind(key, params);
        } catch (error) {
          text = undefined;
        }
        if (typeof text === 'string' && text !== '' && text !== key) return text;
      }
      const template = systemDict()[key];
      return typeof template === 'string' ? interpolate(template, params) : key;
    }

    function interpolate(template, params) {
      if (params === null || params === undefined) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
    }

    /* ------------------------------------------------------------------ */
    /* Vocabulary: the same features under two naming systems              */
    /*                                                                     */
    /* "jargon" is the Alibaba-flavoured naming (毕业 / 返聘 / 销户),        */
    /* "standard" is the plain, professional one. Only *feature names* and  */
    /* the handful of sentences that repeat a verb are switched: everything */
    /* else (filters, sizes, hints) stays in one calm voice so the joke     */
    /* never leaks into an instruction.                                     */
    /* ------------------------------------------------------------------ */

    const VOCAB_STORAGE_KEY = 'dsh-session-manager:vocabulary';
    const VOCAB_JARGON = 'jargon';
    const VOCAB_STANDARD = 'standard';

    const JARGON = {
      zh: {
        'panel.label': '毕业办',
        'panel.title': '会话毕业办公室',
        'action.delete': '办理毕业',
        'confirm.trash': '办理毕业',
        'action.restore': '返聘',
        'action.purge': '销户',
        'confirm.purge': '销户',
        'confirm.purgeTitle': '确定销户？',
        'action.purgeExpired': '到期清退',
        'action.gc': '工位盘点',
        'gc.noticeAction': '盘点',
        'filter.trash': '人才池',
        'trash.empty': '人才池是空的。',
        'trash.emptyHint': '办理毕业的会话会在这里保留 {days} 天，期间随时可以返聘。',
        'trash.emptyHintForever': '办理毕业的会话会一直保留，直到你手动销户。',
        'trash.emptyHintUnknown': '办理毕业的会话会在保留期结束后自动清退。',
        'status.trashed': '已办理毕业 {count} 项 · {size}',
        'status.trashedNoSize': '已办理毕业 {count} 项',
        'status.trashing': '正在办理毕业 {done}/{total}',
        'status.restored': '已返聘 {count} 项',
        'status.restoring': '正在返聘 {done}/{total}',
        'status.purged': '已销户 {count} 项 · 释放 {size}',
        'status.purgedNoSize': '已销户 {count} 项',
        'status.gone': '{count} 个会话已没有日志，已从列表移除',
      },
      en: {
        'panel.label': 'Exit office',
        'panel.title': 'Session exit office',
        'action.delete': 'Offboard',
        'confirm.trash': 'Offboard',
        'action.restore': 'Rehire',
        'action.purge': 'Terminate',
        'confirm.purge': 'Terminate',
        'confirm.purgeTitle': 'Terminate for good?',
        'action.purgeExpired': 'Clear expired',
        'action.gc': 'Desk sweep',
        'gc.noticeAction': 'Sweep',
        'filter.trash': 'Talent pool',
        'trash.empty': 'The talent pool is empty.',
        'trash.emptyHint': 'Offboarded sessions stay here for {days} days and can be rehired meanwhile.',
        'trash.emptyHintForever': 'Offboarded sessions stay here until you terminate them.',
        'trash.emptyHintUnknown': 'Offboarded sessions are cleared when their retention ends.',
        'status.trashed': 'Offboarded {count} · {size}',
        'status.trashedNoSize': 'Offboarded {count}',
        'status.trashing': 'Offboarding {done} of {total}…',
        'status.restored': 'Rehired {count}',
        'status.restoring': 'Rehiring {done} of {total}…',
        'status.purged': 'Terminated {count} · {size} freed',
        'status.purgedNoSize': 'Terminated {count}',
        'status.gone': '{count} sessions had no log left and were removed from the list',
      },
    };

    /** Read the saved preference; a browser that refuses storage simply keeps the default. */
    function loadVocabulary() {
      try {
        const raw = globalThis.localStorage?.getItem(VOCAB_STORAGE_KEY);
        return raw === VOCAB_STANDARD || raw === VOCAB_JARGON ? raw : VOCAB_JARGON;
      } catch (error) {
        return VOCAB_JARGON;
      }
    }

    /**
     * The naming preference is a small subscribable value: the panel re-renders on a
     * change and the sidebar label is re-registered, so both surfaces stay in one voice.
     */
    const vocabularyStore = (() => {
      let value = loadVocabulary();
      const listeners = new Set();
      return {
        get() {
          return value;
        },
        set(next) {
          const wanted = next === VOCAB_STANDARD ? VOCAB_STANDARD : VOCAB_JARGON;
          if (wanted === value) return;
          value = wanted;
          try {
            globalThis.localStorage?.setItem(VOCAB_STORAGE_KEY, wanted);
          } catch (error) {
            /* a preference that cannot be stored still applies for this session */
          }
          for (const listener of [...listeners]) {
            try {
              listener(value);
            } catch (error) {
              /* one broken listener must not block the rest */
            }
          }
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
    })();

    /** Which dictionary a jargon override must come from. */
    function activeLanguage() {
      try {
        const language = typeof navigator === 'object' && navigator !== null && typeof navigator.language === 'string'
          ? navigator.language.toLowerCase()
          : 'en';
        return language.indexOf('zh') === 0 ? 'zh' : 'en';
      } catch (error) {
        return 'en';
      }
    }

    /** The jargon override for a key, or null when this key keeps its standard name. */
    function jargonOverride(key, params) {
      if (vocabularyStore.get() !== VOCAB_JARGON) return null;
      const table = JARGON[activeLanguage()];
      if (table === null || table === undefined) return null;
      const template = table[key];
      return typeof template === 'string' ? interpolate(template, params) : null;
    }

    /* ------------------------------------------------------------------ */
    /* Host contract                                                       */
    /* ------------------------------------------------------------------ */

    function reasonOf(error) {
      if (error === null || error === undefined) return '';
      const raw = typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error);
      return raw.length > 240 ? raw.slice(0, 237) + '…' : raw;
    }

    /** POST one JSON operation to the bundle's Host route; never throws on JSON. */
    async function postOp(body) {
      const response = await fetch(API_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let payload = null;
      if (text !== '') {
        try {
          payload = JSON.parse(text);
        } catch (error) {
          payload = null;
        }
      }
      return { status: response.status, ok: response.ok, payload };
    }

    /**
     * The archive service is the shipped workspace controller. `uiWorkspace`
     * exposes the same two methods, so it is the fallback when a Profile replaces
     * the controller but keeps the UI service.
     */
    function archiveService(ctx) {
      const candidates = [ctx.get('workspaces'), ctx.get('uiWorkspace')];
      for (const service of candidates) {
        if (service === null || service === undefined) continue;
        if (typeof service.archiveSession === 'function' && typeof service.unarchiveSession === 'function') return service;
      }
      return undefined;
    }

    /* ------------------------------------------------------------------ */
    /* v2 helpers: sizes, failure codes, bounded batches                   */
    /* ------------------------------------------------------------------ */

    /** Byte units, largest last; the formatter never invents a smaller unit. */
    const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

    /** Batches run at most this many operations at once, whatever the Host allows. */
    const MAX_PARALLEL = 4;

    /** Machine-readable failure codes the Host may report (DESIGN.md protocol v2). */
    const FAILURE_CODES = [
      'not-found',
      'running',
      'no-location',
      'io',
      'invalid-id',
      'archive-failed',
      'trash-move-failed',
      'trash-entry-exists',
      'not-in-trash',
      'restore-target-exists',
      'purge-failed',
      'trash-verify-failed',
      'restore-verify-failed',
      'has-descendants',
      'unknown',
    ];

    /**
     * Compact byte text for a real measurement, or `null` when the value is not
     * a known finite non-negative number — callers render the unknown glyph
     * rather than a fabricated `0 B`.
     * @param bytes - measurement from the Host `sizes` op.
     * @param t - locale seat.
     * @returns localized `{n} {unit}` text, or null for an unknown value.
     */
    function formatBytes(bytes, t) {
      if (typeof bytes !== 'number' || Number.isFinite(bytes) !== true || bytes < 0) return null;
      if (bytes < 1024) return t('size.bytes', { n: String(Math.round(bytes)), unit: BYTE_UNITS[0] });
      let value = bytes;
      let unit = 0;
      while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
        value /= 1024;
        unit += 1;
      }
      let text = value.toFixed(1);
      // 1023.97 KB must read 1.0 MB, not 1024.0 KB.
      if (Number(text) >= 1024 && unit < BYTE_UNITS.length - 1) {
        value /= 1024;
        unit += 1;
        text = value.toFixed(1);
      }
      return t('size.bytes', { n: text, unit: BYTE_UNITS[unit] });
    }

    /**
     * One failure's code, normalized to a code the dictionaries know.
     * @returns the code, `'unknown'` for an unrecognized one, or `null` when the
     *   Host predates codes — a v1 reason is shown verbatim and never mislabelled.
     */
    function failureCodeOf(entry) {
      const code = entry !== null && typeof entry === 'object' ? entry.code : undefined;
      if (typeof code !== 'string' || code === '') return null;
      return FAILURE_CODES.indexOf(code) >= 0 ? code : 'unknown';
    }

    /**
     * Localized failure text: the code's meaning first, then the Host's raw
     * reason as a secondary detail when it says anything more.
     */
    function failureText(entry, t) {
      const code = failureCodeOf(entry);
      const reason = entry !== null && typeof entry === 'object' && typeof entry.reason === 'string'
        ? entry.reason.trim()
        : '';
      if (code === null) {
        // v1 Host: no machine code, so the reason is all the user can be told.
        return reason === '' ? t('fail.code.unknown') : reason;
      }
      const label = t('fail.code.' + code);
      if (reason === '' || reason === label) return label;
      return t('fail.detail', { label, reason });
    }

    /**
     * The Host's own failure wording. It is technical English, so it never becomes the
     * user-facing sentence: it goes on the status element's tooltip for the curious.
     */
    function failureRawOf(entry) {
      if (entry === null || typeof entry !== 'object') return '';
      return typeof entry.reason === 'string' ? entry.reason.trim() : '';
    }

    /** `not-found` needs no user action: the log is already gone, so the row goes. */
    function hidesAfterAttempt(entry) {
      return failureCodeOf(entry) === 'not-found';
    }

    /**
     * Run `worker` over `items` with at most `limit` (≤ MAX_PARALLEL) in flight.
     * Every item is attempted; a throw is collected instead of cancelling the
     * batch, so one slow or failing session never blocks the rest.
     * @returns `{done, failures}` where failures keep the item and its error.
     */
    async function mapPool(items, limit, worker, onProgress) {
      const list = Array.isArray(items) ? items.slice() : [];
      const requested = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : MAX_PARALLEL;
      const width = Math.max(1, Math.min(requested, MAX_PARALLEL, list.length));
      const done = [];
      const failures = [];
      let cursor = 0;
      let finished = 0;
      const publish = () => {
        if (typeof onProgress !== 'function') return;
        try {
          onProgress(finished, list.length);
        } catch (error) {
          // a progress callback must never fail the batch
        }
      };
      const lane = async () => {
        while (cursor < list.length) {
          const at = cursor;
          cursor += 1;
          const item = list[at];
          try {
            await worker(item, at);
            done.push(item);
          } catch (error) {
            failures.push({ item, error });
          }
          finished += 1;
          publish();
        }
      };
      const lanes = [];
      for (let index = 0; index < width; index += 1) lanes.push(lane());
      await Promise.all(lanes);
      return { done, failures };
    }

    /**
     * A finite, non-negative measurement or null. A numeric string is accepted
     * (a Host may serialize large integers as text); anything else stays unknown.
     */
    function measurement(value) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
      if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed >= 0) return parsed;
      }
      return null;
    }

    /**
     * Normalize a `gc-preview` report into the numbers the confirm block shows.
     * Unknown fields stay null so the UI can omit rather than invent them.
     */
    function gcSummary(report) {
      const groups = report !== null && typeof report === 'object' && Array.isArray(report.groups) ? report.groups : [];
      let groupFiles = 0;
      let groupBytes = 0;
      let sawGroup = false;
      for (const group of groups) {
        if (group === null || typeof group !== 'object') continue;
        const files = measurement(group.deletableFiles);
        const bytes = measurement(group.deletableBytes);
        if (files !== null) {
          groupFiles += files;
          sawGroup = true;
        }
        if (bytes !== null) {
          groupBytes += bytes;
          sawGroup = true;
        }
      }
      const reportBytes = report !== null && typeof report === 'object' ? measurement(report.deletableBytes) : null;
      const safeBytes = reportBytes !== null ? reportBytes : sawGroup ? groupBytes : null;
      const safeFiles = sawGroup ? groupFiles : null;
      const cacheFiles = report !== null && typeof report === 'object' ? measurement(report.cacheFiles) : null;
      const cacheBytes = report !== null && typeof report === 'object' ? measurement(report.cacheBytes) : null;
      const counts = (value) => (value === null ? 0 : value);
      return {
        sessionsScanned: report !== null && typeof report === 'object' ? measurement(report.sessionsScanned) : null,
        referencedImages: report !== null && typeof report === 'object' ? measurement(report.referencedImages) : null,
        referencedFiles: report !== null && typeof report === 'object' ? measurement(report.referencedFiles) : null,
        safeFiles,
        safeBytes,
        cacheFiles,
        cacheBytes,
        unresolvedCount: report !== null && typeof report === 'object' ? measurement(report.unresolvedCount) : null,
        available: counts(safeFiles) > 0 || counts(safeBytes) > 0 || counts(cacheFiles) > 0 || counts(cacheBytes) > 0,
      };
    }

    /* ------------------------------------------------------------------ */
    /* Styles — theme tokens only                                          */
    /* ------------------------------------------------------------------ */

    const STYLES = `
.dsh-sm{box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;padding:0 clamp(16px,3vw,32px) 16px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;text-align:left}
.dsh-sm-head{flex:none;display:flex;flex-direction:column;gap:4px;padding:24px 0 10px}
.dsh-sm-title{margin:0;font-size:20px;font-weight:500;line-height:28px}
.dsh-sm-headrow{display:flex;align-items:baseline;gap:10px;justify-content:space-between}
.dsh-sm-vocab{flex:none;color:var(--dsh-alias-label-tertiary);font-size:12px;line-height:16px;padding:2px 6px;border-radius:var(--dsw-radius-xs)}
.dsh-sm-vocab:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-sm-sub{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:18px}
.dsh-sm-toolbar{flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:2px 0 8px}
.dsh-sm-toolbarwrap{padding-top:0;overflow-x:auto;flex-wrap:nowrap;scrollbar-width:none}
.dsh-sm-toolbarwrap::-webkit-scrollbar{display:none}
.dsh-sm-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform)}
.dsh-sm-segbtn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;line-height:18px;padding:4px 10px;border-radius:var(--dsw-radius-sm);cursor:pointer;white-space:nowrap}
.dsh-sm-segbtn[aria-pressed='true']{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-soft)}
.dsh-sm-segbtn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dsh-sm-search{flex:1 1 200px;min-width:140px;box-sizing:border-box;height:32px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.dsh-sm-search::placeholder{color:var(--dsw-alias-label-tertiary)}
.dsh-sm-search:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:inset 0 0 0 .5px var(--dsw-alias-state-business-primary)}
.dsh-sm-statuswrap{flex:none;min-width:0}
.dsh-sm-status{padding:0 0 6px;margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsh-sm-statussuffix{color:var(--dsw-alias-label-tertiary)}
.dsh-sm-status[data-tone='error']{color:var(--dsw-alias-state-error-primary)}
.dsh-sm-bar{flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 8px;margin-bottom:6px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform)}
.dsh-sm-barcount{color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:18px;white-space:nowrap;font-variant-numeric:tabular-nums}
.dsh-sm-grow{flex:1;min-width:0}
.dsh-sm-confirm{flex:none;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 10px;margin-bottom:6px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-label-primary)}
.dsh-sm-confirmstack{flex-direction:column;align-items:stretch;gap:6px;padding:10px 12px}
.dsh-sm-confirmtext{flex:1 1 220px;min-width:0;font-size:12.5px;line-height:18px}
.dsh-sm-confirmtitle{font-weight:500}
.dsh-sm-confirmbody{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsh-sm-confirmsub{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px}
.dsh-sm-confirmrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.dsh-sm-gcstat{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.dsh-sm-gcstat[data-tone='warn']{color:var(--dsw-alias-state-warn-primary)}
.dsh-sm-gccheck{display:flex;align-items:flex-start;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:pointer;border-radius:var(--dsw-radius-xs);outline:none}
.dsh-sm-gccheck[data-disabled='true']{opacity:.6;cursor:default}
.dsh-sm-gccheck input{margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary);cursor:inherit}
.dsh-sm-gccheck:focus-within{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dsh-sm-toolbarspacer{flex:0 0 0;min-width:0;margin-left:auto}
.dsh-sm-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 10px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;line-height:18px;cursor:pointer;white-space:nowrap}
.dsh-sm-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.dsh-sm-btn:disabled{opacity:.5;cursor:default}
.dsh-sm-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dsh-sm-btn[data-variant='quiet']{border-color:transparent}
.dsh-sm-btn[data-variant='primary']{background:var(--dsw-alias-label-primary);border-color:transparent;color:var(--dsw-alias-label-primary-foreground);font-weight:500}
.dsh-sm-btn[data-variant='primary']:hover:not(:disabled){opacity:.88}
.dsh-sm-btn[data-variant='dangerText']{border-color:transparent;color:var(--dsw-alias-state-error-primary);padding:0 6px}
.dsh-sm-btn[data-variant='dangerText']:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.dsh-sm-btn[data-variant='dangerText']::after{display:none}
.dsh-sm-iconbtn{appearance:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dsh-sm-iconbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-sm-iconbtn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dsh-sm-iconbtn:disabled{opacity:.4;cursor:default}
.dsh-sm-note{color:var(--dsw-alias-label-tertiary)}
.dsh-sm-files{margin:6px 0 4px;display:flex;flex-direction:column;gap:3px}
.dsh-sm-filecheck{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--dsw-alias-label-primary);cursor:pointer}
.dsh-sm-filecheck input{margin:0;width:13px;height:13px;accent-color:var(--dsw-alias-state-business-primary)}
.dsh-sm-fileline{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsh-sm-risk{flex:none;display:inline-flex;align-items:center;color:var(--dsw-alias-state-warn-primary);margin-left:2px}
.dsh-sm-risk[data-tier='high']{color:var(--dsw-alias-state-warn-primary)}
.dsh-sm-risklines{display:flex;flex-direction:column;gap:2px;margin:2px 0 2px;font-size:12px;line-height:17px}
.dsh-sm-riskline[data-tier='low']{color:var(--dsw-alias-state-success-primary)}
.dsh-sm-riskline[data-tier='medium']{color:var(--dsw-alias-label-secondary)}
.dsh-sm-riskline[data-tier='high']{color:var(--dsw-alias-state-warn-primary)}
.dsh-sm-suggest{flex:none;font-size:12px}
.dsh-sm-backrow{display:inline-flex;align-items:center;gap:8px;min-width:0}
.dsh-sm-backtitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500}
.dsh-sm-undo{margin-left:6px;text-decoration:underline;text-underline-offset:2px}
.dsh-sm-notice{flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 8px;padding:7px 10px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1)}
.dsh-sm-noticetext{color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:18px}
.dsh-sm-linkbtn{appearance:none;border:0;background:transparent;padding:2px 4px;border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-state-business-primary);font:inherit;font-size:12.5px;cursor:pointer}
.dsh-sm-linkbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-sm-linkbtn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dsh-sm-linkbtn:disabled{opacity:.5;cursor:default}
.dsh-sm-progress{flex:none;height:2px;margin:0 0 8px;border-radius:1px;background:var(--dsw-alias-border-l1);overflow:hidden}
.dsh-sm-progressfill{height:100%;background:var(--dsw-alias-state-business-primary);transition:width 180ms var(--ds-ease-in-out, ease)}
@media (prefers-reduced-motion: no-preference){
.dsh-sm-confirm{animation:dsh-sm-confirm-in 140ms var(--ds-ease-in-out, ease)}
@keyframes dsh-sm-confirm-in{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}
.dsh-sm-row{transition:background-color 120ms var(--ds-ease-in-out, ease)}
}
@media (prefers-reduced-motion: reduce){
.dsh-sm-progressfill{transition:none}
}
.dsh-sm-btn[data-variant='danger']{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent)}
.dsh-sm-btn[data-variant='dangerSolid']{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground)}
.dsh-sm-meta{flex:none;display:flex;align-items:center;gap:10px;min-height:30px;padding:0 8px;border-top:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsh-sm-checkall{display:inline-flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:var(--dsw-radius-xs);outline:none}
.dsh-sm-checkall:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dsh-sm-count{font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-sm-list{flex:1;min-height:0;margin:0;padding:0;list-style:none;overflow-y:auto;overscroll-behavior:contain}
.dsh-sm-row{display:flex;align-items:center;gap:10px;box-sizing:border-box;min-height:34px;padding:0 8px;border-bottom:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);cursor:pointer;outline:none;user-select:none}
.dsh-sm-row[aria-checked='true']{background:var(--dsw-alias-bg-multi-select)}
.dsh-sm-row:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.dsh-sm-rowtitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-sm-badges{flex:none;display:inline-flex;align-items:center;gap:4px}
.dsh-sm-badge{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:10px;line-height:1;white-space:nowrap}
.dsh-sm-badge[data-tone='live']{color:var(--dsw-alias-state-business-primary)}
.dsh-sm-badge[data-tone='muted']{color:var(--dsw-alias-label-tertiary)}
.dsh-sm-time{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-sm-size{flex:none;box-sizing:border-box;min-width:62px;max-width:96px;text-align:right;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:18px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-sm-size[data-known='false']{color:var(--dsw-alias-label-tertiary);opacity:.6}
.dsh-sm-check{flex:none;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:var(--dsw-radius-xs);border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary-foreground)}
.dsh-sm-check[data-state='on'],.dsh-sm-check[data-state='mixed']{border-color:transparent;background:var(--dsw-alias-brand-primary)}
.dsh-sm-empty{flex:1;display:flex;align-items:center;justify-content:center;min-height:80px;color:var(--dsw-alias-label-tertiary);font-size:13px}
.dsh-sm-hint{flex:none;padding:6px 8px 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
@media (hover:hover){
.dsh-sm-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-sm-row[aria-checked='true']:hover{background:var(--dsw-alias-interactive-bg-active)}
.dsh-sm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-sm-btn[data-variant='danger']:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger,var(--dsw-alias-interactive-bg-hover))}
.dsh-sm-btn[data-variant='dangerSolid']:hover:not(:disabled){background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground)}
.dsh-sm-segbtn:hover{color:var(--dsw-alias-label-primary)}
.dsh-sm-checkall:hover{color:var(--dsw-alias-label-primary)}
}
`;

    /* ------------------------------------------------------------------ */
    /* Sidebar glyph                                                       */
    /* ------------------------------------------------------------------ */

    /**
     * Original glyph: a closed archive box with its lid seam and slot.
     * Props come from the sidebar panel row ({size, active}); the button shell,
     * its hover fill, its tooltip and its active tint belong to the host, so the
     * glyph only strokes with currentColor.
     */
    function ManagerIcon(props) {
      const size = props !== null && props !== undefined && typeof props.size === 'number' && props.size > 0
        ? props.size
        : 16;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.25,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: 'false',
        style: { display: 'block' },
      },
        h('rect', { x: 2.3, y: 3, width: 11.4, height: 2.7, rx: 0.8 }),
        h('path', { d: 'M3.7 5.7v6.5a1.3 1.3 0 0 0 1.3 1.3h6a1.3 1.3 0 0 0 1.3-1.3V5.7' }),
        h('path', { d: 'M6.4 8.4h3.2' }),
      );
    }

    /* ------------------------------------------------------------------ */
    /* Panel                                                               */
    /* ------------------------------------------------------------------ */

    const EMPTY_LIST_STATE = Object.freeze({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} });

    /** Stable stand-in so a missing standard hook cannot change hook order. */
    function useStandInStore(selector) {
      const state = React.useState(EMPTY_LIST_STATE)[0];
      return typeof selector === 'function' ? selector(state) : state;
    }

    function pad2(value) {
      return value < 10 ? '0' + String(value) : String(value);
    }

    function basename(path) {
      const trimmed = String(path).replace(/[/\\]+$/, '');
      const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
      return index >= 0 ? trimmed.slice(index + 1) : trimmed;
    }

    function titleOf(entry, id) {
      if (typeof entry.displayTitle === 'string' && entry.displayTitle !== '') return entry.displayTitle;
      if (typeof entry.title === 'string' && entry.title !== '') return entry.title;
      if (typeof entry.cwd === 'string' && entry.cwd !== '') {
        const base = basename(entry.cwd);
        if (base !== '') return base;
      }
      return id;
    }

    function createPanel() {
      function CheckMark(props) {
        return h('svg', {
          width: 10,
          height: 10,
          viewBox: '0 0 10 10',
          'aria-hidden': true,
          focusable: 'false',
          style: { display: 'block' },
        }, h('path', {
          d: props.state === 'mixed' ? 'M2.4 5h5.2' : 'M2.2 5.2 4.1 7.1 7.9 3.2',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }));
      }

      function Badge(props) {
        return h('span', { className: 'dsh-sm-badge', 'data-tone': props.tone }, props.label);
      }

      function SegmentedFilter(props) {
        const options = [
          { value: 'all', label: props.t('filter.all') },
          { value: 'active', label: props.t('filter.active') },
          { value: 'archived', label: props.t('filter.archived') },
        ];
        if (props.withTrash === true) options.push({ value: 'trash', label: props.t('filter.trash') });
        return h('div', { className: 'dsh-sm-seg', role: 'group', 'aria-label': props.t('filter.aria') },
          options.map((option) => h('button', {
            key: option.value,
            type: 'button',
            className: 'dsh-sm-segbtn',
            'aria-pressed': props.value === option.value ? 'true' : 'false',
            disabled: props.disabled,
            onClick: () => props.onChange(option.value),
          }, option.label)),
        );
      }

      function SessionRow(props) {
        const row = props.row;
        const toggle = () => props.onToggle(row.id);
        const onKeyDown = (event) => {
          if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
            event.preventDefault();
            toggle();
          }
        };
        const riskMark = row.riskTier === 'high'
          ? h('span', {
            className: 'dsh-sm-risk',
            'data-tier': 'high',
            title: props.t('risk.rowTitle', { reasons: row.riskTitle }),
            'aria-label': props.t('risk.rowTitle', { reasons: row.riskTitle }),
          }, h('svg', { width: 11, height: 11, viewBox: '0 0 12 12', 'aria-hidden': true, focusable: 'false' },
            h('path', { d: 'M6 1.6 11 10.4H1z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.1, strokeLinejoin: 'round' }),
            h('path', { d: 'M6 4.6v2.6M6 8.9v.1', fill: 'none', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round' })))
          : null;
        const badges = [];
        if (row.running) badges.push(h(Badge, { key: 'running', label: props.t('badge.running'), tone: 'live' }));
        if (row.blank) badges.push(h(Badge, { key: 'blank', label: props.t('badge.blank'), tone: '' }));
        if (row.child) badges.push(h(Badge, { key: 'child', label: props.t('badge.child'), tone: 'muted' }));
        if (row.archived) badges.push(h(Badge, { key: 'archived', label: props.t('badge.archived'), tone: 'muted' }));
        return h('li', {
          className: 'dsh-sm-row',
          role: 'checkbox',
          'aria-checked': row.selected ? 'true' : 'false',
          'aria-label': props.t('row.selectAria', { title: row.title }),
          tabIndex: 0,
          onClick: toggle,
          onKeyDown,
        },
          h('span', { className: 'dsh-sm-check', 'data-state': row.selected ? 'on' : 'off', 'aria-hidden': 'true' },
            row.selected ? h(CheckMark, { state: 'on' }) : null),
          h('span', { className: 'dsh-sm-rowtitle', title: row.cwd !== '' ? row.cwd : row.title }, row.title),
          badges.length > 0 ? h('span', { className: 'dsh-sm-badges' }, badges) : null,
          riskMark,
          h('span', {
            className: 'dsh-sm-size',
            'data-known': row.sizeText === null ? 'false' : 'true',
            title: row.sizeText === null ? props.t('size.unknown') : row.sizeText,
          }, row.sizeText === null ? props.t('size.unknown') : row.sizeText),
          h('span', { className: 'dsh-sm-time', title: row.absolute }, row.relative),
        );
      }

      return function SessionManagerPanel(props) {
        const t = (key, params) => {
          const jargon = jargonOverride(key, params);
          if (jargon !== null) return jargon;
          const seats = [props.t, props.fallbackT];
          for (const seat of seats) {
            if (typeof seat !== 'function') continue;
            let text;
            try {
              text = seat(key, params);
            } catch (error) {
              text = undefined;
            }
            if (typeof text === 'string' && text !== '' && text !== key) return text;
          }
          const dict = systemDict();
          const template = dict[key];
          if (typeof template !== 'string') return key;
          return interpolate(template, params);
        };

        const useSessions = typeof props.useSessions === 'function' ? props.useSessions : useStandInStore;
        const useWorkspaces = typeof props.useWorkspaces === 'function' ? props.useWorkspaces : useStandInStore;
        const actions = props.actions !== null && props.actions !== undefined ? props.actions : {};
        const hiddenIds = props.hiddenIds !== null && props.hiddenIds !== undefined ? props.hiddenIds : new Set();

        const byId = useSessions((state) => (state === null || state === undefined ? undefined : state.byId));
        const phase = useSessions((state) => (state === null || state === undefined ? undefined : state.phase));
        const archivedIds = useWorkspaces((state) => (state === null || state === undefined ? undefined : state.archivedSessionIds));
        const workspaceItems = useWorkspaces((state) => (state === null || state === undefined ? undefined : state.items));

        // Deletion risk is decided by the Host (it owns pins, archive state, activity and log
        // sizes). The Client fetches verdicts and renders them; it never re-implements the policy,
        // so a threshold can only ever be wrong in one place.
        const [riskMap, setRiskMap] = React.useState(null);
        const riskSeq = React.useRef(0);

        /** Refresh the Host risk verdicts; an older Host simply has no verdicts to show. */
        const loadRisk = async () => {
          const seq = riskSeq.current + 1;
          riskSeq.current = seq;
          try {
            const response = await postOp({ op: 'risk' });
            const payload = response.payload;
            if (seq !== riskSeq.current) return;
            if (response.ok !== true || payload === null || payload.ok !== true || payload.items === null || typeof payload.items !== 'object') {
              setRiskMap(null);
              return;
            }
            const next = {};
            for (const id of Object.keys(payload.items)) {
              const verdict = payload.items[id];
              if (verdict === null || typeof verdict !== 'object') continue;
              const tier = verdict.tier === 'low' || verdict.tier === 'high' ? verdict.tier : 'medium';
              const reasons = Array.isArray(verdict.reasons) ? verdict.reasons : [];
              next[id] = { tier, reasons };
            }
            setRiskMap(next);
          } catch (error) {
            if (seq === riskSeq.current) setRiskMap(null);
          }
        };

        /**
         * Workspaces offered as a filter: only entries carrying a usable path, because the
         * filter matches a session's cwd. A profile without workspaces hides the control.
         */
        const workspaceChoices = React.useMemo(() => {
          const source = Array.isArray(workspaceItems) ? workspaceItems : [];
          const seen = new Set();
          const choices = [];
          for (const entry of source) {
            if (entry === null || typeof entry !== 'object') continue;
            const path = typeof entry.path === 'string' ? entry.path : '';
            if (path === '' || seen.has(path)) continue;
            seen.add(path);
            const title = typeof entry.title === 'string' && entry.title !== '' ? entry.title : path;
            choices.push({ id: typeof entry.workspaceId === 'string' ? entry.workspaceId : path, path, title });
          }
          choices.sort((left, right) => left.title.localeCompare(right.title));
          return choices;
        }, [workspaceItems]);

        const [vocabulary, setVocabularyState] = React.useState(() => vocabularyStore.get());
        React.useEffect(() => vocabularyStore.subscribe((next) => setVocabularyState(next)), []);

        const [filter, setFilter] = React.useState('all');
        const [query, setQuery] = React.useState('');
        const [workspaceId, setWorkspaceId] = React.useState('all');

        /** The cwd a selected workspace filters on; empty means "every workspace". */
        const workspacePath = React.useMemo(() => {
          if (workspaceId === 'all') return '';
          const found = workspaceChoices.filter((choice) => choice.id === workspaceId || choice.path === workspaceId)[0];
          return found === undefined ? '' : found.path;
        }, [workspaceId, workspaceChoices]);
        const [selected, setSelected] = React.useState([]);
        const [status, setStatus] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const [confirming, setConfirming] = React.useState(false);
        const [now, setNow] = React.useState(() => Date.now());
        // Ids hidden in this mount; the plugin-level set survives a remount.
        const [hidden, setHidden] = React.useState(() => Array.from(hiddenIds));
        // Durable log sizes: null = not measured/unsupported (rows show the
        // unknown glyph rather than a fabricated zero).
        const [sizes, setSizes] = React.useState(null);
        // Attachment-cleanup preview summary; null hides the toolbar action.
        const [gc, setGc] = React.useState(null);
        const [gcOpen, setGcOpen] = React.useState(false);
        const [gcIncludeCache, setGcIncludeCache] = React.useState(false);
        const [gcPreparing, setGcPreparing] = React.useState(false);
        const [gcBusy, setGcBusy] = React.useState(false);
        const [auditPath, setAuditPath] = React.useState(null);
        const cancelRef = React.useRef(null);
        const deleteRef = React.useRef(null);
        const gcCancelRef = React.useRef(null);
        const gcRef = React.useRef(null);
        const sizesSeq = React.useRef(0);
        const gcSeq = React.useRef(0);
        const visibleIdsRef = React.useRef([]);

        /** Remember the audit-log path when the Host reports one (v2 optional). */
        const rememberAudit = (payload) => {
          if (payload === null || typeof payload !== 'object') return;
          if (typeof payload.auditLog === 'string' && payload.auditLog !== '') setAuditPath(payload.auditLog);
        };

        /**
         * Refresh the size map. A Host without the `sizes` op keeps every value
         * unknown; a later failure keeps the last good measurement.
         */
        const loadSizes = async () => {
          const seq = sizesSeq.current + 1;
          sizesSeq.current = seq;
          try {
            const response = await postOp({ op: 'sizes' });
            const payload = response.payload;
            if (response.ok !== true || payload === null || payload.ok !== true) return;
            if (seq !== sizesSeq.current) return;
            const raw = payload.sizes;
            if (raw === null || typeof raw !== 'object') return;
            const next = {};
            for (const id of Object.keys(raw)) {
              const value = measurement(raw[id]);
              if (value !== null) next[id] = value;
            }
            rememberAudit(payload);
            setSizes(next);
          } catch (error) {
            // sizes are an enhancement; the panel stays usable without them
          }
        };

        // Recycle bin (v3): null while the Host predates the op or has not answered.
        const [trash, setTrash] = React.useState(null);
        // What the selected conversations would take with them, and whether the user said yes.
        const [fileInfo, setFileInfo] = React.useState(null);
        const [deleteFiles, setDeleteFiles] = React.useState(false);
        const fileSeq = React.useRef(0);
        // A restored session is on disk again, but the client session store only learns about
        // sessions from its own list/event feed, so its row can lag. These entries keep the panel
        // truthful in the meantime and disappear as soon as the store catches up.
        const [restored, setRestored] = React.useState([]);
        const [hostVersion, setHostVersion] = React.useState(null);
        const trashSeq = React.useRef(0);

        /** True only when the Host speaks the recycle-bin protocol. */
        const canTrash = hostVersion !== null && Number(hostVersion) >= 3;

        /** Ask which protocol the Host speaks; a failure leaves the panel in v2 mode. */
        const probeHost = async () => {
          try {
            const response = await postOp({ op: 'ping' });
            const payload = response.payload;
            if (response.ok === true && payload !== null && payload.ok === true && typeof payload.version === 'string') {
              setHostVersion(payload.version);
            }
          } catch (error) {
            // an unreachable ping leaves the v2 fallbacks in place
          }
        };

        /**
         * Refresh the recycle bin. A Host without the op (400) clears it to null so
         * the segment and its actions simply disappear.
         */
        const loadTrash = async () => {
          const seq = trashSeq.current + 1;
          trashSeq.current = seq;
          try {
            const response = await postOp({ op: 'trash-list' });
            const payload = response.payload;
            if (seq !== trashSeq.current) return;
            if (response.ok !== true || payload === null || payload.ok !== true || Array.isArray(payload.items) !== true) {
              setTrash(null);
              return;
            }
            const items = [];
            for (const entry of payload.items) {
              if (entry === null || typeof entry !== 'object' || typeof entry.sessionId !== 'string') continue;
              items.push({
                id: entry.sessionId,
                title: typeof entry.title === 'string' && entry.title !== '' ? entry.title : null,
                bytes: measurement(entry.bytes),
                trashedAt: typeof entry.trashedAt === 'number' && Number.isFinite(entry.trashedAt) ? entry.trashedAt : 0,
                expiresAt: typeof entry.expiresAt === 'number' && Number.isFinite(entry.expiresAt) ? entry.expiresAt : null,
                expiresInDays: typeof entry.expiresInDays === 'number' && Number.isFinite(entry.expiresInDays) ? entry.expiresInDays : null,
                originalPath: typeof entry.originalPath === 'string' ? entry.originalPath : null,
                descendantCount: typeof entry.descendantCount === 'number' && Number.isFinite(entry.descendantCount) ? entry.descendantCount : 0,
              });
            }
            setTrash({
              items,
              retentionDays: typeof payload.retentionDays === 'number' ? payload.retentionDays : null,
              totalBytes: measurement(payload.totalBytes),
            });
          } catch (error) {
            if (seq === trashSeq.current) setTrash(null);
          }
        };

        /**
         * Ask the Host what the current selection owns exclusively. Read-only, and the answer is
         * what the confirm sheet shows before the user decides about their files.
         */
        const loadFileInfo = async (ids) => {
          const seq = fileSeq.current + 1;
          fileSeq.current = seq;
          if (!Array.isArray(ids) || ids.length === 0) {
            setFileInfo(null);
            return;
          }
          try {
            const response = await postOp({ op: 'session-files', sessionIds: ids });
            const payload = response.payload;
            if (seq !== fileSeq.current) return;
            if (response.ok !== true || payload === null || payload.ok !== true || payload.totals === null || typeof payload.totals !== 'object') {
              setFileInfo(null);
              return;
            }
            const totals = payload.totals;
            const samples = [];
            for (const item of Object.values(payload.items ?? {})) {
              for (const path of Array.isArray(item?.workspaceFiles?.sample) ? item.workspaceFiles.sample : []) {
                if (samples.indexOf(path) < 0) samples.push(String(path));
              }
            }
            setFileInfo({
              attachments: measurement(totals.attachments) ?? 0,
              attachmentExclusive: measurement(totals.attachmentsExclusive) ?? 0,
              paths: measurement(totals.paths) ?? 0,
              pathExclusive: measurement(totals.pathsExclusive) ?? 0,
              samples: samples.slice(0, 20),
            });
          } catch (error) {
            if (seq === fileSeq.current) setFileInfo(null);
          }
        };

        /** Refresh the attachment-cleanup preview that decides the toolbar action. */
        const loadGc = async () => {
          const seq = gcSeq.current + 1;
          gcSeq.current = seq;
          try {
            const response = await postOp({ op: 'gc-preview', includeRequestImageCache: false });
            const payload = response.payload;
            if (response.ok !== true || payload === null || payload.ok !== true) {
              if (seq === gcSeq.current) setGc(null);
              return;
            }
            if (seq !== gcSeq.current) return;
            rememberAudit(payload);
            setGc(gcSummary(payload.report));
          } catch (error) {
            if (seq === gcSeq.current) setGc(null);
          }
        };

        // First measurement pass: the list is already rendered from the client
        // store, so both requests run behind it — sequentially, because each one
        // walks the session logs on the Host and two concurrent scans would only
        // fight for the same disk.
        React.useEffect(() => {
          let live = true;
          void probeHost();
          void loadTrash();
          void loadRisk();
          void loadSizes().then(() => {
            if (live) void loadGc();
          });
          return () => {
            live = false;
            sizesSeq.current += 1;
            gcSeq.current += 1;
            trashSeq.current += 1;
            riskSeq.current += 1;
          };
        }, []);

        React.useEffect(() => {
          const timer = setInterval(() => {
            setNow(Date.now());
          }, 60000);
          return () => {
            clearInterval(timer);
          };
        }, []);

        // Escape cancels the delete confirmation from anywhere in the panel.
        React.useEffect(() => {
          if (!confirming) return undefined;
          if (typeof document === 'undefined') return undefined;
          const onKeyDown = (event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            setConfirming(false);
            const trigger = deleteRef.current;
            if (trigger !== null && trigger !== undefined && typeof trigger.focus === 'function') trigger.focus();
          };
          document.addEventListener('keydown', onKeyDown, true);
          return () => {
            document.removeEventListener('keydown', onKeyDown, true);
          };
        }, [confirming]);

        React.useEffect(() => {
          if (!confirming) return;
          const button = cancelRef.current;
          if (button !== null && button !== undefined && typeof button.focus === 'function') button.focus();
        }, [confirming]);

        // Select-all and clear are the two commands a management list owes its keyboard
        // users; both respect the open confirm/cleanup surfaces above.
        React.useEffect(() => {
          if (typeof document === 'undefined') return undefined;
          const onKeyDown = (event) => {
            const meta = event.metaKey === true || event.ctrlKey === true;
            if (meta && String(event.key).toLowerCase() === 'a' && confirming !== true && gcOpen !== true) {
              const target = event.target;
              const typing = target !== null && target !== undefined
                && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
              if (typing) return;
              event.preventDefault();
              setSelected(visibleIdsRef.current.slice());
              return;
            }
            if (event.key === 'Escape' && confirming !== true && gcOpen !== true) {
              setSelected((current) => (current.length === 0 ? current : []));
            }
          };
          document.addEventListener('keydown', onKeyDown, true);
          return () => {
            document.removeEventListener('keydown', onKeyDown, true);
          };
        }, [confirming, gcOpen]);

        // Escape also closes the cleanup block; a cleanup that is already running
        // keeps running (the status line reports it) and cannot be cancelled away.
        React.useEffect(() => {
          if (!gcOpen) return undefined;
          if (typeof document === 'undefined') return undefined;
          const onKeyDown = (event) => {
            if (event.key !== 'Escape' || gcBusy) return;
            event.stopPropagation();
            dismissGc();
          };
          document.addEventListener('keydown', onKeyDown, true);
          return () => {
            document.removeEventListener('keydown', onKeyDown, true);
          };
        }, [gcOpen, gcBusy]);

        React.useEffect(() => {
          if (!gcOpen) return;
          const button = gcCancelRef.current;
          if (button !== null && button !== undefined && typeof button.focus === 'function') button.focus();
        }, [gcOpen]);

        const archivedSet = React.useMemo(() => {
          const set = new Set();
          if (Array.isArray(archivedIds)) {
            for (const id of archivedIds) set.add(id);
          }
          return set;
        }, [archivedIds]);

        const selectedSet = React.useMemo(() => new Set(selected), [selected]);

        const hiddenSet = React.useMemo(() => new Set(hidden), [hidden]);

        const allRows = React.useMemo(() => {
          const rows = [];
          const storeKnown = byId !== null && typeof byId === 'object' ? byId : {};
          const pendingRestored = restored.filter((row) => storeKnown[row.id] === undefined && hiddenSet.has(row.id) !== true);
          for (const row of pendingRestored) {
            rows.push({
              id: row.id,
              title: row.title,
              cwd: row.cwd,
              archived: false,
              running: false,
              blank: false,
              child: false,
              updatedAt: 0,
              sizeBytes: row.sizeBytes,
            });
          }
          if (byId === null || typeof byId !== 'object') return rows;
          const sizeMap = sizes !== null && typeof sizes === 'object' ? sizes : null;
          for (const id of Object.keys(byId)) {
            if (hiddenSet.has(id)) continue;
            const entry = byId[id];
            if (entry === null || typeof entry !== 'object') continue;
            const measured = sizeMap !== null ? measurement(sizeMap[id]) : null;
            rows.push({
              id,
              title: titleOf(entry, id),
              cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
              archived: archivedSet.has(id),
              running: entry.running === true,
              blank: entry.blank === true,
              child: entry.origin === 'subagent' || typeof entry.parentId === 'string',
              updatedAt: typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
              sizeBytes: measured,
            });
          }
          rows.sort((left, right) => right.updatedAt - left.updatedAt);
          return rows;
        }, [byId, archivedSet, hiddenSet, sizes, restored]);

        // Recycle-bin rows reuse the session-row shape so the list renders and behaves
        // identically; the only new facts are the retention countdown and the origin path.
        const trashRows = React.useMemo(() => {
          const source = trash === null ? [] : trash.items;
          return source.map((entry) => ({
            id: entry.id,
            title: entry.title !== null ? entry.title : entry.originalPath !== null ? entry.originalPath : entry.id,
            cwd: entry.originalPath !== null ? entry.originalPath : '',
            archived: false,
            running: false,
            blank: false,
            child: false,
            trashed: true,
            expiresInDays: entry.expiresInDays,
            updatedAt: entry.trashedAt,
            sizeBytes: entry.bytes,
          }));
        }, [trash]);

        const inTrash = filter === 'trash' && canTrash;

        /** The Host's verdict for one row, or null when this Host has none. */
        const riskOf = (row) => (riskMap === null ? null : riskMap[row.id] ?? null);

        /** Localized text for one risk reason (the Host sends keys, the panel speaks). */
        const riskReasonText = (reason) => {
          if (reason === null || reason === undefined) return '';
          if (reason.key === 'risk.reason.large') {
            const size = formatBytes(reason.bytes, t);
            return t(reason.key, { size: size === null ? t('size.unknown') : size });
          }
          return reason.count === undefined ? t(reason.key) : t(reason.key, { count: reason.count });
        };

        const visibleRows = React.useMemo(() => {
          const needle = query.trim().toLowerCase();
          const source = inTrash ? trashRows : allRows;
          const rows = [];
          for (const row of source) {
            if (inTrash !== true) {
              if (filter === 'active' && row.archived) continue;
              if (filter === 'archived' && !row.archived) continue;
              if (workspaceId !== 'all' && row.cwd !== workspacePath) continue;
            }
            if (needle !== '') {
              const haystack = (row.title + '\n' + row.cwd + '\n' + row.id).toLowerCase();
              if (haystack.indexOf(needle) < 0) continue;
            }
            rows.push(row);
          }
          return rows;
        }, [allRows, trashRows, inTrash, filter, query, workspaceId, workspacePath]);

        const rows = visibleRows.slice(0, MAX_ROWS);
        const truncated = visibleRows.length > rows.length;
        visibleIdsRef.current = rows.map((row) => row.id);

        const archiveCount = allRows.reduce((total, row) => (row.archived ? total + 1 : total), 0);
        const runningCount = allRows.reduce((total, row) => (row.running ? total + 1 : total), 0);

        const selectedVisible = rows.filter((row) => selectedSet.has(row.id));
        const selectedRows = (inTrash ? trashRows : allRows).filter((row) => selectedSet.has(row.id));
        const selectedCount = selectedRows.length;
        const selectedArchivable = selectedRows.filter((row) => !row.archived);
        const selectedRestorable = selectedRows.filter((row) => row.archived);
        const selectedKnown = selectedRows.filter((row) => row.sizeBytes !== null);
        const selectedKnownBytes = selectedKnown.reduce((total, row) => total + row.sizeBytes, 0);
        const selectedUnknownCount = selectedRows.length - selectedKnown.length;
        const selectedSizeText = formatBytes(selectedKnownBytes, t);
        // A partial measurement would be a number the user cannot act on, so the size is
        // shown only when every selected row has been measured.
        const selectionLabel = selectedCount === 0 || selectedSizeText === null || selectedUnknownCount > 0
          ? t('selection.count', { count: selectedCount })
          : t('selection.size', { count: selectedCount, size: selectedSizeText });
        const gcCacheFiles = gc !== null && gc.cacheFiles !== null ? gc.cacheFiles : 0;
        const gcCacheBytes = gc !== null && gc.cacheBytes !== null ? gc.cacheBytes : 0;
        const gcCacheAvailable = gcCacheFiles > 0 || gcCacheBytes > 0;
        const gcSafeBytes = gc !== null && gc.safeBytes !== null ? gc.safeBytes : 0;
        const gcActionBytes = gcSafeBytes > 0 ? gcSafeBytes : gcCacheBytes;
        const gcActionSize = formatBytes(gcActionBytes, t);
        const gcVisible = gc !== null && gc.available === true;
        const lowRiskVisible = inTrash === true ? 0 : rows.filter((row) => riskOf(row)?.tier === 'low').length;
        const allVisibleSelected = rows.length > 0 && selectedVisible.length === rows.length;
        const someVisibleSelected = selectedVisible.length > 0 && !allVisibleSelected;
        const loading = phase !== 'ready' && allRows.length === 0;

        const clearSelection = () => {
          setSelected([]);
          setConfirming(false);
        };

        const toggleRow = (id) => {
          setConfirming(false);
          setSelected((current) => {
            const next = current.filter((entry) => entry !== id);
            if (next.length === current.length) next.push(id);
            return next;
          });
        };

        const toggleAllVisible = () => {
          setConfirming(false);
          const ids = rows.map((row) => row.id);
          setSelected((current) => {
            const inside = ids.filter((id) => current.indexOf(id) >= 0);
            if (inside.length === ids.length) {
              return current.filter((id) => ids.indexOf(id) < 0);
            }
            const next = current.slice();
            for (const id of ids) if (next.indexOf(id) < 0) next.push(id);
            return next;
          });
        };

        const absoluteOf = (stamp) => {
          if (stamp <= 0) return '';
          const date = new Date(stamp);
          const day = t('date.ymd', { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() });
          const clock = t('time.clock', { h: pad2(date.getHours()), i: pad2(date.getMinutes()) });
          return t('time.absolute', { date: day, time: clock });
        };

        /** Retention countdown for one recycle-bin row. */
        const trashCountdownOf = (row) => {
          if (row.expiresInDays === null || row.expiresInDays === undefined) return t('trash.kept');
          if (row.expiresInDays <= 0) return t('trash.expired');
          return t('trash.expiresIn', { days: row.expiresInDays });
        };

        const relativeOf = (stamp) => {
          if (stamp <= 0) return '';
          const delta = Math.max(0, now - stamp);
          const minute = 60000;
          const hour = 60 * minute;
          const day = 24 * hour;
          if (delta < minute) return t('time.now');
          if (delta < hour) return t('time.ago', { t: t('time.minutes', { n: Math.floor(delta / minute) }) });
          if (delta < day) return t('time.ago', { t: t('time.hours', { n: Math.floor(delta / hour) }) });
          return t('time.ago', { t: t('time.days', { n: Math.floor(delta / day) }) });
        };

        const failureStatus = (failures, total, doneKey, doneCount) => {
          const first = failures.length > 0 ? failures[0] : '';
          if (failures.length === 0) return { tone: 'ok', key: doneKey, params: { count: doneCount } };
          if (doneCount > 0) {
            return { tone: 'error', key: 'status.partial', params: { failed: failures.length, total, reason: first }, detail: failures[0]?.raw ?? '' };
          }
          return { tone: 'error', key: 'status.failed', params: { reason: first }, detail: failures[0]?.raw ?? '' };
        };

        /**
         * One archive/unarchive batch: bounded concurrency (MAX_PARALLEL), live
         * progress, per-row failures collected, selection cleared only for rows
         * that actually succeeded.
         */
        const runBatch = async (targets, keys, invoke) => {
          if (busy || targets.length === 0) return;
          setBusy(true);
          setConfirming(false);
          setGcOpen(false);
          const failures = [];
          setStatus({ tone: 'idle', key: keys.progress, params: { done: 0, total: targets.length } });
          const outcome = await mapPool(targets, MAX_PARALLEL, (row) => invoke(row.id), (done, total) => {
            setStatus({ tone: 'idle', key: keys.progress, params: { done, total } });
          });
          for (const entry of outcome.failures) failures.push(reasonOf(entry.error));
          const done = outcome.done.map((row) => row.id);
          setSelected((current) => current.filter((id) => done.indexOf(id) < 0));
          setBusy(false);
          setStatus(failureStatus(failures, targets.length, keys.done, done.length));
        };

        const runArchive = (targets) => {
          if (typeof actions.archive !== 'function') {
            setStatus({ tone: 'error', key: 'status.failed', params: { reason: t('error.noService') } });
            return;
          }
          return runBatch(targets, { progress: 'status.archiving', done: 'status.archived' }, (id) => actions.archive(id));
        };

        const runUnarchive = (targets) => {
          if (typeof actions.unarchive !== 'function') {
            setStatus({ tone: 'error', key: 'status.failed', params: { reason: t('error.noService') } });
            return;
          }
          return runBatch(targets, { progress: 'status.unarchiving', done: 'status.unarchived' }, (id) => actions.unarchive(id));
        };

        const runDelete = async (targets) => {
          if (busy || targets.length === 0) return;
          setBusy(true);
          setConfirming(false);
          setGcOpen(false);
          setStatus({ tone: 'idle', key: 'status.deleting', params: { done: 0, total: targets.length } });
          try {
            if (typeof actions.remove !== 'function') throw new Error(t('error.noService'));
            const result = await actions.remove(targets.map((row) => row.id), archivedSet, { deleteFiles });
            const deleted = Array.isArray(result.deleted) ? result.deleted : [];
            const failed = Array.isArray(result.failed) ? result.failed : [];
            // `not-found` is not a failure the user must act on: the log is
            // already gone, so the row is simply removed from the list.
            const gone = [];
            const hard = [];
            for (const entry of failed) {
              if (hidesAfterAttempt(entry)) gone.push(String(entry !== null && typeof entry === 'object' ? entry.sessionId : entry));
              else hard.push(entry);
            }
            const removedIds = deleted.concat(gone);
            for (const id of gone) hiddenIds.add(id);
            setSelected((current) => current.filter((id) => removedIds.indexOf(id) < 0));
            if (removedIds.length > 0) {
              setHidden((current) => {
                const next = current.slice();
                for (const id of removedIds) if (next.indexOf(id) < 0) next.push(id);
                return next;
              });
            }
            const trashed = Array.isArray(result.trashed) ? result.trashed : [];
            const trashedBytes = measurement(result.trashedBytes);
            const freed = measurement(result.freedBytes);
            const freedText = formatBytes(freed, t);
            const goneSuffix = gone.length > 0 ? t('status.gone', { count: gone.length }) : '';
            const removedFiles = result.filesRemoved === null || result.filesRemoved === undefined
              ? 0
              : (result.filesRemoved.attachments ?? 0) + (result.filesRemoved.workspace ?? 0);
            const filesSuffix = removedFiles > 0 ? t('files.removed', { count: removedFiles }) : '';
            const reported = typeof result.auditLog === 'string' && result.auditLog !== '' ? result.auditLog : null;
            if (reported !== null) setAuditPath(reported);
            const auditTarget = reported !== null ? reported : auditPath;
            const hint = auditTarget !== null ? t('gc.audit', { path: auditTarget }) : '';
            if (hard.length === 0 && trashed.length > 0) {
              // v3: the batch moved into the recycle bin instead of being destroyed.
              const movedText = formatBytes(trashedBytes, t);
              const purgeHint = t('gc.audit', { path: auditTarget });
              const undoIds = trashed.slice();
              setStatus(movedText === null
                ? { tone: 'ok', key: 'status.trashedNoSize', params: { count: trashed.length }, suffix: [goneSuffix, filesSuffix].filter(Boolean).join(' · '), hint: auditTarget !== null ? purgeHint : '', undoIds }
                : { tone: 'ok', key: 'status.trashed', params: { count: trashed.length, size: movedText }, suffix: [goneSuffix, filesSuffix].filter(Boolean).join(' · '), hint: auditTarget !== null ? purgeHint : '', undoIds });
              void loadTrash();
            } else if (hard.length === 0) {
              if (deleted.length === 0) {
                setStatus(gone.length > 0
                  ? { tone: 'idle', key: 'status.gone', params: { count: gone.length }, hint }
                  : { tone: 'ok', key: 'status.deletedNoSize', params: { count: 0 }, hint });
              } else if (freedText !== null) {
                setStatus({ tone: 'ok', key: 'status.deleted', params: { count: deleted.length, size: freedText }, suffix: goneSuffix, hint });
              } else {
                setStatus({ tone: 'ok', key: 'status.deletedNoSize', params: { count: deleted.length }, suffix: goneSuffix, hint });
              }
            } else {
              const detail = failureText(hard[0], t);
              const raw = failureRawOf(hard[0]);
              setStatus(deleted.length > 0
                ? { tone: 'error', key: 'status.partial', params: { failed: hard.length, total: targets.length, reason: detail }, suffix: goneSuffix, hint, detail: raw }
                : { tone: 'error', key: 'status.failed', params: { reason: detail }, suffix: goneSuffix, hint, detail: raw });
            }
            if (removedIds.length > 0) {
              void loadSizes();
            void loadRisk();
              void loadGc();
            void loadRisk();
            }
          } catch (error) {
            setStatus({ tone: 'error', key: 'status.failed', params: { reason: reasonOf(error) } });
          } finally {
            setBusy(false);
          }
        };

        /** Restore recycle-bin entries back to their original session folders. */
        const runRestore = async (targets) => {
          if (busy || targets.length === 0) return;
          setBusy(true);
          setConfirming(false);
          setGcOpen(false);
          setStatus({ tone: 'idle', key: 'status.restoring', params: { done: 0, total: targets.length } });
          try {
            if (typeof actions.restore !== 'function') throw new Error(t('error.noService'));
            const result = await actions.restore(targets.map((row) => row.id));
            const restored = Array.isArray(result.restored) ? result.restored : [];
            {
              const known = new Map((trash === null ? [] : trash.items).map((entry) => [entry.id, entry]));
              const added = [];
              for (const id of restored) {
                const entry = known.get(id);
                added.push({
                  id,
                  title: entry !== undefined && entry.title !== null ? entry.title : id,
                  cwd: entry !== undefined && entry.originalPath !== null ? entry.originalPath : '',
                  sizeBytes: entry !== undefined ? entry.bytes : null,
                });
              }
              if (added.length > 0) {
                setRestored((current) => {
                  const next = current.slice();
                  for (const row of added) if (next.every((existing) => existing.id !== row.id)) next.push(row);
                  return next;
                });
              }
            }
            const failed = Array.isArray(result.failed) ? result.failed : [];
            rememberAudit(result);
            setSelected((current) => current.filter((id) => restored.indexOf(id) < 0));
            void loadTrash();
            void loadSizes();
            void loadRisk();
            void loadGc();
            void loadRisk();
            const detail = failed.length > 0 ? failureText(failed[0], t) : '';
            setStatus(failed.length === 0
              ? { tone: 'ok', key: 'status.restored', params: { count: restored.length } }
              : restored.length > 0
                ? { tone: 'error', key: 'status.partial', params: { failed: failed.length, total: targets.length, reason: detail }, detail: raw }
                : { tone: 'error', key: 'status.failed', params: { reason: detail }, detail: raw });
          } catch (error) {
            setStatus({ tone: 'error', key: 'status.failed', params: { reason: reasonOf(error) } });
          } finally {
            setBusy(false);
          }
        };

        /** Purge recycle-bin entries for good (the only irreversible step). */
        const runPurge = async (targets) => {
          if (busy || targets.length === 0) return;
          setBusy(true);
          setConfirming(false);
          setGcOpen(false);
          setStatus({ tone: 'idle', key: 'status.purging', params: { done: 0, total: targets.length } });
          try {
            if (typeof actions.purge !== 'function') throw new Error(t('error.noService'));
            const result = await actions.purge(targets.map((row) => row.id));
            const purged = Array.isArray(result.purged) ? result.purged : [];
            const failed = Array.isArray(result.failed) ? result.failed : [];
            rememberAudit(result);
            setSelected((current) => current.filter((id) => purged.indexOf(id) < 0));
            void loadTrash();
            void loadGc();
            void loadRisk();
            const freedText = formatBytes(measurement(result.freedBytes), t);
            const detail = failed.length > 0 ? failureText(failed[0], t) : '';
            const raw = failed.length > 0 ? failureRawOf(failed[0]) : '';
            setStatus(failed.length === 0
              ? freedText === null
                ? { tone: 'ok', key: 'status.purgedNoSize', params: { count: purged.length } }
                : { tone: 'ok', key: 'status.purged', params: { count: purged.length, size: freedText } }
              : purged.length > 0
                ? { tone: 'error', key: 'status.partial', params: { failed: failed.length, total: targets.length, reason: detail }, detail: raw }
                : { tone: 'error', key: 'status.failed', params: { reason: detail }, detail: raw });
          } catch (error) {
            setStatus({ tone: 'error', key: 'status.failed', params: { reason: reasonOf(error) } });
          } finally {
            setBusy(false);
          }
        };

        /**
         * Ask the Host for a fresh attachment preview, then open the confirm
         * block. The scan runs behind a busy state and never freezes the panel.
         */
        const openGc = async () => {
          if (busy || gcPreparing) return;
          setConfirming(false);
          setGcPreparing(true);
          setStatus({ tone: 'idle', key: 'gc.preparing' });
          try {
            const response = await postOp({ op: 'gc-preview', includeRequestImageCache: false });
            const payload = response.payload;
            if (response.ok !== true || payload === null || payload.ok !== true) {
              const reason = payload !== null && typeof payload.reason === 'string' && payload.reason !== ''
                ? payload.reason
                : t('error.http', { status: response.status });
              throw new Error(reason);
            }
            rememberAudit(payload);
            const summary = gcSummary(payload.report);
            setGc(summary);
            setGcIncludeCache(false);
            setStatus(null);
            if (summary.available !== true) {
              setGcOpen(false);
              setStatus({ tone: 'idle', key: 'status.gcNothing' });
              return;
            }
            setGcOpen(true);
          } catch (error) {
            setStatus({ tone: 'error', key: 'status.failed', params: { reason: reasonOf(error) } });
          } finally {
            setGcPreparing(false);
          }
        };

        const dismissGc = () => {
          setGcOpen(false);
          const trigger = gcRef.current;
          if (trigger !== null && trigger !== undefined && typeof trigger.focus === 'function') trigger.focus();
        };

        /** Run the cleanup the confirm block describes. */
        const runGc = async () => {
          if (gcBusy) return;
          const includeCache = gcIncludeCache === true && gcCacheAvailable === true;
          setGcBusy(true);
          setStatus({ tone: 'idle', key: 'status.gcRunning' });
          try {
            const response = await postOp({ op: 'gc', includeRequestImageCache: includeCache });
            const payload = response.payload;
            if (response.ok !== true || payload === null || payload.ok !== true) {
              const reason = payload !== null && typeof payload.reason === 'string' && payload.reason !== ''
                ? payload.reason
                : t('error.http', { status: response.status });
              throw new Error(reason);
            }
            rememberAudit(payload);
            const deletedFiles = measurement(payload.deletedFiles);
            const freedText = formatBytes(measurement(payload.freedBytes), t);
            const failures = Array.isArray(payload.failed) ? payload.failed : [];
            const hint = auditPath !== null ? t('gc.audit', { path: auditPath }) : '';
            if (failures.length > 0) {
              const first = failures[0];
              const reason = reasonOf(first !== null && typeof first === 'object' ? first.reason : first);
              setStatus({ tone: 'error', key: 'status.gcPartial', params: { failed: failures.length, reason }, hint });
            } else if (deletedFiles !== null && deletedFiles === 0) {
              setStatus({ tone: 'ok', key: 'status.gcNothing', hint });
            } else if (payload.verify !== null && typeof payload.verify === 'object' && payload.verify.ok === false) {
              // The Host rescanned and something the history names no longer resolves: say so
              // instead of reporting a clean success.
              setStatus({
                tone: 'error',
                key: 'status.gcUnverified',
                params: {
                  files: deletedFiles === null ? t('size.unknown') : String(deletedFiles),
                  size: freedText === null ? t('size.unknown') : freedText,
                  count: measurement(payload.verify.missingCount) ?? t('size.unknown'),
                },
                hint,
              });
            } else {
              setStatus({
                tone: 'ok',
                key: 'status.gcDone',
                params: {
                  files: deletedFiles === null ? t('size.unknown') : String(deletedFiles),
                  size: freedText === null ? t('size.unknown') : freedText,
                },
                hint,
              });
            }
            setGcOpen(false);
            void loadSizes();
            void loadGc();
          } catch (error) {
            setStatus({ tone: 'error', key: 'status.failed', params: { reason: reasonOf(error) } });
          } finally {
            setGcBusy(false);
          }
        };

        // The header states facts, not instructions: a count, the space involved, and one
        // sentence about how removal works in this build. Duplicated hint text is noise.
        const measuredTotal = (() => {
          let sum = 0;
          let complete = true;
          for (const row of allRows) {
            if (row.sizeBytes === null || row.sizeBytes === undefined) complete = false;
            else sum += row.sizeBytes;
          }
          return complete && allRows.length > 0 ? formatBytes(sum, t) : null;
        })();
        const introParts = [t('panel.introOne', { total: allRows.length })];
        if (archiveCount > 0) introParts.push(t('panel.introArchived', { count: archiveCount }));
        if (runningCount > 0) introParts.push(t('panel.introRunning', { count: runningCount }));
        if (measuredTotal !== null) introParts.push(t('panel.introSize', { size: measuredTotal }));
        const trashTotalText = trash === null ? null : formatBytes(trash.totalBytes, t);
        const trashIntro = trash === null
          ? t('trash.empty')
          : [
            t('trash.intro', {
              count: trashRows.length,
              size: trashTotalText === null ? t('size.unknown') : trashTotalText,
            }),
            trash.retentionDays === null || trash.retentionDays === 0
              ? null
              : t('trash.retention', { days: trash.retentionDays }),
          ].filter(Boolean).join(' · ');
        const headerNote = inTrash
          ? trashIntro
          : canTrash
            ? t('panel.hintTrash', { days: trash !== null && trash.retentionDays !== null && trash.retentionDays > 0 ? trash.retentionDays : 30 })
            : t('panel.hint');
        const header = h('div', { className: 'dsh-sm-head' },
          h('div', { className: 'dsh-sm-headrow' },
            h('h1', { className: 'dsh-sm-title' }, t('panel.title')),
            h('button', {
              type: 'button',
              className: 'dsh-sm-linkbtn dsh-sm-vocab',
              title: t('vocab.aria'),
              'aria-label': t('vocab.aria'),
              onClick: () => {
                vocabularyStore.set(vocabulary === VOCAB_JARGON ? VOCAB_STANDARD : VOCAB_JARGON);
              },
            }, vocabulary === VOCAB_JARGON ? t('vocab.toStandard') : t('vocab.toJargon')),
          ),
          h('p', { className: 'dsh-sm-sub' }, introParts.join(' · ')),
          h('p', { className: 'dsh-sm-sub dsh-sm-note' }, headerNote),
        );

        // Cleanup is a housekeeping detail, not a primary action: it surfaces as one quiet
        // sentence only when something can actually be reclaimed, and explains itself.
        const gcNotice = gcVisible
          ? h('div', { className: 'dsh-sm-notice', role: 'note' },
            h('span', { className: 'dsh-sm-noticetext' }, t('gc.notice', {
              size: gcActionSize === null ? t('size.unknown') : gcActionSize,
            })),
            h('button', {
              type: 'button',
              className: 'dsh-sm-linkbtn',
              ref: gcRef,
              disabled: busy || gcPreparing,
              onClick: () => {
                void openGc();
              },
            }, gcPreparing ? t('gc.preparing') : t('gc.noticeAction')),
          )
          : null;

        const workspaceSegment = workspaceChoices.length === 0
          ? null
          : h('div', { className: 'dsh-sm-seg', role: 'group', 'aria-label': t('workspace.aria') },
            [{ id: 'all', title: t('workspace.all') }].concat(workspaceChoices).map((choice) => h('button', {
              key: choice.id,
              type: 'button',
              className: 'dsh-sm-segbtn',
              'aria-pressed': workspaceId === choice.id ? 'true' : 'false',
              disabled: busy,
              title: choice.title,
              onClick: () => {
                setSelected([]);
                setWorkspaceId(choice.id);
              },
            }, choice.title)),
          );

        const browseControls = inTrash
          ? h('div', { className: 'dsh-sm-backrow' },
            h('button', {
              type: 'button',
              className: 'dsh-sm-linkbtn',
              disabled: busy,
              onClick: () => {
                clearSelection();
                setFilter('all');
              },
            }, `← ${t('action.back')}`),
            h('span', { className: 'dsh-sm-backtitle' }, t('filter.trash')),
          )
          : h(SegmentedFilter, { t, value: filter, disabled: busy, withTrash: canTrash, onChange: setFilter });

        const toolbar = h('div', { className: 'dsh-sm-toolbar' },
          browseControls,
          h('input', {
            type: 'search',
            className: 'dsh-sm-search',
            value: query,
            placeholder: t('search.placeholder'),
            'aria-label': t('search.aria'),
            spellCheck: false,
            autoComplete: 'off',
            disabled: busy,
            onChange: (event) => setQuery(event.target.value),
          }),
        );

        const workspaceBar = workspaceSegment === null || inTrash
          ? null
          : h('div', { className: 'dsh-sm-toolbar dsh-sm-toolbarwrap' }, workspaceSegment);

        // A batch reports its own progress; a determinate bar replaces "3/12" as the only
        // signal so the user can see how much is left without reading a number.
        const progressNode = (() => {
          if (status === null || typeof status !== 'object') return null;
          const params = status.params ?? {};
          const total = typeof params.total === 'number' ? params.total : 0;
          const done = typeof params.done === 'number' ? params.done : 0;
          if (total <= 0 || done >= total) return null;
          const percent = Math.max(4, Math.min(100, Math.round((done / total) * 100)));
          return h('div', {
            className: 'dsh-sm-progress',
            role: 'progressbar',
            'aria-label': t('progress.aria'),
            'aria-valuemin': 0,
            'aria-valuemax': total,
            'aria-valuenow': done,
          }, h('div', { className: 'dsh-sm-progressfill', style: { width: `${percent}%` } }));
        })();

        const statusSuffix = status !== null && typeof status.suffix === 'string' && status.suffix !== ''
          ? status.suffix
          : '';
        const statusHint = status !== null && typeof status.hint === 'string' && status.hint !== ''
          ? status.hint
          : '';
        const statusNode = status === null
          ? null
          : h('div', { className: 'dsh-sm-statuswrap' },
            h('p', {
              className: 'dsh-sm-status',
              'data-tone': status.tone === 'error' ? 'error' : 'idle',
              role: status.tone === 'error' ? 'alert' : 'status',
              'aria-live': status.tone === 'error' ? 'assertive' : 'polite',
              title: typeof status.detail === 'string' && status.detail !== '' ? status.detail : undefined,
            },
              t(status.key, status.params),
              statusSuffix === '' ? null : h('span', { className: 'dsh-sm-statussuffix' }, ' ', statusSuffix),
              Array.isArray(status.undoIds) && status.undoIds.length > 0
                ? h('button', {
                  type: 'button',
                  className: 'dsh-sm-linkbtn dsh-sm-undo',
                  disabled: busy,
                  onClick: () => {
                    void runRestore(status.undoIds.map((id) => ({ id })));
                  },
                }, t('action.undo'))
                : null,
            ),
            statusHint === '' ? null : h('p', { className: 'dsh-sm-confirmsub' }, statusHint),
          );

        let bar = null;
        if (gcOpen && gc !== null) {
          // Cleanup confirm: what was scanned, what is safe to remove, and the
          // derived cache behind an explicit opt-in (default off).
          const cacheTotal = gcIncludeCache === true && gcCacheAvailable === true ? gcCacheBytes : 0;
          const confirmBytes = gcSafeBytes + cacheTotal;
          const confirmSize = formatBytes(confirmBytes, t);
          const numeral = (value) => (value === null ? t('size.unknown') : String(value));
          bar = h('div', {
            className: 'dsh-sm-confirm dsh-sm-confirmstack',
            role: 'group',
            'aria-label': t('gc.title'),
          },
            h('div', { className: 'dsh-sm-confirmtext' },
              h('div', { className: 'dsh-sm-confirmtitle' }, t('gc.title')),
              gc.sessionsScanned === null && gc.referencedImages === null && gc.referencedFiles === null
                ? null
                : h('div', { className: 'dsh-sm-confirmbody' }, t('gc.scanned', {
                  sessions: numeral(gc.sessionsScanned),
                  images: numeral(gc.referencedImages),
                  files: numeral(gc.referencedFiles),
                })),
              gc.unresolvedCount !== null && gc.unresolvedCount > 0
                ? h('div', { className: 'dsh-sm-gcstat', 'data-tone': 'warn', title: t('gc.unresolvedAria') }, t('gc.unresolved', { count: gc.unresolvedCount }))
                : null,
              gc.safeBytes !== null && gc.safeBytes > 0
                ? h('div', { className: 'dsh-sm-gcstat' }, t('gc.safe', {
                  files: numeral(gc.safeFiles),
                  size: formatBytes(gc.safeBytes, t) === null ? t('size.unknown') : formatBytes(gc.safeBytes, t),
                }))
                : h('div', { className: 'dsh-sm-gcstat' }, t('gc.safeNone')),
              h('label', {
                className: 'dsh-sm-gccheck',
                'data-disabled': gcCacheAvailable === true ? 'false' : 'true',
              },
                h('input', {
                  type: 'checkbox',
                  checked: gcIncludeCache === true && gcCacheAvailable === true,
                  disabled: gcCacheAvailable !== true || gcBusy,
                  onChange: (event) => setGcIncludeCache(event.target.checked === true),
                }),
                h('span', null, gcCacheAvailable === true
                  ? t('gc.includeCache', {
                    files: numeral(gc.cacheFiles),
                    size: formatBytes(gcCacheBytes, t) === null ? t('size.unknown') : formatBytes(gcCacheBytes, t),
                  })
                  : t('gc.includeCacheEmpty')),
              ),
              h('div', { className: 'dsh-sm-confirmbody' }, t('gc.body')),
              h('div', { className: 'dsh-sm-confirmsub' }, auditPath === null ? t('gc.auditHint') : t('gc.audit', { path: auditPath })),
            ),
            h('div', { className: 'dsh-sm-confirmrow' },
              h('button', {
                type: 'button',
                className: 'dsh-sm-btn',
                ref: gcCancelRef,
                onClick: dismissGc,
              }, t('confirm.cancel')),
              h('button', {
                type: 'button',
                className: 'dsh-sm-btn',
                'data-variant': 'dangerSolid',
                disabled: gcBusy,
                onClick: () => {
                  void runGc();
                },
              }, t('gc.confirm', { size: confirmSize === null ? t('size.unknown') : confirmSize })),
            ),
          );
        } else if (confirming) {
          // The same confirm surface serves three irreversible-looking actions: purging a
          // recycle-bin entry (truly irreversible), moving sessions into the bin (recoverable)
          // and - only against a v2 Host - deleting outright.
          const purging = inTrash;
          const retention = trash !== null && trash.retentionDays !== null ? trash.retentionDays : null;
          const canRestore = canTrash && retention !== null;
          const confirmTitle = purging
            ? t('confirm.purgeTitle', { count: selectedCount })
            : canTrash
              ? t('confirm.trashTitle', { count: selectedCount })
              : t('confirm.title', { count: selectedCount });
          const confirmBody = purging
            ? t('confirm.purgeBody', { count: selectedCount })
            : canTrash
              ? canRestore
                ? t('confirm.trashBody', { days: retention })
                : t('confirm.trashBodyUnknown')
              : t('confirm.body');

          // Risk is the point of this surface: say how the selection splits, and name the ones
          // that deserve a second look instead of treating every row the same.
          // A row the Host has no verdict for is never recommended: unknown degrades to "check first".
          const tierOf = (row) => (purging === true ? 'low' : riskOf(row)?.tier ?? 'medium');
          const buckets = { low: [], medium: [], high: [] };
          for (const row of selectedRows) buckets[tierOf(row)].push(row);
          const lowReasons = new Map();
          for (const row of buckets.low) {
            for (const reason of riskOf(row)?.reasons ?? []) {
              lowReasons.set(reason.key, (lowReasons.get(reason.key) ?? 0) + 1);
            }
          }
          const lowDetail = [...lowReasons.entries()]
            .map(([key, count]) => (count > 1 ? `${t(key, { count })}×${count}` : t(key, { count })))
            .join(' · ');
          const highNames = buckets.high.slice(0, 3).map((row) => row.title).join('、');
          const highMore = buckets.high.length > 3 ? t('risk.summaryHighMore', { count: buckets.high.length - 3 }) : '';
          const purgingDescendants = purging === true
            ? (() => {
              const known = new Map((trash === null ? [] : trash.items).map((entry) => [entry.id, entry]));
              let entries = 0;
              let count = 0;
              for (const row of selectedRows) {
                const entry = known.get(row.id);
                const derived = entry !== undefined && typeof entry.descendantCount === 'number' ? entry.descendantCount : 0;
                if (derived > 0) {
                  entries += 1;
                  count += derived;
                }
              }
              return { entries, count };
            })()
            : null;
          const filesNode = (() => {
            if (purging === true || fileInfo === null) return null;
            const deletable = fileInfo.attachmentExclusive > 0 || fileInfo.pathExclusive > 0;
            if (deletable !== true) {
              return h('div', { className: 'dsh-sm-fileline' }, t('files.none'));
            }
            return h('div', { className: 'dsh-sm-files' },
              h('label', { className: 'dsh-sm-filecheck' },
                h('input', {
                  type: 'checkbox',
                  checked: deleteFiles === true,
                  disabled: busy,
                  onChange: (event) => setDeleteFiles(event.target.checked === true),
                }),
                h('span', null, t('files.question')),
              ),
              h('div', {
                className: 'dsh-sm-fileline',
                title: fileInfo.samples.length === 0
                  ? undefined
                  : `${t('files.pathsTitle')} ${fileInfo.samples.join('  ·  ')}`,
              }, t('files.detail', {
                attachments: String(fileInfo.attachments),
                attachmentExclusive: String(fileInfo.attachmentExclusive),
                paths: String(fileInfo.paths),
                pathExclusive: String(fileInfo.pathExclusive),
              })),
              h('div', { className: 'dsh-sm-fileline' }, t('files.shared')),
            );
          })();
          const riskLines = riskMap === null && purging !== true
            ? null
            : h('div', { className: 'dsh-sm-risklines' },
              purgingDescendants !== null && purgingDescendants.count > 0
                ? h('div', { className: 'dsh-sm-riskline', 'data-tier': 'high' }, t('confirm.purgeDescendants', {
                  entries: purgingDescendants.entries,
                  count: purgingDescendants.count,
                }))
                : null,
              purging === true ? null : buckets.low.length > 0
                ? h('div', { className: 'dsh-sm-riskline', 'data-tier': 'low' }, t('risk.summaryLow', {
                  count: buckets.low.length,
                  reasons: lowDetail === '' ? t('risk.reason.other') : lowDetail,
                }))
                : null,
              purging === true ? null : buckets.medium.length > 0
                ? h('div', { className: 'dsh-sm-riskline', 'data-tier': 'medium' }, t('risk.summaryMedium', { count: buckets.medium.length }))
                : null,
              purging === true ? null : buckets.high.length > 0
                ? h('div', { className: 'dsh-sm-riskline', 'data-tier': 'high' }, t('risk.summaryHigh', {
                  count: buckets.high.length,
                  names: highMore === '' ? highNames : `${highNames} ${highMore}`,
                }))
                : null,
            );
          bar = h('div', { className: 'dsh-sm-confirm', role: 'group', 'aria-label': confirmTitle },
            h('div', { className: 'dsh-sm-confirmtext' },
              h('div', { className: 'dsh-sm-confirmtitle' }, confirmTitle),
              h('div', null, confirmBody),
              filesNode,
              riskLines,
              selectedSizeText === null ? null : h('div', { className: 'dsh-sm-confirmsub' }, selectionLabel),
            ),
            h('div', { className: 'dsh-sm-grow' }),
            h('button', {
              type: 'button',
              className: 'dsh-sm-btn',
              ref: cancelRef,
              onClick: () => {
                setConfirming(false);
                const trigger = deleteRef.current;
                if (trigger !== null && trigger !== undefined && typeof trigger.focus === 'function') trigger.focus();
              },
            }, t('confirm.cancel')),
            h('button', {
              type: 'button',
              className: 'dsh-sm-btn',
              'data-variant': 'dangerSolid',
              onClick: () => {
                if (purging) void runPurge(selectedRows);
                else void runDelete(selectedRows);
              },
            }, purging ? t('confirm.purge') : canTrash ? t('confirm.trash') : t('confirm.delete')),
          );
        } else if (inTrash && selectedCount > 0) {
          const expiredCount = trashRows.filter((row) => row.expiresInDays !== null && row.expiresInDays <= 0).length;
          bar = h('div', { className: 'dsh-sm-bar', role: 'group', 'aria-label': selectionLabel },
            h('span', { className: 'dsh-sm-barcount' }, selectionLabel),
            h('div', { className: 'dsh-sm-grow' }),
            h('button', {
              type: 'button',
              className: 'dsh-sm-btn',
              'data-variant': 'primary',
              disabled: busy,
              onClick: () => {
                void runRestore(selectedRows);
              },
            }, t('action.restore')),
            h('button', {
              type: 'button',
              className: 'dsh-sm-btn',
              'data-variant': 'dangerText',
              ref: deleteRef,
              disabled: busy,
              onClick: () => setConfirming(true),
            }, t('action.purge')),
            expiredCount > 0
              ? h('button', {
                type: 'button',
                className: 'dsh-sm-btn',
                'data-variant': 'quiet',
                disabled: busy,
                onClick: () => {
                  void runPurge(trashRows.filter((row) => row.expiresInDays !== null && row.expiresInDays <= 0));
                },
              }, t('action.purgeExpired'))
              : null,
            h('button', {
              type: 'button',
              className: 'dsh-sm-iconbtn',
              'aria-label': t('action.clear'),
              title: t('action.clear'),
              disabled: busy,
              onClick: clearSelection,
            }, h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true, focusable: 'false' },
              h('path', { d: 'M3 3l6 6M9 3l-6 6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }))),
          );
        } else if (selectedCount > 0) {
          // One primary action for what the selection is mostly made of, the opposite state
          // as a quiet secondary, the destructive step as a text button, and clear as an icon.
          const mostlyArchived = selectedRestorable.length > selectedArchivable.length;
          const primary = mostlyArchived
            ? { label: t('action.unarchive'), run: () => runUnarchive(selectedRestorable), enabled: selectedRestorable.length > 0 }
            : { label: t('action.archive'), run: () => runArchive(selectedArchivable), enabled: selectedArchivable.length > 0 };
          const secondary = mostlyArchived
            ? { label: t('action.archive'), run: () => runArchive(selectedArchivable), enabled: selectedArchivable.length > 0 }
            : { label: t('action.unarchive'), run: () => runUnarchive(selectedRestorable), enabled: selectedRestorable.length > 0 };
          bar = h('div', { className: 'dsh-sm-bar', role: 'group', 'aria-label': selectionLabel },
            h('span', { className: 'dsh-sm-barcount' }, selectionLabel),
            h('div', { className: 'dsh-sm-grow' }),
            h('button', {
              type: 'button',
              className: 'dsh-sm-btn',
              'data-variant': 'primary',
              disabled: busy || primary.enabled !== true,
              onClick: primary.run,
            }, primary.label),
            h('button', {
              type: 'button',
              className: 'dsh-sm-btn',
              'data-variant': 'quiet',
              disabled: busy || secondary.enabled !== true,
              onClick: secondary.run,
            }, secondary.label),
            h('button', {
              type: 'button',
              className: 'dsh-sm-btn',
              'data-variant': 'dangerText',
              ref: deleteRef,
              disabled: busy,
              onClick: () => {
                setDeleteFiles(false);
                setConfirming(true);
                void loadFileInfo(selectedRows.map((row) => row.id));
              },
            }, t('action.delete')),
            h('button', {
              type: 'button',
              className: 'dsh-sm-iconbtn',
              'aria-label': t('action.clear'),
              title: t('action.clear'),
              disabled: busy,
              onClick: clearSelection,
            }, h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true, focusable: 'false' },
              h('path', { d: 'M3 3l6 6M9 3l-6 6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }))),
          );
        }

        const meta = h('div', { className: 'dsh-sm-meta' },
          h('div', {
            className: 'dsh-sm-checkall',
            role: 'checkbox',
            tabIndex: 0,
            'aria-checked': allVisibleSelected ? 'true' : someVisibleSelected ? 'mixed' : 'false',
            'aria-label': t('list.selectAllAria'),
            onClick: toggleAllVisible,
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
                event.preventDefault();
                toggleAllVisible();
              }
            },
          },
            h('span', {
              className: 'dsh-sm-check',
              'data-state': allVisibleSelected ? 'on' : someVisibleSelected ? 'mixed' : 'off',
              'aria-hidden': 'true',
            }, allVisibleSelected || someVisibleSelected ? h(CheckMark, { state: allVisibleSelected ? 'on' : 'mixed' }) : null),
            h('span', null, t('list.selectAll')),
          ),
          h('div', { className: 'dsh-sm-grow' }),
          // The header already states the total; a "1 of 1" line here would only add noise.
          lowRiskVisible > 0 && inTrash !== true
            ? h('button', {
              type: 'button',
              className: 'dsh-sm-linkbtn dsh-sm-suggest',
              disabled: busy,
              'aria-label': t('risk.selectLowAria'),
              title: t('risk.selectLowAria'),
              onClick: () => {
                setConfirming(false);
                setSelected(rows.filter((row) => riskOf(row)?.tier === 'low').map((row) => row.id));
              },
            }, t('risk.selectLow', { count: lowRiskVisible }))
            : null,
          rows.length === visibleRows.length && visibleRows.length === allRows.length
            ? null
            : h('span', { className: 'dsh-sm-count' }, t('list.count', { shown: rows.length, total: visibleRows.length })),
        );

        let body = null;
        if (loading) {
          body = h('div', { className: 'dsh-sm-empty', role: 'status' }, t('list.loading'));
        } else if (rows.length === 0) {
          if (inTrash) {
            const retention = trash !== null && trash.retentionDays !== null ? trash.retentionDays : null;
            body = h('div', { className: 'dsh-sm-empty' },
              h('div', null, t('trash.empty')),
              h('div', { className: 'dsh-sm-hint' }, retention === null
                ? t('trash.emptyHintUnknown')
                : retention === 0
                  ? t('trash.emptyHintForever')
                  : t('trash.emptyHint', { days: retention })),
            );
          } else {
            body = h('div', { className: 'dsh-sm-empty' }, allRows.length === 0 ? t('list.empty') : t('list.emptyFiltered'));
          }
        } else {
          body = h('ul', { className: 'dsh-sm-list' },
            rows.map((row) => h(SessionRow, {
              key: row.id,
              row: {
                id: row.id,
                title: row.title,
                cwd: row.cwd,
                relative: row.trashed === true ? trashCountdownOf(row) : relativeOf(row.updatedAt),
                absolute: row.trashed === true ? row.cwd : absoluteOf(row.updatedAt),
                running: row.running,
                blank: row.blank,
                child: row.child,
                archived: row.archived,
                selected: selectedSet.has(row.id),
                riskTier: (inTrash === true ? undefined : riskOf(row)?.tier),
                riskTitle: (inTrash === true ? '' : (riskOf(row)?.reasons ?? []).map(riskReasonText).join(' · ')),
                sizeText: formatBytes(row.sizeBytes, t),
              },
              t,
              onToggle: toggleRow,
            })),
          );
        }

        return h('div', { className: 'dsh-sm', 'aria-busy': busy ? 'true' : 'false' },
          h('style', null, STYLES),
          header,
          toolbar,
          workspaceBar,
          gcNotice,
          progressNode,
          statusNode,
          bar,
          meta,
          body,
          truncated ? h('p', { className: 'dsh-sm-hint' }, t('list.truncated', { count: rows.length })) : null,
        );
      };
    }

    /**
     * An error boundary keeps a render failure from blanking the panel: a plain
     * text line stays visible instead.
     */
    function withBoundary(Inner) {
      class Guard extends React.Component {
        constructor(props) {
          super(props);
          this.state = { error: null };
        }

        static getDerivedStateFromError(error) {
          return { error };
        }

        render() {
          const state = this.state === null || this.state === undefined ? {} : this.state;
          if (state.error !== null && state.error !== undefined) {
            const message = typeof state.error.message === 'string' ? state.error.message : String(state.error);
            let text = 'Session manager could not render: ' + message;
            if (typeof this.props.t === 'function') {
              try {
                text = this.props.t('error.render', { message });
              } catch (error) {
                text = 'Session manager could not render: ' + message;
              }
            }
            return h('div', { style: { padding: '24px clamp(16px,3vw,32px)', color: 'var(--dsw-alias-state-error-primary)' } }, text);
          }
          return h(Inner, this.props);
        }
      }
      return Guard;
    }

    /* ------------------------------------------------------------------ */
    /* Plugin                                                              */
    /* ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        // A namespace clash would throw; the bundled dictionary keeps the panel
        // readable for both languages even then.
        ctx.effect(() => {
          try {
            return ctx.locale.register(NS, DICTS);
          } catch (error) {
            return () => {};
          }
        }, 'session-manager: dictionaries');

        // Ids the Host deleted from disk. The client session store has no delete
        // push, so the panel hides them for the rest of the app session.
        const hiddenIds = new Set();

        const archive = async (sessionId) => {
          const service = archiveService(ctx);
          if (service === undefined) throw new Error(notice(t, 'error.noService'));
          await service.archiveSession(sessionId, { stopActivity: true });
        };

        const unarchive = async (sessionId) => {
          const service = archiveService(ctx);
          if (service === undefined) throw new Error(notice(t, 'error.noService'));
          await service.unarchiveSession(sessionId);
        };

        /**
         * Archive anything still active (stops running work instead of letting the
         * Host refuse the removal), then ask the Host route to delete the logs.
         * The pre-archive step is a bounded batch: a slow session never delays the
         * others, and an archive failure is not fatal because the Host's delete
         * result is authoritative.
         */
        const remove = async (sessionIds, archivedSet, options = {}) => {
          const archived = archivedSet instanceof Set ? archivedSet : new Set();
          const ids = Array.isArray(sessionIds) ? sessionIds.slice() : [];
          const pending = ids.filter((sessionId) => archived.has(sessionId) !== true);
          await mapPool(pending, MAX_PARALLEL, async (sessionId) => {
            await archive(sessionId);
          });
          const response = await postOp({ op: 'delete', sessionIds: ids, deleteFiles: options.deleteFiles === true });
          if (response.payload === null) throw new Error(notice(t, 'error.http', { status: response.status }));
          if (response.payload.ok !== true) {
            const reason = typeof response.payload.reason === 'string' && response.payload.reason !== ''
              ? response.payload.reason
              : notice(t, 'error.badPayload');
            throw new Error(reason);
          }
          const deleted = Array.isArray(response.payload.deleted) ? response.payload.deleted : [];
          const trashed = Array.isArray(response.payload.trashed) ? response.payload.trashed : [];
          const failed = Array.isArray(response.payload.failed) ? response.payload.failed : [];
          // Both outcomes remove the row from the live list; only a permanent delete hides it
          // from the app session (a trashed one reappears if it is restored).
          for (const sessionId of deleted) hiddenIds.add(sessionId);
          const freedBytes = measurement(response.payload.freedBytes);
          const trashedBytes = measurement(response.payload.trashedBytes);
          const filesRemoved = response.payload.filesRemoved !== null && typeof response.payload.filesRemoved === 'object'
            ? {
              attachments: measurement(response.payload.filesRemoved.attachments) ?? 0,
              workspace: measurement(response.payload.filesRemoved.workspace) ?? 0,
              bytes: measurement(response.payload.filesRemoved.bytes) ?? 0,
              failed: Array.isArray(response.payload.filesRemoved.failed) ? response.payload.filesRemoved.failed.length : 0,
            }
            : null;
          const auditLog = typeof response.payload.auditLog === 'string' && response.payload.auditLog !== ''
            ? response.payload.auditLog
            : null;
          return { deleted, trashed, failed, freedBytes, trashedBytes, filesRemoved, auditLog };
        };

        /** Bring recycle-bin entries back; the Host reports per-entry failures by code. */
        const restore = async (sessionIds) => {
          const ids = Array.isArray(sessionIds) ? sessionIds.slice() : [];
          const response = await postOp({ op: 'trash-restore', sessionIds: ids });
          if (response.payload === null) throw new Error(notice(t, 'error.http', { status: response.status }));
          if (response.payload.ok !== true) {
            const reason = typeof response.payload.reason === 'string' && response.payload.reason !== ''
              ? response.payload.reason
              : notice(t, 'error.badPayload');
            throw new Error(reason);
          }
          const restored = Array.isArray(response.payload.restored) ? response.payload.restored : [];
          const failed = Array.isArray(response.payload.failed) ? response.payload.failed : [];
          const auditLog = typeof response.payload.auditLog === 'string' && response.payload.auditLog !== ''
            ? response.payload.auditLog
            : null;
          return { restored, failed, auditLog };
        };

        /** Permanently drop recycle-bin entries (the only irreversible step left). */
        const purge = async (sessionIds) => {
          const ids = Array.isArray(sessionIds) ? sessionIds.slice() : [];
          const response = await postOp({ op: 'trash-purge', sessionIds: ids, force: true });
          if (response.payload === null) throw new Error(notice(t, 'error.http', { status: response.status }));
          if (response.payload.ok !== true) {
            const reason = typeof response.payload.reason === 'string' && response.payload.reason !== ''
              ? response.payload.reason
              : notice(t, 'error.badPayload');
            throw new Error(reason);
          }
          const purged = Array.isArray(response.payload.purged) ? response.payload.purged : [];
          const failed = Array.isArray(response.payload.failed) ? response.payload.failed : [];
          const freedBytes = measurement(response.payload.freedBytes);
          const auditLog = typeof response.payload.auditLog === 'string' && response.payload.auditLog !== ''
            ? response.payload.auditLog
            : null;
          return { purged, failed, freedBytes, auditLog };
        };

        const Panel = withBoundary(createPanel());

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({
            actions: { archive, unarchive, remove, restore, purge },
            hiddenIds,
            fallbackT: t,
          }),
        }, Panel));

        /** The rail label in the same voice as the panel it opens. */
        const panellistLabel = () => jargonOverride('panel.label') ?? notice(t, 'panel.label');

        ctx.slots.inject('sidebar.panellist', () => {
          const register = () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 20,
            locale: NS,
            label: panellistLabel,
          }, ManagerIcon);
          let current = register();
          // A rename is a re-registration: the sidebar owns its projection, so replacing the
          // entry is the only way the rail shows the new name in the same session.
          const unsubscribe = vocabularyStore.subscribe(() => {
            const stale = current;
            current = undefined;
            if (typeof stale === 'function') stale();
            current = register();
          });
          return () => {
            unsubscribe();
            if (typeof current === 'function') current();
            current = undefined;
          };
        });
      },
    };
  },
});