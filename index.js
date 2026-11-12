/**
 * Session Manager — Host half (v3: recycle bin + self-verifying attachment cleanup).
 *
 * Registers exactly one same-origin JSON route, `POST /plugins/session-manager/api`
 * (see DESIGN.md "Protocol v2"), which the client half calls to inspect, archive and
 * permanently remove session logs, and to reclaim attachment objects that no surviving
 * session references any more.
 *
 * v2 is a strict superset of v1: `ping` reports version "2", `list` rows carry
 * `bytes`, `delete` reports `freedBytes` and a machine-readable `failed[].code`, and
 * `sizes`, `gc-preview` and `gc` are new. Every v1 caller keeps working — the v1
 * client in the profile calls `list`/`delete`/`ping` and ignores the added fields.
 *
 * Service choices (deliberately soft — every lookup is `ctx.get`, never a hard
 * inject, so a profile missing one of them degrades instead of failing):
 *
 * - `webServer` — hard `inject`: the route is the whole point of this plugin, and
 *   Cordis keeps the plugin inactive (not failed) until the carrier exists.
 * - `connection` — optional trust fence. When the composition exposes it, every
 *   request runs through `requestRejection(request)`, the shipped Host/Origin +
 *   browser-authentication check other Web routes use. Absent: the route serves
 *   whatever reached the loopback listener.
 * - `workspaceRegistry` — optional. `archiveSession(id, {stopActivity: true})` stops
 *   work and hides the session before its log is removed; `archivedSessionIds` feeds
 *   the `archived` flag of `list`; a successful delete drops the id from that archive
 *   set (`unarchiveSession`) so no dangling archive entry survives its log.
 * - `sessionPersistence` — optional, and the *only* source of truth for the path we
 *   delete and for the durable size we report. `stat(id).location.path` is the durable
 *   artifact (verified: the JSONL backend reports
 *   `<root>/<cwd-slug>/<encoded id>/session.v<N>.jsonl[.zstd]`) and
 *   `stat(id).sizeBytes` is its physical size. A session with no reported location is
 *   refused, never guessed from the id.
 * - `sessionController` — optional. `list({}, signal)` backs `list`, `sizes` and audit
 *   titles, and `state({sessionId})` is a second, independent "is it still running?"
 *   check.
 *
 * Safety rules the delete path enforces:
 *  1. a path is never constructed from a session id — it always comes from `stat()`;
 *  2. the whole session directory is removed only when `path` sits inside a real
 *     (non-symlink) directory whose name is that session id (raw or in the backend's
 *     `encodeSegment` form); otherwise just the reported file is unlinked;
 *  3. relative paths, missing paths and unreadable paths are refused with a code;
 *  4. each id is handled independently: one failure is reported in `failed` and the
 *     batch continues (bounded concurrency, results reported in request order);
 *  5. the handler never throws — every outcome is a JSON response.
 *
 * Attachment GC (`gc-preview`/`gc`) implements the DESIGN.md safety model plus two
 * strictly-safer additions:
 *  - references come only from surviving session logs
 *    (`sessions/<slug>/<sessionId>/session[.vN].jsonl[.zstd|.gz]`, every generation,
 *    legacy format included) and `storages/session_projcache/sessions/*.json`; the scan
 *    is streamed, never retains the corpus, and carries a 128-byte overlap so a digest
 *    split across a chunk boundary is still detected;
 *  - before scanning we ask `sessionPersistence.flush()` for a durability barrier, so an
 *    image referenced by an unflushed in-flight turn still counts as referenced;
 *  - durable objects younger than `GC_PROTECT_RECENT_MS` are treated as referenced: an
 *    upload staged for an unsent draft has a live receipt but no log reference yet, and
 *    it must not be swept out from under the composer;
 *  - if any reference document could not be read at all, the whole run fails closed
 *    (nothing is deleted and the unreadable file is reported in `failed`), because a
 *    missed reference deletes live data while a skipped sweep only costs disk;
 *  - candidates are only `objects/`, `file-objects/`, `files/<2>/<digest>/` and, opt-in,
 *    `request-images/`; nothing outside `<DSH_HOME>/attachments/v1` is ever touched,
 *    symlinks are never followed, directories are removed with `rmdir` only when already
 *    empty, and `tmp/` is ignored.
 *
 * Report semantics (the client is written against these):
 *  - `groups[]` carries the three durable groups; `request-images` appears only when the
 *    caller opts in with `includeRequestImageCache: true`, i.e. a group is listed exactly
 *    when it participates;
 *  - per-group `files`/`bytes` are raw on-disk totals; `deletableFiles`/`deletableBytes`
 *    are the raw totals of that group's deletable entries;
 *  - the report-level `deletableBytes` is the *deduplicated* amount `gc` would free (a
 *    `files/<2>/<digest>/<name>` entry is a hard link to `file-objects/…`, so it counts
 *    once) and always excludes the optional cache; `cacheFiles`/`cacheBytes` describe
 *    `request-images/` so the panel can offer the checkbox;
 *  - `gc.deletedFiles`/`gc.freedBytes` describe what the run did — or, with
 *    `dryRun: true`, exactly what it would do. No undocumented keys are added.
 *
 * Audit trail: one JSON line per `delete` and per `gc` (never per preview) appended to
 * `<DSH_HOME>/logs/session-manager.jsonl`, `<DSH_HOME>` = `$DSH_HOME` else `~/.dsh`. A
 * write failure is logged once and never fails the request.
 *
 * Options come from the bundle row `config`, read defensively per request: `auditLog`
 * (boolean, default true) and `maxConcurrency` (integer 1..8, default 4; out-of-range
 * values are clamped, non-integers fall back). Unknown keys are ignored.
 */

