/**
 * Host-half smoke test — runs the real route handler from ../index.js against fake services.
 *
 *   node tools/host-smoke.mjs
 *
 * Nothing outside a throwaway fixture under tools/.smoke/ is written or deleted. The last two
 * sections only *read*: they mount the real JSONL session-persistence backend on ~/.dsh/sessions
 * to report what `stat(id).location` actually is, then confirm the on-disk layout the delete guard
 * depends on. Both skip cleanly when the extracted source tree is unavailable.
 */

import { createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { apply } from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixtureRoot = join(here, '.smoke')

/* ------------------------------------------------------------------ tiny assertion harness ---- */

let passed = 0
const failures = []

function check(name, condition, detail) {
	if (condition) {
		passed += 1
		console.log(`  ok   ${name}`)
		return
	}
	failures.push(name)
	console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

function section(title) {
	console.log(`\n${title}`)
}

async function exists(path) {
	try {
		await stat(path)
		return true
	} catch {
		return false
	}
}

/* ------------------------------------------------------- real backend probe (read-only mount) --- */

let resolutionHooksInstalled = false

/**
 * The extracted source tree ships only @deepseek-ai packages, so a bare `import` of the real
 * backend cannot resolve its third-party dependencies. Resolve those from the profile's
 * node_modules and stub the two that neither tree carries. This affects *this probe process only*
 * — inside the running harness every package resolves normally.
 */
function installResolutionHooks(profileDir) {
	if (resolutionHooksInstalled) return
	resolutionHooksInstalled = true
	const stubs = {
		'@js-temporal/polyfill': 'data:text/javascript,export const Temporal = {};',
		'p-limit': 'data:text/javascript,export default function pLimit(){ return (fn) => fn() }',
	}
	let req
	try {
		req = createRequire(join(profileDir, 'package.json'))
	} catch {
		req = undefined
	}
	registerHooks({
		resolve(specifier, context, next) {
			const stub = stubs[specifier]
			if (stub !== undefined) return { url: stub, shortCircuit: true }
			if (/^(\.|\/|node:|data:|file:)/.test(specifier)) return next(specifier, context)
			if (req !== undefined) {
				try {
					return { url: `file://${req.resolve(specifier)}`, shortCircuit: true }
				} catch {
					/* not in the profile either: let node report it */
				}
			}
			return next(specifier, context)
		},
	})
}

/**
 * Mount the real JSONL session-persistence backend on the live sessions root, read-only, and
 * return the service. `DSH_SRC` / `DSH_PROFILE_DIR` override the discovered paths.
 */
async function mountRealBackend() {
	const sourceRoot = process.env.DSH_SRC ?? '/Users/ivanyin/dsh-work/src/dsh'
	const sessionRoot = join(process.env.HOME ?? '/Users/ivanyin', '.dsh', 'sessions')
	const profileDir = process.env.DSH_PROFILE_DIR ?? '/Users/ivanyin/.dsh/profiles/desktop'
	let Context
	let backend
	try {
		installResolutionHooks(profileDir)
		;({ Context } = await import(`file://${sourceRoot}/node_modules/@deepseek-ai/cordis/lib/index.js`))
		backend = await import(`file://${sourceRoot}/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js`)
	} catch {
		return undefined
	}
	for (const compression of ['zstd', 'none']) {
		const root = new Context()
		try {
			root.plugin({ name: 'hot-smoke-probe', apply: backend.apply }, { root: sessionRoot, compression })
			let service
			for (let i = 0; i < 300 && service === undefined; i += 1) {
				service = root.get('sessionPersistence')
				if (service === undefined) await new Promise((resolve) => setTimeout(resolve, 10))
			}
			if (service === undefined) continue
			await service.list() // surfaces a root-encoding mismatch as a rejection
			return service
		} catch {
			/* try the other compression */
		}
	}
	return undefined
}

/* ------------------------------------------------------------------------ fake HTTP carrier --- */

function makeRes() {
	return {
		statusCode: 0,
		headers: {},
		writableEnded: false,
		body: undefined,
		setHeader(name, value) {
			this.headers[String(name).toLowerCase()] = value
		},
		end(body) {
			this.writableEnded = true
			this.body = body === undefined ? undefined : String(body)
		},
		once() {},
		off() {},
	}
}

function makeReq({ method, url, body, headers }) {
	return {
		method,
		url,
		headers: headers ?? {},
		once() {},
		off() {},
		resume() {},
		async *[Symbol.asyncIterator]() {
			if (body !== undefined) yield Buffer.from(body, 'utf8')
		},
	}
}

function makeContext(services) {
	const routes = []
	const disposers = []
	const ctx = {
		webServer: {
			register(route) {
				if (routes.some((r) => r.kind === route.kind && r.path === route.path)) throw new Error('duplicate route')
				routes.push(route)
				return () => {
					const at = routes.indexOf(route)
					if (at !== -1) routes.splice(at, 1)
				}
			},
		},
		effect(execute, _label) {
			const disposer = execute()
			if (typeof disposer === 'function') disposers.push(disposer)
			return disposer
		},
		get(key) {
			return services[key]
		},
		logger: { warn: () => {}, info: () => {} },
	}
	return { ctx, routes, disposers }
}

async function call(route, { method = 'POST', url = '/plugins/session-manager/api', body, headers } = {}) {
	const res = makeRes()
	const req = makeReq({ method, url, body, headers })
	await route.handler(req, res)
	let json
	try {
		json = res.body === undefined ? undefined : JSON.parse(res.body)
	} catch {
		json = undefined
	}
	return { status: res.statusCode, json, headers: res.headers, raw: res.body }
}

/* ----------------------------------------------------------------------------- fake services -- */

function fakePersistence(locations, sizes = {}) {
	const calls = []
	return {
		calls,
		async stat(id) {
			calls.push(id)
			const path = locations[id]
			if (path === undefined) return undefined
			if (path instanceof Error) throw path
			const size = sizes[id]
			return {
				header: { id, version: 4, createdAt: 1, isSeeded: false },
				revision: 'r',
				location: { kind: 'jsonl', path },
				...(Number.isFinite(size) ? { sizeBytes: size } : {}),
			}
		},
	}
}

function fakeRegistry({ archived = [], failArchive } = {}) {
	const calls = { archive: [], unarchive: [] }
	const state = new Set(archived)
	return {
		calls,
		get archivedSessionIds() {
			return [...state]
		},
		async archiveSession(id, options) {
			calls.archive.push({ id, options })
			if (failArchive !== undefined) throw failArchive
			state.add(id)
		},
		async unarchiveSession(id) {
			calls.unarchive.push(id)
			state.delete(id)
		},
	}
}

function fakeController({ items = [], running = false, stateThrows = false } = {}) {
	return {
		async list(_request, _signal) {
			return { items }
		},
		async state(request) {
			if (stateThrows) throw new Error('no live agent')
			return { cursor: 0, active: running, running, queue: null, pendingInput: [] }
		},
	}
}

/** Build one disposable session directory the shape the JSONL backend produces. */
async function makeSessionDir(root, slug, id) {
	const dir = join(root, slug, id)
	await mkdir(dir, { recursive: true })
	const log = join(dir, 'session.v4.jsonl.zstd')
	await writeFile(log, 'x')
	await writeFile(join(dir, 'session.lock'), '')
	return { dir, log }
}


/* ------------------------------------------------------------- v2 fixture helpers -- */

/** Deterministic 64-hex digest for a fixture label. */
function digestOf(label) {
	return createHash('sha256').update(label).digest('hex')
}

/** Exact-size fixture file with an aged mtime (outside the GC grace window). */
async function writeAgedFile(path, size, fill = 'x', ageMs = 3600000) {
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, fill.repeat(Math.max(1, size)).slice(0, size))
	const when = new Date(Date.now() - ageMs)
	await utimes(path, when, when)
}

/** Exact-size fixture file with the current mtime (inside the GC grace window). */
async function writeFreshFile(path, size, fill = 'y') {
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, fill.repeat(Math.max(1, size)).slice(0, size))
}

/** A document whose 64-hex digest starts 32 bytes before the 64 KiB stream boundary. */
function boundaryLogContent(digest) {
	const start = 65536 - 32
	return `${'h'.repeat(start)}${digest}${'g'.repeat(64)}
`
}