import { createReadStream } from 'node:fs'
import { appendFile, cp, lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat as statPath, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { createGunzip, zstdDecompressSync } from 'node:zlib'

/** Loader entry identity, matching the bundle patch row (module-local: a function plugin exports only `apply`). */
const name = 'session-manager'

/** The route carrier is required; without it the plugin stays inactive instead of failing. */
export const inject = ['webServer']

/** The one endpoint this plugin serves. */
const ROUTE_PATH = '/plugins/session-manager/api'

/** Wire version reported by `ping` (DESIGN.md "Protocol v3"). */
const PROTOCOL_VERSION = '3'

/** Request bodies are small JSON control messages; anything larger is refused. */
const MAX_BODY_BYTES = 1024 * 1024

/** How long we wait for an archived session's turn to actually end before refusing. */
const RUNNING_POLL_ATTEMPTS = 6
const RUNNING_POLL_INTERVAL_MS = 100

/** Archive refusals that only mean "nothing to stop": the real error comes from `stat()`. */
const IGNORABLE_ARCHIVE_ERRORS = new Set([
	'WorkspaceUnknownSessionError',
	'SessionPersistenceNotFoundError',
])

/** The fixed machine-readable failure vocabulary from DESIGN.md (v2 + v3). */
const FAILURE_CODES = new Set([
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
])

/** Default and bounds for the bounded-concurrency delete loop. */
const DEFAULT_MAX_CONCURRENCY = 4
const MIN_MAX_CONCURRENCY = 1
const MAX_MAX_CONCURRENCY = 8

/* ---- Destructive-work serialization ---------------------------------------------------------- */

/**
 * Destructive operations take this in-process lock one at a time.
 *
 * The dangerous interleaving is concrete: a cleanup scans references, a restore resurrects a
 * session, and the cleanup then unlinks an object the restored session owns. Nothing in the
 * single-threaded event loop prevents that, because each step awaits I/O. Serialising the four
 * destructive entry points costs nothing (they already take tens of milliseconds) and removes the
 * whole class. Verification still runs afterwards; this is prevention, not detection.
 */
let destructiveChain = Promise.resolve()

/**
 * Run `operation` after every previously queued destructive operation settled.
 * @returns the operation's own result; a failure propagates but never blocks the queue.
 */
function withDestructiveLock(operation) {
	const run = destructiveChain.then(operation, operation)
	destructiveChain = run.then(
		() => undefined,
		() => undefined,
	)
	return run
}

/* ---- Trash (v3) ------------------------------------------------------------------------------ */

/** Session entries of the recycle bin, relative to `<DSH_HOME>`. */
const TRASH_RELATIVE = ['trash', 'sessions']

/** Per-entry metadata written inside a trashed session directory. */
const TRASH_SIDECAR = '.dsh-trash.json'

/** Recycle-bin retention in days: 0 keeps entries forever. */
const DEFAULT_TRASH_RETENTION_DAYS = 30
const MAX_TRASH_RETENTION_DAYS = 3650
const DAY_MS = 24 * 60 * 60 * 1000

/** Expiry sweep cadence while the plugin is mounted. */
const TRASH_SWEEP_INTERVAL_MS = 60 * 60 * 1000

/** Attachment store directory under `<DSH_HOME>/attachments`. */
const ATTACHMENT_STORE = 'v1'

/** Audit trail file name under `<DSH_HOME>/logs`. */
const AUDIT_FILE = 'session-manager.jsonl'

/** A durable attachment younger than this is treated as referenced (live upload / unsent draft). */
const GC_PROTECT_RECENT_MS = 10 * 60 * 1000

/** Overlap kept between stream chunks so a digest split across a boundary is still matched. */
const SCAN_OVERLAP = 128

/** Whole-file ceiling for the fallback read of a reference document no stream would read. */
const SCAN_FALLBACK_MAX_BYTES = 256 * 1024 * 1024

/**
 * Compressed-size ceiling for a whole-file zstd decode (~4x its bytes in memory).
 * Beyond it the document is reported unreadable, and GC refuses to run rather than guess.
 */
const ZSTD_SCAN_MAX_BYTES = 64 * 1024 * 1024

/** Guard rails for directory measurement and the attachment walk. */
const WALK_MAX_ENTRIES = 20000
const WALK_MAX_DEPTH = 8

/** A bare 64-hex digest anywhere in a scanned document (covers `sha256:<digest>` too). */
const DIGEST_PATTERN = /[0-9a-f]{64}/g

/** Store leaf name of one content-addressed entry. */
const DIGEST_NAME = /^[0-9a-f]{64}$/

/** Shard directory name of the attachment store. */
const SHARD_NAME = /^[0-9a-f]{2}$/

/** A surviving session log: every generation, current and legacy formats. */
const SESSION_LOG_NAME = /^session(\.[A-Za-z0-9_-]+)*\.jsonl(\.zstd|\.gz)?$/

/** Magic number every zstd frame starts with; a DSH log appends one frame per write. */
const ZSTD_FRAME_MAGIC = 0xfd2fb528

/* ------------------------------------------------------------------------------------------------
 * Deletion-risk policy: data owns the judgement, this code owns the operators
 *
 * The first version of this feature hard-coded its thresholds inside the client bundle. That
 * failed in a predictable way: the only way to know whether the thresholds were sane was to read
 * a one-off script against a real home, they could not be tuned without editing UI code, and a
 * second copy of the same judgement on the other side of the wire would have drifted.
 * So: the policy is a shipped JSON document (versioned, overridable per request for calibration),
 * the evaluator is pure, and only the Host — the side that owns persistence, pins, archive state
 * and attachment sizes — produces a verdict. The Client renders verdicts; it never re-judges.
 * ---------------------------------------------------------------------------------------------- */

const RISK_POLICY_PATH = new URL('./policy/risk-policy.json', import.meta.url)
const RISK_POLICY_MAX_BYTES = 256 * 1024
const RISK_TIER_ORDER = Object.freeze({ low: 1, medium: 2, high: 3 })

let riskPolicyCache

/** Load and validate the shipped policy once; a malformed policy is a startup-visible error. */
async function loadRiskPolicy() {
	if (riskPolicyCache !== undefined) return riskPolicyCache
	let raw
	try {
		const info = await statPath(fileURLToPath(RISK_POLICY_PATH))
		if (info.isFile() !== true || info.size > RISK_POLICY_MAX_BYTES) throw new Error('risk policy is missing or oversized')
		raw = JSON.parse(await readFile(RISK_POLICY_PATH, 'utf8'))
	} catch (error) {
		throw new Error(`cannot load the risk policy: ${messageOf(error)}`)
	}
	riskPolicyCache = validateRiskPolicy(raw)
	return riskPolicyCache
}

/**
 * Reject a policy that cannot be evaluated unambiguously.
 * @returns the policy with its rules ordered by descending priority.
 */
function validateRiskPolicy(raw) {
	if (raw === null || typeof raw !== 'object') throw new Error('risk policy must be an object')
	const policyVersion = raw.policyVersion
	if (!Number.isInteger(policyVersion) || policyVersion < 1) throw new Error('risk policy needs an integer policyVersion')
	if (!Array.isArray(raw.rules) || raw.rules.length === 0) throw new Error('risk policy needs at least one rule')
	const seen = new Set()
	const rules = []
	for (const rule of raw.rules) {
		if (rule === null || typeof rule !== 'object') throw new Error('risk rule must be an object')
		const id = rule.id
		if (typeof id !== 'string' || id === '') throw new Error('risk rule needs a string id')
		if (seen.has(id) === true) throw new Error(`duplicate risk rule id "${id}"`)
		seen.add(id)
		if (RISK_TIER_ORDER[rule.tier] === undefined) throw new Error(`risk rule "${id}" has an unknown tier`)
		if (typeof rule.reason !== 'string' || rule.reason === '') throw new Error(`risk rule "${id}" needs a reason key`)
		if (!Number.isInteger(rule.priority)) throw new Error(`risk rule "${id}" needs an integer priority`)
		rules.push({ id, tier: rule.tier, reason: rule.reason, priority: rule.priority, when: rule.when })
	}
	rules.sort((left, right) => right.priority - left.priority)
	const fallback = raw.fallback !== null && typeof raw.fallback === 'object' ? raw.fallback : {}
	const fallbackTier = RISK_TIER_ORDER[fallback.tier] === undefined ? 'medium' : fallback.tier
	const unknownTier = RISK_TIER_ORDER[raw.guards?.unknownFactTier] === undefined ? 'medium' : raw.guards.unknownFactTier
	return {
		policyVersion,
		rules,
		fallback: { tier: fallbackTier, reason: typeof fallback.reason === 'string' ? fallback.reason : 'risk.reason.other' },
		unknownFactTier: unknownTier,
	}
}

/** Evaluate one predicate against a fact record. `unknown` is a first-class outcome. */
function riskPredicate(predicate, facts) {
	if (predicate === null || typeof predicate !== 'object') return 'unknown'
	if (Array.isArray(predicate.and)) {
		let sawUnknown = false
		for (const child of predicate.and) {
			const outcome = riskPredicate(child, facts)
			if (outcome === false) return false
			if (outcome === 'unknown') sawUnknown = true
		}
		return sawUnknown === true ? 'unknown' : true
	}
	const fact = predicate.fact
	if (typeof fact !== 'string') return 'unknown'
	const value = facts[fact]
	if (value === undefined || value === null) return 'unknown'
	switch (predicate.op) {
		case 'isTrue':
			return value === true
		case 'isFalse':
			return value === false
		case 'eq':
			return value === predicate.value
		case 'gte':
			return typeof value === 'number' && value >= predicate.value
		case 'lt':
			return typeof value === 'number' && value < predicate.value
		default:
			return 'unknown'
	}
}

/**
 * Evaluate the deletion risk of one session.
 *
 * Resolution order is deliberate: rules are ranked by priority, the highest-priority match decides
 * the tier, and same-tier matches are reported together as reasons (an operator wants to see
 * "pinned · running · 2 derived sessions" at once, not one at a time).
 * Unknown facts can never produce the lowest tier.
 * @returns `{tier, reasons, ruleIds, degraded}`.
 */
function evaluateRisk(facts, policy) {
	const matched = []
	const unknown = []
	for (const rule of policy.rules) {
		const outcome = riskPredicate(rule.when, facts)
		if (outcome === 'unknown') unknown.push(rule)
		if (outcome === true) matched.push(rule)
	}
	if (matched.length === 0) {
		return {
			tier: unknown.length > 0 ? policy.unknownFactTier : policy.fallback.tier,
			reasons: [{ key: policy.fallback.reason }],
			ruleIds: [],
			degraded: unknown.length > 0,
		}
	}
	const winner = matched[0]
	const decided = matched.filter((rule) => rule.tier === winner.tier)
	// Safety, precisely: a missing fact can only hurt when it belongs to a rule that outranks the
	// rule which decided the verdict — that rule might have matched and raised the tier. A rule
	// below the winner could only have agreed or lowered it.
	const riskyUnknown = winner.tier === 'low' && unknown.some((rule) => rule.priority >= winner.priority)
	const tier = riskyUnknown === true ? policy.unknownFactTier : winner.tier
	const reasons = decided.map((rule) => (rule.reason === 'risk.reason.children'
		? { key: rule.reason, count: Number(facts.childCount) || 0 }
		: rule.reason === 'risk.reason.large'
			? { key: rule.reason, bytes: Number(facts.logBytes) || 0 }
			: { key: rule.reason }))
	return {
		tier,
		reasons,
		ruleIds: decided.map((rule) => rule.id),
		degraded: tier !== winner.tier,
	}
}

/**
 * Assemble the authoritative facts for every visible session.
 * @returns `{items, counts, pinned, archived}` — one record per session plus the corpus size.
 */
async function collectRiskFacts(ctx, signal) {
	const controller = serviceOf(ctx, 'sessionController')
	const registry = serviceOf(ctx, 'workspaceRegistry')
	const persistence = serviceOf(ctx, 'sessionPersistence')
	const listing = controller !== undefined && typeof controller.list === 'function'
		? await controller.list({}, signal)
		: { items: [] }
	const sessions = Array.isArray(listing?.items) ? listing.items : []
	const pinList = registry?.pinnedSessionIds
	const pinned = new Set(Array.isArray(pinList) ? pinList.map(String) : [])
	const archived = archivedIdsOf(registry) ?? new Set()
	const childCounts = new Map()
	for (const item of sessions) {
		const parent = item?.parentSessionId
		if (typeof parent === 'string') childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1)
	}
	const now = Date.now()
	const items = []
	for (const item of sessions) {
		if (item === null || typeof item !== 'object') continue
		const sessionId = String(item.sessionId ?? '')
		if (sessionId === '') continue
		let logBytes = null
		if (persistence !== undefined && typeof persistence.stat === 'function') {
			try {
				const snapshot = await persistence.stat(sessionId)
				const size = Number(snapshot?.sizeBytes)
				if (Number.isFinite(size) && size >= 0) logBytes = size
			} catch {
				logBytes = null
			}
		}
		const updatedAt = Number.isFinite(item.updatedAt) ? item.updatedAt : null
		items.push({
			sessionId,
			title: projectionString(item.projections?.values?.title),
			facts: {
				pinned: pinned.has(sessionId),
				archived: archived.has(sessionId),
				running: item.running === true,
				blank: item.blank === true,
				origin: item.origin === 'subagent' ? 'subagent' : 'user',
				childCount: childCounts.get(sessionId) ?? 0,
				ageMs: updatedAt === null ? null : Math.max(0, now - updatedAt),
				logBytes,
			},
		})
	}
	return { items, counts: { sessions: sessions.length, pinned: pinned.size, archived: archived.size } }
}

/** The policy version for audit records; an unreadable policy must not fail a deletion. */
async function riskPolicyVersion() {
	try {
		return (await loadRiskPolicy()).policyVersion
	} catch {
		return null
	}
}

/** One risk map for the wire: verdicts only, never raw facts. */
async function riskOverview(ctx, signal) {
	const policy = await loadRiskPolicy()
	const { items, counts } = await collectRiskFacts(ctx, signal)
	const out = {}
	for (const item of items) out[item.sessionId] = evaluateRisk(item.facts, policy)
	return { policyVersion: policy.policyVersion, items: out, counts }
}

/**
 * Histogram of one corpus under one policy — the calibration instrument.
 * @param candidate an optional policy document from the request body (defaults to the shipped one).
 * @returns `{policyVersion, total, tiers, rules, degraded, sample}`.
 */
async function riskStats(ctx, candidate, signal) {
	const policy = candidate === undefined ? await loadRiskPolicy() : validateRiskPolicy(candidate)
	const { items } = await collectRiskFacts(ctx, signal)
	const tiers = { low: 0, medium: 0, high: 0 }
	const rules = {}
	let degraded = 0
	const sample = { low: [], medium: [], high: [] }
	for (const item of items) {
		const verdict = evaluateRisk(item.facts, policy)
		tiers[verdict.tier] = (tiers[verdict.tier] ?? 0) + 1
		if (verdict.degraded === true) degraded += 1
		for (const id of verdict.ruleIds) rules[id] = (rules[id] ?? 0) + 1
		if (sample[verdict.tier].length < 5) sample[verdict.tier].push({ sessionId: item.sessionId, title: item.title, reasons: verdict.reasons.map((reason) => reason.key) })
	}
	return { policyVersion: policy.policyVersion, total: items.length, tiers, rules, degraded, sample }
}

/* ------------------------------------------------------------------------------------------------
 * Wire helpers
 * ---------------------------------------------------------------------------------------------- */

/** JSON response; `no-store` because every answer is a live fact about the host. */
function sendJson(res, status, payload) {
	if (res.writableEnded === true) return
	res.statusCode = status
	res.setHeader('content-type', 'application/json; charset=utf-8')
	res.setHeader('cache-control', 'no-store')
	res.end(JSON.stringify(payload))
}

/** The documented failure envelope. */
function sendFailure(res, status, reason) {
	sendJson(res, status, { ok: false, reason })
}

/** Short, safe text for a failure reason. */
function messageOf(error) {
	const text = error instanceof Error ? error.message : String(error)
	return text.length > 400 ? `${text.slice(0, 397)}...` : text
}

/** Log without ever letting a logging failure escape the handler. */
function warn(logger, message) {
	try {
		logger?.warn?.(message)
	} catch {
		/* logging is best-effort */
	}
}

/** Collect a bounded UTF-8 body; `null` past the ceiling (the stream is drained first). */
async function readBoundedBody(req) {
	const chunks = []
	let size = 0
	for await (const chunk of req) {
		const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
		size += bytes
		if (size > MAX_BODY_BYTES) {
			req.resume?.()
			return null
		}
		chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
	}
	return Buffer.concat(chunks).toString('utf8')
}

/* ------------------------------------------------------------------------------------------------
 * Options (read defensively from the bundle row config; no schema export)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Read the plugin options from a row config: unknown keys are ignored and anything that is not a
 * usable value falls back to the default.
 * @param config the Loader row's `config` (may be undefined, a plain object, or a proxy).
 * @returns `{auditLog: boolean, maxConcurrency: number, trashRetentionDays: number}`.
 */
function readOptions(config) {
	const options = {
		auditLog: true,
		maxConcurrency: DEFAULT_MAX_CONCURRENCY,
		trashRetentionDays: DEFAULT_TRASH_RETENTION_DAYS,
	}
	if (config === null || typeof config !== 'object') return options
	try {
		const auditLog = config.auditLog
		if (typeof auditLog === 'boolean') options.auditLog = auditLog
	} catch {
		/* an unreadable field keeps the default */
	}
	try {
		const raw = config.maxConcurrency
		if (typeof raw === 'number' && Number.isInteger(raw)) {
			options.maxConcurrency = Math.min(MAX_MAX_CONCURRENCY, Math.max(MIN_MAX_CONCURRENCY, raw))
		}
	} catch {
		/* an unreadable field keeps the default */
	}
	try {
		const raw = config.trashRetentionDays
		if (typeof raw === 'number' && Number.isFinite(raw)) {
			const days = Math.trunc(raw)
			options.trashRetentionDays = days <= 0 ? 0 : Math.min(MAX_TRASH_RETENTION_DAYS, days)
		}
	} catch {
		/* an unreadable field keeps the default */
	}
	return options
}

/** `<DSH_HOME>` for durable side stores: a non-empty `$DSH_HOME`, else `~/.dsh`. */
function dshHome() {
	const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
	if (configured !== '') return configured
	try {
		return join(homedir(), '.dsh')
	} catch {
		return '.dsh'
	}
}

/* ------------------------------------------------------------------------------------------------
 * Service access (all optional, all read at call time so late mounts still work)
 * ---------------------------------------------------------------------------------------------- */

function serviceOf(ctx, key) {
	try {
		return ctx.get(key)
	} catch {
		return undefined
	}
}

/** `Set` of archived session ids, or `undefined` when the registry cannot answer. */
function archivedIdsOf(registry) {
	if (registry === undefined) return undefined
	try {
		const ids = registry.archivedSessionIds
		return Array.isArray(ids) === true ? new Set(ids.map(String)) : undefined
	} catch {
		return undefined
	}
}

/** Plain-JSON value out of a projection hint, when it is a non-empty string. */
function projectionString(value) {
	return typeof value === 'string' && value.length > 0 ? value : null
}

/* ------------------------------------------------------------------------------------------------
 * Path resolution
 *
 * `sessionPersistence.stat()` reports the durable artifact, which for the shipped JSONL backend is
 * the log *file* inside the directory that backend documents as owned by that one session
 * (`sessionDir(root, cwd, id)` + `generationLogFilename(...)`). Removing the whole owned directory
 * is what leaves no residue, but only after checking that the directory really is that session's.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The JSONL backend's path-segment encoding, mirrored only as an *extra* guard: when the directory
 * name matches neither the raw id nor this encoded form, the conservative fallback (unlink the
 * reported file alone) applies. Any drift between the two can therefore only narrow the deletion.
 */
function encodeSegment(raw) {
	if (raw === '.') return '~002E'
	if (raw === '..') return '~002E~002E'
	let out = ''
	for (let i = 0; i < raw.length; i += 1) {
		const ch = raw[i]
		out += /^[A-Za-z0-9._-]$/.test(ch) && ch !== '~'
			? ch
			: `~${raw.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`
	}
	return out
}

/** A delete-path refusal that carries the machine-readable code the wire reports. */
class SessionActionError extends Error {
	/**
	 * @param code one of the DESIGN.md failure codes.
	 * @param reason human-readable English text (kept for v1 callers).
	 */
	constructor(code, reason) {
		super(reason)
		this.name = 'SessionActionError'
		this.code = FAILURE_CODES.has(code) ? code : 'unknown'
	}
}

/** The wire code for an error, defaulting to `unknown`. */
function codeOf(error) {
	const code = error instanceof SessionActionError ? error.code : undefined
	return code !== undefined && FAILURE_CODES.has(code) ? code : 'unknown'
}

/**
 * Decide exactly which filesystem entry to remove for one reported location.
 * @param id session id whose log was reported.
 * @param locationPath `stat(id).location.path` exactly as the backend reported it.
 * @returns `{path, recursive, scope}` — never a path we did not read from the backend.
 * @throws {SessionActionError} `no-location` / `io` when the path cannot be trusted.
 */
async function resolveDeletionTarget(id, locationPath) {
	if (typeof locationPath !== 'string' || locationPath.length === 0) {
		throw new SessionActionError('no-location', 'session persistence reported no on-disk location')
	}
	if (isAbsolute(locationPath) !== true) {
		throw new SessionActionError('no-location', `refusing a relative location: ${locationPath}`)
	}
	let info
	try {
		info = await statPath(locationPath)
	} catch (error) {
		throw new SessionActionError('io', `cannot stat the reported location ${locationPath}: ${messageOf(error)}`)
	}
	if (info.isDirectory() === true) {
		return { path: locationPath, recursive: true, scope: 'reported location is the session directory' }
	}
	const dir = dirname(locationPath)
	if (dir === locationPath || basename(dir) === '') {
		return { path: locationPath, recursive: false, scope: 'reported location has no separate directory' }
	}
	let dirInfo
	try {
		dirInfo = await lstat(dir)
	} catch {
		return { path: locationPath, recursive: false, scope: 'the containing directory is unreadable' }
	}
	// `lstat`: a symlinked directory is left in place; only the reported artifact inside it goes.
	if (dirInfo.isDirectory() !== true || dirInfo.isSymbolicLink() === true) {
		return { path: locationPath, recursive: false, scope: 'the containing entry is not a plain directory' }
	}
	const dirName = basename(dir)
	if (dirName === id || dirName === encodeSegment(id)) {
		return { path: dir, recursive: true, scope: 'the containing directory is owned by this session' }
	}
	return {
		path: locationPath,
		recursive: false,
		scope: `the containing directory "${dirName}" is not named after this session`,
	}
}

/* ------------------------------------------------------------------------------------------------
 * Sizes
 * ---------------------------------------------------------------------------------------------- */

/**
 * Sum the physical size of exactly what is about to be removed, counting a hard-linked inode once.
 * @param path the resolved deletion target.
 * @param recursive whether the target is a directory removed wholesale.
 * @returns bytes; `0` when nothing could be measured (degraded, never fatal).
 */
async function measureTarget(path, recursive) {
	const seenInodes = new Set()
	let total = 0
	let budget = WALK_MAX_ENTRIES
	const visit = async (entryPath, info, depth) => {
		if (budget <= 0) return
		budget -= 1
		if (info.isSymbolicLink() === true) return
		if (info.isFile() === true) {
			const key = `${info.dev}:${info.ino}`
			if (seenInodes.has(key) === true) return
			seenInodes.add(key)
			total += Number(info.size) || 0
			return
		}
		if (info.isDirectory() !== true || recursive !== true || depth >= WALK_MAX_DEPTH) return
		let children
		try {
			children = await readdir(entryPath, { withFileTypes: true })
		} catch {
			return
		}
		for (const child of children) {
			let childInfo
			try {
				childInfo = await lstat(join(entryPath, child.name))
			} catch {
				continue
			}
			await visit(join(entryPath, child.name), childInfo, depth + 1)
		}
	}
	let rootInfo
	try {
		rootInfo = await lstat(path)
	} catch {
		return 0
	}
	await visit(path, rootInfo, 0)
	return total
}

/**
 * Session id → durable artifact size, from one persistence snapshot listing.
 * @returns `Map<sessionId, bytes>` (empty when persistence cannot list).
 */
async function sizeMap(persistence, signal) {
	const sizes = new Map()
	if (persistence === undefined || typeof persistence.list !== 'function') return sizes
	let snapshots
	try {
		snapshots = await persistence.list({ signal })
	} catch {
		return sizes
	}
	if (Array.isArray(snapshots) !== true) return sizes
	for (const snapshot of snapshots) {
		const id = snapshot?.header?.id
		if (typeof id !== 'string' || id.length === 0) continue
		const reported = Number(snapshot.sizeBytes)
		if (Number.isFinite(reported) && reported >= 0) {
			sizes.set(id, reported)
			continue
		}
		const locationPath = snapshot.location?.path
		sizes.set(id, typeof locationPath === 'string' && locationPath.length > 0
			? await measureTarget(locationPath, false)
			: 0)
	}
	return sizes
}

/** One session's durable size from its own snapshot (never guessed from the id). */
async function sizeOfSession(persistence, id) {
	if (persistence === undefined || typeof persistence.stat !== 'function') return 0
	try {
		const snapshot = await persistence.stat(id)
		const reported = Number(snapshot?.sizeBytes)
		if (Number.isFinite(reported) && reported >= 0) return reported
		const locationPath = snapshot?.location?.path
		if (typeof locationPath === 'string' && locationPath.length > 0) return await measureTarget(locationPath, false)
	} catch {
		/* degraded: report 0 rather than failing a list/sizes request */
	}
	return 0
}

/* ------------------------------------------------------------------------------------------------
 * Activity stop
 * ---------------------------------------------------------------------------------------------- */

/**
 * Archive the session so its work is stopped before its files move.
 * @returns `{ok: true}` when activity was handled, `{ok: false, reason}` when the archive failed
 *   for a reason other than "nothing there to archive".
 */
async function archiveBeforeDelete(registry, id) {
	if (registry === undefined || typeof registry.archiveSession !== 'function') {
		return { ok: true, reason: 'no workspace registry; deletion proceeds on the persistence snapshot' }
	}
	try {
		// Already-archived ids resolve immediately (the registry documents that as a no-op), and
		// `stopActivity` makes the archive write without an activity refusal, then asks every
		// `workspace/session-stop` provider to end the session's work.
		await registry.archiveSession(id, { stopActivity: true })
		return { ok: true }
	} catch (error) {
		if (error instanceof Error && IGNORABLE_ARCHIVE_ERRORS.has(error.name)) return { ok: true }
		return { ok: false, reason: messageOf(error) }
	}
}

/**
 * Ask the session controller whether the session still runs, polling briefly because archive stops
 * work asynchronously ("after every stop request was issued").
 * @returns `'idle'`, `'running'`, or `'unknown'` when no controller can answer.
 */
async function activityVerdict(controller, id) {
	if (controller === undefined || typeof controller.state !== 'function') return 'unknown'
	for (let attempt = 0; attempt < RUNNING_POLL_ATTEMPTS; attempt += 1) {
		let state
		try {
			state = await controller.state({ sessionId: id })
		} catch {
			return 'unknown'
		}
		if (state === undefined || state === null) return 'unknown'
		if (state.running !== true) return 'idle'
		if (attempt < RUNNING_POLL_ATTEMPTS - 1) await sleep(RUNNING_POLL_INTERVAL_MS)
	}
	return 'running'
}

/* ------------------------------------------------------------------------------------------------
 * Audit trail
 * ---------------------------------------------------------------------------------------------- */

/** Report an audit failure once per process, so a broken logs directory cannot spam a batch. */
let auditFailureReported = false

/**
 * Append one audit record. Never throws: an audit problem must not fail the request.
 * @param options resolved plugin options.
 * @param logger the context logger (optional).
 * @param entry the record to append.
 */
async function appendAudit(options, logger, entry) {
	if (options.auditLog !== true) return
	const dir = join(dshHome(), 'logs')
	const file = join(dir, AUDIT_FILE)
	try {
		await mkdir(dir, { recursive: true })
		await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8')
	} catch (error) {
		if (auditFailureReported !== true) {
			auditFailureReported = true
			warn(logger, `session-manager: cannot append the audit log ${file}: ${messageOf(error)}`)
		}
	}
}

/** Best-effort `sessionId → title` map for audit records (one controller listing, never fatal). */
async function titleMap(controller, signal) {
	const titles = new Map()
	if (controller === undefined || typeof controller.list !== 'function') return titles
	try {
		const value = await controller.list({}, signal)
		const items = Array.isArray(value?.items) ? value.items : []
		for (const item of items) {
			const id = item?.sessionId
			if (typeof id === 'string') titles.set(id, projectionString(item?.projections?.values?.title))
		}
	} catch {
		/* titles are a convenience; the audit line still records ids and sizes */
	}
	return titles
}

/* ------------------------------------------------------------------------------------------------
 * Bounded concurrency
 * ---------------------------------------------------------------------------------------------- */

/**
 * Run `worker` over `items` with at most `limit` in flight, returning results in input order so the
 * wire payload stays deterministic.
 * @returns results in the same order as `items`.
 */
async function mapPool(items, limit, worker) {
	const results = new Array(items.length)
	let cursor = 0
	const runnerCount = Math.max(1, Math.min(limit, items.length))
	const runners = []
	for (let slot = 0; slot < runnerCount; slot += 1) {
		runners.push((async () => {
			for (;;) {
				const index = cursor
				cursor += 1
				if (index >= items.length) return
				results[index] = await worker(items[index], index)
			}
		})())
	}
	await Promise.all(runners)
	return results
}

/* ------------------------------------------------------------------------------------------------
 * Delete
 * ---------------------------------------------------------------------------------------------- */