/** path → `size:mtime` for every file under root (used to prove read-only behaviour). */
async function snapshotTree(root) {
	const out = new Map()
	const walk = async (dir) => {
		let entries = []
		try {
			entries = await readdir(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			const full = join(dir, entry.name)
			if (entry.isDirectory() === true) {
				await walk(full)
				continue
			}
			try {
				const info = await stat(full)
				out.set(full, `${info.size}:${Math.round(info.mtimeMs)}`)
			} catch {
				out.set(full, 'missing')
			}
		}
	}
	await walk(root)
	return out
}

/** files:bytes fingerprint of a tree (used for the live read-only probe). */
async function treePaths(root) {
	const found = new Set()
	const walk = async (dir, depth) => {
		if (depth > 3) return
		let entries = []
		try {
			entries = await readdir(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			const path = join(dir, entry.name)
			if (entry.isDirectory()) await walk(path, depth + 1)
			else if (entry.isFile()) found.add(path)
		}
	}
	await walk(root, 0)
	return found
}

async function treeSize(root) {
	let files = 0
	let bytes = 0
	const walk = async (dir) => {
		let entries = []
		try {
			entries = await readdir(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			const full = join(dir, entry.name)
			if (entry.isDirectory() === true) {
				await walk(full)
				continue
			}
			try {
				const info = await stat(full)
				files += 1
				bytes += info.size
			} catch {
				/* gone between readdir and stat */
			}
		}
	}
	await walk(root)
	return `${files}:${bytes}`
}

/* ------------------------------------------------------------------------------------- tests -- */

async function main() {
	await rm(fixtureRoot, { recursive: true, force: true })
	await mkdir(fixtureRoot, { recursive: true })
	// Point every write at the fixture home: the audit log must never touch the real ~/.dsh.
	process.env.DSH_HOME = join(fixtureRoot, 'home')

	section('mount: exactly one route, removed by the effect disposer')
	const baseServices = {}
	const mounted = makeContext(baseServices)
	apply(mounted.ctx, {})
	check('one route registered', mounted.routes.length === 1, `got ${mounted.routes.length}`)
	const route = mounted.routes[0]
	check('route is an exact POST endpoint', route?.kind === 'exact' && route?.path === '/plugins/session-manager/api', JSON.stringify({ kind: route?.kind, path: route?.path }))
	check('handler is a function', typeof route?.handler === 'function')
	check('apply owns its effects through ctx.effect (route + recycle-bin sweep)', mounted.disposers.length === 2, `got ${mounted.disposers.length}`)
	for (const dispose of mounted.disposers) dispose()
	check('disposing the effects unregisters the route', mounted.routes.length === 0, `left ${mounted.routes.length}`)

	section('protocol: ping / list / validation')
	{
		const bare = makeContext({})
		apply(bare.ctx, {})
		const r = bare.routes[0]
		const ping = await call(r, { body: JSON.stringify({ op: 'ping' }) })
		check('POST ping → 200 {ok:true,version:"3"}', ping.status === 200 && ping.json?.ok === true && ping.json?.version === '3', JSON.stringify(ping.json))
		check('ping sets json content-type', String(ping.headers['content-type']).startsWith('application/json'))
		check('ping sets cache-control no-store', ping.headers['cache-control'] === 'no-store')

		const badJson = await call(r, { body: '{ not json' })
		check('bad JSON → 400 {ok:false,reason}', badJson.status === 400 && badJson.json?.ok === false && typeof badJson.json?.reason === 'string', JSON.stringify(badJson.json))

		const unknown = await call(r, { body: JSON.stringify({ op: 'nope' }) })
		check('unknown op → 400', unknown.status === 400 && unknown.json?.ok === false)

		const noOp = await call(r, { body: JSON.stringify({}) })
		check('missing op → 400', noOp.status === 400 && noOp.json?.ok === false)

		const nonObject = await call(r, { body: '[1,2]' })
		check('array body → 400', nonObject.status === 400)

		const notArray = await call(r, { body: JSON.stringify({ op: 'delete', sessionIds: 'abc' }) })
		check('non-array sessionIds → 400', notArray.status === 400 && notArray.json?.ok === false, JSON.stringify(notArray.json))

		const empty = await call(r, { body: JSON.stringify({ op: 'delete', sessionIds: [] }) })
		check('empty sessionIds → 400', empty.status === 400 && empty.json?.ok === false)

		const noOpBody = await call(r, { body: '' })
		check('empty body → 400 (missing op)', noOpBody.status === 400)

		const wrongMethod = await call(r, { method: 'PUT' })
		check('PUT → 405 with allow', wrongMethod.status === 405 && wrongMethod.headers.allow === 'POST, GET')

		const getPing = await call(r, { method: 'GET', url: '/plugins/session-manager/api?op=ping' })
		check('GET ?op=ping → 200', getPing.status === 200 && getPing.json?.ok === true)
		const getDelete = await call(r, { method: 'GET', url: '/plugins/session-manager/api?op=delete' })
		check('GET ?op=delete → 400 (delete needs POST)', getDelete.status === 400)
	}

	section('list: mapped from sessionController.list + registry archive set')
	{
		const services = {
			sessionController: fakeController({
				items: [
					{ sessionId: 'a1', cwd: '/Users/x/proj', updatedAt: 1700000000000, running: true, blank: false, projections: { kind: 'sequenced', asOfSeq: 3, values: { title: 'Hello world' } } },
					{ sessionId: 'b2', cwd: '/Users/x/proj', updatedAt: 1700000001000, running: false, blank: true },
				],
			}),
			workspaceRegistry: fakeRegistry({ archived: ['b2'] }),
		}
		const m = makeContext(services)
		apply(m.ctx, {})
		const r = m.routes[0]
		const list = await call(r, { body: JSON.stringify({ op: 'list' }) })
		const items = list.json?.items ?? []
		check('list → 200 ok', list.status === 200 && list.json?.ok === true, JSON.stringify(list.json))
		check('list maps the documented fields plus bytes', items.length === 2
			&& Object.keys(items[0] ?? {}).sort().join(',') === 'archived,blank,bytes,cwd,running,sessionId,title,updatedAt', JSON.stringify(Object.keys(items[0] ?? {})))
		check('title comes from projections.values.title', items[0]?.title === 'Hello world', String(items[0]?.title))
		check('missing title is null', items[1]?.title === null, String(items[1]?.title))
		check('running/blank flags carried', items[0]?.running === true && items[1]?.blank === true)
		check('archived flag read from the registry archive set', items[1]?.archived === true && items[0]?.archived === false, JSON.stringify(items.map((i) => i.archived)))

		const bare = makeContext({})
		apply(bare.ctx, {})
		const emptyList = await call(bare.routes[0], { body: JSON.stringify({ op: 'list' }) })
		check('list without sessionController → 200 ok with no items', emptyList.status === 200 && emptyList.json?.ok === true && emptyList.json?.items?.length === 0, JSON.stringify(emptyList.json))
	}

	section('delete: one disposable session (archive → stat → rm, no residue)')
	{
		const one = await makeSessionDir(fixtureRoot, 'slug-one', 'session-1111')
		const outside = join(fixtureRoot, 'slug-one', 'unrelated')
		await mkdir(outside, { recursive: true })
		await writeFile(join(outside, 'keep.txt'), 'keep')

		const registry = fakeRegistry({ archived: ['session-1111'] })
		const services = { sessionPersistence: fakePersistence({ 'session-1111': one.log }), workspaceRegistry: registry, sessionController: fakeController() }
		const m = makeContext(services)
		apply(m.ctx, {})
		const result = await call(m.routes[0], { body: JSON.stringify({ op: 'delete', sessionIds: ['session-1111'], permanent: true }) })
		check('delete → 200 ok', result.status === 200 && result.json?.ok === true, JSON.stringify(result.json))
		check('reported in deleted', JSON.stringify(result.json?.deleted) === '["session-1111"]', JSON.stringify(result.json?.deleted))
		check('failed list empty', Array.isArray(result.json?.failed) && result.json.failed.length === 0)
		check('session directory removed from disk', (await exists(one.dir)) === false)
		check('sibling directory untouched', (await exists(outside)) === true)
		check('archive used stopActivity:true', registry.calls.archive[0]?.options?.stopActivity === true, JSON.stringify(registry.calls.archive))
		check('archive set entry dropped after delete', registry.calls.unarchive.includes('session-1111'), JSON.stringify(registry.calls.unarchive))
	}

	section('delete: safety refusals and per-id isolation')
	{
		const good = await makeSessionDir(fixtureRoot, 'slug-two', 'session-good')
		// An id the backend path-encodes: the directory name is `encodeSegment(id)`, not the raw id.
		const encodedId = 'a:b'
		const encodedDir = join(fixtureRoot, 'slug-two', 'a~003Ab')
		await mkdir(encodedDir, { recursive: true })
		await writeFile(join(encodedDir, 'session.v4.jsonl.zstd'), 'x')
		// A location whose containing directory is NOT named after the id: only the file may go.
		const loop = join(fixtureRoot, 'loop-proj', 'artifact-host')
		await mkdir(loop, { recursive: true })
		await writeFile(join(loop, 'session.v4.jsonl.zstd'), 'x')
		await writeFile(join(loop, 'other.txt'), 'keep')

		const services = {
			sessionPersistence: fakePersistence({
				'session-good': good.log,
				'session-loop': join(loop, 'session.v4.jsonl.zstd'),
				[encodedId]: join(encodedDir, 'session.v4.jsonl.zstd'),
				'session-missing': undefined,
				'session-relative': 'relative/path/session.jsonl',
				'session-throws': new Error('corrupt header: refusing to read'),
			}),
			workspaceRegistry: fakeRegistry(),
			sessionController: fakeController(),
		}
		const m = makeContext(services)
		apply(m.ctx, {})
		const r = m.routes[0]

		const mixed = await call(r, {
			body: JSON.stringify({
				op: 'delete',
				sessionIds: ['session-good', encodedId, 'session-missing', 'session-throws', 'session-relative', 'session-loop', 42, ''],
				permanent: true,
			}),
		})
		const failedIds = (mixed.json?.failed ?? []).map((f) => f.sessionId)
		check(
			'mixed batch still deletes every resolvable id',
			JSON.stringify(mixed.json?.deleted) === JSON.stringify(['session-good', encodedId, 'session-loop']),
			JSON.stringify(mixed.json?.deleted),
		)
		check('unknown session reported as failed', failedIds.includes('session-missing'))
		check('throwing stat reported as failed', failedIds.includes('session-throws'))
		check('relative location refused', failedIds.includes('session-relative'))
		check('non-string id reported as failed', failedIds.includes('42'))
		check('empty-string id reported as failed', failedIds.includes(''))
		check('every failure carries a reason', (mixed.json?.failed ?? []).every((f) => typeof f.reason === 'string' && f.reason.length > 0))
		check('per-id failure did not abort the batch', mixed.status === 200 && mixed.json?.ok === true)
		check('loop project: log file gone', (await exists(join(loop, 'session.v4.jsonl.zstd'))) === false)
		check('loop project: directory and sibling kept', (await exists(join(loop, 'other.txt'))) === true && (await exists(loop)) === true)

		check('encoded id removed with its own directory', (await exists(encodedDir)) === false)
	}

	section('delete: a still-running session keeps its files')
	{
		const running = await makeSessionDir(fixtureRoot, 'slug-three', 'session-busy')
		const services = {
			sessionPersistence: fakePersistence({ 'session-busy': running.log }),
			workspaceRegistry: fakeRegistry(),
			sessionController: fakeController({ running: true }),
		}
		const m = makeContext(services)
		apply(m.ctx, {})
		const result = await call(m.routes[0], { body: JSON.stringify({ op: 'delete', sessionIds: ['session-busy'], permanent: true }) })
		check('running id lands in failed', JSON.stringify(result.json?.failed?.map((f) => f.sessionId)) === '["session-busy"]', JSON.stringify(result.json))
		check('failure reason names the running session', /running/i.test(result.json?.failed?.[0]?.reason ?? ''), String(result.json?.failed?.[0]?.reason))
		check('files left in place', (await exists(running.dir)) === true)
	}

	section('delete: archive failure without a controller verdict refuses')
	{
		const guarded = await makeSessionDir(fixtureRoot, 'slug-four', 'session-guarded')
		const services = {
			sessionPersistence: fakePersistence({ 'session-guarded': guarded.log }),
			workspaceRegistry: fakeRegistry({ failArchive: new Error('storage write failed') }),
			sessionController: { async state() { throw new Error('no live agent') } },
		}
		const m = makeContext(services)
		apply(m.ctx, {})
		const result = await call(m.routes[0], { body: JSON.stringify({ op: 'delete', sessionIds: ['session-guarded'], permanent: true }) })
		check('refused when activity could not be confirmed', result.json?.deleted?.length === 0 && result.json?.failed?.length === 1, JSON.stringify(result.json))
		check('files left in place', (await exists(guarded.dir)) === true)

		// Same archive failure, but the controller can prove the session is idle → deletion proceeds.
		const ok = await makeSessionDir(fixtureRoot, 'slug-four', 'session-guarded-2')
		const services2 = {
			sessionPersistence: fakePersistence({ 'session-guarded-2': ok.log }),
			workspaceRegistry: fakeRegistry({ failArchive: new Error('storage write failed') }),
			sessionController: fakeController(),
		}
		const m2 = makeContext(services2)
		apply(m2.ctx, {})
		const result2 = await call(m2.routes[0], { body: JSON.stringify({ op: 'delete', sessionIds: ['session-guarded-2'], permanent: true }) })
		check('proceeds when the controller proves idleness', JSON.stringify(result2.json?.deleted) === '["session-guarded-2"]', JSON.stringify(result2.json))
	}

	section('delete: trust fence short-circuits')
	{
		const fenced = await makeSessionDir(fixtureRoot, 'slug-five', 'session-fenced')
		const seen = []
		const services = {
			sessionPersistence: fakePersistence({ 'session-fenced': fenced.log }),
			workspaceRegistry: fakeRegistry(),
			sessionController: fakeController(),
			connection: {
				requestRejection(request) {
					seen.push(request)
					return 403
				},
			},
		}
		const m = makeContext(services)
		apply(m.ctx, {})
		const result = await call(m.routes[0], { body: JSON.stringify({ op: 'delete', sessionIds: ['session-fenced'], permanent: true }) })
		check('403 from the fence, no JSON body', result.status === 403 && result.raw === undefined, JSON.stringify({ s: result.status, b: result.raw }))
		check('no deletion happened', (await exists(fenced.dir)) === true)
		check(
			'the whole request is handed to requestRejection (not a {headers} wrapper), matching the shipped route',
			seen.length === 1 && typeof seen[0].method === 'string' && typeof seen[0].url === 'string' && typeof seen[0].headers === 'object',
			JSON.stringify(seen[0] === undefined ? null : { keys: Object.keys(seen[0]), method: seen[0].method }),
		)
		// undefined means admitted: the request must then be served normally.
		const allowing = makeContext({
			...services,
			connection: { requestRejection: () => undefined },
		})
		apply(allowing.ctx, {})
		const permitted = await call(allowing.routes[0], { body: JSON.stringify({ op: 'ping' }) })
		check('undefined from the fence admits the request', permitted.status === 200 && permitted.json?.ok === true, JSON.stringify(permitted.json))
	}

section('v2 sizes: per-session durable bytes and list bytes')
	{
		await writeAgedFile(join(fixtureRoot, 'sized', 's2', 'session.v1.jsonl'), 1234)
		const services = {
			sessionController: fakeController({ items: [{ sessionId: 's1' }, { sessionId: 's2' }] }),
			sessionPersistence: {
				async list() {
					return [
						{ header: { id: 's1' }, sizeBytes: 4096, location: { kind: 'jsonl', path: join(fixtureRoot, 'sized', 's1', 'session.v1.jsonl') } },
						{ header: { id: 's2' }, location: { kind: 'jsonl', path: join(fixtureRoot, 'sized', 's2', 'session.v1.jsonl') } },
					]
				},
				async stat(id) {
					return { header: { id }, revision: 'r', sizeBytes: 4096 }
				},
			},
		}
		const m = makeContext(services)
		apply(m.ctx, {})
		const r = m.routes[0]
		const sizes = await call(r, { body: JSON.stringify({ op: 'sizes' }) })
		check('sizes → 200 ok', sizes.status === 200 && sizes.json?.ok === true, JSON.stringify(sizes.json))
		check('sizes reports stat().sizeBytes', sizes.json?.sizes?.s1 === 4096, JSON.stringify(sizes.json?.sizes))
		check('sizes falls back to the measured artifact', sizes.json?.sizes?.s2 === 1234, JSON.stringify(sizes.json?.sizes))
		check('sizes carries a scannedAt timestamp', Number.isFinite(sizes.json?.scannedAt) && sizes.json.scannedAt > 0, JSON.stringify(sizes.json?.scannedAt))

		const list = await call(r, { body: JSON.stringify({ op: 'list' }) })
		const rows = list.json?.items ?? []
		check('list rows carry bytes', rows.length === 2 && rows.every((row) => Number.isFinite(row.bytes)), JSON.stringify(rows))
		check('list bytes come from the persistence sizes', rows.find((row) => row.sessionId === 's1')?.bytes === 4096, JSON.stringify(rows))

		const bare = makeContext({ sessionController: fakeController({ items: [{ sessionId: 'ghost' }] }) })
		apply(bare.ctx, {})
		const bareList = await call(bare.routes[0], { body: JSON.stringify({ op: 'list' }) })
		check('list without persistence degrades to bytes:0', bareList.json?.items?.[0]?.bytes === 0, JSON.stringify(bareList.json?.items))
		const bareSizes = await call(bare.routes[0], { body: JSON.stringify({ op: 'sizes' }) })
		check('sizes without persistence → empty map', bareSizes.status === 200 && bareSizes.json?.ok === true && Object.keys(bareSizes.json?.sizes ?? {}).length === 0, JSON.stringify(bareSizes.json))
	}

	section('v2 delete: freedBytes and the audit trail')
	{
		const target = await makeSessionDir(fixtureRoot, 'slug-v2', 'session-freed')
		await writeAgedFile(join(target.dir, 'session.v4.jsonl.zstd'), 5000)
		const services = {
			sessionPersistence: fakePersistence({ 'session-freed': join(target.dir, 'session.v4.jsonl.zstd') }),
			workspaceRegistry: fakeRegistry(),
			sessionController: fakeController({
				items: [{ sessionId: 'session-freed', projections: { kind: 'sequenced', asOfSeq: 1, values: { title: 'Freed session' } } }],
			}),
		}
		const m = makeContext(services)
		apply(m.ctx, { auditLog: true })
		const result = await call(m.routes[0], { body: JSON.stringify({ op: 'delete', sessionIds: ['session-freed'], permanent: true }) })
		check('delete reports freedBytes for the removed artifact', Number.isFinite(result.json?.freedBytes) && result.json.freedBytes >= 5000, JSON.stringify(result.json?.freedBytes))
		check('freedBytes is absent from failed batches', (await call(m.routes[0], { body: JSON.stringify({ op: 'delete', sessionIds: ['gone'], permanent: true }) })).json?.freedBytes === 0)

		const auditPath = join(fixtureRoot, 'home', 'logs', 'session-manager.jsonl')
		let lines = []
		try {
			lines = (await readFile(auditPath, 'utf8')).trim().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
		} catch {
			lines = []
		}
		const entry = lines.find((line) => line.sessions?.[0]?.sessionId === 'session-freed') ?? {}
		check('audit file is written under <DSH_HOME>/logs', Object.keys(entry).length > 0 && lines.length >= 1, auditPath)
		check(
			'audit line carries the documented fields',
			typeof entry.time === 'string' && Number.isFinite(Date.parse(entry.time)) && entry.op === 'delete' && entry.actor === 'ui'
				&& typeof entry.freedBytes === 'number' && typeof entry.failed === 'number' && Array.isArray(entry.sessions),
			JSON.stringify(entry),
		)
		check(
			'audit line records sessionId/title/bytes',
			entry.sessions?.[0]?.sessionId === 'session-freed' && entry.sessions?.[0]?.title === 'Freed session' && entry.sessions?.[0]?.bytes >= 5000,
			JSON.stringify(entry.sessions),
		)
	}

	section('v2 delete: every failure code is reachable and documented')
	{
		const ok = await makeSessionDir(fixtureRoot, 'slug-codes', 'code-ok')
		const relative = 'relative/path/session.jsonl'
		const persistence = {
			async stat(id) {
				if (id === 'code-not-found') return undefined
				if (id === 'code-io') throw new Error('disk on fire')
				if (id === 'code-unknown') {
					return {
						header: { id },
						revision: 'r',
						get location() {
							throw new Error('boom')
						},
					}
				}
				if (id === 'code-relative') return { header: { id }, revision: 'r', location: { kind: 'jsonl', path: relative } }
				return { header: { id }, revision: 'r', location: { kind: 'jsonl', path: ok.log } }
			},
		}
		const registry = {
			state: new Set(),
			get archivedSessionIds() {
				return [...this.state]
			},
			async archiveSession(id) {
				if (id === 'code-archived') throw new Error('storage write failed')
				this.state.add(id)
			},
			async unarchiveSession(id) {
				this.state.delete(id)
			},
		}
		const controller = {
			async list() {
				return { items: [] }
			},
			async state(request) {
				if (request.sessionId === 'code-archived') throw new Error('no live agent')
				return { running: request.sessionId === 'code-running' }
			},
		}
		const m = makeContext({ sessionPersistence: persistence, workspaceRegistry: registry, sessionController: controller })
		apply(m.ctx, {})
		const batch = await call(m.routes[0], {
			body: JSON.stringify({
				op: 'delete',
				sessionIds: ['code-ok', 'code-not-found', 'code-relative', 'code-io', 'code-unknown', 'code-running', 'code-archived', 42, ''],
				permanent: true,
			}),
		})
		const byId = new Map((batch.json?.failed ?? []).map((item) => [item.sessionId, item]))
		check('not-found code', byId.get('code-not-found')?.code === 'not-found', JSON.stringify(byId.get('code-not-found')))
		check('no-location code for a relative location', byId.get('code-relative')?.code === 'no-location', JSON.stringify(byId.get('code-relative')))
		check('io code for an unreadable snapshot', byId.get('code-io')?.code === 'io', JSON.stringify(byId.get('code-io')))
		check('unknown code for an unexpected failure', byId.get('code-unknown')?.code === 'unknown', JSON.stringify(byId.get('code-unknown')))
		check('running code', byId.get('code-running')?.code === 'running', JSON.stringify(byId.get('code-running')))
		check('archive-failed code', byId.get('code-archived')?.code === 'archive-failed', JSON.stringify(byId.get('code-archived')))
		check('invalid-id code for a non-string id', byId.get('42')?.code === 'invalid-id', JSON.stringify(byId.get('42')))
		check('invalid-id code for an empty id', byId.get('')?.code === 'invalid-id', JSON.stringify(byId.get('')))
		check(
			'every code is in the documented set',
			(batch.json?.failed ?? []).every((item) => ['not-found', 'running', 'no-location', 'io', 'invalid-id', 'archive-failed', 'unknown'].includes(item.code)),
			JSON.stringify((batch.json?.failed ?? []).map((item) => item.code)),
		)
		check('every failure keeps a human-readable reason', (batch.json?.failed ?? []).every((item) => typeof item.reason === 'string' && item.reason.length > 0))
		check('the resolvable id was still deleted', JSON.stringify(batch.json?.deleted) === '["code-ok"]', JSON.stringify(batch.json?.deleted))
	}

	section('v2 delete: bounded concurrency from the plugin config')
	{
		const ids = Array.from({ length: 8 }, (_unused, index) => `conc-${index}`)
		const cases = [
			{ configured: 2, cap: 2, label: 'maxConcurrency:2' },
			{ configured: 0, cap: 1, label: 'maxConcurrency:0 clamps to 1' },
			{ configured: 99, cap: 8, label: 'maxConcurrency:99 clamps to 8' },
			{ configured: 'x', cap: 4, label: 'a non-integer falls back to 4' },
			{ configured: 3.5, cap: 4, label: 'a fractional value falls back to 4' },
		]
		for (const testCase of cases) {
			const dir = join(fixtureRoot, `conc-${String(testCase.configured)}`)
			const locations = {}
			for (const id of ids) {
				const path = join(dir, id, 'session.v1.jsonl')
				await writeAgedFile(path, 10)
				locations[id] = path
			}
			let inFlight = 0
			let peak = 0
			const persistence = {
				async stat(id) {
					inFlight += 1
					peak = Math.max(peak, inFlight)
					await new Promise((resolve) => setTimeout(resolve, 12))
					inFlight -= 1
					return { header: { id }, revision: 'r', location: { kind: 'jsonl', path: locations[id] } }
				},
			}
			const m = makeContext({ sessionPersistence: persistence, workspaceRegistry: fakeRegistry(), sessionController: fakeController() })
			apply(m.ctx, { maxConcurrency: testCase.configured })
			const result = await call(m.routes[0], { body: JSON.stringify({ op: 'delete', sessionIds: ids, permanent: true }) })
			check(`${testCase.label}: parallel work stays within ${testCase.cap}`, peak <= testCase.cap && peak > 0, `peak ${peak}`)
			check(`${testCase.label}: deletes every id`, result.json?.deleted?.length === ids.length, JSON.stringify(result.json?.deleted))
			if (testCase.cap > 1) check(`${testCase.label}: actually runs in parallel`, peak >= 2, `peak ${peak}`)
			check(`${testCase.label}: results keep request order`, JSON.stringify(result.json?.deleted) === JSON.stringify(ids), JSON.stringify(result.json?.deleted))
		}
	}

	section('v2 gc: fixture attachment store (preview, dryRun, execute, idempotency)')
	{
		const gcHome = join(fixtureRoot, 'gchome')
		const store = join(gcHome, 'attachments', 'v1')
		const previousHome = process.env.DSH_HOME

		const imageA = digestOf('image-a')
		const imageB = digestOf('image-b')
		const imageC = digestOf('image-c')
		const imageD = digestOf('image-boundary')
		const imageX = digestOf('image-unreferenced')
		const imageY = digestOf('image-recent')
		const imageL = digestOf('image-symlinked')
		const fileF = digestOf('file-referenced')
		const fileG = digestOf('file-unreferenced')
		const cacheH = digestOf('request-image-cache')

		// Surviving logs referencing A/F (with D split across the 64 KiB read boundary), B, and C (checkpoint).
		await mkdir(join(gcHome, 'sessions', 'proj-alpha', 'session-alpha'), { recursive: true })
		await writeFile(
			join(gcHome, 'sessions', 'proj-alpha', 'session-alpha', 'session.v4.jsonl'),
			`${boundaryLogContent(imageD)}{"type":"user/message","data":{"text":"sha256:${imageA} and ${fileF}"}}\n`,
		)
		await mkdir(join(gcHome, 'sessions', 'proj-alpha', 'session-beta'), { recursive: true })
		// A real log is one zstd frame per append: the reference lives in a later frame, which a
		// decoder that stops at the first frame would never see (and would collect imageB).
		await writeFile(
			join(gcHome, 'sessions', 'proj-alpha', 'session-beta', 'session.v3.jsonl.zstd'),
			Buffer.concat([
				zstdCompressSync(Buffer.from('{"type":"session","version":4,"id":"session-beta"}\n', 'utf8')),
				zstdCompressSync(Buffer.from('{"type":"user/message","data":{"text":"hello"}}\n', 'utf8')),
				zstdCompressSync(Buffer.from(`{"type":"tool/result","data":{"attachmentId":"sha256:${imageB}"}}\n`, 'utf8')),
			]),
		)
		await mkdir(join(gcHome, 'storages', 'session_projcache', 'sessions'), { recursive: true })
		await writeFile(
			join(gcHome, 'storages', 'session_projcache', 'sessions', 'session-gamma.json'),
			JSON.stringify({ values: { attachments: [`sha256:${imageC}`] } }),
		)

		// Durable store.
		await writeAgedFile(join(store, 'objects', imageA.slice(0, 2), imageA), 400)
		await writeAgedFile(join(store, 'objects', imageB.slice(0, 2), imageB), 300)
		await writeAgedFile(join(store, 'objects', imageC.slice(0, 2), imageC), 200)
		await writeAgedFile(join(store, 'objects', imageD.slice(0, 2), imageD), 100)
		await writeAgedFile(join(store, 'objects', imageX.slice(0, 2), imageX), 700)
		await writeFreshFile(join(store, 'objects', imageY.slice(0, 2), imageY), 800)
		await writeAgedFile(join(store, 'file-objects', fileF.slice(0, 2), fileF), 900)
		await writeAgedFile(join(store, 'file-objects', fileG.slice(0, 2), fileG), 1100)
		await mkdir(join(store, 'files', fileF.slice(0, 2), fileF), { recursive: true })
		await link(join(store, 'file-objects', fileF.slice(0, 2), fileF), join(store, 'files', fileF.slice(0, 2), fileF, 'kept.pdf'))
		await mkdir(join(store, 'files', fileG.slice(0, 2), fileG), { recursive: true })
		await link(join(store, 'file-objects', fileG.slice(0, 2), fileG), join(store, 'files', fileG.slice(0, 2), fileG, 'gone.txt'))
		await writeAgedFile(join(store, 'request-images', cacheH.slice(0, 2), cacheH), 250)
		await writeAgedFile(join(store, 'tmp', 'staging.part'), 999)
		// Guards: a symlink leaf with a digest name, and an unexpected directory inside objects/.
		await mkdir(join(store, 'objects', imageL.slice(0, 2)), { recursive: true })
		await symlink(join(store, 'objects', imageA.slice(0, 2), imageA), join(store, 'objects', imageL.slice(0, 2), imageL))
		await mkdir(join(store, 'objects', digestOf('unexpected-dir').slice(0, 2), digestOf('unexpected-dir')), { recursive: true })
		await writeAgedFile(join(store, 'objects', digestOf('unexpected-dir').slice(0, 2), digestOf('unexpected-dir'), 'inside.bin'), 64)

		const before = await snapshotTree(store)
		process.env.DSH_HOME = gcHome
		const m = makeContext({})
		apply(m.ctx, {})
		const r = m.routes[0]

		const preview = await call(r, { body: JSON.stringify({ op: 'gc-preview' }) })
		const report = preview.json?.report ?? {}
		check('gc-preview → 200 ok', preview.status === 200 && preview.json?.ok === true, JSON.stringify(preview.json))
		check(
			'preview carries exactly the documented report keys',
			Object.keys(report).sort().join(',') === 'cacheBytes,cacheFiles,deletableBytes,groups,referencedFiles,referencedImages,sessionsScanned,storePresent,unresolvedCount,unresolvedSample',
			JSON.stringify(Object.keys(report).sort()),
		)
		check('preview counts the scanned sessions', report.sessionsScanned === 2, JSON.stringify(report.sessionsScanned))
		check('preview detects every referenced image, including the chunk-boundary digest', report.referencedImages === 4, JSON.stringify(report.referencedImages))
		check('preview detects the referenced file object', report.referencedFiles === 1, JSON.stringify(report.referencedFiles))
		check('preview lists the three durable groups', Array.isArray(report.groups) && report.groups.length === 3 && report.groups.map((group) => group.name).join(',') === 'objects,file-objects,files', JSON.stringify(report.groups?.map((group) => group.name)))
		const objectsGroup = report.groups?.find((group) => group.name === 'objects') ?? {}
		check('objects group counts every digest-named regular file', objectsGroup.files === 6, JSON.stringify(objectsGroup))
		check('objects deletable excludes referenced, recent and symlinked entries', objectsGroup.deletableFiles === 1 && objectsGroup.deletableBytes === 700, JSON.stringify(objectsGroup))
		const fileObjectsGroup = report.groups?.find((group) => group.name === 'file-objects') ?? {}
		check('file-objects deletable excludes the referenced object', fileObjectsGroup.deletableFiles === 1 && fileObjectsGroup.deletableBytes === 1100, JSON.stringify(fileObjectsGroup))
		const filesGroup = report.groups?.find((group) => group.name === 'files') ?? {}
		check('files group sees both hard-link aliases', filesGroup.files === 2, JSON.stringify(filesGroup))
		check('report-level deletableBytes dedupes the hard link', report.deletableBytes === 700 + 1100, JSON.stringify(report.deletableBytes))
		check('cache is reported separately and not counted as deletable', report.cacheFiles === 1 && report.cacheBytes === 250, JSON.stringify({ cacheFiles: report.cacheFiles, cacheBytes: report.cacheBytes }))
		check('preview never writes', JSON.stringify([...(await snapshotTree(store))]) === JSON.stringify([...before]))
		check('preview writes no audit line', (await exists(join(gcHome, 'logs', 'session-manager.jsonl'))) === false)

		const withCachePreview = await call(r, { body: JSON.stringify({ op: 'gc-preview', includeRequestImageCache: true }) })
		check(
			'includeRequestImageCache adds the cache group',
			withCachePreview.json?.report?.groups?.length === 4 && withCachePreview.json.report.groups[3]?.name === 'request-images',
			JSON.stringify(withCachePreview.json?.report?.groups?.map((group) => group.name)),
		)

		const dry = await call(r, { body: JSON.stringify({ op: 'gc', dryRun: true }) })
		check('gc dryRun reports the would-be numbers', dry.json?.deletedFiles === 3 && dry.json?.freedBytes === 700 + 1100, JSON.stringify(dry.json))
		check('gc dryRun deletes nothing', JSON.stringify([...(await snapshotTree(store))]) === JSON.stringify([...before]))

		const run = await call(r, { body: JSON.stringify({ op: 'gc' }) })
		check('gc → 200 ok', run.status === 200 && run.json?.ok === true, JSON.stringify(run.json))
		check('gc reports the documented keys', Object.keys(run.json ?? {}).sort().join(',') === 'auditLog,deletedFiles,failed,freedBytes,groups,ok,verify', JSON.stringify(Object.keys(run.json ?? {}).sort()))
		check('a clean cleanup verifies itself', run.json?.verify?.ok === true && run.json?.verify?.missingCount === 0, JSON.stringify(run.json?.verify))
		check('gc deletes exactly the unreferenced durable objects', run.json?.deletedFiles === 3 && run.json?.freedBytes === 700 + 1100, JSON.stringify(run.json))
		check('gc removed the unreferenced image', (await exists(join(store, 'objects', imageX.slice(0, 2), imageX))) === false)
		check('gc removed both hard-link aliases', (await exists(join(store, 'file-objects', fileG.slice(0, 2), fileG))) === false && (await exists(join(store, 'files', fileG.slice(0, 2), fileG))) === false)
		check('gc kept every referenced object', (await exists(join(store, 'objects', imageA.slice(0, 2), imageA))) === true && (await exists(join(store, 'objects', imageD.slice(0, 2), imageD))) === true)
		check('gc kept the image referenced only by a later zstd frame', (await exists(join(store, 'objects', imageB.slice(0, 2), imageB))) === true)
		check('gc kept the recent upload inside the grace window', (await exists(join(store, 'objects', imageY.slice(0, 2), imageY))) === true)
		check('gc kept the referenced file object and its alias', (await exists(join(store, 'file-objects', fileF.slice(0, 2), fileF))) === true && (await exists(join(store, 'files', fileF.slice(0, 2), fileF, 'kept.pdf'))) === true)
		check('gc left the request-image cache alone by default', (await exists(join(store, 'request-images', cacheH.slice(0, 2), cacheH))) === true)
		const linkedSurvived = (await readdir(join(store, 'objects', imageL.slice(0, 2)), { withFileTypes: true })).some((entry) => entry.name === imageL && entry.isSymbolicLink() === true)
		check('gc never follows a symlink out of the store', linkedSurvived === true && (await exists(join(store, 'objects', imageA.slice(0, 2), imageA))) === true, String(linkedSurvived))
		check('gc never deletes inside tmp/', (await exists(join(store, 'tmp', 'staging.part'))) === true)
		check('gc skips an unexpected directory inside a group', (await exists(join(store, 'objects', digestOf('unexpected-dir').slice(0, 2), digestOf('unexpected-dir'), 'inside.bin'))) === true)

		const again = await call(r, { body: JSON.stringify({ op: 'gc' }) })
		check('a second gc is idempotent', again.json?.deletedFiles === 0 && again.json?.freedBytes === 0, JSON.stringify(again.json))

		const withCache = await call(r, { body: JSON.stringify({ op: 'gc', includeRequestImageCache: true }) })
		check('gc with includeRequestImageCache removes the derived cache', withCache.json?.deletedFiles === 1 && withCache.json?.freedBytes === 250, JSON.stringify(withCache.json))
		check('the cache file is gone', (await exists(join(store, 'request-images', cacheH.slice(0, 2), cacheH))) === false)

		const auditLines = (await readFile(join(gcHome, 'logs', 'session-manager.jsonl'), 'utf8')).trim().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
		check('every gc run appended one audit line', auditLines.length === 3, JSON.stringify(auditLines.length))
		check(
			'gc audit lines are shaped like the documented record',
			auditLines.every((line) => line.op === 'gc' && line.actor === 'ui' && Array.isArray(line.sessions) && typeof line.freedBytes === 'number' && typeof line.failed === 'number' && typeof line.time === 'string'),
			JSON.stringify(auditLines[0]),
		)

		process.env.DSH_HOME = previousHome
	}

	section('v8 safety: a move that cannot be restored is rolled back, never left in the bin')
	{
		const home = join(fixtureRoot, 'safety-move')
		process.env.DSH_HOME = home
		const sessionsRoot = join(home, 'sessions')
		// A session whose directory holds no log at all: the move can succeed, a restore could not.
		// The backend is made to report the directory itself, so the resolver accepts it.
		const hollowDir = join(sessionsRoot, '--s--', 'hollow')
		await mkdir(hollowDir, { recursive: true })
		await writeFile(join(hollowDir, 'session.lock'), '')
		const persistence = fakePersistence({ hollow: hollowDir })
		const m = makeContext({ sessionPersistence: persistence })
		apply(m.ctx, {})
		const r = m.routes[0]

		const result = await call(r, { body: JSON.stringify({ op: 'delete', sessionIds: ['hollow'] }) })
		check('a verify failure is reported, not swallowed', result.json?.failed?.[0]?.code === 'trash-verify-failed', JSON.stringify(result.json))
		check('the session is not left in the bin', JSON.stringify(result.json?.trashed) === '[]', JSON.stringify(result.json?.trashed))
		check('the rejection left no entry behind', (await exists(join(home, 'trash', 'sessions', 'hollow'))) === false)
		check('the rolled-back session is exactly where it was', (await exists(hollowDir)) === true && (await readdir(hollowDir)).length === 1, JSON.stringify(await readdir(hollowDir)))
	}

	section('v8 safety: irreversible removals refuse to orphan a live session')
	{
		const home = join(fixtureRoot, 'safety-lineage')
		process.env.DSH_HOME = home
		const sessionsRoot = join(home, 'sessions')
		const parent = await makeSessionDir(sessionsRoot, '--s--', 'lineage-parent')
		const child = await makeSessionDir(sessionsRoot, '--s--', 'lineage-child')
		const persistence = fakePersistence({
			'lineage-parent': join(parent.dir, 'session.v4.jsonl.zstd'),
			'lineage-child': join(child.dir, 'session.v4.jsonl.zstd'),
		})
		const controller = fakeController({ items: [
			{ sessionId: 'lineage-parent', updatedAt: Date.now() - 3600000, blank: false, running: false },
			{ sessionId: 'lineage-child', updatedAt: Date.now() - 3600000, blank: false, running: false, parentSessionId: 'lineage-parent', origin: 'subagent' },
		] })
		const m = makeContext({ sessionPersistence: persistence, sessionController: controller })
		apply(m.ctx, {})
		const r = m.routes[0]

		// Moving to the bin stays allowed: it is reversible.
		const trashed = await call(r, { body: JSON.stringify({ op: 'delete', sessionIds: ['lineage-parent'] }) })
		check('a parent may still be moved to the bin', JSON.stringify(trashed.json?.trashed) === '["lineage-parent"]', JSON.stringify(trashed.json))

		const blocked = await call(r, { body: JSON.stringify({ op: 'trash-purge', sessionIds: ['lineage-parent'] }) })
		check('purging a parent with live descendants is refused', blocked.json?.failed?.[0]?.code === 'has-descendants', JSON.stringify(blocked.json))
		check('the refused entry survives', (await exists(join(home, 'trash', 'sessions', 'lineage-parent'))) === true)

		const forced = await call(r, { body: JSON.stringify({ op: 'trash-purge', sessionIds: ['lineage-parent'], force: true }) })
		check('an explicit force purges it', JSON.stringify(forced.json?.purged) === '["lineage-parent"]', JSON.stringify(forced.json))
		check('the forced purge removed the directory', (await exists(join(home, 'trash', 'sessions', 'lineage-parent'))) === false)

		// The permanent path has the same guard.
		const permanent = await call(r, { body: JSON.stringify({ op: 'delete', sessionIds: ['lineage-child'], permanent: true }) })
		check('the permanent path removes a childless session', JSON.stringify(permanent.json?.deleted) === '["lineage-child"]', JSON.stringify(permanent.json))
	}

	section('v8 safety: trash listings expose the descendant count, purge honours it')
	{
		const home = join(fixtureRoot, 'safety-listing')
		process.env.DSH_HOME = home
		const sessionsRoot = join(home, 'sessions')
		const parent = await makeSessionDir(sessionsRoot, '--s--', 'counted-parent')
		await makeSessionDir(sessionsRoot, '--s--', 'counted-child')
		const persistence = fakePersistence({ 'counted-parent': join(parent.dir, 'session.v4.jsonl.zstd') })
		const controller = fakeController({ items: [
			{ sessionId: 'counted-parent', updatedAt: Date.now() - 3600000, blank: false, running: false },
			{ sessionId: 'counted-child', updatedAt: Date.now() - 3600000, blank: false, running: false, parentSessionId: 'counted-parent', origin: 'subagent' },
		] })
		const m = makeContext({ sessionPersistence: persistence, sessionController: controller })
		apply(m.ctx, {})
		await call(m.routes[0], { body: JSON.stringify({ op: 'delete', sessionIds: ['counted-parent'] }) })
		const listing = await call(m.routes[0], { body: JSON.stringify({ op: 'trash-list' }) })
		check('the listing reports how many live sessions derive from an entry', listing.json?.items?.[0]?.descendantCount === 1, JSON.stringify(listing.json?.items?.[0]))
	}

	section('v8 safety: concurrent destructive requests are serialized')
	{
		const home = join(fixtureRoot, 'safety-serial')
		process.env.DSH_HOME = home
		const sessionsRoot = join(home, 'sessions')
		const ids = ['serial-a', 'serial-b', 'serial-c']
		const locations = {}
		for (const id of ids) {
			const made = await makeSessionDir(sessionsRoot, '--s--', id)
			locations[id] = join(made.dir, 'session.v4.jsonl.zstd')
		}
		const m = makeContext({ sessionPersistence: fakePersistence(locations) })
		apply(m.ctx, {})
		const r = m.routes[0]
		const [first, second, third] = await Promise.all(
			ids.map((id) => call(r, { body: JSON.stringify({ op: 'delete', sessionIds: [id] }) })),
		)
		const trashed = [first, second, third].flatMap((result) => result.json?.trashed ?? [])
		check('every concurrent move landed', trashed.length === ids.length, JSON.stringify(trashed))
		const entries = await readdir(join(home, 'trash', 'sessions'))
		check('each concurrent move produced exactly one entry', entries.length === ids.length, JSON.stringify(entries))
	}

	section('v7 risk: the policy is data, the evaluator is pure, and the Host is the only judge')
	{
		const home = join(fixtureRoot, 'risk-home')
		process.env.DSH_HOME = home
		const sessionsRoot = join(home, 'sessions')
		const DAY = 86400000
		const now = Date.now()
		const mk = (id) => makeSessionDir(sessionsRoot, '--r--', id)
		const ids = ['r-pinned', 'r-running', 'r-parent', 'r-child', 'r-blank', 'r-sub', 'r-today', 'r-week', 'r-large', 'r-stale', 'r-ancient']
		for (const id of ids) await mk(id)
		const locations = {}
		const sizes = {}
		for (const id of ids) locations[id] = join(sessionsRoot, '--r--', id, 'session.v4.jsonl.zstd')
		sizes['r-large'] = 30 * 1024 * 1024
		sizes['r-stale'] = 1024
		const items = [
			{ sessionId: 'r-pinned', updatedAt: now - 40 * DAY, blank: false, running: false },
			{ sessionId: 'r-running', updatedAt: now - 40 * DAY, blank: false, running: true },
			{ sessionId: 'r-parent', updatedAt: now - 40 * DAY, blank: false, running: false },
			{ sessionId: 'r-child', updatedAt: now - 40 * DAY, blank: false, running: false, origin: 'subagent', parentSessionId: 'r-parent' },
			{ sessionId: 'r-blank', updatedAt: now - 60 * 1000, blank: true, running: false },
			{ sessionId: 'r-sub', updatedAt: now - 3 * DAY, blank: false, running: false, origin: 'subagent' },
			{ sessionId: 'r-today', updatedAt: now - 60 * 60 * 1000, blank: false, running: false },
			{ sessionId: 'r-week', updatedAt: now - 3 * DAY, blank: false, running: false },
			{ sessionId: 'r-large', updatedAt: now - 20 * DAY, blank: false, running: false },
			{ sessionId: 'r-stale', updatedAt: now - 20 * DAY, blank: false, running: false },
			{ sessionId: 'r-ancient', updatedAt: now - 400 * DAY, blank: false, running: false },
		]
		const persistence = fakePersistence(locations, sizes)
		const controller = fakeController({ items })
		const registry = { archivedSessionIds: ['r-ancient'], pinnedSessionIds: ['r-pinned'] }
		const m = makeContext({ sessionPersistence: persistence, sessionController: controller, workspaceRegistry: registry })
		apply(m.ctx, {})
		const r = m.routes[0]

		const risk = await call(r, { body: JSON.stringify({ op: 'risk' }) })
		check('risk overview answers with a policy version', risk.status === 200 && risk.json?.ok === true && Number.isInteger(risk.json?.policyVersion), JSON.stringify(risk.json && { ok: risk.json.ok, policyVersion: risk.json.policyVersion }))
		const verdict = (id) => risk.json?.items?.[id] ?? {}
		check('pinned dominates everything', verdict('r-pinned').tier === 'high' && verdict('r-pinned').reasons.some((reason) => reason.key === 'risk.reason.pinned'), JSON.stringify(verdict('r-pinned')))
		check('running is a warning', verdict('r-running').tier === 'high', JSON.stringify(verdict('r-running')))
		check('a session others derive from is a warning', verdict('r-parent').tier === 'high' && verdict('r-parent').reasons.some((reason) => reason.key === 'risk.reason.children' && reason.count === 1), JSON.stringify(verdict('r-parent')))
		check('a derived session itself is a recommendation', verdict('r-child').tier === 'low', JSON.stringify(verdict('r-child')))
		check('a blank session is a recommendation even when it is brand new', verdict('r-blank').tier === 'low', JSON.stringify(verdict('r-blank')))
		check('a subagent session is a recommendation', verdict('r-sub').tier === 'low', JSON.stringify(verdict('r-sub')))
		check('activity today is a warning', verdict('r-today').tier === 'high', JSON.stringify(verdict('r-today')))
		check('activity this week is "check first"', verdict('r-week').tier === 'medium', JSON.stringify(verdict('r-week')))
		check('a large log is "check first" even when idle', verdict('r-large').tier === 'medium' && verdict('r-large').reasons.some((reason) => reason.key === 'risk.reason.large'), JSON.stringify(verdict('r-large')))
		check('an idle ordinary session is a recommendation', verdict('r-stale').tier === 'low', JSON.stringify(verdict('r-stale')))
		check('an archived session idle for over a month is a recommendation', verdict('r-ancient').tier === 'low' && verdict('r-ancient').reasons.some((reason) => reason.key === 'risk.reason.archivedIdle'), JSON.stringify(verdict('r-ancient')))
		check('verdicts carry the rule ids that produced them', Array.isArray(verdict('r-pinned').ruleIds) && verdict('r-pinned').ruleIds.includes('pinned'), JSON.stringify(verdict('r-pinned').ruleIds))

		// Missing facts must never be read as "safe".
		const noSizes = makeContext({
			sessionPersistence: fakePersistence(locations),
			sessionController: fakeController({ items: [{ sessionId: 'r-stale', updatedAt: now - 20 * DAY, blank: false, running: false }] }),
			workspaceRegistry: { archivedSessionIds: [], pinnedSessionIds: [] },
		})
		apply(noSizes.ctx, {})
		const degraded = await call(noSizes.routes[0], { body: JSON.stringify({ op: 'risk' }) })
		const degradedVerdict = degraded.json?.items?.['r-stale'] ?? {}
		check('an unknown size downgrades a recommendation to "check first"', degradedVerdict.tier === 'medium' && degradedVerdict.degraded === true, JSON.stringify(degradedVerdict))

		const stats = await call(r, { body: JSON.stringify({ op: 'risk-stats' }) })
		check('risk-stats returns a histogram over the corpus', stats.json?.ok === true && stats.json?.total === ids.length && typeof stats.json?.tiers?.low === 'number', JSON.stringify(stats.json?.tiers))
		check('risk-stats counts the rules that fired', typeof stats.json?.rules?.pinned === 'number' && stats.json.rules.pinned >= 1, JSON.stringify(stats.json?.rules))

		// Calibration: a candidate policy can be tried without touching the shipped one.
		const candidate = {
			policyVersion: 99,
			rules: [{ id: 'everything', tier: 'medium', reason: 'risk.reason.other', priority: 1, when: { fact: 'blank', op: 'isFalse' } }],
			fallback: { tier: 'low', reason: 'risk.reason.blank' },
		}
		const tuned = await call(r, { body: JSON.stringify({ op: 'risk-stats', policy: candidate }) })
		check('a candidate policy is evaluated, not installed', tuned.json?.policyVersion === 99 && tuned.json?.tiers?.medium === 10 && tuned.json?.tiers?.low === 1, JSON.stringify({ v: tuned.json?.policyVersion, tiers: tuned.json?.tiers }))
		const after = await call(r, { body: JSON.stringify({ op: 'risk' }) })
		check('the shipped policy is unchanged after a calibration run', after.json?.policyVersion === risk.json?.policyVersion)

		const bad = await call(r, { body: JSON.stringify({ op: 'risk-stats', policy: { policyVersion: 1, rules: [] } }) })
		check('an invalid candidate policy is a client error', bad.status === 400 && bad.json?.ok === false, JSON.stringify(bad.json))
	}

	section('v7 risk: the distribution stays useful on a realistic corpus')
	{
		const home = join(fixtureRoot, 'risk-corpus-home')
		process.env.DSH_HOME = home
		const sessionsRoot = join(home, 'sessions')
		const DAY = 86400000
		const now = Date.now()
		const items = []
		const locations = {}
		// 60 sessions: mostly old and idle, a handful active this week — the shape of a real home.
		for (let index = 0; index < 60; index += 1) {
			const id = `c-${index}`
			await makeSessionDir(sessionsRoot, '--c--', id)
			locations[id] = join(sessionsRoot, '--c--', id, 'session.v4.jsonl.zstd')
			const age = index < 6 ? 2 * 3600000 : index < 14 ? 3 * DAY : 10 * DAY + index * DAY
			items.push({ sessionId: id, updatedAt: now - age, blank: false, running: false })
		}
		const corpusSizes = {}
		for (const id of Object.keys(locations)) corpusSizes[id] = 1024
		const m = makeContext({
			sessionPersistence: fakePersistence(locations, corpusSizes),
			sessionController: fakeController({ items }),
			workspaceRegistry: { archivedSessionIds: [], pinnedSessionIds: [] },
		})
		apply(m.ctx, {})
		const stats = await call(m.routes[0], { body: JSON.stringify({ op: 'risk-stats' }) })
		const tiers = stats.json?.tiers ?? { low: 0, medium: 0, high: 0 }
		const share = (value) => value / Math.max(1, stats.json?.total ?? 1)
		// The failure this guards against: a "check first" tier that swallows the corpus is advice
		// nobody can act on. The recommendation tier is expected to be the bulk — that is the point.
		check('the caution tiers stay selective', Math.max(share(tiers.medium), share(tiers.high)) <= 0.7, JSON.stringify(tiers))
		check('the recommendation tier is actually populated', share(tiers.low) >= 0.2, JSON.stringify(tiers))
		check('the warning tier stays for the active few', tiers.high <= 12, JSON.stringify(tiers))
	}

	section('v4 gc: the cleanup proves itself, and reports references it cannot satisfy')
	{
		const home = join(fixtureRoot, 'gc-verify-home')
		process.env.DSH_HOME = home
		const sessionsRoot = join(home, 'sessions')
		const present = 'b'.repeat(64)
		const absent = 'c'.repeat(64)
		const unrelated = 'd'.repeat(64)
		const made = await makeSessionDir(sessionsRoot, '--p--', 'gc-verify')
		// Two real attachment references (one of them already lost) plus an unrelated digest that
		// only looks like one — a Docker-style `sha256:` value must never be reported as missing.
		const log = [
			JSON.stringify({ type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: `ImageID=sha256:${unrelated} (docker)` }] } } }),
			JSON.stringify({ type: 'user/message', data: { message: { role: 'user', content: [{ type: 'image', attachment: { attachmentId: `sha256:${present}`, mediaType: 'image/png', bytes: 2, width: 1, height: 1 } }] } } }),
			JSON.stringify({ type: 'user/message', data: { message: { role: 'user', content: [{ type: 'image', attachment: { attachmentId: `sha256:${absent}`, mediaType: 'image/png', bytes: 3, width: 1, height: 1 } }] } } }),
		].join('\n') + '\n'
		await writeFile(join(made.dir, 'session.v4.jsonl'), log)
		await rm(join(made.dir, 'session.v4.jsonl.zstd'), { force: true })
		const store = join(home, 'attachments', 'v1')
		await mkdir(join(store, 'objects', present.slice(0, 2)), { recursive: true })
		await writeFile(join(store, 'objects', present.slice(0, 2), present), 'img')
		const old = new Date(Date.now() - 60 * 60 * 1000)
		await utimes(join(store, 'objects', present.slice(0, 2), present), old, old)
		const persistence = fakePersistence({ 'gc-verify': join(made.dir, 'session.v4.jsonl') })
		const m = makeContext({ sessionPersistence: persistence })
		apply(m.ctx, {})
		const r = m.routes[0]

		const preview = await call(r, { body: JSON.stringify({ op: 'gc-preview' }) })
		check('preview counts the reference it cannot satisfy', preview.json?.report?.unresolvedCount === 1, JSON.stringify(preview.json?.report))
		check('preview names the missing reference', JSON.stringify(preview.json?.report?.unresolvedSample) === JSON.stringify([absent]), JSON.stringify(preview.json?.report?.unresolvedSample))
		check('an unrelated digest in a log is not reported as a lost attachment', preview.json?.report?.unresolvedCount === 1)

		const run = await call(r, { body: JSON.stringify({ op: 'gc' }) })
		check('gc reports a failed verification when a reference cannot resolve', run.json?.verify?.ok === false && run.json?.verify?.missingCount === 1, JSON.stringify(run.json?.verify))
		check('gc verification reports what it checked', run.json?.verify?.checked === 2, JSON.stringify(run.json?.verify))
		check('a lost reference does not stop the cleanup from removing dead weight', run.json?.ok === true)

		{
			const lines = (await readFile(join(home, 'logs', 'session-manager.jsonl'), 'utf8')).trim().split('\n')
			const record = lines.map((line) => JSON.parse(line)).filter((entry) => entry.op === 'gc').pop()
			check('the audit line records the verification outcome', record?.verify?.ok === false && record?.verify?.missingCount === 1, JSON.stringify(record))
		}

		// Restore the missing object, then the same run must verify cleanly.
		await mkdir(join(store, 'objects', absent.slice(0, 2)), { recursive: true })
		await writeFile(join(store, 'objects', absent.slice(0, 2), absent), 'img')
		const repaired = await call(r, { body: JSON.stringify({ op: 'gc' }) })
		check('a satisfied corpus verifies cleanly', repaired.json?.verify?.ok === true, JSON.stringify(repaired.json?.verify))
	}

	section('v2 gc: an unreadable reference document fails closed')
	{
		const gcHome = join(fixtureRoot, 'gcbad')
		const store = join(gcHome, 'attachments', 'v1')
		const orphan = digestOf('orphan-image')
		const previousHome = process.env.DSH_HOME
		await writeAgedFile(join(store, 'objects', orphan.slice(0, 2), orphan), 321)
		await mkdir(join(gcHome, 'sessions', 'proj', 'session-good'), { recursive: true })
		await writeFile(join(gcHome, 'sessions', 'proj', 'session-good', 'session.v1.jsonl'), '{"text":"nothing here"}\n')
		await mkdir(join(gcHome, 'sessions', 'proj', 'session-broken'), { recursive: true })
		await writeFile(join(gcHome, 'sessions', 'proj', 'session-broken', 'session.v9.jsonl.zstd'), Buffer.from('not zstd at all', 'utf8'))
		process.env.DSH_HOME = gcHome
		const m = makeContext({})
		apply(m.ctx, {})
		const r = m.routes[0]
		const preview = await call(r, { body: JSON.stringify({ op: 'gc-preview' }) })
		check('preview still answers when a log is unreadable', preview.status === 200 && preview.json?.ok === true, JSON.stringify(preview.json))
		const run = await call(r, { body: JSON.stringify({ op: 'gc' }) })
		check('gc deletes nothing when a reference document is unreadable', run.json?.deletedFiles === 0 && run.json?.freedBytes === 0, JSON.stringify(run.json))
		check('gc names the unreadable document in failed[]', (run.json?.failed ?? []).some((item) => String(item.path).includes('session.v9.jsonl.zstd') && typeof item.reason === 'string'), JSON.stringify(run.json?.failed))
		check('the orphan object survives the failed-closed run', (await exists(join(store, 'objects', orphan.slice(0, 2), orphan))) === true)
		process.env.DSH_HOME = previousHome
	}

	section('v2 gc: a missing attachment store is a no-op')
	{
		const previousHome = process.env.DSH_HOME
		process.env.DSH_HOME = join(fixtureRoot, 'empty-home')
		const m = makeContext({})
		apply(m.ctx, {})
		const preview = await call(m.routes[0], { body: JSON.stringify({ op: 'gc-preview' }) })
		check('preview without a store → zero report', preview.status === 200 && preview.json?.report?.deletableBytes === 0 && preview.json.report.groups.length === 0, JSON.stringify(preview.json))
		const run = await call(m.routes[0], { body: JSON.stringify({ op: 'gc' }) })
		check('gc without a store → zeroes', run.status === 200 && run.json?.deletedFiles === 0 && run.json?.freedBytes === 0, JSON.stringify(run.json))
		process.env.DSH_HOME = previousHome
	}

	section('v2 audit: an unwritable log path must not fail the request')
	{
		const previousHome = process.env.DSH_HOME
		const home = join(fixtureRoot, 'audit-home')
		await mkdir(home, { recursive: true })
		// `logs` exists as a FILE, so mkdir(logs, {recursive:true}) fails and the append cannot happen.
		await writeFile(join(home, 'logs'), 'not a directory')
		const dir = join(fixtureRoot, 'audit-slug', 'audit-session')
		await mkdir(dir, { recursive: true })
		const log = join(dir, 'session.v1.jsonl')
		await writeFile(log, 'x')
		process.env.DSH_HOME = home
		const m = makeContext({
			sessionPersistence: fakePersistence({ 'audit-session': log }),
			workspaceRegistry: fakeRegistry(),
			sessionController: fakeController(),
		})
		apply(m.ctx, { auditLog: true })
		const result = await call(m.routes[0], { body: JSON.stringify({ op: 'delete', sessionIds: ['audit-session'], permanent: true }) })
		check('delete succeeds even when the audit line cannot be written', result.status === 200 && result.json?.ok === true && JSON.stringify(result.json?.deleted) === '["audit-session"]', JSON.stringify(result.json))
		check('the session log was still removed', (await exists(dir)) === false)
		check('auditLog:false skips the file entirely', await (async () => {
			const dir2 = join(fixtureRoot, 'audit-off', 'audit-off-session')
			await mkdir(dir2, { recursive: true })
			await writeFile(join(dir2, 'session.v1.jsonl'), 'x')
			const offHome = join(fixtureRoot, 'audit-off-home')
			await mkdir(offHome, { recursive: true })
			const before = await exists(join(offHome, 'logs', 'session-manager.jsonl'))
			process.env.DSH_HOME = offHome
			const m2 = makeContext({
				sessionPersistence: fakePersistence({ 'audit-off-session': join(dir2, 'session.v1.jsonl') }),
				workspaceRegistry: fakeRegistry(),
				sessionController: fakeController(),
			})
			apply(m2.ctx, { auditLog: false })
			await call(m2.routes[0], { body: JSON.stringify({ op: 'delete', sessionIds: ['audit-off-session'], permanent: true }) })
			const after = await exists(join(offHome, 'logs', 'session-manager.jsonl'))
			return before === false && after === false
		})())
		process.env.DSH_HOME = previousHome
	}

	section('v3 wire: delete and gc responses carry auditLog')
	{
		const stubPersistence = fakePersistence({})
		makeSessionDir.toString()
		const home = join(fixtureRoot, 'home')
		process.env.DSH_HOME = home
		const m = makeContext({ sessionPersistence: stubPersistence })
		apply(m.ctx, {})
		const r = m.routes[0]
		const del = await call(r, { body: JSON.stringify({ op: 'delete', sessionIds: ['no-such-id'] }) })
		check(
			'delete wire JSON exposes auditLog (the v2 handler dropped it)',
			typeof del.json?.auditLog === 'string' && del.json.auditLog.endsWith('logs/session-manager.jsonl'),
			JSON.stringify(del.json),
		)
		check('delete wire JSON also carries the v3 trash fields', Array.isArray(del.json?.trashed) && typeof del.json?.trashedBytes === 'number', JSON.stringify(del.json))
		const gc = await call(r, { body: JSON.stringify({ op: 'gc', dryRun: true }) })
		check('gc dryRun wire JSON carries auditLog:null', gc.json?.ok === true && gc.json?.auditLog === null, JSON.stringify(gc.json))
		const listing = await call(r, { body: JSON.stringify({ op: 'trash-list' }) })
		check(
			'trash-list on an empty bin answers the documented shape',
			listing.status === 200 && listing.json?.ok === true && Array.isArray(listing.json?.items) && typeof listing.json?.retentionDays === 'number',
			JSON.stringify(listing.json),
		)
	}

	section('v3 trash: move → list → restore round-trip')
	{
		const home = join(fixtureRoot, 'trash-home')
		process.env.DSH_HOME = home
		const sessionsRoot = join(home, 'sessions')
		const { dir } = await makeSessionDir(sessionsRoot, '--proj--', 'trash-a')
		const persistence = fakePersistence({ 'trash-a': join(dir, 'session.v4.jsonl.zstd') })
		const registry = fakeRegistry({ archived: ['trash-a'] })
		const controller = fakeController({ items: [{ sessionId: 'trash-a', projections: { values: { title: 'trashed title' } } }] })
		const m = makeContext({ sessionPersistence: persistence, workspaceRegistry: registry, sessionController: controller })
		apply(m.ctx, { trashRetentionDays: 7 })
		const r = m.routes[0]

		const moved = await call(r, { body: JSON.stringify({ op: 'delete', sessionIds: ['trash-a'] }) })
		check('delete trashes by default', moved.json?.ok === true && JSON.stringify(moved.json?.trashed) === '["trash-a"]', JSON.stringify(moved.json))
		check('trashing reports freedBytes:0 and the moved byte count', moved.json?.freedBytes === 0 && moved.json?.trashedBytes > 0, JSON.stringify(moved.json))
		check('the session directory left its live location', (await exists(dir)) === false)
		const entryDir = join(home, 'trash', 'sessions', 'trash-a')
		check('the entry exists under trash/sessions/<id>', (await exists(entryDir)) === true)
		const sidecar = JSON.parse(await readFile(join(entryDir, '.dsh-trash.json'), 'utf8'))
		check('sidecar records the original path', sidecar.originalPath === dir, JSON.stringify(sidecar))
		check('sidecar records the retention deadline', typeof sidecar.expiresAt === 'number' && sidecar.expiresAt > sidecar.trashedAt, JSON.stringify(sidecar))
		check('sidecar carries the title for the panel', sidecar.title === 'trashed title', JSON.stringify(sidecar))
		check('trashing drops the durable archive marker', registry.calls.unarchive.includes('trash-a'))

		const listing = await call(r, { body: JSON.stringify({ op: 'trash-list' }) })
		const item = listing.json?.items?.[0]
		check('trash-list reports the entry', listing.json?.items?.length === 1 && item?.sessionId === 'trash-a', JSON.stringify(listing.json))
		check('trash-list reports remaining days', item?.expiresInDays === 7, JSON.stringify(item))
		check('trash-list reports the retention policy', listing.json?.retentionDays === 7, JSON.stringify(listing.json))

		const restored = await call(r, { body: JSON.stringify({ op: 'trash-restore', sessionIds: ['trash-a'] }) })
		check('restore succeeds', JSON.stringify(restored.json?.restored) === '["trash-a"]', JSON.stringify(restored.json))
		check('the session directory is back at its original path', (await exists(join(dir, 'session.v4.jsonl.zstd'))) === true)
		check('the sidecar does not leak into a restored session', (await exists(join(dir, '.dsh-trash.json'))) === false)
		check('the trash entry is gone', (await exists(entryDir)) === false)

		// The audit trail must describe what came back, not just an id.
		{
			const lines = (await readFile(join(home, 'logs', 'session-manager.jsonl'), 'utf8')).trim().split('\n')
			const records = lines.map((line) => JSON.parse(line))
			const restoredRecord = records.filter((entry) => entry.op === 'restore').pop()
			check(
				'the restore audit line records the title and size of the entry',
				restoredRecord?.sessions?.[0]?.title === 'trashed title' && restoredRecord?.sessions?.[0]?.bytes > 0,
				JSON.stringify(restoredRecord),
			)
			const trashRecord = records.filter((entry) => entry.op === 'trash').pop()
			check('the trash audit line records the trashed byte count', trashRecord?.freedBytes === 0 && typeof trashRecord?.sessions?.[0]?.bytes === 'number', JSON.stringify(trashRecord))
		}

		const missing = await call(r, { body: JSON.stringify({ op: 'trash-restore', sessionIds: ['nope'] }) })
		check('restoring a non-entry reports not-in-trash', missing.json?.failed?.[0]?.code === 'not-in-trash', JSON.stringify(missing.json))
	}

	section('v4 trash: the sidecar keeps the title even when auditing is off')
	{
		const home = join(fixtureRoot, 'trash-notitle')
		process.env.DSH_HOME = home
		const sessionsRoot = join(home, 'sessions')
		const made = await makeSessionDir(sessionsRoot, '--p--', 'untitled-gate')
		const persistence = fakePersistence({ 'untitled-gate': join(made.dir, 'session.v4.jsonl.zstd') })
		const controller = fakeController({ items: [{ sessionId: 'untitled-gate', projections: { values: { title: '有标题的会话' } } }] })
		const m = makeContext({ sessionPersistence: persistence, sessionController: controller })
		apply(m.ctx, { auditLog: false })
		const trashed = await call(m.routes[0], { body: JSON.stringify({ op: 'delete', sessionIds: ['untitled-gate'] }) })
		check('trashing works with auditing disabled', JSON.stringify(trashed.json?.trashed) === '["untitled-gate"]', JSON.stringify(trashed.json))
		const sidecar = JSON.parse(await readFile(join(home, 'trash', 'sessions', 'untitled-gate', '.dsh-trash.json'), 'utf8'))
		check('the recycle-bin sidecar still records the title', sidecar.title === '有标题的会话', JSON.stringify(sidecar))
		const listing = await call(m.routes[0], { body: JSON.stringify({ op: 'trash-list' }) })
		check('the listing shows the title, not the id', listing.json?.items?.[0]?.title === '有标题的会话', JSON.stringify(listing.json?.items?.[0]))
	}

	section('v3 trash: guards, expiry and purge')
	{
		const home = join(fixtureRoot, 'trash-guards')
		process.env.DSH_HOME = home
		const sessionsRoot = join(home, 'sessions')
		const one = await makeSessionDir(sessionsRoot, '--p--', 'guard-one')
		const two = await makeSessionDir(sessionsRoot, '--p--', 'guard-two')
		const persistence = fakePersistence({
			'guard-one': join(one.dir, 'session.v4.jsonl.zstd'),
			'guard-two': join(two.dir, 'session.v4.jsonl.zstd'),
		})
		const m = makeContext({ sessionPersistence: persistence })
		apply(m.ctx, {})
		const r = m.routes[0]

		// A pre-existing entry with the same id must not be overwritten.
		await mkdir(join(home, 'trash', 'sessions', 'guard-one'), { recursive: true })
		const clash = await call(r, { body: JSON.stringify({ op: 'delete', sessionIds: ['guard-one'] }) })
		check('an occupied trash slot is refused', clash.json?.failed?.[0]?.code === 'trash-entry-exists', JSON.stringify(clash.json))
		await rm(join(home, 'trash', 'sessions', 'guard-one'), { recursive: true, force: true })

		// Restore into an occupied original location must be refused.
		const trashed = await call(r, { body: JSON.stringify({ op: 'delete', sessionIds: ['guard-two'] }) })
		check('second delete trashes', JSON.stringify(trashed.json?.trashed) === '["guard-two"]', JSON.stringify(trashed.json))
		await mkdir(two.dir, { recursive: true })
		await writeFile(join(two.dir, 'session.v4.jsonl.zstd'), 'x')
		const blocked = await call(r, { body: JSON.stringify({ op: 'trash-restore', sessionIds: ['guard-two'] }) })
		check('restore refuses an occupied target', blocked.json?.failed?.[0]?.code === 'restore-target-exists', JSON.stringify(blocked.json))
		await rm(two.dir, { recursive: true, force: true })

		// Expiry: rewrite the sidecar deadline into the past; purge is what acts on it.
		const entryDir = join(home, 'trash', 'sessions', 'guard-two')
		const sidecarPath = join(entryDir, '.dsh-trash.json')
		const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8'))
		sidecar.expiresAt = Date.now() - 1000
		await writeFile(sidecarPath, JSON.stringify(sidecar), 'utf8')
		// Reading must never destroy: the expired entry stays visible (0 days left) until an
		// explicit purge or the retention timer removes it, so a restore can still rescue it.
		const listing = await call(r, { body: JSON.stringify({ op: 'trash-list' }) })
		check('an expired entry stays listed until something purges it', (listing.json?.items ?? []).some((item) => item.sessionId === 'guard-two' && item.expiresInDays === 0), JSON.stringify(listing.json))
		const rescued = await call(r, { body: JSON.stringify({ op: 'trash-restore', sessionIds: ['guard-two'] }) })
		check('a restore can still rescue an expired entry', JSON.stringify(rescued.json?.restored) === '["guard-two"]', JSON.stringify(rescued.json))
		check('the rescued session is back on disk', (await exists(join(two.dir, 'session.v4.jsonl.zstd'))) === true)

		// A second entry that expires after that listing, purged explicitly by the caller.
		const three = await makeSessionDir(sessionsRoot, '--p--', 'guard-three')
		const persistence3 = fakePersistence({ 'guard-three': join(three.dir, 'session.v4.jsonl.zstd') })
		const m3 = makeContext({ sessionPersistence: persistence3 })
		apply(m3.ctx, {})
		const r3 = m3.routes[0]
		await call(r3, { body: JSON.stringify({ op: 'delete', sessionIds: ['guard-three'] }) })
		const entryThree = join(home, 'trash', 'sessions', 'guard-three')
		const sidecarThree = JSON.parse(await readFile(join(entryThree, '.dsh-trash.json'), 'utf8'))
		sidecarThree.expiresAt = Date.now() - 1000
		await writeFile(join(entryThree, '.dsh-trash.json'), JSON.stringify(sidecarThree), 'utf8')
		const purged = await call(r3, { body: JSON.stringify({ op: 'trash-purge', expiredOnly: true }) })
		check('purge expiredOnly removes the expired entry', purged.json?.ok === true && (await exists(entryThree)) === false, JSON.stringify(purged.json))
		check('purge reports freed bytes', typeof purged.json?.freedBytes === 'number' && purged.json.freedBytes > 0, JSON.stringify(purged.json))
		{
			const lines = (await readFile(join(home, 'logs', 'session-manager.jsonl'), 'utf8')).trim().split('\n')
			const record = lines.map((line) => JSON.parse(line)).filter((entry) => entry.op === 'purge').pop()
			check(
				'the purge audit line records what was destroyed',
				record?.sessions?.[0]?.sessionId === 'guard-three' && record?.sessions?.[0]?.bytes > 0,
				JSON.stringify(record),
			)
		}
		check('purge carries auditLog', typeof purged.json?.auditLog === 'string', JSON.stringify(purged.json))

		const again = await call(r, { body: JSON.stringify({ op: 'trash-purge', expiredOnly: true }) })
		check('purging an empty bin is a no-op', again.json?.ok === true && JSON.stringify(again.json?.purged) === '[]', JSON.stringify(again.json))

		const badPurge = await call(r, { body: JSON.stringify({ op: 'trash-purge' }) })
		check('trash-purge without a selector → 400', badPurge.status === 400 && badPurge.json?.ok === false, JSON.stringify(badPurge.json))
	}

	section('v3 trash protects its attachments from the collector')
	{
		const home = join(fixtureRoot, 'trash-gc-home')
		process.env.DSH_HOME = home
		const sessionsRoot = join(home, 'sessions')
		const digest = 'a'.repeat(64)
		const log = `{"type":"user/message","data":{"message":{"content":[{"type":"image","attachment":{"attachmentId":"sha256:${digest}","mediaType":"image/png","bytes":2,"width":1,"height":1}}]}}}\n`
		const made = await makeSessionDir(sessionsRoot, '--p--', 'gc-trash')
		await writeFile(join(made.dir, 'session.v4.jsonl'), log)
		await rm(join(made.dir, 'session.v4.jsonl.zstd'), { force: true })
		const store = join(home, 'attachments', 'v1')
		await mkdir(join(store, 'objects', digest.slice(0, 2)), { recursive: true })
		const imagePath = join(store, 'objects', digest.slice(0, 2), digest)
		await writeFile(imagePath, 'img')
		const longAgo = new Date(Date.now() - 60 * 60 * 1000)
		await utimes(imagePath, longAgo, longAgo)
		const persistence = fakePersistence({ 'gc-trash': join(made.dir, 'session.v4.jsonl') })
		const m = makeContext({ sessionPersistence: persistence })
		apply(m.ctx, {})
		const r = m.routes[0]

		const trashed = await call(r, { body: JSON.stringify({ op: 'delete', sessionIds: ['gc-trash'] }) })
		check('session moved to trash for the gc test', JSON.stringify(trashed.json?.trashed) === '["gc-trash"]', JSON.stringify(trashed.json))
		const kept = await call(r, { body: JSON.stringify({ op: 'gc' }) })
		check(
			'a trashed session still protects its attachment',
			(await exists(join(store, 'objects', digest.slice(0, 2), digest))) === true && kept.json?.freedBytes === 0,
			JSON.stringify(kept.json),
		)
		const purge = await call(r, { body: JSON.stringify({ op: 'trash-purge', all: true }) })
		check('purge empties the bin', purge.json?.ok === true && (await exists(join(home, 'trash', 'sessions', 'gc-trash'))) === false, JSON.stringify(purge.json))
		const collected = await call(r, { body: JSON.stringify({ op: 'gc' }) })
		check(
			'after the purge the attachment becomes collectable',
			(await exists(join(store, 'objects', digest.slice(0, 2), digest))) === false && collected.json?.freedBytes > 0,
			JSON.stringify(collected.json),
		)
	}

	section('v3 trash: retention option parsing')
	{
		const cases = [
			[undefined, 30],
			[{ trashRetentionDays: 7 }, 7],
			[{ trashRetentionDays: 0 }, 0],
			[{ trashRetentionDays: -3 }, 0],
			[{ trashRetentionDays: 99999 }, 3650],
			[{ trashRetentionDays: 'x' }, 30],
			[{ trashRetentionDays: 3.9 }, 3],
		]
		for (const [config, expected] of cases) {
			const home = join(fixtureRoot, `retention-${String(expected)}-${config === undefined ? 'default' : 'set'}`)
			process.env.DSH_HOME = home
			const m = makeContext({})
			apply(m.ctx, config ?? {})
			const listing = await call(m.routes[0], { body: JSON.stringify({ op: 'trash-list' }) })
			check(`trashRetentionDays ${JSON.stringify(config?.trashRetentionDays ?? 'unset')} → ${expected}`, listing.json?.retentionDays === expected, JSON.stringify(listing.json))
		}
	}

	section('v3 trash: the hourly sweep timer is owned by the plugin')
	{
		process.env.DSH_HOME = join(fixtureRoot, 'timer-home')
		const timers = []
		const m = makeContext({})
		const holder = []
		m.ctx.interval = (callback, delay) => {
			const entry = { callback: () => {}, delay, disposed: false }
			void callback
			timers.push(entry)
			return () => {
				entry.disposed = true
			}
		}
		holder.push(m)
		apply(m.ctx, {})
		check('activation installs one hourly sweep', timers.length === 1 && timers[0].delay === 60 * 60 * 1000, JSON.stringify(timers.map((t) => t.delay)))
		for (const dispose of m.disposers) dispose()
		check('unloading the plugin disposes the sweep', timers[0].disposed === true)
	}

	section('v2 gc-preview against the live home (read-only)')
	{
		const previousHome = process.env.DSH_HOME
		delete process.env.DSH_HOME
		const liveHome = join(process.env.HOME ?? '/Users/ivanyin', '.dsh')
		const liveStore = join(liveHome, 'attachments', 'v1')
		const pathsBefore = await treePaths(liveStore)
		const m = makeContext({})
		apply(m.ctx, {})
		const preview = await call(m.routes[0], { body: JSON.stringify({ op: 'gc-preview' }) })
		const report = preview.json?.report
		const pathsAfter = await treePaths(liveStore)
		// Another session may legitimately add objects while this runs; what matters is that a
		// preview removed nothing.
		const removed = [...pathsBefore].filter((path) => pathsAfter.has(path) !== true)
		check('live preview answers ok', preview.status === 200 && preview.json?.ok === true, JSON.stringify(preview.json?.ok))
		check('live preview removed nothing from the real attachment store', removed.length === 0, `removed ${removed.length}: ${removed.slice(0, 3).join(', ')}`)
		if (report !== undefined) {
			console.log(`       sessionsScanned=${report.sessionsScanned} referencedImages=${report.referencedImages} referencedFiles=${report.referencedFiles}`)
			for (const group of report.groups ?? []) {
				console.log(`       ${group.name}: files=${group.files} bytes=${group.bytes} deletableFiles=${group.deletableFiles} deletableBytes=${group.deletableBytes}`)
			}
			console.log(`       deletableBytes=${report.deletableBytes} cacheFiles=${report.cacheFiles} cacheBytes=${report.cacheBytes}`)
		}
		process.env.DSH_HOME = previousHome
	}
	section('real stat (read-only): what sessionPersistence.stat(id).location actually is')
	{
		const sp = await mountRealBackend()
		if (sp === undefined) {
			console.log('  skip real stat probe (extracted tree or profile deps unavailable — set DSH_SRC to override)')
		} else {
			const listed = await sp.list()
			const withLocation = listed.filter((snapshot) => snapshot.location !== undefined)
			check('a real backend lists the profile sessions', listed.length > 0, `listed ${listed.length}`)
			check('every listed session reports a location', withLocation.length === listed.length, `${withLocation.length}/${listed.length}`)
			const sample = withLocation[0]
			if (sample !== undefined) {
				const value = await sp.stat(sample.header.id)
				const location = value?.location
				const logPath = location?.path
				check('stat(...).location.kind is the backend artifact kind', location?.kind === 'jsonl', JSON.stringify(location))
				check(
					'stat(...).location.path is the log FILE, not the session directory',
					typeof logPath === 'string' && /\/session\.v\d+\.jsonl(\.zstd)?$/.test(logPath),
					String(logPath),
				)
				check('dirname(location.path) is the directory named after the session id', typeof logPath === 'string' && basename(dirname(logPath)) === sample.header.id, `${String(logPath)} vs ${sample.header.id}`)
				check('that directory exists on disk', typeof logPath === 'string' && (await exists(dirname(logPath))) === true)
				check('stat of an unknown id returns undefined', (await sp.stat('no-such-session-xyz')) === undefined)
				console.log(`       stat(${sample.header.id}).location = ${JSON.stringify(location)}`)
				console.log(`       listed ${listed.length} sessions, ${withLocation.length} with a location`)
			}
		}
	}

	section('real layout (read-only): the delete guard matches disk')
	{
		const root = join(process.env.HOME ?? '/Users/ivanyin', '.dsh', 'sessions')
		let projects = []
		try {
			projects = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => join(root, e.name))
		} catch {
			projects = []
		}
		let sample
		let sampleLog
		for (const project of projects) {
			let sessions = []
			try {
				sessions = (await readdir(project, { withFileTypes: true })).filter((e) => e.isDirectory())
			} catch {
				continue
			}
			for (const session of sessions) {
				let files = []
				try {
					files = await readdir(join(project, session.name))
				} catch {
					continue
				}
				const log = files.find((f) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(f))
				if (log === undefined) continue
				const full = join(project, session.name, log)
				const info = await stat(full)
				if (sample === undefined || info.size < sample.size) {
					sample = { size: info.size, dir: join(project, session.name), log: full, name: session.name, file: log }
				}
			}
		}
		check('real session logs exist on disk', sample !== undefined)
		if (sample !== undefined) {
			check('a session log lives in a directory named after its id', basename(sample.dir) === sample.name, sample.dir)
			check('dirname(stat.location.path) is that session directory', dirname(sample.log) === sample.dir, sample.log)
			check('log filename is a generation artifact', /^session\.v\d+\.jsonl(\.zstd)?$/.test(sample.file), sample.file)
			let headerId
			if (sample.file.endsWith('.zstd') && sample.size < 8 * 1024 * 1024) {
				try {
					const text = zstdDecompressSync(await readFile(sample.log)).toString('utf8')
					headerId = JSON.parse(text.slice(0, text.indexOf('\n'))).id
				} catch {
					headerId = undefined
				}
			}
			check(
				'stored header id equals the directory name (when decompressible)',
				headerId === undefined || headerId === sample.name,
				`header=${String(headerId)} dir=${sample.name}`,
			)
			console.log(`       sample: ${sample.log}`)
		}
	}

	section('loader semantics (real Cordis, when the extracted tree is available)')
	{
		const cordisPath = process.env.DSH_CORDIS_PATH ?? '/Users/ivanyin/dsh-work/src/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
		let Context
		try {
			;({ Context } = await import(`file://${cordisPath}`))
		} catch {
			Context = undefined
		}
		if (Context === undefined) {
			console.log(`  skip Cordis probe (not found at ${cordisPath})`)
		} else {
			const root = new Context()
			const routes = []
			root.plugin({ name: 'session-manager', apply, inject: ['webServer'] })
			await new Promise((resolve) => setTimeout(resolve, 30))
			check('inactive (no route, no failure) while webServer is absent', routes.length === 0, `got ${routes.length}`)
			root.provide('webServer')
			root.set('webServer', {
				register(route) {
					routes.push(route)
					return () => {
						const at = routes.indexOf(route)
						if (at !== -1) routes.splice(at, 1)
					}
				},
			})
			await new Promise((resolve) => setTimeout(resolve, 50))
			check('activates and registers exactly one route when webServer mounts', routes.length === 1 && routes[0].path === '/plugins/session-manager/api', JSON.stringify(routes.map((r) => r.path)))
		}
	}

	section('summary')
	console.log(`  ${passed} checks passed, ${failures.length} failed`)
	if (failures.length > 0) {
		for (const name of failures) console.log(`   - ${name}`)
		process.exitCode = 1
	}
}

try {
	await main()
} finally {
	delete process.env.DSH_HOME
	await rm(fixtureRoot, { recursive: true, force: true })
}