/**
 * Resolve one session's removable target, stopping its activity first.
 * Shared by the destructive path and the recycle-bin path so both obey the identical guards:
 * a path is only ever the one `sessionPersistence.stat()` reported, and a running session is
 * never moved or removed.
 * @returns `{target, bytes}` — the filesystem entry plus its measured physical size.
 */
async function prepareRemoval(ctx, id) {
	if (typeof id !== 'string' || id.trim().length === 0) {
		throw new SessionActionError('invalid-id', 'session id must be a non-empty string')
	}
	const persistence = serviceOf(ctx, 'sessionPersistence')
	if (persistence === undefined || typeof persistence.stat !== 'function') {
		throw new SessionActionError('no-location', 'session persistence is unavailable; refusing to guess the session path')
	}
	const registry = serviceOf(ctx, 'workspaceRegistry')
	const controller = serviceOf(ctx, 'sessionController')

	const archived = await archiveBeforeDelete(registry, id)
	const verdict = await activityVerdict(controller, id)
	if (verdict === 'running') {
		throw new SessionActionError('running', 'session is still running; its log was left in place')
	}
	if (verdict === 'unknown' && archived.ok !== true) {
		throw new SessionActionError('archive-failed', `could not confirm the session stopped (${archived.reason})`)
	}

	let snapshot
	try {
		snapshot = await persistence.stat(id)
	} catch (error) {
		throw new SessionActionError('io', `cannot read the persistence snapshot: ${messageOf(error)}`)
	}
	if (snapshot === undefined) throw new SessionActionError('not-found', 'session not found in session persistence')

	const target = await resolveDeletionTarget(id, snapshot.location?.path)
	const bytes = await measureTarget(target.path, target.recursive)
	return { target, bytes }
}

/**
 * Drop the durable archive marker once a session leaves its live location, so no archive entry
 * outlives its session. Best effort: a registry problem never fails the operation.
 */
async function detachArchiveMarker(ctx, id) {
	const registry = serviceOf(ctx, 'workspaceRegistry')
	if (registry === undefined || typeof registry.unarchiveSession !== 'function') return
	const archivedSet = archivedIdsOf(registry)
	if (archivedSet === undefined || archivedSet.has(id) !== true) return
	try {
		await registry.unarchiveSession(id)
	} catch (error) {
		warn(ctx.logger, `session-manager: could not unarchive ${id}: ${messageOf(error)}`)
	}
}

/**
 * Permanently remove one session log (the `permanent: true` path). Every refusal is a
 * `SessionActionError` carrying the wire code; nothing outside the path `stat()` reported is
 * ever touched.
 * @returns `{bytes}` — the physical size that was reclaimed.
 */
async function deleteOneSession(ctx, id, childIndex, force) {
	const { target, bytes } = await prepareRemoval(ctx, id)
	const blocked = lineageGuardError(id, childIndex ?? new Map(), force, 'delete it permanently')
	if (blocked !== undefined) throw blocked
	try {
		await rm(target.path, { recursive: target.recursive, force: true })
	} catch (error) {
		throw new SessionActionError('io', `cannot remove ${target.path}: ${messageOf(error)}`)
	}
	await detachArchiveMarker(ctx, id)
	return { bytes }
}

/**
 * Confirm a trash entry is restorable: the directory is there, it holds at least one session log,
 * and the recorded original path is gone (so a restore cannot collide with itself).
 * @returns `{ok: true}` or `{ok: false, reason}`.
 */
async function verifyTrashEntry(home, id) {
	const found = await readTrashEntry(home, id)
	if (found === undefined) return { ok: false, reason: 'the entry or its metadata is unreadable' }
	let files
	try {
		files = await readdir(found.dir, { withFileTypes: true })
	} catch (error) {
		return { ok: false, reason: `the entry directory is unreadable: ${messageOf(error)}` }
	}
	const logs = files.filter((file) => file.isFile() === true && SESSION_LOG_NAME.test(file.name) === true)
	if (logs.length === 0) return { ok: false, reason: 'the entry holds no session log' }
	const original = found.meta.originalPath
	if (typeof original === 'string') {
		let taken = false
		try {
			await lstat(original)
			taken = true
		} catch {
			taken = false
		}
		if (taken === true) return { ok: false, reason: 'the original path is still occupied' }
	}
	return { ok: true }
}

/* ------------------------------------------------------------------------------------------------
 * Recycle bin (v3)
 *
 * A deletion is a MOVE into `<DSH_HOME>/trash/sessions/<sessionId>/`, with a
 * `.dsh-trash.json` sidecar recording where the session came from and when it expires. The
 * sidecar lives inside the entry, so removing the entry removes its metadata: there is no
 * second index that can drift. Until an entry is purged its logs still count as attachment
 * references, so a restore never returns a session whose images were collected.
 * ---------------------------------------------------------------------------------------------- */

/** `<DSH_HOME>/trash/sessions`. */
function trashRoot(home) {
	return join(home, ...TRASH_RELATIVE)
}

/** The directory one trashed session occupies. */
function trashEntryDir(home, id) {
	return join(trashRoot(home), id)
}

/**
 * Move a directory (or file) inside one filesystem, degrading to copy+remove across devices.
 * @param from existing path.
 * @param to destination path; must not exist.
 */
async function movePath(from, to) {
	try {
		await rename(from, to)
		return
	} catch (error) {
		if (error?.code !== 'EXDEV') throw error
	}
	await cp(from, to, { recursive: true, preserveTimestamps: true, errorOnExist: true })
	await rm(from, { recursive: true, force: true })
}

/** Read one entry's sidecar. `undefined` when the directory is not a valid trash entry. */
async function readTrashEntry(home, id) {
	const dir = trashEntryDir(home, id)
	let raw
	try {
		raw = await readFile(join(dir, TRASH_SIDECAR), 'utf8')
	} catch {
		return undefined
	}
	let meta
	try {
		meta = JSON.parse(raw)
	} catch {
		return undefined
	}
	if (meta === null || typeof meta !== 'object') return undefined
	if (meta.sessionId !== id) return undefined
	return { dir, meta }
}

/** Whole days until `expiresAt`, rounded up; `null` for entries kept forever. */
function expiresInDays(expiresAt, now) {
	if (typeof expiresAt !== 'number' || Number.isFinite(expiresAt) !== true) return null
	return Math.max(0, Math.ceil((expiresAt - now) / DAY_MS))
}

/**
 * List trash entries, newest first.
 * @returns `{items, totalBytes}` with the documented per-item fields.
 */
async function listTrash(home, signal, childIndex) {
	const root = trashRoot(home)
	let entries = []
	try {
		entries = await readdir(root, { withFileTypes: true })
	} catch {
		return { items: [], totalBytes: 0 }
	}
	const now = Date.now()
	const items = []
	for (const entry of entries) {
		if (entry.isDirectory() !== true) continue
		signal?.throwIfAborted()
		const found = await readTrashEntry(home, entry.name)
		if (found === undefined) continue
		const meta = found.meta
		const bytes = typeof meta.bytes === 'number' && Number.isFinite(meta.bytes) ? meta.bytes : await measureTarget(found.dir, true)
		items.push({
			sessionId: entry.name,
			title: typeof meta.title === 'string' && meta.title !== '' ? meta.title : null,
			bytes,
			trashedAt: typeof meta.trashedAt === 'number' ? meta.trashedAt : 0,
			expiresAt: typeof meta.expiresAt === 'number' ? meta.expiresAt : null,
			expiresInDays: expiresInDays(meta.expiresAt, now),
			originalPath: typeof meta.originalPath === 'string' ? meta.originalPath : null,
			descendantCount: childIndex instanceof Map ? (childIndex.get(entry.name) ?? []).length : 0,
		})
	}
	items.sort((left, right) => right.trashedAt - left.trashedAt)
	let totalBytes = 0
	for (const item of items) totalBytes += item.bytes
	return { items, totalBytes }
}

/**
 * Move one session into the recycle bin.
 * @param ctx plugin context (services are looked up defensively).
 * @param options resolved plugin options (retention).
 * @param id session to trash.
 * @param titles best-effort `id → title` map for the sidecar and the audit trail.
 * @returns `{bytes}` — the size that moved (not freed).
 */
async function trashOneSession(ctx, options, id, titles) {
	const home = dshHome()
	const { target, bytes } = await prepareRemoval(ctx, id)
	const root = trashRoot(home)
	const dir = trashEntryDir(home, id)
	try {
		await mkdir(root, { recursive: true })
	} catch (error) {
		throw new SessionActionError('trash-move-failed', `cannot create ${root}: ${messageOf(error)}`)
	}
	let existing = false
	try {
		await lstat(dir)
		existing = true
	} catch {
		existing = false
	}
	if (existing === true) {
		throw new SessionActionError('trash-entry-exists', `the recycle bin already holds an entry for ${id}`)
	}

	const now = Date.now()
	const retention = options.trashRetentionDays
	const meta = {
		schema: 1,
		sessionId: id,
		originalPath: target.path,
		trashedAt: now,
		expiresAt: retention === 0 ? null : now + retention * DAY_MS,
		title: titles?.get(id) ?? null,
		bytes,
	}
	const tmpSidecar = join(root, `.${id}.sidecar.tmp`)
	try {
		await writeFile(tmpSidecar, JSON.stringify(meta), 'utf8')
	} catch (error) {
		throw new SessionActionError('trash-move-failed', `cannot write the recycle-bin sidecar: ${messageOf(error)}`)
	}
	try {
		await movePath(target.path, dir)
	} catch (error) {
		await rm(tmpSidecar, { force: true })
		throw new SessionActionError('trash-move-failed', `cannot move ${target.path} into the recycle bin: ${messageOf(error)}`)
	}
	try {
		await rename(tmpSidecar, join(dir, TRASH_SIDECAR))
	} catch (error) {
		// Roll the move back: an entry without metadata could not be restored.
		try {
			await movePath(dir, target.path)
		} catch (rollbackError) {
			warn(ctx.logger, `session-manager: could not roll back the trash move of ${id}: ${messageOf(rollbackError)}`)
		}
		await rm(tmpSidecar, { force: true })
		throw new SessionActionError('trash-move-failed', `cannot record the recycle-bin metadata: ${messageOf(error)}`)
	}
	// Verify the move before declaring success: an entry without a readable log could not be
	// restored later, so it must not be left in the bin. Roll back and report instead.
	const verified = await verifyTrashEntry(home, id)
	if (verified.ok !== true) {
		try {
			await movePath(dir, target.path)
			await rm(join(target.path, TRASH_SIDECAR), { force: true })
		} catch (rollbackError) {
			warn(ctx.logger, `session-manager: could not roll back the trash move of ${id}: ${messageOf(rollbackError)}`)
		}
		throw new SessionActionError('trash-verify-failed', `the move of ${id} did not verify (${verified.reason}); the session was put back`)
	}
	await detachArchiveMarker(ctx, id)
	return { bytes }
}

/**
 * Restore one trashed session to the recorded original location.
 * @returns `{bytes}` — the size that came back.
 */
async function restoreOneSession(home, id) {
	const found = await readTrashEntry(home, id)
	if (found === undefined) throw new SessionActionError('not-in-trash', `no recycle-bin entry for ${id}`)
	const original = found.meta.originalPath
	if (typeof original !== 'string' || isAbsolute(original) !== true) {
		throw new SessionActionError('not-in-trash', `the recycle-bin entry for ${id} records no absolute original path`)
	}
	let taken = false
	try {
		await lstat(original)
		taken = true
	} catch {
		taken = false
	}
	if (taken === true) {
		throw new SessionActionError('restore-target-exists', `${original} already exists`)
	}
	try {
		await mkdir(dirname(original), { recursive: true })
		await movePath(found.dir, original)
	} catch (error) {
		throw new SessionActionError('io', `cannot restore ${id} to ${original}: ${messageOf(error)}`)
	}
	await rm(join(original, TRASH_SIDECAR), { force: true })
	// Confirm the session is really back: the directory exists and holds a log again.
	let restoredFiles = []
	try {
		restoredFiles = await readdir(original, { withFileTypes: true })
	} catch (error) {
		throw new SessionActionError('restore-verify-failed', `${id} was moved back but ${original} could not be read: ${messageOf(error)}`)
	}
	if (restoredFiles.some((file) => file.isFile() === true && SESSION_LOG_NAME.test(file.name) === true) !== true) {
		throw new SessionActionError('restore-verify-failed', `${id} was moved back but ${original} holds no session log`)
	}
	return { bytes: typeof found.meta.bytes === 'number' ? found.meta.bytes : 0 }
}

/**
 * Permanently remove one trash entry.
 * @returns `{bytes}` — the size that was freed.
 */
async function purgeOneEntry(home, id) {
	const found = await readTrashEntry(home, id)
	if (found === undefined) throw new SessionActionError('not-in-trash', `no recycle-bin entry for ${id}`)
	const bytes = typeof found.meta.bytes === 'number' && Number.isFinite(found.meta.bytes)
		? found.meta.bytes
		: await measureTarget(found.dir, true)
	try {
		await rm(found.dir, { recursive: true, force: true })
	} catch (error) {
		throw new SessionActionError('purge-failed', `cannot remove ${found.dir}: ${messageOf(error)}`)
	}
	return { bytes }
}

/**
 * Purge every entry whose retention elapsed. Never throws: a broken entry is reported instead.
 * @returns `{purged, freedBytes}`.
 */
async function sweepExpired(home, signal) {
	const { items } = await listTrash(home, signal)
	const now = Date.now()
	const expired = items.filter((item) => typeof item.expiresAt === 'number' && item.expiresAt <= now)
	const purged = []
	let freedBytes = 0
	for (const item of expired) {
		signal?.throwIfAborted()
		try {
			const { bytes } = await purgeOneEntry(home, item.sessionId)
			purged.push(item.sessionId)
			freedBytes += bytes
		} catch {
			/* the next sweep retries */
		}
	}
	return { purged, freedBytes }
}

/**
 * Sidecar metadata for the ids an operation is about to touch, so the audit trail records what
 * was moved or destroyed rather than a bare id.
 * @returns `Map<id, {sessionId, title, bytes}>`.
 */
async function trashMetaOf(home, ids) {
	const map = new Map()
	for (const id of ids) {
		const found = await readTrashEntry(home, id)
		if (found === undefined) continue
		const meta = found.meta
		map.set(id, {
			sessionId: id,
			title: typeof meta.title === 'string' && meta.title !== '' ? meta.title : null,
			bytes: typeof meta.bytes === 'number' && Number.isFinite(meta.bytes) ? meta.bytes : 0,
		})
	}
	return map
}

/** Best-effort expiry sweep used by every trash request and the hourly timer. */
async function sweepQuietly(ctx, logger) {
	try {
		const result = await sweepExpired(dshHome(), undefined)
		if (result.purged.length > 0) {
			warn(logger, `session-manager: expired ${result.purged.length} recycle-bin ${result.purged.length === 1 ? 'entry' : 'entries'} (${result.freedBytes} bytes)`)
		}
		return result
	} catch (error) {
		warn(logger, `session-manager: recycle-bin sweep failed: ${messageOf(error)}`)
		return { purged: [], freedBytes: 0 }
	}
}

/**
 * Count live sessions that derive from `id`.
 * @returns `Map<childSessionId, parentSessionId>` inverted once per batch, then a lookup helper.
 */
async function liveChildIndex(ctx, signal) {
	const controller = serviceOf(ctx, 'sessionController')
	const index = new Map()
	if (controller === undefined || typeof controller.list !== 'function') return index
	try {
		const listing = await controller.list({}, signal)
		for (const item of Array.isArray(listing?.items) ? listing.items : []) {
			const parent = item?.parentSessionId
			if (typeof parent !== 'string') continue
			const bucket = index.get(parent)
			if (bucket === undefined) index.set(parent, [String(item.sessionId)])
			else bucket.push(String(item.sessionId))
		}
	} catch {
		/* an unreadable listing must not block a removal; the caller decides how to treat it */
	}
	return index
}

/**
 * Irreversible removals refuse to orphan a live session unless the caller says `force`.
 * Moving into the recycle bin stays unguarded: it is reversible, and the panel already warns.
 * @returns a `SessionActionError` to throw, or undefined when the removal may proceed.
 */
function lineageGuardError(id, childIndex, force, what) {
	if (force === true) return undefined
	const children = childIndex.get(id) ?? []
	if (children.length === 0) return undefined
	return new SessionActionError('has-descendants', `${id} still has ${children.length} derived session(s); ${what} with force to continue`)
}

/**
 * Restore every id independently under bounded concurrency.
 * @returns `{restored, failed}`.
 */
async function restoreSessions(options, ids) {
	const home = dshHome()
	const meta = await trashMetaOf(home, ids)
	const outcomes = await mapPool(ids, options.maxConcurrency, async (id) => {
		try {
			return { ok: true, id, ...(await restoreOneSession(home, id)) }
		} catch (error) {
			return { ok: false, id, code: codeOf(error), reason: messageOf(error) }
		}
	})
	const restored = []
	const failed = []
	const audited = []
	for (const outcome of outcomes) {
		if (outcome.ok === true) {
			restored.push(outcome.id)
			audited.push(meta.get(outcome.id) ?? { sessionId: outcome.id, title: null, bytes: 0 })
		} else {
			failed.push({ sessionId: outcome.id, code: outcome.code, reason: outcome.reason })
		}
	}
	return { restored, failed, audited }
}

/**
 * Purge trashed entries by id, by expiry, or entirely.
 * @returns `{purged, freedBytes, failed}`.
 */
async function purgeTrash(options, ids, expiredOnly, all, childIndex, force) {
	const home = dshHome()
	let targets = ids
	if (all === true || expiredOnly === true) {
		const { items } = await listTrash(home, undefined)
		const now = Date.now()
		targets = items
			.filter((item) => all === true || (typeof item.expiresAt === 'number' && item.expiresAt <= now))
			.map((item) => item.sessionId)
	}
	const meta = await trashMetaOf(home, targets)
	const outcomes = await mapPool(targets, options.maxConcurrency, async (id) => {
		try {
			const blocked = lineageGuardError(id, childIndex ?? new Map(), force, 'purge it')
			if (blocked !== undefined) throw blocked
			return { ok: true, id, ...(await purgeOneEntry(home, id)) }
		} catch (error) {
			return { ok: false, id, code: codeOf(error), reason: messageOf(error) }
		}
	})
	const purged = []
	const failed = []
	const audited = []
	let freedBytes = 0
	for (const outcome of outcomes) {
		if (outcome.ok === true) {
			purged.push(outcome.id)
			freedBytes += Number(outcome.bytes) || 0
			const known = meta.get(outcome.id)
			audited.push({
				sessionId: outcome.id,
				title: known?.title ?? null,
				bytes: Number(outcome.bytes) || known?.bytes || 0,
			})
		} else {
			failed.push({ sessionId: outcome.id, code: outcome.code, reason: outcome.reason })
		}
	}
	return { purged, freedBytes, failed, audited }
}

/**
 * Handle a delete request: the recycle bin by default, permanent removal on request, under
 * bounded concurrency, then audit the batch.
 * @returns `{trashed, deleted, failed, trashedBytes, freedBytes, auditLog}`.
 */
async function deleteSessions(ctx, options, ids, signal, permanent, force) {
	const trashing = permanent !== true
	// Titles feed the recycle-bin sidecar (the panel shows them) as well as the audit record, so
	// disabling auditing must not degrade the UI into raw session ids.
	const titles = trashing === true || options.auditLog === true
		? await titleMap(serviceOf(ctx, 'sessionController'), signal)
		: new Map()
	const childIndex = trashing === true ? new Map() : await liveChildIndex(ctx, signal)
	const outcomes = await mapPool(ids, options.maxConcurrency, async (id) => {
		try {
			const { bytes } = trashing
				? await trashOneSession(ctx, options, id, titles)
				: await deleteOneSession(ctx, id, childIndex, force)
			return { ok: true, id, bytes }
		} catch (error) {
			return { ok: false, id, code: codeOf(error), reason: messageOf(error) }
		}
	})

	const trashed = []
	const deleted = []
	const failed = []
	const audited = []
	let trashedBytes = 0
	let freedBytes = 0
	for (const outcome of outcomes) {
		if (outcome.ok === true) {
			if (trashing) {
				trashed.push(outcome.id)
				trashedBytes += outcome.bytes
			} else {
				deleted.push(outcome.id)
				freedBytes += outcome.bytes
			}
			audited.push({ sessionId: outcome.id, title: titles.get(outcome.id) ?? null, bytes: outcome.bytes })
		} else {
			failed.push({ sessionId: outcome.id, code: outcome.code, reason: outcome.reason })
		}
	}

	await appendAudit(options, ctx.logger, {
		time: new Date().toISOString(),
		op: trashing ? 'trash' : 'delete',
		riskPolicy: await riskPolicyVersion(),
		sessions: audited,
		freedBytes: trashing ? 0 : freedBytes,
		failed: failed.length,
		actor: 'ui',
	})

	return { trashed, deleted, failed, trashedBytes, freedBytes, auditLog: auditPathOf(options) }
}

/**
 * The audit file the caller can look at, or `null` when auditing is off. The panel shows this
 * path after a destructive action so the record is findable without reading the docs.
 * @param options resolved plugin options.
 * @returns the absolute audit log path, or null.
 */
function auditPathOf(options) {
	if (options.auditLog !== true) return null
	try {
		return join(dshHome(), 'logs', AUDIT_FILE)
	} catch {
		return null
	}
}

/* ------------------------------------------------------------------------------------------------
 * List / sizes
 * ---------------------------------------------------------------------------------------------- */

/** Session rows for the `list` op, each with the durable size of its log. */
async function listSessions(ctx, signal) {
	const controller = serviceOf(ctx, 'sessionController')
	const persistence = serviceOf(ctx, 'sessionPersistence')
	if (controller === undefined || typeof controller.list !== 'function') return []
	const sizes = await sizeMap(persistence, signal)
	const archived = archivedIdsOf(serviceOf(ctx, 'workspaceRegistry')) ?? new Set()
	const value = await controller.list({}, signal)
	const items = Array.isArray(value?.items) ? value.items : []
	const rows = []
	for (const item of items) {
		if (item === null || typeof item !== 'object') continue
		const sessionId = String(item.sessionId ?? '')
		const known = sizes.get(sessionId)
		// Rows the persistence listing already sized cost nothing; the rest get one own snapshot.
		const bytes = known !== undefined && known > 0 ? known : await sizeOfSession(persistence, sessionId)
		rows.push({
			sessionId,
			title: projectionString(item.projections?.values?.title),
			cwd: typeof item.cwd === 'string' ? item.cwd : null,
			updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
			running: item.running === true,
			blank: item.blank === true,
			archived: archived.has(sessionId),
			bytes,
		})
	}
	return rows
}

/** Session id → durable bytes for the `sizes` op. */
async function sessionSizes(ctx, signal) {
	const sizes = await sizeMap(serviceOf(ctx, 'sessionPersistence'), signal)
	const out = {}
	for (const [id, bytes] of sizes) out[id] = bytes
	return { sizes: out, scannedAt: Date.now() }
}

/* ------------------------------------------------------------------------------------------------
 * Attachment GC
 * ----------------------------------------------------------------------------------------------
 * Store layout (verified against `dsh-attachment-local`):
 *   objects/<2>/<sha256>              normalized image attachments
 *   file-objects/<2>/<sha256>         generic file bytes
 *   files/<2>/<sha256>/<displayName>  hard-link alias of the same file object
 *   request-images/<2>/<hash>         derived encode cache keyed by a request hash
 *   tmp/                              staging, ignored
 * ---------------------------------------------------------------------------------------------- */

/** True when `candidate` is strictly inside `root` (containment on the constructed path only). */
function insideRoot(root, candidate) {
	const prefix = root.endsWith(sep) === true ? root : `${root}${sep}`
	return candidate.startsWith(prefix)
}

/** Feed every 64-hex digest in `text` into `into` (a Set, so repeats are free). */
function collectDigests(text, into) {
	const found = text.match(DIGEST_PATTERN)
	if (found !== null) for (const digest of found) into.add(digest)
}

/**
 * Collect only real attachment references (`"attachmentId":"sha256:<hex>"`).
 *
 * `collectDigests` is deliberately over-inclusive — any 64-hex run keeps an object, which is the
 * safe direction for deletion. That is the wrong set for *reporting*, because logs contain plenty
 * of unrelated digests (Docker image IDs, integrity hashes, a digest quoted in tool output). The
 * precise set answers the different question "is every attachment this log names still on disk?".
 */
function collectAttachmentIds(text, into) {
	for (const match of text.matchAll(/"attachmentId"\s*:\s*"sha256:([0-9a-f]{64})"/g)) into.add(match[1])
}

/** Everything one document contributes: the broad keep-set plus the precise reference set. */
function collectReferenceDocument(text, into) {
	collectDigests(text, into.referenced)
	collectAttachmentIds(text, into.attachments)
}

/**
 * Byte length of the zstd frame starting at `start`, header and trailing checksum included.
 *
 * A DSH session log is a concatenation of independent frames (one per append), and `node:zlib`
 * decodes only the first one — both `zstdDecompressSync` and `createZstdDecompress` stop there.
 * Measuring each frame is what makes the rest of the log reachable; a log that cannot be walked
 * must throw so the caller fails closed instead of reporting a short scan as a complete one.
 * @returns the frame length in bytes.
 */
function zstdFrameLength(raw, start) {
	if (start + 4 > raw.length) throw new Error(`zstd frame header is truncated at byte ${start}`)
	if (raw.readUInt32LE(start) !== ZSTD_FRAME_MAGIC) throw new Error(`zstd frame magic is missing at byte ${start}`)
	let offset = start + 4
	if (offset >= raw.length) throw new Error('zstd frame descriptor is truncated')
	const descriptor = raw[offset]
	offset += 1
	const contentSizeFlag = descriptor >> 6
	const singleSegment = (descriptor >> 5) & 0b1
	const hasChecksum = (descriptor >> 2) & 0b1
	const dictionaryFlag = descriptor & 0b11
	// A single-segment frame has no window descriptor.
	if (singleSegment === 0) offset += 1
	const dictionaryBytes = [0, 1, 2, 4][dictionaryFlag]
	const contentSizeBytes = contentSizeFlag === 0
		? (singleSegment === 1 ? 1 : 0)
		: contentSizeFlag === 1 ? 2 : contentSizeFlag === 2 ? 4 : 8
	offset += dictionaryBytes + contentSizeBytes
	for (;;) {
		if (offset + 3 > raw.length) throw new Error('zstd block header is truncated')
		const header = raw[offset] | (raw[offset + 1] << 8) | (raw[offset + 2] << 16)
		offset += 3
		const last = (header & 0b1) === 1
		const type = (header >> 1) & 0b11
		const size = header >>> 3
		if (type === 0b11) throw new Error('zstd block type is reserved')
		// An RLE block stores one byte however far it expands.
		offset += type === 0b01 ? 1 : size
		if (last === true) break
	}
	if (hasChecksum === 1) offset += 4
	if (offset > raw.length) throw new Error('zstd frame is truncated')
	return offset - start
}

/**
 * Decode every frame of one zstd document into a single string.
 * @returns the decoded bytes as latin1 (one character per byte, so no byte is ever replaced).
 */
function decodeZstdDocument(raw) {
	const parts = []
	let offset = 0
	while (offset < raw.length) {
		const length = zstdFrameLength(raw, offset)
		parts.push(zstdDecompressSync(raw.subarray(offset, offset + length)))
		offset += length
	}
	return Buffer.concat(parts).toString('latin1')
}

/**
 * Read one reference document and collect the digests it mentions.
 * Plain and gzip logs stream; a zstd log is decoded whole, because it is a frame concatenation
 * neither `node:zlib` reader walks and a silently short read would hide live references.
 * Chunks are decoded as latin1 so no byte is ever replaced by a decoding placeholder and a hex
 * sequence spanning a chunk boundary survives through the carried overlap.
 * @returns the number of decoded bytes (diagnostics only).
 */
async function scanReferenceFile(path, into) {
	if (path.endsWith('.zstd') === true) {
		const info = await statPath(path)
		if (info.isFile() !== true) throw new Error('reference document is not a regular file')
		if (info.size > ZSTD_SCAN_MAX_BYTES) throw new Error('zstd document exceeds the whole-file scan ceiling')
		const text = decodeZstdDocument(await readFile(path))
		collectReferenceDocument(text, into)
		return text.length
	}
	const decoded = (target) => {
		if (target !== null && typeof target.setEncoding === 'function') target.setEncoding('latin1')
		return target
	}
	const source = decoded(createReadStream(path))
	let stream = source
	if (path.endsWith('.gz') === true) stream = decoded(source.pipe(createGunzip()))
	let tail = ''
	let consumed = 0
	try {
		for await (const chunk of stream) {
			const text = typeof chunk === 'string' ? chunk : chunk.toString('latin1')
			consumed += text.length
			const joined = tail + text
			collectReferenceDocument(joined, into)
			tail = joined.slice(-SCAN_OVERLAP)
		}
	} finally {
		source.destroy()
		if (stream !== source && typeof stream.destroy === 'function') stream.destroy()
	}
	return consumed
}

/**
 * Whole-file fallback for a reference document no stream could read.
 * @returns whether the document was read (the caller fails closed when it was not).
 */
async function scanReferenceFileInBulk(path, into) {
	try {
		const info = await statPath(path)
		const ceiling = path.endsWith('.zstd') === true ? ZSTD_SCAN_MAX_BYTES : SCAN_FALLBACK_MAX_BYTES
		if (info.isFile() !== true || info.size > ceiling) return false
		const raw = await readFile(path)
		const text = path.endsWith('.zstd') === true
			? decodeZstdDocument(raw)
			: raw.toString('latin1')
		collectReferenceDocument(text, into)
		return true
	} catch {
		return false
	}
}

/** One reference document: stream first, in-bulk second, recorded as unreadable when both fail. */
async function scanReferenceDocument(path, referenced, unreadable) {
	try {
		await scanReferenceFile(path, referenced)
		return
	} catch (streamError) {
		const bulk = await scanReferenceFileInBulk(path, referenced)
		if (bulk !== true) unreadable.push({ path, reason: messageOf(streamError) })
	}
}

/**
 * Collect every digest a surviving session still references.
 * @returns `{referenced: Set<string>, sessions: number, documents: number, unreadable: {path, reason}[]}`.
 */
async function scanReferences(home, signal) {
	const into = { referenced: new Set(), attachments: new Set() }
	const unreadable = []
	let sessions = 0
	let documents = 0

	// 1. Surviving session logs, every generation and both formats.
	const sessionsRoot = join(home, 'sessions')
	let projects = []
	try {
		projects = await readdir(sessionsRoot, { withFileTypes: true })
	} catch {
		projects = []
	}
	for (const project of projects) {
		if (project.isDirectory() !== true) continue
		const projectPath = join(sessionsRoot, project.name)
		let sessionDirs = []
		try {
			sessionDirs = await readdir(projectPath, { withFileTypes: true })
		} catch {
			continue
		}
		for (const sessionDir of sessionDirs) {
			if (sessionDir.isDirectory() !== true) continue
			signal?.throwIfAborted()
			const sessionPath = join(projectPath, sessionDir.name)
			let files = []
			try {
				files = await readdir(sessionPath, { withFileTypes: true })
			} catch {
				continue
			}
			const logs = files.filter((file) => file.isFile() === true && SESSION_LOG_NAME.test(file.name) === true)
			if (logs.length === 0) continue
			sessions += 1
			for (const log of logs) {
				documents += 1
				await scanReferenceDocument(join(sessionPath, log.name), into, unreadable)
			}
		}
	}

	// 2. Recycle-bin entries: a trashed session still owns its attachments until it is purged,
	//    otherwise restoring it would return a session whose images were already collected.
	let trashEntries = []
	try {
		trashEntries = await readdir(trashRoot(home), { withFileTypes: true })
	} catch {
		trashEntries = []
	}
	for (const entry of trashEntries) {
		if (entry.isDirectory() !== true) continue
		signal?.throwIfAborted()
		const entryPath = trashEntryDir(home, entry.name)
		let files = []
		try {
			files = await readdir(entryPath, { withFileTypes: true })
		} catch {
			continue
		}
		for (const file of files) {
			if (file.isFile() !== true || SESSION_LOG_NAME.test(file.name) !== true) continue
			documents += 1
			await scanReferenceDocument(join(entryPath, file.name), into, unreadable)
		}
	}

	// 3. Projection checkpoints (`storages/session_projcache/sessions/*.json`).
	const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
	let checkpoints = []
	try {
		checkpoints = await readdir(cacheDir, { withFileTypes: true })
	} catch {
		checkpoints = []
	}
	for (const checkpoint of checkpoints) {
		if (checkpoint.isFile() !== true || checkpoint.name.endsWith('.json') !== true) continue
		signal?.throwIfAborted()
		documents += 1
		await scanReferenceDocument(join(cacheDir, checkpoint.name), into, unreadable)
	}

	return { referenced: into.referenced, attachments: into.attachments, sessions, documents, unreadable }
}

/**
 * Enumerate one durable group.
 * @param groupRoot the group directory (`objects`, `file-objects` or `files`).
 * @param layout `flat` for `<2>/<digest>`, `named` for `<2>/<digest>/<displayName>`.
 * @param root the attachment store root every candidate must stay inside.
 * @returns entries `{path, digest, size, dev, ino}`; unreadable/unknown entries are skipped.
 */
async function enumerateGroup(groupRoot, layout, root) {
	const entries = []
	let groupInfo
	try {
		groupInfo = await lstat(groupRoot)
	} catch {
		return entries
	}
	// A symlinked group directory would let the walk escape the store; skip it entirely.
	if (groupInfo.isDirectory() !== true || groupInfo.isSymbolicLink() === true) return entries
	let shards = []
	try {
		shards = await readdir(groupRoot, { withFileTypes: true })
	} catch {
		return entries
	}
	for (const shard of shards) {
		if (shard.isDirectory() !== true || SHARD_NAME.test(shard.name) !== true) continue
		const shardPath = join(groupRoot, shard.name)
		let members = []
		try {
			members = await readdir(shardPath, { withFileTypes: true })
		} catch {
			continue
		}
		for (const member of members) {
			const memberPath = join(shardPath, member.name)
			if (layout === 'flat') {
				if (member.isFile() !== true || DIGEST_NAME.test(member.name) !== true) continue
				if (insideRoot(root, memberPath) !== true) continue
				let info
				try {
					info = await lstat(memberPath)
				} catch {
					continue
				}
				if (info.isSymbolicLink() === true || info.isFile() !== true) continue
				entries.push({ path: memberPath, digest: member.name, size: Number(info.size) || 0, dev: info.dev, ino: info.ino, mtime: Number(info.mtimeMs) || 0 })
				continue
			}
			// `named`: the digest is the directory name; every leaf is a hard-link alias of it.
			if (member.isDirectory() !== true || DIGEST_NAME.test(member.name) !== true) continue
			if (insideRoot(root, memberPath) !== true) continue
			let leaves = []
			try {
				leaves = await readdir(memberPath, { withFileTypes: true })
			} catch {
				continue
			}
			for (const leaf of leaves) {
				if (leaf.isFile() !== true) continue
				const leafPath = join(memberPath, leaf.name)
				if (insideRoot(root, leafPath) !== true) continue
				let info
				try {
					info = await lstat(leafPath)
				} catch {
					continue
				}
				if (info.isSymbolicLink() === true || info.isFile() !== true) continue
				entries.push({ path: leafPath, digest: member.name, size: Number(info.size) || 0, dev: info.dev, ino: info.ino, mtime: Number(info.mtimeMs) || 0 })
			}
		}
	}
	return entries
}

/** Enumerate `request-images/<2>/<hash>` (pure derived cache; a miss is re-encoded on demand). */
async function enumerateCacheGroup(cacheRoot, root) {
	const entries = []
	let groupInfo
	try {
		groupInfo = await lstat(cacheRoot)
	} catch {
		return entries
	}
	if (groupInfo.isDirectory() !== true || groupInfo.isSymbolicLink() === true) return entries
	let shards = []
	try {
		shards = await readdir(cacheRoot, { withFileTypes: true })
	} catch {
		return entries
	}
	for (const shard of shards) {
		if (shard.isDirectory() !== true || SHARD_NAME.test(shard.name) !== true) continue
		const shardPath = join(cacheRoot, shard.name)
		let members = []
		try {
			members = await readdir(shardPath, { withFileTypes: true })
		} catch {
			continue
		}
		for (const member of members) {
			if (member.isFile() !== true) continue
			const memberPath = join(shardPath, member.name)
			if (insideRoot(root, memberPath) !== true) continue
			let info
			try {
				info = await lstat(memberPath)
			} catch {
				continue
			}
			if (info.isSymbolicLink() === true || info.isFile() !== true) continue
			entries.push({ path: memberPath, digest: member.name, size: Number(info.size) || 0, dev: info.dev, ino: info.ino, mtime: Number(info.mtimeMs) || 0 })
		}
	}
	return entries
}

/** Group statistics in the documented shape. */
function groupReport(label, entries, isDeletable) {
	let files = 0
	let bytes = 0
	let deletableFiles = 0
	let deletableBytes = 0
	for (const entry of entries) {
		files += 1
		bytes += entry.size
		if (isDeletable(entry) === true) {
			deletableFiles += 1
			deletableBytes += entry.size
		}
	}
	return { name: label, files, bytes, deletableFiles, deletableBytes }
}

/**
 * Sum the deduplicated size of every inode whose *every* candidate path is deletable, so the
 * number matches what the filesystem would actually reclaim (a hard-linked alias counts once).
 */
function dedupedBytes(entries, isDeletable) {
	const inodes = new Map()
	for (const entry of entries) {
		const key = `${entry.dev}:${entry.ino}`
		const record = inodes.get(key)
		if (record === undefined) inodes.set(key, { size: entry.size, deletable: true, seen: 0, deletableSeen: 0 })
		const target = inodes.get(key)
		target.seen += 1
		if (isDeletable(entry) === true) target.deletableSeen += 1
		else target.deletable = false
	}
	let total = 0
	for (const record of inodes.values()) {
		if (record.deletable === false) continue
		if (record.deletableSeen !== record.seen) continue
		total += record.size
	}
	return total
}

/**
 * Plan one GC run: scan references, enumerate the store and decide what is deletable.
 * Read-only: nothing here writes.
 * @returns the plan plus the documented preview report.
 */
async function planGc(home, includeRequestImageCache, signal) {
	const root = join(home, 'attachments', ATTACHMENT_STORE)
	let rootInfo
	try {
		rootInfo = await statPath(root)
	} catch {
		rootInfo = undefined
	}
	const emptyReport = {
		sessionsScanned: 0,
		referencedImages: 0,
		referencedFiles: 0,
		groups: [],
		deletableBytes: 0,
		cacheFiles: 0,
		cacheBytes: 0,
		unresolvedCount: 0,
		unresolvedSample: [],
		storePresent: false,
	}
	if (rootInfo === undefined || rootInfo.isDirectory() !== true) {
		return {
			root,
			durableEntries: [],
			cacheEntries: [],
			durableDeletable: () => false,
			report: emptyReport,
			unreadable: [],
		}
	}

	// (The caller flushes sessions first, so in-flight references are durable before this read.)

	const { referenced, attachments, sessions, unreadable } = await scanReferences(home, signal)
	signal?.throwIfAborted()

	const objects = await enumerateGroup(join(root, 'objects'), 'flat', root)
	const fileObjects = await enumerateGroup(join(root, 'file-objects'), 'flat', root)
	const files = await enumerateGroup(join(root, 'files'), 'named', root)
	const cache = await enumerateCacheGroup(join(root, 'request-images'), root)

	// Which attachments the corpus names but the store cannot produce. This is the honest answer
	// to "is anything already lost", computed before any deletion, from real `attachmentId`s only.
	const stored = new Set()
	for (const entry of [...objects, ...fileObjects, ...files]) stored.add(entry.digest)
	const unresolved = [...attachments].filter((digest) => stored.has(digest) !== true)

	const now = Date.now()
	const isReferenced = (entry) => referenced.has(entry.digest) === true
	const isRecent = (entry) => {
		// mtime is checked live for durable entries only; the cache is regenerable and exempt.
		return entry.mtime !== undefined && now - entry.mtime < GC_PROTECT_RECENT_MS
	}
	const durableDeletable = (entry) => isReferenced(entry) !== true && isRecent(entry) !== true

	const groups = [
		groupReport('objects', objects, durableDeletable),
		groupReport('file-objects', fileObjects, durableDeletable),
		groupReport('files', files, durableDeletable),
	]
	const cacheReport = groupReport('request-images', cache, () => true)
	const groupsOut = includeRequestImageCache === true ? [...groups, cacheReport] : groups

	const objectDigests = new Set(objects.map((entry) => entry.digest))
	const fileDigests = new Set([...fileObjects, ...files].map((entry) => entry.digest))
	let referencedImages = 0
	for (const digest of referenced) if (objectDigests.has(digest) === true) referencedImages += 1
	let referencedFiles = 0
	for (const digest of referenced) if (fileDigests.has(digest) === true) referencedFiles += 1

	const durableEntries = [...objects, ...fileObjects, ...files]
	const report = {
		sessionsScanned: sessions,
		referencedImages,
		referencedFiles,
		unresolvedCount: unresolved.length,
		unresolvedSample: unresolved.slice(0, 10),
		storePresent: true,
		groups: groupsOut,
		deletableBytes: dedupedBytes(durableEntries, durableDeletable),
		cacheFiles: cacheReport.files,
		cacheBytes: dedupedBytes(cache, () => true),
	}
	return {
		root,
		durableEntries,
		cacheEntries: cache,
		durableDeletable,
		report,
		unreadable,
	}
}

/** Delete every planned entry, then drop the directories it emptied (never recursively). */
async function executeGc(plan, includeRequestImageCache) {
	const failed = []
	let deletedFiles = 0
	const removedPaths = []
	const wantCache = includeRequestImageCache === true
	const candidates = [...plan.durableEntries.filter(plan.durableDeletable)]
	if (wantCache === true) candidates.push(...plan.cacheEntries)

	for (const entry of candidates) {
		if (insideRoot(plan.root, entry.path) !== true) {
			failed.push({ path: entry.path, reason: 'outside the attachment store root' })
			continue
		}
		try {
			await unlink(entry.path)
			deletedFiles += 1
			removedPaths.push(entry.path)
		} catch (error) {
			if (error instanceof Error && error.code === 'ENOENT') {
				deletedFiles += 1
				removedPaths.push(entry.path)
			} else {
				failed.push({ path: entry.path, reason: messageOf(error) })
			}
		}
	}

	// Count what was really removed: an inode with any surviving link (a failed deletion) frees nothing.
	const failedPaths = new Set(failed.map((item) => item.path))
	const freedBytes = dedupedBytes(candidates, (entry) => failedPaths.has(entry.path) !== true)

	// Removing an emptied digest/shard directory is cosmetic; `rmdir` refuses non-empty dirs.
	const directories = new Set()
	for (const path of removedPaths) {
		directories.add(dirname(path))
		directories.add(dirname(dirname(path)))
	}
	const sorted = [...directories].sort((left, right) => right.length - left.length)
	for (const directory of sorted) {
		if (directory === plan.root || insideRoot(plan.root, directory) !== true) continue
		try {
			await rmdir(directory)
		} catch {
			/* still holding files, or already gone */
		}
	}

	return { deletedFiles, freedBytes, failed }
}

/** Flush every active session write handle so in-flight references are durable before scanning. */
async function flushSessions(ctx) {
	const persistence = serviceOf(ctx, 'sessionPersistence')
	if (persistence === undefined || typeof persistence.flush !== 'function') return
	try {
		await persistence.flush()
	} catch (error) {
		warn(ctx.logger, `session-manager: session flush before GC did not complete: ${messageOf(error)}`)
	}
}

/**
 * Verify a finished cleanup the only way that actually proves anything: rescan the corpus for the
 * attachment ids it names, then confirm each one still resolves in the store.
 *
 * This exists because the first version of this plugin deleted 1,607 objects while its own report
 * confidently said "0 references" — the scan was wrong, and nothing checked it afterwards.
 * @returns `{checked, ok, missingCount, missingSample, unreadable}`.
 */
async function verifyAfterGc(home, signal) {
	const root = join(home, 'attachments', ATTACHMENT_STORE)
	const { attachments, unreadable } = await scanReferences(home, signal)
	const stored = new Set()
	for (const group of ['objects', 'file-objects']) {
		for (const entry of await enumerateGroup(join(root, group), 'flat', root)) stored.add(entry.digest)
	}
	for (const entry of await enumerateGroup(join(root, 'files'), 'named', root)) stored.add(entry.digest)
	const missing = [...attachments].filter((digest) => stored.has(digest) !== true)
	return {
		checked: attachments.size,
		ok: missing.length === 0,
		missingCount: missing.length,
		missingSample: missing.slice(0, 10),
		unreadable: unreadable.length,
	}
}

/** `gc-preview`: read-only plan + report. */
async function gcPreview(ctx, options, includeRequestImageCache, signal) {
	await flushSessions(ctx)
	const plan = await planGc(dshHome(), includeRequestImageCache, signal)
	return plan
}

/** `gc`: execute the plan (or only report it with `dryRun`), then audit. */
async function gcRun(ctx, options, includeRequestImageCache, dryRun, signal) {
	await flushSessions(ctx)
	const plan = await planGc(dshHome(), includeRequestImageCache, signal)

	// Fail closed: an unreadable reference document could hide a live reference.
	if (plan.unreadable.length > 0) {
		const failed = plan.unreadable.map((item) => ({ path: item.path, reason: `reference scan failed: ${item.reason}` }))
		await appendAudit(options, ctx.logger, {
			time: new Date().toISOString(),
			op: 'gc',
			sessions: [],
			freedBytes: 0,
			failed: failed.length,
			actor: 'ui',
			verify: { checked: 0, ok: false, missingCount: plan.report.unresolvedCount, skipped: true, unreadable: plan.unreadable.length },
		})
		return {
			deletedFiles: 0,
			freedBytes: 0,
			groups: plan.report.groups,
			failed,
			auditLog: auditPathOf(options),
			verify: { checked: 0, ok: false, missingCount: plan.report.unresolvedCount, missingSample: plan.report.unresolvedSample, unreadable: plan.unreadable.length, skipped: true },
		}
	}

	if (dryRun === true) {
		const candidates = [...plan.durableEntries.filter(plan.durableDeletable)]
		if (includeRequestImageCache === true) candidates.push(...plan.cacheEntries)
		const freedBytes = dedupedBytes(candidates, () => true)
		// A dry run mutates nothing, so it appends no audit line: the trail records changes.
		return {
			deletedFiles: candidates.length,
			freedBytes,
			groups: plan.report.groups,
			failed: [],
			auditLog: null,
			verify: { checked: 0, ok: plan.report.unresolvedCount === 0, missingCount: plan.report.unresolvedCount, missingSample: plan.report.unresolvedSample, unreadable: 0, skipped: true },
		}
	}

	const outcome = await executeGc(plan, includeRequestImageCache)
	// The proof that the deletion was safe: an independent rescan of what the corpus still names.
	const verify = await verifyAfterGc(dshHome(), signal)
	if (verify.ok !== true) {
		warn(ctx.logger, `session-manager: ${verify.missingCount} attachment reference(s) no longer resolve after the cleanup`)
	}
	await appendAudit(options, ctx.logger, {
		time: new Date().toISOString(),
		op: 'gc',
		sessions: [],
		freedBytes: outcome.freedBytes,
		failed: outcome.failed.length,
		actor: 'ui',
		verify: { checked: verify.checked, ok: verify.ok, missingCount: verify.missingCount },
	})
	return {
		deletedFiles: outcome.deletedFiles,
		freedBytes: outcome.freedBytes,
		groups: plan.report.groups,
		failed: outcome.failed,
		auditLog: auditPathOf(options),
		verify,
	}
}

/* ------------------------------------------------------------------------------------------------
 * Request handling
 * ---------------------------------------------------------------------------------------------- */

/**
 * Apply the composition's Host/Origin + browser-authentication fence when it exists.
 * The real node request is passed through unchanged (same call shape as the shipped
 * `dsh-host-open-in-app` route): the fence reads its headers, and any future check it adds must
 * see the whole request. `undefined` admits the request; a number is the rejection status.
 */
function rejectedByTrustFence(ctx, req, res) {
	const connection = serviceOf(ctx, 'connection')
	if (connection === undefined || typeof connection.requestRejection !== 'function') return false
	let rejection
	try {
		rejection = connection.requestRejection(req)
	} catch {
		return false
	}
	if (rejection === undefined) return false
	res.statusCode = rejection
	res.end()
	return true
}

/** The request lifetime, used for read-only work only. */
function requestSignal(req, res) {
	const controller = new AbortController()
	const abort = () => controller.abort()
	req.once?.('aborted', abort)
	res.once?.('close', abort)
	return controller.signal
}

/** Split a requested id list into usable ids and per-id refusals, preserving input order. */
function normalizeIds(raw) {
	const ids = []
	const invalid = []
	const seen = new Set()
	for (const entry of raw) {
		if (typeof entry !== 'string' || entry.trim().length === 0) {
			invalid.push({
				sessionId: typeof entry === 'string' ? entry : String(entry),
				code: 'invalid-id',
				reason: 'not a non-empty session id',
			})
			continue
		}
		const id = entry.trim()
		if (seen.has(id) === true) continue
		seen.add(id)
		ids.push(id)
	}
	return { ids, invalid }
}

async function handleRequest(ctx, req, res, config) {
	const method = String(req.method ?? 'GET').toUpperCase()
	const url = new URL(String(req.url ?? ROUTE_PATH), 'http://localhost')
	const options = readOptions(config)

	// Read-only convenience: GET ?op=ping|list|sizes|gc-preview. Writes always need a POST body.
	if (method === 'GET' || method === 'HEAD') {
		const op = url.searchParams.get('op') ?? 'ping'
		if (op === 'delete' || op === 'gc') return sendFailure(res, 400, `op "${op}" requires POST with a JSON body`)
		if (op === 'risk') {
			const overview = await riskOverview(ctx, requestSignal(req, res))
			return sendJson(res, 200, { ok: true, ...overview })
		}
		if (op === 'ping' || op === 'list' || op === 'sizes') {
			const signal = requestSignal(req, res)
			if (op === 'ping') return sendJson(res, 200, { ok: true, version: PROTOCOL_VERSION })
			if (op === 'list') return sendJson(res, 200, { ok: true, items: await listSessions(ctx, signal) })
			const value = await sessionSizes(ctx, signal)
			return sendJson(res, 200, { ok: true, sizes: value.sizes, scannedAt: value.scannedAt })
		}
		if (op === 'gc-preview') {
			const plan = await gcPreview(ctx, options, url.searchParams.get('includeRequestImageCache') === 'true', requestSignal(req, res))
			return sendJson(res, 200, { ok: true, report: plan.report })
		}
		if (op === 'trash-list') {
			const signal = requestSignal(req, res)
			const { items, totalBytes } = await listTrash(dshHome(), signal, await liveChildIndex(ctx, signal))
			return sendJson(res, 200, { ok: true, retentionDays: options.trashRetentionDays, totalBytes, items })
		}
		return sendFailure(res, 400, `unknown op: ${op}`)
	}

	if (method !== 'POST') {
		res.statusCode = 405
		res.setHeader('allow', 'POST, GET')
		res.end()
		return
	}

	let text
	try {
		text = await readBoundedBody(req)
	} catch (error) {
		return sendFailure(res, 400, `request body unreadable: ${messageOf(error)}`)
	}
	if (text === null) return sendFailure(res, 413, 'request body is too large')

	let body
	try {
		body = JSON.parse(text.length === 0 ? '{}' : text)
	} catch (error) {
		return sendFailure(res, 400, `request body is not JSON: ${messageOf(error)}`)
	}
	if (body === null || typeof body !== 'object' || Array.isArray(body) === true) {
		return sendFailure(res, 400, 'request body must be a JSON object')
	}

	const op = body.op
	const includeRequestImageCache = body.includeRequestImageCache === true
	if (op === 'ping') return sendJson(res, 200, { ok: true, version: PROTOCOL_VERSION })
	if (op === 'list') return sendJson(res, 200, { ok: true, items: await listSessions(ctx, requestSignal(req, res)) })
	if (op === 'risk') {
		const overview = await riskOverview(ctx, requestSignal(req, res))
		return sendJson(res, 200, { ok: true, ...overview })
	}
	if (op === 'risk-stats') {
		let stats
		try {
			stats = await riskStats(ctx, body.policy, requestSignal(req, res))
		} catch (error) {
			return sendFailure(res, 400, `risk policy rejected: ${messageOf(error)}`)
		}
		return sendJson(res, 200, { ok: true, ...stats })
	}
	if (op === 'sizes') {
		const value = await sessionSizes(ctx, requestSignal(req, res))
		return sendJson(res, 200, { ok: true, sizes: value.sizes, scannedAt: value.scannedAt })
	}
	if (op === 'gc-preview') {
		const plan = await gcPreview(ctx, options, includeRequestImageCache, requestSignal(req, res))
		return sendJson(res, 200, { ok: true, report: plan.report })
	}
	if (op === 'gc') {
		const outcome = await withDestructiveLock(() => gcRun(ctx, options, includeRequestImageCache, body.dryRun === true, requestSignal(req, res)))
		return sendJson(res, 200, {
			ok: true,
			deletedFiles: outcome.deletedFiles,
			freedBytes: outcome.freedBytes,
			groups: outcome.groups,
			failed: outcome.failed,
			auditLog: outcome.auditLog ?? null,
			verify: outcome.verify ?? null,
		})
	}

	// Recycle bin. Reads never mutate: expiry belongs to the retention timer and to an explicit
	// purge, so a listing can never destroy an entry the user was about to restore.
	if (op === 'trash-list') {
		const signal = requestSignal(req, res)
		const { items, totalBytes } = await listTrash(dshHome(), signal, await liveChildIndex(ctx, signal))
		return sendJson(res, 200, {
			ok: true,
			retentionDays: options.trashRetentionDays,
			totalBytes,
			items,
		})
	}

	if (op === 'trash-restore') {
		if (Array.isArray(body.sessionIds) !== true) return sendFailure(res, 400, 'sessionIds must be an array')
		const { ids, invalid } = normalizeIds(body.sessionIds)
		if (ids.length === 0 && invalid.length === 0) return sendFailure(res, 400, 'sessionIds is empty')
		const outcome = await withDestructiveLock(() => restoreSessions(options, ids))
		await appendAudit(options, ctx.logger, {
			time: new Date().toISOString(),
			op: 'restore',
			sessions: outcome.audited,
			freedBytes: 0,
			failed: outcome.failed.length,
			actor: 'ui',
		})
		return sendJson(res, 200, {
			ok: true,
			restored: outcome.restored,
			failed: [...invalid, ...outcome.failed],
			auditLog: auditPathOf(options),
		})
	}

	if (op === 'trash-purge') {
		const byIds = Array.isArray(body.sessionIds) ? body.sessionIds : undefined
		const expiredOnly = body.expiredOnly === true
		const all = body.all === true
		if (byIds === undefined && expiredOnly !== true && all !== true) {
			return sendFailure(res, 400, 'trash-purge needs sessionIds, expiredOnly:true, or all:true')
		}
		const { ids, invalid } = byIds === undefined ? { ids: [], invalid: [] } : normalizeIds(byIds)
		if (byIds !== undefined && ids.length === 0 && invalid.length === 0) {
			return sendFailure(res, 400, 'sessionIds is empty')
		}
		const childIndex = await liveChildIndex(ctx, requestSignal(req, res))
		const outcome = await withDestructiveLock(() => purgeTrash(options, ids, expiredOnly, all, childIndex, body.force === true))
		await appendAudit(options, ctx.logger, {
			time: new Date().toISOString(),
			op: 'purge',
			sessions: outcome.audited,
			freedBytes: outcome.freedBytes,
			failed: outcome.failed.length,
			actor: 'ui',
		})
		return sendJson(res, 200, {
			ok: true,
			purged: outcome.purged,
			freedBytes: outcome.freedBytes,
			failed: [...invalid, ...outcome.failed],
			auditLog: auditPathOf(options),
		})
	}

	if (op !== 'delete') return sendFailure(res, 400, `unknown op: ${String(op)}`)

	if (Array.isArray(body.sessionIds) !== true) return sendFailure(res, 400, 'sessionIds must be an array')
	const { ids, invalid } = normalizeIds(body.sessionIds)
	if (ids.length === 0 && invalid.length === 0) return sendFailure(res, 400, 'sessionIds is empty')

	const outcome = await withDestructiveLock(() => deleteSessions(ctx, options, ids, requestSignal(req, res), body.permanent === true, body.force === true))
	return sendJson(res, 200, {
		ok: true,
		trashed: outcome.trashed,
		deleted: outcome.deleted,
		failed: [...invalid, ...outcome.failed],
		trashedBytes: outcome.trashedBytes,
		freedBytes: outcome.freedBytes,
		auditLog: outcome.auditLog ?? null,
	})
}

/**
 * Mount the Session Manager route on the Web carrier and remove it on unload.
 * @param ctx the plugin Context (only `webServer` is required).
 * @param config the bundle row's config (`auditLog`, `maxConcurrency`).
 */
export function apply(ctx, config) {
	ctx.effect(
		() => ctx.webServer.register({
			kind: 'exact',
			path: ROUTE_PATH,
			handler: async (req, res) => {
				try {
					if (rejectedByTrustFence(ctx, req, res) === true) return
					await handleRequest(ctx, req, res, config)
				} catch (error) {
					warn(ctx.logger, `session-manager: request failed: ${messageOf(error)}`)
					sendFailure(res, 500, messageOf(error))
				}
			},
		}),
		`${name}: POST ${ROUTE_PATH}`,
	)

	// Recycle-bin retention: sweep once on activation (an app that stayed closed past a deadline
	// must still expire entries) and then hourly. Both are owned by the plugin fiber, so unloading
	// the plugin stops the timer; a profile without the timer plugin simply skips the cadence and
	// still sweeps on every request.
	ctx.effect(() => {
		// The sweep is a convenience, never a precondition: a profile whose timer service is absent
		// (or a Cordis build that throws on `interval`) must still mount the route, so the whole
		// scheduling step is guarded. Every request sweeps as well.
		void sweepQuietly(ctx, ctx.logger)
		let dispose
		try {
			const schedule = typeof ctx.interval === 'function' ? ctx.interval.bind(ctx) : undefined
			if (schedule !== undefined) {
				dispose = schedule(() => {
					void sweepQuietly(ctx, ctx.logger)
				}, TRASH_SWEEP_INTERVAL_MS)
			}
		} catch (error) {
			warn(ctx.logger, `session-manager: the hourly recycle-bin sweep could not be scheduled: ${messageOf(error)}`)
		}
		return () => {
			if (typeof dispose === 'function') dispose()
		}
	}, `${name}: recycle-bin retention sweep`)
}