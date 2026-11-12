/**
 * Logic harness for the session-manager client half (v2).
 *
 * The browser artifact cannot run here, so this emulates just enough of React
 * (hooks, createElement), a document with a keydown registry, the slot host and
 * the Host HTTP route to walk the real component: registration, rendering,
 * selection, size merge, delete feedback, attachment cleanup and batching.
 *
 * Run:  node tools/client-smoke.mjs            (Chinese strings, the primary UI)
 *       SM_LANG=en node tools/client-smoke.mjs  (English strings)
 *
 * It asserts instead of narrating: any failed check exits non-zero.
 */

/* ------------------------------------------------------------------ */
/* Harness state                                                       */
/* ------------------------------------------------------------------ */

const LOCALE = process.env.SM_LANG === 'en' ? 'en' : 'zh';
const results = [];
let currentCheck = null;

function check(name, run) {
  currentCheck = name;
  try {
    run();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    currentCheck = null;
  }
}

async function checkAsync(name, run) {
  currentCheck = name;
  try {
    await run();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    currentCheck = null;
  }
}

function assert(condition, message) {
  if (condition !== true) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* ------------------------------------------------------------------ */
/* Module load                                                         */
/* ------------------------------------------------------------------ */

Object.defineProperty(globalThis, 'navigator', { value: { language: LOCALE === 'zh' ? 'zh-CN' : 'en-US' }, configurable: true });

let moduleDefinition = null;
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      moduleDefinition = definition;
    },
  },
};

// A minimal Web Storage shim: the naming preference is persisted through it, and the
// panel must work with or without it.
const storageCalls = [];
globalThis.localStorage = {
  getItem(key) {
    return key in this.data ? this.data[key] : null;
  },
  setItem(key, value) {
    storageCalls.push([key, String(value)]);
    this.data[key] = String(value);
  },
  removeItem(key) {
    delete this.data[key];
  },
  data: Object.create(null),
};

const pkgName = JSON.parse((await import('node:fs')).readFileSync(
  new URL('../package.json', import.meta.url),
  'utf8',
)).name;

const source = await readSource();
new Function('window', source)(globalThis.window);

async function readSource() {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  return readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8');
}

check('module registers under the package name', () => {
  assert(moduleDefinition !== null, 'module did not call __ModuleLoader__.load');
  // The browser module id must equal the package name, or the loader serves the wrong row.
  assert(moduleDefinition.id === pkgName, `module id ${moduleDefinition.id} must match package.json name ${pkgName}`);
});

/* ------------------------------------------------------------------ */
/* Document + React emulation                                          */
/* ------------------------------------------------------------------ */

const documentListeners = new Map();
globalThis.document = {
  addEventListener(type, handler) {
    if (!documentListeners.has(type)) documentListeners.set(type, new Set());
    documentListeners.get(type).add(handler);
  },
  removeEventListener(type, handler) {
    documentListeners.get(type)?.delete(handler);
  },
};
function dispatchDocument(type, event) {
  for (const handler of [...(documentListeners.get(type) ?? [])]) handler(event);
}

const hookState = new Map();
let currentHooks = null;
let hookIndex = 0;

function instanceHooks(key) {
  let slots = hookState.get(key);
  if (slots === undefined) {
    slots = [];
    hookState.set(key, slots);
  }
  currentHooks = slots;
  hookIndex = 0;
}

const React = {
  createElement(type, props, ...children) {
    const flat = [];
    const push = (child) => {
      if (Array.isArray(child)) {
        for (const entry of child) push(entry);
      } else if (child !== null && child !== undefined && child !== false && child !== true) {
        flat.push(child);
      }
    };
    push(children);
    return { type, props: { ...(props ?? {}), children: flat } };
  },
  Component: class {
    constructor(props) {
      this.props = props;
    }
  },
  useState(initial) {
    const slots = currentHooks;
    const index = hookIndex;
    hookIndex += 1;
    if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
    const slot = slots[index];
    const setter = (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next;
      if (Object.is(value, slot.value)) return;
      slot.value = value;
    };
    return [slot.value, setter];
  },
  useMemo(factory, deps) {
    const slots = currentHooks;
    const index = hookIndex;
    hookIndex += 1;
    const key = deps === undefined ? null : JSON.stringify(deps, (k, v) => (v instanceof Set ? [...v].sort() : v));
    const previous = slots[index];
    if (previous !== undefined && previous.key === key && key !== null) return previous.value;
    const value = factory();
    slots[index] = { key, value };
    return value;
  },
  useRef(initial) {
    const slots = currentHooks;
    const index = hookIndex;
    hookIndex += 1;
    if (!(index in slots)) slots[index] = { current: initial };
    return slots[index];
  },
  useEffect(effect, deps) {
    const slots = currentHooks;
    const index = hookIndex;
    hookIndex += 1;
    const key = deps === undefined ? null : JSON.stringify(deps);
    const previous = slots[index];
    if (previous !== undefined && previous.key === key) return;
    const cleanup = effect();
    slots[index] = { key, cleanup };
  },
};

const seen = new Map();
let renderCounter = 0;
/**
 * Each check that needs a fresh panel mount bumps this epoch: the emulation then
 * hands out new hook slots, so mount effects run again exactly like a remount in
 * the browser (React keys/instances are per mount).
 */
let mountEpoch = 0;
function newMount() {
  mountEpoch += 1;
}

function renderNode(node, out) {
  if (node === null || node === undefined || node === false || node === true) return;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push({ kind: 'text', text: String(node) });
    return;
  }
  if (Array.isArray(node)) {
    for (const entry of node) renderNode(entry, out);
    return;
  }
  const { type, props } = node;
  if (typeof type === 'string') {
    const record = { kind: 'element', tag: type, props, children: [] };
    out.push(record);
    for (const child of props.children) renderNode(child, record.children);
    return;
  }
  if (typeof type === 'function') {
    let identity = seen.get(type);
    if (identity === undefined) {
      identity = renderCounter;
      renderCounter += 1;
      seen.set(type, identity);
    }
    instanceHooks(`${mountEpoch}:${identity}`);
    if (type.prototype !== undefined && typeof type.prototype.render === 'function') {
      const instance = new type(props);
      instance.state = typeof instance.state === 'object' && instance.state !== null ? instance.state : {};
      renderNode(instance.render(), out);
      return;
    }
    renderNode(type(props), out);
  }
}

function collect(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const entry of node) collect(entry, predicate, found);
    return found;
  }
  if (node.kind === 'element') {
    if (predicate(node)) found.push(node);
    for (const child of node.children ?? []) collect(child, predicate, found);
  }
  return found;
}

function textOf(node) {
  if (node === null || node === undefined) return '';
  if (node.kind === 'text') return node.text;
  if (Array.isArray(node)) return node.map(textOf).join('');
  return (node.children ?? []).map(textOf).join('');
}

const squash = (node) => textOf(node).replace(/\s+/g, ' ').trim();

/* ------------------------------------------------------------------ */
/* Host route + services                                               */
/* ------------------------------------------------------------------ */

const KNOWN_SIZES = {
  'session-alpha': 8808038, // 8.4 MB
  'session-beta': 0,
  'session-huge': 1649267441664, // 1.5 TB
};

let responder = (body) => {
  switch (body.op) {
    case 'sizes':
      return { payload: { ok: true, sizes: KNOWN_SIZES, scannedAt: Date.now() } };
    case 'gc-preview':
      return { payload: { ok: true, report: { sessionsScanned: 3, referencedImages: 1, referencedFiles: 0, groups: [], deletableBytes: 0, cacheFiles: 0, cacheBytes: 0 } } };
    case 'gc':
      return { payload: { ok: true, deletedFiles: 0, freedBytes: 0, groups: [], failed: [] } };
    case 'delete':
      return { payload: { ok: true, deleted: body.sessionIds, failed: [], freedBytes: 0 } };
    default:
      return { payload: { ok: false, reason: `unknown op ${body.op}` } };
  }
};
const httpCalls = [];
let lastHttp = null;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  httpCalls.push(body);
  lastHttp = { url, body };
  const reply = responder(body) ?? {};
  const status = typeof reply.status === 'number' ? reply.status : 200;
  const text = typeof reply.text === 'string' ? reply.text : JSON.stringify(reply.payload ?? { ok: false, reason: 'no payload' });
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() {
      return text;
    },
  };
};

const now = Date.now();
const sessions = {
  // risk fixtures: pinned / running / idle-with-content
  'session-pinned': { id: 'session-pinned', title: '置顶的规范', displayTitle: '置顶的规范', cwd: '/Users/ivanyin/work/pinned', updatedAt: now - 40 * 86400000, running: false, blank: false },
  'session-running': { id: 'session-running', displayTitle: '正在跑的批处理', cwd: '/Users/ivanyin/work/batch', updatedAt: now - 30 * 60000, running: true, blank: false },
  'session-idle': { id: 'session-idle', title: '两周前的调研', displayTitle: '两周前的调研', cwd: '/Users/ivanyin/work/docs', updatedAt: now - 14 * 86400000, running: false, blank: false },
  'session-alpha': { id: 'session-alpha', displayTitle: '重构鉴权模块', cwd: '/Users/ivanyin/work/auth', updatedAt: now - 4 * 86400000, running: false, blank: false },
  'session-beta': { id: 'session-beta', cwd: '/Users/ivanyin/work/docs', updatedAt: now - 3 * 3600000, running: false, blank: true },
  'session-huge': { id: 'session-huge', title: '夜间批处理', displayTitle: '夜间批处理', cwd: '/Users/ivanyin/work/batch', updatedAt: now - 2 * 86400000, running: false, blank: false, origin: 'subagent', parentId: 'session-alpha' },
  'session-unmeasured': { id: 'session-unmeasured', title: '没有尺寸记录', displayTitle: '没有尺寸记录', cwd: '/Users/ivanyin/work/old', updatedAt: now - 9 * 86400000, running: false, blank: false },
};
let archivedList = [];

const serviceCalls = [];
const workspaceService = {
  async archiveSession(id, options) {
    serviceCalls.push(['service.archive', id, options]);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    archivedList = archivedList.concat([id]);
  },
  async unarchiveSession(id) {
    serviceCalls.push(['service.unarchive', id]);
    archivedList = archivedList.filter((entry) => entry !== id);
  },
};
let active = 0;
let peak = 0;

let dictionaries = null;
const localeService = {
  register(namespace, value) {
    assert(typeof namespace === 'string', 'locale namespace must be a string');
    assert(value !== null && typeof value === 'object', 'locale dictionaries must be an object');
    assert(value.zh !== undefined && value.en !== undefined, 'dictionaries must cover zh and en');
    dictionaries = value;
    return () => {};
  },
  bind() {
    return (key, params) => interpolate(dictionaries?.[LOCALE]?.[key] ?? key, params);
  },
  getLocale() {
    return { id: LOCALE };
  },
  getSnapshot() {
    return { id: LOCALE };
  },
  subscribe() {
    return () => {};
  },
};

function interpolate(template, params) {
  if (typeof template !== 'string') return template;
  if (params === null || params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

let injectedProps = null;
const registrations = {};
const slotEvents = [];
const ctx = {
  locale: localeService,
  effect(factory) {
    return factory();
  },
  on() {
    return () => {};
  },
  get(key) {
    if (key === 'workspaces') return workspaceService;
    if (key === 'uiWorkspace') return workspaceService;
    return undefined;
  },
  slots: {
    inject(owner, factory) {
      const disposal = factory();
      return typeof disposal === 'function' ? disposal : () => {};
    },
    register(options, component) {
      registrations[options.name] = { options, component };
      slotEvents.push(['register', options.name, options.id ?? options.key ?? '']);
      const id = options.id ?? options.key ?? '';
      return () => {
        slotEvents.push(['dispose', options.name, id]);
      };
    },
  },
};

const plugin = moduleDefinition.factory((specifier) => {
  if (specifier !== 'react') throw new Error(`unexpected require ${specifier}`);
  return React;
});
plugin.apply(ctx);
injectedProps = registrations.main.options.inject();

/* ------------------------------------------------------------------ */
/* Panel driver                                                        */
/* ------------------------------------------------------------------ */

const READY_SESSIONS = { byId: sessions, phase: 'ready' };
const PENDING_SESSIONS = { byId: {}, phase: 'pending' };
const WORKSPACE_SPY = {
  getSnapshot: () => ({ archivedSessionIds: archivedList }),
};

function panelProps(overrides = {}) {
  return {
    ...injectedProps,
    t: localeService.bind('sessionManager'),
    useSessions: (selector) => selector(READY_SESSIONS),
    useWorkspaces: (selector) => selector(WORKSPACE_SPY.getSnapshot()),
    ...overrides,
  };
}

function renderPanel(overrides = {}) {
  const tree = [];
  renderNode(React.createElement(registrations.main.component, panelProps(overrides)), tree);
  return tree;
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Mount a fresh panel (new hook slots, so mount effects run and the panel issues
 * its sizes / preview requests), wait for those requests to land, and return the
 * settled tree.
 */
async function mountPanel(overrides = {}, settleMs = 30) {
  newMount();
  renderPanel(overrides);
  await settle(settleMs);
  return renderPanel(overrides);
}

function rowsOf(tree) {
  return collect(tree, (node) => node.props.className === 'dsh-sm-row');
}
function statusText(tree) {
  const node = collect(tree, (item) => item.props.className === 'dsh-sm-status')[0];
  return node === undefined ? '' : squash(node);
}
function buttons(tree, variant) {
  return collect(tree, (node) => node.tag === 'button' && node.props.className === 'dsh-sm-btn' && (variant === undefined || node.props['data-variant'] === variant));
}
function notices(tree) {
  return collect(tree, (node) => node.props.className === 'dsh-sm-notice');
}

function linkButtons(tree) {
  return collect(tree, (node) => typeof node.props.className === 'string'
    && node.props.className.split(' ').indexOf('dsh-sm-linkbtn') >= 0
    && node.props.className.split(' ').indexOf('dsh-sm-vocab') < 0);
}

function vocabSwitch(tree) {
  return collect(tree, (node) => typeof node.props.className === 'string' && node.props.className.split(' ').indexOf('dsh-sm-vocab') >= 0)[0];
}

function findLink(tree, text) {
  return linkButtons(tree).find((node) => String(squash(node)).includes(text));
}

function gcBlock(tree) {
  return collect(tree, (node) => typeof node.props.className === 'string' && node.props.className.indexOf('dsh-sm-confirmstack') >= 0)[0];
}

/* ------------------------------------------------------------------ */
/* Checks: registration surface                                        */
/* ------------------------------------------------------------------ */

check('host registrations keep the documented ids', () => {
  assert(registrations.main !== undefined, 'main slot registration missing');
  assertEqual(registrations.main.options.key, 'session-manager', 'main key');
  assert(registrations['sidebar.panellist'] !== undefined, 'panellist registration missing');
  assertEqual(registrations['sidebar.panellist'].options.id, 'session-manager', 'panellist id');
  assertEqual(typeof registrations['sidebar.panellist'].options.label, 'function', 'panellist label thunk');
  const label = registrations['sidebar.panellist'].options.label();
  assert(label.length > 0 && label !== 'panel.label', `panellist label not localized: ${label}`);
  assertEqual(registrations['sidebar.panellist'].options.locale, 'sessionManager', 'locale namespace');
});

check('every referenced locale key exists in both dictionaries', () => {
  const referenced = new Set();
  const add = (key) => {
    if (key.endsWith('.')) return; // dynamic prefix such as `fail.code.`
    referenced.add(key);
  };
  for (const match of source.matchAll(/\bt\('([a-zA-Z][\w.]*)'/g)) add(match[1]);
  for (const match of source.matchAll(/notice\([^,]+,\s*'([a-zA-Z][\w.]*)'/g)) add(match[1]);
  for (const match of source.matchAll(/key:\s*'([a-zA-Z][\w.]*)'/g)) {
    if (match[1].includes('.')) add(match[1]);
  }
  // keys built dynamically
  for (const code of ['not-found', 'running', 'no-location', 'io', 'invalid-id', 'archive-failed', 'unknown']) referenced.add(`fail.code.${code}`);
  const missing = [];
  for (const key of referenced) {
    for (const locale of ['zh', 'en']) {
      if (typeof dictionaries[locale][key] !== 'string') missing.push(`${locale}:${key}`);
    }
  }
  assert(missing.length === 0, `missing locale keys: ${missing.join(', ')}`);
});

check('no raw dictionary key is rendered as a label', () => {
  const tree = renderPanel();
  const texts = collect(tree, () => true).map((node) => (node.kind === 'text' ? node.text : ''));
  const suspicious = texts.filter((text) => /^[a-z]+\.[a-zA-Z]+(\.[a-zA-Z]+)?$/.test(text.trim()));
  assert(suspicious.length === 0, `untranslated keys rendered: ${suspicious.join(', ')}`);
});

check('sidebar glyph renders at both rail sizes', () => {
  for (const size of [16, 18]) {
    const tree = [];
    renderNode(React.createElement(registrations['sidebar.panellist'].component, { size, active: size === 18 }), tree);
    const svg = collect(tree, (node) => node.tag === 'svg')[0];
    assert(svg !== undefined, 'icon did not render an svg');
    assertEqual(svg.props.width, size, 'icon width');
    assert(svg.children.length >= 2, 'icon lost its paths');
  }
});

check('theme tokens only (no literal colors in the stylesheet)', () => {
  const styles = collect(renderPanel(), (node) => node.tag === 'style')[0];
  const css = textOf(styles);
  const literals = css.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/g) ?? [];
  assert(literals.length === 0, `literal colors in CSS: ${literals.join(', ')}`);
  assert(css.indexOf('--dsw-') >= 0, 'stylesheet does not use theme tokens');
});

/* ------------------------------------------------------------------ */
/* Checks: sizes                                                       */
/* ------------------------------------------------------------------ */

await checkAsync('sizes load on open and render per row', async () => {
  const next = await mountPanel();
  const rows = rowsOf(next);
  assertEqual(rows.length, Object.keys(sessions).length, 'row count');
  const cells = collect(next, (node) => node.props.className === 'dsh-sm-size').map(squash);
  const unmeasured = Object.keys(sessions).filter((id) => KNOWN_SIZES[id] === undefined);
  assert(['0 B', '1.5 TB', '8.4 MB'].every((value) => cells.includes(value)), `known sizes missing from: ${cells.join(',')}`);
  const unknownCell = collect(next, (node) => node.props.className === 'dsh-sm-size' && node.props['data-known'] === 'false');
  assertEqual(unknownCell.length, unmeasured.length, 'every unmeasured row shows the unknown glyph');
  assertEqual(squash(unknownCell[0]), dictionaries[LOCALE]['size.unknown'], 'unknown glyph');
});

await checkAsync('selection bar totals the measured sizes', async () => {
  let tree = await mountPanel();
  const alpha = rowsOf(tree).find((row) => squash(row).includes('重构鉴权模块'));
  alpha.props.onClick();
  tree = renderPanel();
  const bar = collect(tree, (node) => node.props.className === 'dsh-sm-barcount')[0];
  const text = squash(bar);
  assertEqual(text, dictionaries[LOCALE]['selection.size'].replace('{count}', '1').replace('{size}', '8.4 MB'), 'selection label');
  // a second, unmeasured row turns the total into a lower bound
  const unmeasured = rowsOf(tree).find((row) => squash(row).includes('没有尺寸记录'));
  unmeasured.props.onClick();
  tree = renderPanel();
  const second = squash(collect(tree, (node) => node.props.className === 'dsh-sm-barcount')[0]);
  assertEqual(second, dictionaries[LOCALE]['selection.sizeLower'].replace('{count}', '2').replace('{size}', '8.4 MB'), 'lower-bound label');
  collect(tree, (node) => node.props.className === 'dsh-sm-btn' && node.props['data-variant'] === 'quiet').forEach((node) => {
    if (typeof node.props.onClick === 'function') node.props.onClick();
  });
});

/* ------------------------------------------------------------------ */
/* Checks: delete feedback                                             */
/* ------------------------------------------------------------------ */

await checkAsync('delete reports freed space and hides not-found rows', async () => {
  responder = (body) => {
    if (body.op === 'delete') {
      return {
        payload: {
          ok: true,
          deleted: body.sessionIds.filter((id) => id !== 'session-unmeasured'),
          failed: [
            { sessionId: 'session-unmeasured', code: 'not-found', reason: 'session not found in session persistence' },
            { sessionId: 'session-running', code: 'running', reason: 'session is still running' },
          ],
          freedBytes: 8808038,
          auditLog: '/Users/ivanyin/.dsh/logs/session-manager.jsonl',
        },
      };
    }
    return undefined;
  };
  let tree = await mountPanel();
  rowsOf(tree)[0].props.onClick();
  tree = renderPanel();
  const danger = buttons(tree, 'dangerText')[0];
  danger.props.onClick();
  tree = renderPanel();
  const solid = buttons(tree, 'dangerSolid')[0];
  solid.props.onClick();
  await settle();
  tree = renderPanel();
  const status = statusText(tree);
  const expectedCode = dictionaries[LOCALE]['fail.code.running'];
  assert(status.includes(expectedCode), `status must localize the running code, got: ${status}`);
  {
    const statusNode = collect(tree, (node) => node.props.className === 'dsh-sm-status')[0];
    assert(String(statusNode?.props?.title ?? '').includes('still running'), `the Host wording should stay available as a tooltip, got: ${statusNode?.props?.title}`);
  }
  const goneNote = dictionaries[LOCALE]['status.gone'].split('{count}').join('1');
  assert(status.includes(goneNote), `status must mention the gone session, got: ${status}`);
  assertEqual(rowsOf(tree).length, Object.keys(sessions).length - 2, 'deleted and not-found rows are hidden');
  const hint = collect(tree, (node) => node.props.className === 'dsh-sm-confirmsub').map(squash).join(' ');
  assert(hint.includes('session-manager.jsonl'), `audit path should be surfaced from the Host payload, got: ${hint}`);
  responder = () => undefined;
});

/* ------------------------------------------------------------------ */
/* Checks: attachment cleanup                                          */
/* ------------------------------------------------------------------ */

await checkAsync('cleanup action stays hidden while the preview is zero', async () => {
  responder = undefined;
  const next = await mountPanel();
  const grow = collect(next, (node) => node.props.className === 'dsh-sm-toolbarspacer');
  assertEqual(grow.length, 0, 'no cleanup action should occupy the toolbar');
  assert(gcBlock(next) === undefined, 'cleanup block must stay closed');
});

await checkAsync('cleanup preview opens a confirm block and honours the cache opt-in', async () => {
  responder = (body) => {
    if (body.op === 'gc-preview') {
      return {
        payload: {
          ok: true,
          report: {
            sessionsScanned: 104, referencedImages: 12, referencedFiles: 3,
            groups: [{ name: 'objects', files: 1587, bytes: 519569408, deletableFiles: 1587, deletableBytes: 519569408 }],
            deletableBytes: 519569408, cacheFiles: 40, cacheBytes: 4194304,
          },
        },
      };
    }
    if (body.op === 'gc') {
      return { payload: { ok: true, deletedFiles: body.includeRequestImageCache === true ? 1627 : 1587, freedBytes: body.includeRequestImageCache === true ? 523763712 : 519569408, groups: [], failed: [] } };
    }
    return undefined;
  };
  let tree = await mountPanel();
  const action = linkButtons(tree)[0];
  assert(notices(tree).length === 1, 'the cleanup notice should be the surface for this action');
  assert(action !== undefined, 'cleanup action should be visible for a non-zero preview');
  const noticeText = squash(notices(tree)[0]);
  assert(/519\.6 MB|495\.5 MB/.test(noticeText), `the notice should state the reclaimable size, got: ${noticeText}`);
  action.props.onClick();
  await settle();
  tree = renderPanel();
  const block = gcBlock(tree);
  assert(block !== undefined, 'cleanup confirm block did not open');
  const blockText = squash(block);
  assert(blockText.includes('104'), `block should show scanned sessions: ${blockText}`);
  assert(/519\.6 MB|495\.5 MB/.test(blockText), `block should show the safe size: ${blockText}`);
  const checkbox = collect(block, (node) => node.tag === 'input')[0];
  assert(checkbox !== undefined, 'cache checkbox missing');
  assertEqual(checkbox.props.checked, false, 'cache opt-in must default to off');
  // toggle it and confirm the request carries the choice
  checkbox.props.onChange({ target: { checked: true } });
  tree = renderPanel();
  const confirmButton = buttons(gcBlock(tree), 'dangerSolid')[0];
  confirmButton.props.onClick();
  await settle();
  tree = renderPanel();
  const gcCall = httpCalls.filter((body) => body.op === 'gc').pop();
  assertEqual(gcCall.includeRequestImageCache, true, 'cache choice must reach the Host');
  const status = statusText(tree);
  assert(/1627/.test(status), `status should report the deleted file count: ${status}`);
  assert(/499\.5 MB|4\.0 MB|523\.8 MB/.test(status), `status should report freed space: ${status}`);
  assert(gcBlock(tree) === undefined, 'block closes after a successful cleanup');
  responder = () => undefined;
});

await checkAsync('cleanup failure surfaces in the status line', async () => {
  responder = (body) => {
    if (body.op === 'gc-preview') {
      return { payload: { ok: true, report: { sessionsScanned: 1, referencedImages: 0, referencedFiles: 0, groups: [{ name: 'objects', deletableFiles: 2, deletableBytes: 2048 }], deletableBytes: 2048, cacheFiles: 0, cacheBytes: 0 } } };
    }
    if (body.op === 'gc') {
      return { payload: { ok: true, deletedFiles: 1, freedBytes: 1024, groups: [], failed: [{ path: '/x/ab', reason: 'EACCES' }] } };
    }
    return undefined;
  };
  let tree = await mountPanel();
  linkButtons(tree)[0].props.onClick();
  await settle();
  tree = renderPanel();
  const checkbox = collect(gcBlock(tree), (node) => node.tag === 'input')[0];
  assertEqual(checkbox.props.disabled, true, 'cache checkbox is disabled when the cache is empty');
  buttons(gcBlock(tree), 'dangerSolid')[0].props.onClick();
  await settle();
  tree = renderPanel();
  const status = statusText(tree);
  assert(status.includes('EACCES'), `status should carry the failure reason, got: ${status}`);
  assertEqual(collect(tree, (node) => node.props['data-tone'] === 'error').length > 0, true, 'status should be an error');
  responder = () => undefined;
});

await checkAsync('a Host without the cleanup op hides the action (v1 degradation)', async () => {
  responder = (body) => {
    if (body.op === 'gc-preview') return { status: 400, payload: { ok: false, reason: 'unknown op: gc-preview' } };
    if (body.op === 'sizes') return { status: 400, payload: { ok: false, reason: 'unknown op: sizes' } };
    return undefined;
  };
  const tree = await mountPanel();
  assertEqual(collect(tree, (node) => node.props.className === 'dsh-sm-toolbarspacer').length, 0, 'no cleanup action on v1');
  const cells = collect(tree, (node) => node.props.className === 'dsh-sm-size');
  assert(cells.length > 0, 'size column still renders');
  assert(cells.every((cell) => cell.props['data-known'] === 'false'), 'all sizes unknown on a v1 Host');
  responder = () => undefined;
});

await checkAsync('a v1 delete response still works (no codes, no freed bytes)', async () => {
  responder = (body) => {
    if (body.op === 'delete') {
      return { payload: { ok: true, deleted: body.sessionIds, failed: [{ sessionId: 'gone-legacy', reason: 'session not found in session persistence' }] } };
    }
    return undefined;
  };
  let tree = await mountPanel();
  rowsOf(tree)[0].props.onClick();
  tree = renderPanel();
  buttons(tree, 'dangerText')[0].props.onClick();
  tree = renderPanel();
  buttons(tree, 'dangerSolid')[0].props.onClick();
  await settle();
  tree = renderPanel();
  const status = statusText(tree);
  // v1 semantics: the failure is reported verbatim (no invented code label) and
  // mixed results use the partial line, exactly like the v1 panel did.
  const expected = dictionaries[LOCALE]['status.partial']
    .replace('{total}', '1')
    .replace('{failed}', '1')
    .replace('{reason}', 'session not found in session persistence');
  assertEqual(status, expected, 'v1 partial status');
  assert(status.indexOf(dictionaries[LOCALE]['fail.code.unknown']) < 0, `v1 reason must not be mislabelled as unknown: ${status}`);
  const deleteCall = httpCalls.filter((body) => body.op === 'delete').pop();
  assertEqual(deleteCall.sessionIds.length, 1, 'delete request carries the selection');
  responder = () => undefined;
});

/* ------------------------------------------------------------------ */
/* Checks: bounded concurrency                                         */
/* ------------------------------------------------------------------ */

await checkAsync('archive batches stay within the concurrency bound', async () => {
  const many = {};
  for (let index = 0; index < 12; index += 1) {
    many[`bulk-${index}`] = { id: `bulk-${index}`, displayTitle: `批量 ${index}`, cwd: '/tmp', updatedAt: now - index * 1000, running: false, blank: false };
  }
  active = 0;
  peak = 0;
  const useSessionsMany = (selector) => selector({ byId: many, phase: 'ready' });
  const manyProps = { useSessions: useSessionsMany, useWorkspaces: (selector) => selector({ archivedSessionIds: [] }) };
  let tree = await mountPanel(manyProps);
  collect(tree, (node) => node.props.className === 'dsh-sm-checkall')[0].props.onClick();
  tree = renderPanel(manyProps);
  const archiveButton = buttons(tree).find((node) => squash(node) === dictionaries[LOCALE]['action.archive']);
  assert(archiveButton !== undefined, 'archive action missing');
  archiveButton.props.onClick();
  await settle(120);
  assertEqual(peak, 4, `at most 4 archive calls may run at once (peak ${peak})`);
  assert(active === 0, 'all archive calls settled');
  assert(serviceCalls.filter((call) => call[0] === 'service.archive').length >= 12, 'every selected row was archived');
});

/* ------------------------------------------------------------------ */
/* Checks: keyboard + defensive props                                  */
/* ------------------------------------------------------------------ */

await checkAsync('Escape closes an open cleanup block', async () => {
  responder = (body) => {
    if (body.op === 'gc-preview') {
      return { payload: { ok: true, report: { sessionsScanned: 2, referencedImages: 0, referencedFiles: 0, groups: [{ name: 'objects', deletableFiles: 5, deletableBytes: 5120 }], deletableBytes: 5120, cacheFiles: 0, cacheBytes: 0 } } };
    }
    return undefined;
  };
  let tree = await mountPanel();
  linkButtons(tree)[0].props.onClick();
  await settle();
  tree = renderPanel();
  assert(gcBlock(tree) !== undefined, 'block should be open before Escape');
  dispatchDocument('keydown', { key: 'Escape', stopPropagation() {} });
  tree = renderPanel();
  assert(gcBlock(tree) === undefined, 'Escape must close the cleanup block');
  responder = () => undefined;
});

check('panel renders without the injected action bag', () => {
  const tree = [];
  renderNode(React.createElement(registrations.main.component, {
    t: localeService.bind('sessionManager'),
    useSessions: (selector) => selector(READY_SESSIONS),
    useWorkspaces: (selector) => selector({ archivedSessionIds: [] }),
  }), tree);
  assert(rowsOf(tree).length > 0, 'rows should still render');
});

check('pending store state shows the loading line', () => {
  const tree = [];
  renderNode(React.createElement(registrations.main.component, {
    t: localeService.bind('sessionManager'),
    useSessions: (selector) => selector(PENDING_SESSIONS),
    useWorkspaces: (selector) => selector({ archivedSessionIds: [] }),
  }), tree);
  const empty = collect(tree, (node) => node.props.className === 'dsh-sm-empty')[0];
  assert(empty !== undefined, 'loading state missing');
  assertEqual(squash(empty), dictionaries[LOCALE]['list.loading'], 'loading text');
});

/* ------------------------------------------------------------------ */
/* v3: recycle bin, new failure codes, workspace filter                */
/* ------------------------------------------------------------------ */

const TRASH_LIST = {
  ok: true,
  retentionDays: 30,
  totalBytes: 12582912,
  items: [
    { sessionId: 'trash-old', title: '旧的实验记录', bytes: 8388608, trashedAt: now - 20 * 86400000, expiresAt: now + 10 * 86400000, expiresInDays: 10, originalPath: '/Users/ivanyin/work/auth/trash-old' },
    { sessionId: 'trash-expired', title: null, bytes: 4194304, trashedAt: now - 40 * 86400000, expiresAt: now - 10 * 86400000, expiresInDays: 0, originalPath: '/Users/ivanyin/work/docs/trash-expired' },
  ],
};

const HOST_RISK = {
  ok: true,
  policyVersion: 1,
  items: {
    'trash-old': { tier: 'high', reasons: [{ key: 'risk.reason.pinned' }] },
    'session-huge': { tier: 'low', reasons: [{ key: 'risk.reason.subagent' }] },
    'session-unmeasured': { tier: 'low', reasons: [{ key: 'risk.reason.stale' }] },
    'session-alpha': { tier: 'medium', reasons: [{ key: 'risk.reason.recent7d' }] },
    'session-beta': { tier: 'low', reasons: [{ key: 'risk.reason.blank' }] },
    'session-idle': { tier: 'low', reasons: [{ key: 'risk.reason.stale' }] },
    'session-pinned': { tier: 'high', reasons: [{ key: 'risk.reason.pinned' }] },
    'session-running': { tier: 'high', reasons: [{ key: 'risk.reason.running' }] },
    'session-blank': { tier: 'low', reasons: [{ key: 'risk.reason.blank' }] },
    'session-stale': { tier: 'low', reasons: [{ key: 'risk.reason.stale' }] },
    'session-week': { tier: 'medium', reasons: [{ key: 'risk.reason.recent7d' }] },
  },
};

function v3Responder(overrides = {}) {
  return (body) => {
    if (overrides[body.op] !== undefined) return overrides[body.op](body);
    if (body.op === 'risk') return { payload: HOST_RISK };
    if (body.op === 'ping') return { payload: { ok: true, version: '3' } };
    if (body.op === 'trash-list') return { payload: TRASH_LIST };
    if (body.op === 'trash-restore') return { payload: { ok: true, restored: body.sessionIds, failed: [], auditLog: '/tmp/audit.jsonl' } };
    if (body.op === 'trash-purge') return { payload: { ok: true, purged: body.sessionIds, freedBytes: 4194304, failed: [], auditLog: '/tmp/audit.jsonl' } };
    if (body.op === 'delete') return { payload: { ok: true, trashed: body.sessionIds, deleted: [], trashedBytes: 8808038, freedBytes: 0, failed: [], auditLog: '/tmp/audit.jsonl' } };
    return undefined;
  };
}

function confirmBlock(tree) {
  return collect(tree, (node) => typeof node.props.className === 'string' && node.props.className.split(' ').indexOf('dsh-sm-confirm') >= 0)[0] ?? { props: {}, children: [] };
}

function segmentButton(tree, label) {
  return collect(tree, (node) => node.tag === 'button' && node.props.className === 'dsh-sm-segbtn' && squash(node) === label)[0];
}

function selectRow(tree, id) {
  const rows = collect(tree, (node) => node.props.className === 'dsh-sm-row');
  const row = id === undefined ? rows[0] : rows.find((node) => squash(node).indexOf(id) >= 0 || rows.indexOf(node) === 0);
  assert(row !== undefined, 'no row to select');
  row.props.onClick();
}



/** The naming system under test, per locale (the dictionary holds the plain names). */
const JARGON_PROBE = {
  zh: { title: '会话毕业办公室', pool: '人才池', offboard: '办理毕业' },
  en: { title: 'Session exit office', pool: 'Talent pool', offboard: 'Offboard' },
};
const JARGON_UNDER_TEST = JARGON_PROBE[LOCALE];
/** Switch the naming system by state, not by label text, so the helper cannot invert. */
function setVocabulary(mode) {
  const title = () => squash(collect(renderPanel(), (node) => node.tag === 'h1')[0] ?? { children: [] });
  const wantJargon = mode === 'jargon';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = title();
      const isJargon = current === JARGON_UNDER_TEST.title;
    if (isJargon === wantJargon) return;
    const control = vocabSwitch(renderPanel());
    if (control === undefined) return;
    control.props.onClick();
  }
}


/** A self-contained set for the risk checks: one row per tier, nothing shared with other checks. */
const RISK_NOW = Date.now();
const RISK_SESSIONS = {
  'risk-pinned': { id: 'risk-pinned', title: '置顶的规范', displayTitle: '置顶的规范', cwd: '/work/pinned', updatedAt: RISK_NOW - 40 * 86400000, running: false, blank: false },
  'risk-running': { id: 'risk-running', title: '正在跑的批处理', displayTitle: '正在跑的批处理', cwd: '/work/batch', updatedAt: RISK_NOW - 30 * 60000, running: true, blank: false },
  'risk-parent': { id: 'risk-parent', title: '被派生的父会话', displayTitle: '被派生的父会话', cwd: '/work/auth', updatedAt: RISK_NOW - 20 * 86400000, running: false, blank: false },
  'risk-child': { id: 'risk-child', title: '子代理产物', displayTitle: '子代理产物', cwd: '/work/auth', updatedAt: RISK_NOW - 20 * 86400000, running: false, blank: false, origin: 'subagent', parentId: 'risk-parent' },
  'risk-blank': { id: 'risk-blank', displayTitle: '空白草稿', cwd: '/work/docs', updatedAt: RISK_NOW - 2 * 3600000, running: false, blank: true },
  'risk-idle': { id: 'risk-idle', title: '两周前的调研', displayTitle: '两周前的调研', cwd: '/work/docs', updatedAt: RISK_NOW - 14 * 86400000, running: false, blank: false },
  'risk-recent': { id: 'risk-recent', title: '三天前的调试', displayTitle: '三天前的调试', cwd: '/work/docs', updatedAt: RISK_NOW - 3 * 86400000, running: false, blank: false },
};

function riskPanel(overrides = {}) {
  return {
    useSessions: (selector) => selector({ byId: RISK_SESSIONS, phase: 'ready' }),
    useWorkspaces: (selector) => selector({ archivedSessionIds: [], pinnedSessionIds: ['risk-pinned'], items: [] }),
    ...overrides,
  };
}

/**
 * The protocol checks below assert probe behaviour, so they run under the plain naming.
 * The naming system itself is exercised by the "v4 vocabulary" block at the end.
 */
async function usePlainNames() {
  await mountPanel();
  setVocabulary('standard');
}

await checkAsync('v3: the recycle-bin segment only exists against a v3 Host', async () => {
  responder = v3Responder();
  await usePlainNames();
  let tree = await mountPanel();
  const trashButton = segmentButton(tree, dictionaries[LOCALE]['filter.trash']);
  assert(trashButton !== undefined, 'recycle-bin segment missing against a v3 Host');
  responder = () => undefined;
  tree = await mountPanel();
  assert(segmentButton(tree, dictionaries[LOCALE]['filter.trash']) === undefined, 'recycle-bin segment must disappear without trash support');
});

await checkAsync('v3: the recycle bin lists entries with a retention countdown', async () => {
  responder = v3Responder();
  const tree = await mountPanel();
  segmentButton(tree, dictionaries[LOCALE]['filter.trash']).props.onClick();
  const next = renderPanel();
  const rows = rowsOf(next);
  assertEqual(rows.length, 2, 'trash row count');
  const text = squash(next);
  assert(text.includes(interpolate(dictionaries[LOCALE]['trash.expiresIn'], { days: 10 })), 'countdown missing');
  assert(text.includes(dictionaries[LOCALE]['trash.expired']), 'expired marker missing');
  assert(text.includes('旧的实验记录'), 'trash title missing');
  responder = () => undefined;
});

await checkAsync('v3: an expired entry offers 清空已过期 and purges exactly those ids', async () => {
  responder = v3Responder();
  const tree = await mountPanel();
  segmentButton(tree, dictionaries[LOCALE]['filter.trash']).props.onClick();
  renderPanel();
  const purgeExpired = buttons(renderPanel()).find((node) => squash(node) === dictionaries[LOCALE]['action.purgeExpired']);
  assert(purgeExpired === undefined, 'the expired action needs a selection first');
  selectRow(renderPanel(), 'trash-old');
  const withSelection = renderPanel();
  const expiredAction = buttons(withSelection).find((node) => squash(node) === dictionaries[LOCALE]['action.purgeExpired']);
  assert(expiredAction !== undefined, 'expired purge action missing');
  httpCalls.length = 0;
  expiredAction.props.onClick();
  await settle();
  const purgeCall = httpCalls.filter((call) => call.op === 'trash-purge')[0];
  assert(purgeCall !== undefined, 'no trash-purge request');
  assertEqual(JSON.stringify(purgeCall.sessionIds), JSON.stringify(['trash-expired']), 'expired purge must target only the expired entry');
  responder = () => undefined;
});

await checkAsync('v3: restoring a trashed entry posts trash-restore and reports the count', async () => {
  responder = v3Responder();
  const tree = await mountPanel();
  segmentButton(tree, dictionaries[LOCALE]['filter.trash']).props.onClick();
  renderPanel();
  selectRow(renderPanel(), 'trash-old');
  const restoreButton = buttons(renderPanel()).find((node) => squash(node) === dictionaries[LOCALE]['action.restore']);
  assert(restoreButton !== undefined, 'restore action missing');
  httpCalls.length = 0;
  restoreButton.props.onClick();
  await settle();
  const call = httpCalls.filter((entry) => entry.op === 'trash-restore')[0];
  assert(call !== undefined, 'no trash-restore request');
  assertEqual(JSON.stringify(call.sessionIds), JSON.stringify(['trash-old']), 'restore ids');
  assertEqual(statusText(renderPanel()), interpolate(dictionaries[LOCALE]['status.restored'], { count: 1 }), 'restore status');
  responder = () => undefined;
});

await checkAsync('v3: permanent deletion is a two-step confirm inside the recycle bin', async () => {
  responder = v3Responder();
  const tree = await mountPanel();
  segmentButton(tree, dictionaries[LOCALE]['filter.trash']).props.onClick();
  renderPanel();
  selectRow(renderPanel(), 'trash-old');
  const danger = buttons(renderPanel(), 'dangerText').find((node) => squash(node) === dictionaries[LOCALE]['action.purge']);
  assert(danger !== undefined, 'purge action missing');
  danger.props.onClick();
  const confirming = renderPanel();
  const text = squash(confirmBlock(confirming));
  assert(text.includes(interpolate(dictionaries[LOCALE]['confirm.purgeTitle'], { count: 1 })), 'purge confirm title missing');
  httpCalls.length = 0;
  buttons(confirming, 'dangerSolid')[0].props.onClick();
  await settle();
  assert(httpCalls.some((entry) => entry.op === 'trash-purge'), 'confirm must purge');
  responder = () => undefined;
});

await checkAsync('v3: moving sessions to the recycle bin uses the recovery wording', async () => {
  responder = v3Responder();
  const tree = await mountPanel();
  // Earlier checks permanently deleted some fixtures, so pick a row that is still visible.
  selectRow(renderPanel(), '夜间批处理');
  const trigger = buttons(renderPanel(), 'dangerText').find((node) => squash(node) === dictionaries[LOCALE]['action.delete']);
  assert(trigger !== undefined, 'delete action missing');
  trigger.props.onClick();
  const confirming = renderPanel();
  const text = squash(confirmBlock(confirming));
  assert(text.includes(interpolate(dictionaries[LOCALE]['confirm.trashTitle'], { count: 1 })), 'trash wording missing');
  assert(text.includes(interpolate(dictionaries[LOCALE]['confirm.trashBody'], { days: 30 })), 'retention hint missing');
  httpCalls.length = 0;
  buttons(confirming, 'dangerSolid')[0].props.onClick();
  await settle();
  const call = httpCalls.filter((entry) => entry.op === 'delete')[0];
  assert(call !== undefined, 'no delete request');
  assertEqual(JSON.stringify(call.sessionIds), JSON.stringify(['session-huge']), 'delete ids');
  const status = statusText(renderPanel());
  assert(status.includes('8.4 MB'), `status should report the moved size, got "${status}"`);
  responder = () => undefined;
});

await checkAsync('v3: the new failure codes are localized, not dumped raw', async () => {
  responder = v3Responder({
    delete: () => ({ payload: { ok: true, trashed: [], deleted: [], trashedBytes: 0, freedBytes: 0, failed: [{ sessionId: 'session-alpha', code: 'trash-entry-exists', reason: 'slot taken' }], auditLog: null } }),
  });
  await mountPanel();
  selectRow(renderPanel(), 'session-alpha');
  buttons(renderPanel(), 'dangerText').find((node) => squash(node) === dictionaries[LOCALE]['action.delete']).props.onClick();
  buttons(renderPanel(), 'dangerSolid')[0].props.onClick();
  await settle();
  const status = statusText(renderPanel());
  assert(status.includes(dictionaries[LOCALE]['fail.code.trash-entry-exists']), `localized code missing: "${status}"`);
  responder = () => undefined;
});

await checkAsync('v3: the workspace filter narrows the list and composes with search', async () => {
  responder = v3Responder({ 'trash-list': () => ({ payload: { ok: true, retentionDays: 30, totalBytes: 0, items: [] } }) });
  WORKSPACE_SPY.getSnapshot = () => ({
    archivedSessionIds: [],
    items: [
      { workspaceId: 'ws-auth', path: '/Users/ivanyin/work/auth', title: '鉴权服务' },
      { workspaceId: 'ws-docs', path: '/Users/ivanyin/work/docs', title: '文档站' },
    ],
  });
  const tree = await mountPanel();
  const targetPath = '/Users/ivanyin/work/auth';
  const unfiltered = rowsOf(tree);
  const expected = unfiltered.filter((row) => squash(row).includes('重构鉴权模块')).length;
  const workspaceButtons = collect(tree, (node) => node.tag === 'button' && node.props.className === 'dsh-sm-segbtn' && squash(node) === '鉴权服务');
  assert(workspaceButtons.length === 1, 'workspace segment missing');
  workspaceButtons[0].props.onClick();
  const filtered = rowsOf(renderPanel());
  assertEqual(filtered.length, expected, 'workspace filter row count');
  assert(filtered.every((row) => squash(row).includes('重构鉴权模块')), 'workspace filter leaked a foreign row');
  assert(unfiltered.length > expected, 'the fixture should contain rows outside that workspace');
  WORKSPACE_SPY.getSnapshot = () => ({ archivedSessionIds: archivedList });
  responder = () => undefined;
});

await checkAsync('v4: moving to the recycle bin offers an immediate undo', async () => {
  responder = v3Responder();
  await mountPanel();
  selectRow(renderPanel(), '夜间批处理');
  buttons(renderPanel(), 'dangerText').find((node) => squash(node) === dictionaries[LOCALE]['action.delete']).props.onClick();
  buttons(renderPanel(), 'dangerSolid')[0].props.onClick();
  await settle();
  const undo = linkButtons(renderPanel()).find((node) => squash(node) === dictionaries[LOCALE]['action.undo']);
  assert(undo !== undefined, 'the move should be undone with one click');
  httpCalls.length = 0;
  undo.props.onClick();
  await settle();
  const call = httpCalls.filter((entry) => entry.op === 'trash-restore')[0];
  assert(call !== undefined, 'undo must call trash-restore');
  assertEqual(JSON.stringify(call.sessionIds), JSON.stringify(['session-huge']), 'undo must target exactly what moved');
  responder = () => undefined;
});

await checkAsync('v4: the recycle bin replaces dead filters with a way back', async () => {
  responder = v3Responder();
  const tree = await mountPanel();
  segmentButton(tree, dictionaries[LOCALE]['filter.trash']).props.onClick();
  const trashView = renderPanel();
  const labels = collect(trashView, (node) => node.tag === 'button' && node.props.className === 'dsh-sm-segbtn').map((node) => squash(node));
  assert(labels.indexOf(dictionaries[LOCALE]['filter.archived']) < 0, 'archive filters must not linger in the recycle bin');
  const back = linkButtons(trashView).find((node) => squash(node).includes(dictionaries[LOCALE]['action.back']));
  assert(back !== undefined, 'the recycle bin needs a way back');
  back.props.onClick();
  const backToList = renderPanel();
  assert(segmentButton(backToList, dictionaries[LOCALE]['filter.all']) !== undefined, 'going back must restore the session filters');
  responder = () => undefined;
});

await checkAsync('v4: clearing a selection is an icon with an accessible name', async () => {
  responder = v3Responder();
  await mountPanel();
  selectRow(renderPanel(), '夜间批处理');
  const icons = collect(renderPanel(), (node) => node.tag === 'button' && node.props.className === 'dsh-sm-iconbtn');
  assert(icons.length === 1, 'exactly one icon button in the selection bar');
  assertEqual(icons[0].props['aria-label'], dictionaries[LOCALE]['action.clear'], 'icon needs an accessible name');
  icons[0].props.onClick();
  assert(renderPanel().some((node) => node.props.className === 'dsh-sm-bar') === false, 'clearing must dismiss the bar');
  responder = () => undefined;
});

await checkAsync('v4: a batch shows determinate progress instead of a bare counter', async () => {
  responder = v3Responder();
  await mountPanel();
  selectRow(renderPanel(), '夜间批处理');
  buttons(renderPanel(), 'primary')[0].props.onClick();
  const during = collect(renderPanel(), (node) => node.props.className === 'dsh-sm-progress')[0];
  assert(during !== undefined, 'no progress bar during the batch');
  assertEqual(during.props.role, 'progressbar', 'progress role');
  assert(typeof during.props['aria-valuenow'] === 'number' && typeof during.props['aria-valuemax'] === 'number', 'progress needs a value range');
  await settle();
  responder = () => undefined;
});

await checkAsync('v4 vocabulary: the joke names are the default, and one control swaps them', async () => {
  responder = v3Responder();
  // Back to the shipped default for this check.
  await mountPanel();
  setVocabulary('jargon');
  const office = await mountPanel();
  assertEqual(squash(collect(office, (node) => node.tag === 'h1')[0]), JARGON_UNDER_TEST.title, 'default title');
  assert(String(squash(office)).includes(JARGON_UNDER_TEST.pool), 'the recycle-bin filter should use the office wording');
  selectRow(office, '夜间批处理');
  assert(String(squash(renderPanel())).includes(JARGON_UNDER_TEST.offboard), 'the primary action should use the office wording');
  const swap = vocabSwitch(office);
  assert(swap !== undefined, 'the naming control must be visible');
  assertEqual(squash(swap), dictionaries[LOCALE]['vocab.toStandard'], 'the control names what it will give you');
  swap.props.onClick();
  const plain = renderPanel();
  assertEqual(squash(collect(plain, (node) => node.tag === 'h1')[0]), dictionaries[LOCALE]['panel.title'], 'plain title after the swap');
  assert(String(squash(plain)).includes(dictionaries[LOCALE]['action.delete']), 'plain action label after the swap');
  assertEqual(squash(vocabSwitch(plain)), dictionaries[LOCALE]['vocab.toJargon'], 'the control flips back');
  responder = () => undefined;
});

await checkAsync('v4 vocabulary: the chosen naming survives a remount', async () => {
  responder = v3Responder();
  await usePlainNames();
  const plainLabel = squash(collect(renderPanel(), (node) => node.tag === 'h1')[0]);
  await mountPanel();
  assertEqual(squash(collect(renderPanel(), (node) => node.tag === 'h1')[0]), plainLabel, 'the plain naming must survive a remount');
  setVocabulary('jargon');
  await mountPanel();
  assertEqual(squash(collect(renderPanel(), (node) => node.tag === 'h1')[0]), JARGON_UNDER_TEST.title, 'switching back must survive a remount too');
  responder = () => undefined;
});

await checkAsync('v4 vocabulary: the rail label follows the same choice', async () => {
  responder = v3Responder();
  await mountPanel();
  const before = registrations['sidebar.panellist'].options.label();
  vocabSwitch(renderPanel()).props.onClick();
  const after = registrations['sidebar.panellist'].options.label();
  assert(before !== after, `the rail label must change with the vocabulary (${before} → ${after})`);
  assert(String(after).length > 0, 'the rail label must never be empty');
  // leave the shipped default in place for the next run
  setVocabulary('jargon');
  responder = () => undefined;
});

await checkAsync('v4 vocabulary: the choice is stored so it survives a restart', async () => {
  responder = v3Responder();
  await mountPanel();
  setVocabulary('standard');
  const wrote = storageCalls.filter((entry) => entry[0] === 'dsh-session-manager:vocabulary').map((entry) => entry[1]);
  assert(wrote[wrote.length - 1] === 'standard', `the plain naming must be persisted, got ${JSON.stringify(wrote)}`);
  const control = vocabSwitch(renderPanel());
  control.props.onClick();
  const wroteBack = storageCalls.filter((entry) => entry[0] === 'dsh-session-manager:vocabulary').map((entry) => entry[1]);
  assert(wroteBack[wroteBack.length - 1] === 'jargon', 'switching back must persist too');
  responder = () => undefined;
});

await checkAsync('v4 vocabulary: a browser without storage still switches, just for this session', async () => {
  responder = v3Responder();
  const saved = globalThis.localStorage;
  globalThis.localStorage = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
  };
  try {
    await mountPanel();
    const control = vocabSwitch(renderPanel());
    assert(control !== undefined, 'the switch must render without storage');
    control.props.onClick();
    assert(vocabSwitch(renderPanel()) !== undefined, 'the switch must still work without storage');
  } finally {
    globalThis.localStorage = saved;
  }
  setVocabulary('jargon');
  responder = () => undefined;
});

await checkAsync('v5: the cleanup sheet reports references the history can no longer satisfy', async () => {
  responder = (body) => {
    if (body.op === 'gc-preview') {
      return {
        payload: {
          ok: true,
          report: {
            sessionsScanned: 120, referencedImages: 96, referencedFiles: 0,
            groups: [{ name: 'objects', files: 40, bytes: 1048576, deletableFiles: 4, deletableBytes: 262144 }],
            deletableBytes: 262144, cacheFiles: 0, cacheBytes: 0,
            unresolvedCount: 2, unresolvedSample: ['a'.repeat(64), 'b'.repeat(64)], storePresent: true,
          },
        },
      };
    }
    return undefined;
  };
  const tree = await mountPanel();
  linkButtons(tree)[0].props.onClick();
  await settle();
  const sheet = squash(gcBlock(renderPanel()));
  assert(sheet.includes(interpolate(dictionaries[LOCALE]['gc.unresolved'], { count: 2 })), `sheet must disclose the lost attachments, got: ${sheet}`);
  responder = () => undefined;
});

await checkAsync('v5: a cleanup that cannot verify itself is not reported as a clean success', async () => {
  responder = (body) => {
    if (body.op === 'gc-preview') {
      return { payload: { ok: true, report: { sessionsScanned: 9, referencedImages: 3, referencedFiles: 0, groups: [{ name: 'objects', files: 10, bytes: 2048, deletableFiles: 2, deletableBytes: 1024 }], deletableBytes: 1024, cacheFiles: 0, cacheBytes: 0, unresolvedCount: 0, storePresent: true } } };
    }
    if (body.op === 'gc') {
      return { payload: { ok: true, deletedFiles: 2, freedBytes: 1024, groups: [], failed: [], auditLog: '/tmp/audit.jsonl', verify: { checked: 3, ok: false, missingCount: 1, missingSample: ['c'.repeat(64)] } } };
    }
    return undefined;
  };
  const tree = await mountPanel();
  linkButtons(tree)[0].props.onClick();
  await settle();
  buttons(gcBlock(renderPanel()), 'dangerSolid')[0].props.onClick();
  await settle();
  const status = statusText(renderPanel());
  assert(status.includes(interpolate(dictionaries[LOCALE]['status.gcUnverified'], { files: '2', size: '1.0 KB', count: 1 })), `status must disclose the failed verification, got: ${status}`);
  const node = collect(renderPanel(), (item) => item.props.className === 'dsh-sm-status')[0];
  assertEqual(node?.props?.['data-tone'], 'error', 'an unverified cleanup is an error state');
  responder = () => undefined;
});

await checkAsync('v5: a restored session is visible before the session store catches up', async () => {
  responder = v3Responder();
  await usePlainNames();
  const tree = await mountPanel();
  const trashSegment = segmentButton(tree, dictionaries[LOCALE]['filter.trash']);
  assert(trashSegment !== undefined, 'recycle-bin segment missing');
  trashSegment.props.onClick();
  renderPanel();
  selectRow(renderPanel(), '旧的实验记录');
  const restoreButton = buttons(renderPanel()).find((node) => squash(node) === dictionaries[LOCALE]['action.restore']);
  assert(restoreButton !== undefined, 'restore action missing');
  restoreButton.props.onClick();
  await settle();
  setVocabulary('standard');
  const back = linkButtons(renderPanel()).find((node) => squash(node).includes(dictionaries[LOCALE]['action.back']));
  if (back !== undefined) back.props.onClick();
  const rows = rowsOf(renderPanel());
  assert(rows.some((row) => squash(row).includes('旧的实验记录')), `the restored session must stay visible, got: ${rows.map((row) => squash(row)).join(' | ')}`);
  responder = () => undefined;
});

await checkAsync('v5: switching the naming disposes the rail entry before registering the new one', async () => {
  responder = v3Responder();
  await mountPanel();
  setVocabulary('standard');
  await mountPanel();
  slotEvents.length = 0;
  setVocabulary('jargon');
  const rail = slotEvents.filter((event) => event[1] === 'sidebar.panellist');
  assert(rail.length >= 2, `expected a dispose + register pair, got: ${JSON.stringify(slotEvents)}`);
  assertEqual(rail[0][0], 'dispose', 'the old rail entry must be disposed first');
  assertEqual(rail[rail.length - 1][0], 'register', 'then the replacement is registered');
  assert(registrations['sidebar.panellist'] !== undefined, 'the rail entry must exist after the swap');
  responder = () => undefined;
});

await checkAsync('v6: the panel renders the Host verdict, and only warns where the Host warns', async () => {
  responder = v3Responder({
    risk: () => ({
      payload: {
        ok: true,
        policyVersion: 7,
        items: {
          'risk-pinned': { tier: 'high', reasons: [{ key: 'risk.reason.pinned' }, { key: 'risk.reason.children', count: 2 }] },
          'risk-running': { tier: 'high', reasons: [{ key: 'risk.reason.running' }] },
          'risk-blank': { tier: 'low', reasons: [{ key: 'risk.reason.blank' }] },
          'risk-recent': { tier: 'medium', reasons: [{ key: 'risk.reason.recent7d' }] },
        },
      },
    }),
  });
  await usePlainNames();
  const tree = await mountPanel(riskPanel());
  const mark = (title) => {
    const rows = rowsOf(tree);
    const row = rows.find((node) => squash(node).includes(title));
    assert(row !== undefined, `row not found: ${title}`);
    return collect(row, (node) => typeof node.props.className === 'string' && node.props.className.split(' ').indexOf('dsh-sm-risk') >= 0)[0];
  };
  const pinned = mark('置顶的规范');
  assert(pinned !== undefined, 'a Host "high" verdict must show the warning marker');
  const tooltip = String(pinned.props.title);
  assert(tooltip.includes(dictionaries[LOCALE]['risk.reason.pinned']), `tooltip must name the pinned reason, got: ${tooltip}`);
  assert(tooltip.includes(interpolate(dictionaries[LOCALE]['risk.reason.children'], { count: 2 })), `tooltip must report derived sessions, got: ${tooltip}`);
  assert(mark('正在跑的批处理') !== undefined, 'a running verdict must warn');
  assert(mark('空白草稿') === undefined, 'a low verdict must not warn');
  assert(mark('两周前的调研') === undefined, 'a row without a verdict must not warn');
  responder = () => undefined;
});

await checkAsync('v6: the recommendation selects exactly the rows the Host judged safe', async () => {
  responder = v3Responder({
    risk: () => ({
      payload: {
        ok: true,
        policyVersion: 7,
        items: {
          'risk-blank': { tier: 'low', reasons: [{ key: 'risk.reason.blank' }] },
          'risk-child': { tier: 'low', reasons: [{ key: 'risk.reason.subagent' }] },
          'risk-pinned': { tier: 'high', reasons: [{ key: 'risk.reason.pinned' }] },
          'risk-recent': { tier: 'medium', reasons: [{ key: 'risk.reason.recent7d' }] },
        },
      },
    }),
  });
  await usePlainNames();
  const tree = await mountPanel(riskPanel());
  const wanted = interpolate(dictionaries[LOCALE]['risk.selectLow'], { count: 2 });
  const suggest = linkButtons(tree).find((node) => squash(node) === wanted);
  assert(suggest !== undefined, `expected "${wanted}" in: ${linkButtons(tree).map((node) => squash(node)).join(' | ')}`);
  suggest.props.onClick();
  const selected = rowsOf(renderPanel(riskPanel())).filter((node) => node.props['aria-checked'] === 'true').map((node) => squash(node));
  assertEqual(selected.length, 2, 'exactly the two low-risk rows are selected');
  responder = () => undefined;
});

await checkAsync('v6: the confirm sheet groups the selection by the Host verdict', async () => {
  responder = v3Responder({
    risk: () => ({
      payload: {
        ok: true,
        policyVersion: 7,
        items: {
          'risk-blank': { tier: 'low', reasons: [{ key: 'risk.reason.blank' }] },
          'risk-pinned': { tier: 'high', reasons: [{ key: 'risk.reason.pinned' }] },
          'risk-recent': { tier: 'medium', reasons: [{ key: 'risk.reason.recent7d' }] },
        },
      },
    }),
  });
  await usePlainNames();
  await mountPanel(riskPanel());
  for (const title of ['空白草稿', '置顶的规范', '三天前的调试']) {
    const row = rowsOf(renderPanel(riskPanel())).find((node) => squash(node).includes(title));
    assert(row !== undefined, `row not found: ${title}`);
    row.props.onClick();
  }
  buttons(renderPanel(riskPanel()), 'dangerText').find((node) => squash(node) === dictionaries[LOCALE]['action.delete']).props.onClick();
  const sheet = renderPanel(riskPanel());
  const lines = collect(sheet, (node) => typeof node.props.className === 'string' && node.props.className.split(' ').indexOf('dsh-sm-riskline') >= 0).map((node) => String(squash(node)));
  assert(lines.some((line) => line.includes(dictionaries[LOCALE]['risk.low'])), `no low tier line: ${lines.join(' | ')}`);
  assert(lines.some((line) => line.includes(dictionaries[LOCALE]['risk.medium'])), `no medium tier line: ${lines.join(' | ')}`);
  const high = lines.find((line) => line.includes(dictionaries[LOCALE]['risk.high']));
  assert(high !== undefined, `no high tier line: ${lines.join(' | ')}`);
  assert(high.includes('置顶的规范'), `the warning line must name the session, got: ${high}`);
  responder = () => undefined;
});

await checkAsync('v6: without a Host verdict the panel judges nothing', async () => {
  responder = v3Responder({ risk: () => ({ status: 400, payload: { ok: false, reason: 'unknown op: risk' } }) });
  await usePlainNames();
  const tree = await mountPanel();
  assert(collect(tree, (node) => typeof node.props.className === 'string' && node.props.className.split(' ').indexOf('dsh-sm-risk') >= 0).length === 0, 'no verdict means no warning markers');
  assert(linkButtons(tree).every((node) => squash(node).indexOf('可放心删除') < 0), 'no verdict means no recommendation');
  const row = rowsOf(renderPanel()).find((node) => squash(node).includes('夜间批处理'));
  row.props.onClick();
  buttons(renderPanel(), 'dangerText').find((node) => squash(node) === dictionaries[LOCALE]['action.delete']).props.onClick();
  const lines = collect(renderPanel(), (node) => typeof node.props.className === 'string' && node.props.className.split(' ').indexOf('dsh-sm-riskline') >= 0);
  assertEqual(lines.length, 0, 'no verdict means no tier lines');
  responder = () => undefined;
});

await checkAsync('v8: a purge asks the Host to proceed and states the lineage cost first', async () => {
  responder = v3Responder({
    'trash-list': () => ({
      payload: {
        ok: true,
        retentionDays: 30,
        totalBytes: 2097152,
        items: [
          { sessionId: 'trash-old', title: '旧的实验记录', bytes: 1048576, trashedAt: Date.now() - 86400000, expiresAt: Date.now() + 864000000, expiresInDays: 29, originalPath: '/work/old/trash-old', descendantCount: 2 },
          { sessionId: 'trash-plain', title: '没有派生', bytes: 1048576, trashedAt: Date.now() - 86400000, expiresAt: Date.now() + 864000000, expiresInDays: 29, originalPath: '/work/old/trash-plain', descendantCount: 0 },
        ],
      },
    }),
  });
  await usePlainNames();
  const tree = await mountPanel();
  const trashSegment = segmentButton(tree, dictionaries[LOCALE]['filter.trash']);
  assert(trashSegment !== undefined, 'recycle-bin segment missing');
  trashSegment.props.onClick();
  renderPanel();
  selectRow(renderPanel(), '旧的实验记录');
  const purgeButton = buttons(renderPanel(), 'dangerText').find((node) => squash(node) === dictionaries[LOCALE]['action.purge']);
  assert(purgeButton !== undefined, 'purge action missing');
  purgeButton.props.onClick();
  const sheet = squash(confirmBlock(renderPanel()));
  assert(sheet.includes(interpolate(dictionaries[LOCALE]['confirm.purgeDescendants'], { entries: 1, count: 2 })), `the purge confirm must state the lineage cost, got: ${sheet}`);
  httpCalls.length = 0;
  buttons(confirmBlock(renderPanel()), 'dangerSolid')[0].props.onClick();
  await settle();
  const call = httpCalls.filter((entry) => entry.op === 'trash-purge')[0];
  assert(call !== undefined, 'no purge request');
  assertEqual(call.force, true, 'the acknowledged purge asks the Host to force');
  assertEqual(JSON.stringify(call.sessionIds), JSON.stringify(['trash-old']), 'purge ids');
  responder = () => undefined;
});

await checkAsync('v8: the new safety failures are localized, not shown as raw text', async () => {
  responder = v3Responder({
    delete: () => ({ payload: { ok: true, trashed: [], deleted: [], trashedBytes: 0, freedBytes: 0, failed: [{ sessionId: 'x', code: 'trash-verify-failed', reason: 'identity check failed' }, { sessionId: 'y', code: 'has-descendants', reason: 'still has 2 derived sessions' }], auditLog: null } }),
  });
  await usePlainNames();
  await mountPanel();
  selectRow(renderPanel(), '空白草稿');
  buttons(renderPanel(), 'dangerText').find((node) => squash(node) === dictionaries[LOCALE]['action.delete']).props.onClick();
  buttons(confirmBlock(renderPanel()), 'dangerSolid')[0].props.onClick();
  await settle();
  const status = statusText(renderPanel());
  assert(status.includes(dictionaries[LOCALE]['fail.code.trash-verify-failed']), `expected the localized verify failure, got: ${status}`);
  responder = () => undefined;
});

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

if (process.env.SM_DUMP === '1') {
  // Human-readable snapshot of the two surfaces a reviewer cannot see in CI.
  const settled = await mountPanel();
  const styleText = squash(collect(settled, (node) => node.tag === 'style')[0] ?? { kind: 'text', text: '' });
  const visible = squash(settled).replace(styleText, ' ').replace(/\s+/g, ' ').trim();
  console.log('\n--- panel ---\n' + visible.slice(0, 900));
  responder = (body) => (body.op === 'gc-preview'
    ? { payload: { ok: true, report: { sessionsScanned: 104, referencedImages: 12, referencedFiles: 3, groups: [{ name: 'objects', deletableFiles: 1200, deletableBytes: 471859200 }], deletableBytes: 471859200, cacheFiles: 40, cacheBytes: 4194304 } } }
    : undefined);
  let open = await mountPanel();
  linkButtons(open)[0].props.onClick();
  await settle();
  open = renderPanel();
  console.log('\n--- cleanup confirm ---\n' + squash(gcBlock(open)));
  responder = () => undefined;
}

const failures = results.filter((entry) => entry.ok !== true);
for (const entry of results) {
  console.log(`${entry.ok === true ? 'ok  ' : 'FAIL'}  ${entry.name}${entry.ok === true ? '' : `\n       ${entry.error}`}`);
}
console.log(`\n${results.length - failures.length}/${results.length} checks passed (locale: ${LOCALE})`);
// The panel owns a 60 s clock interval and the Host calls keep handlers alive;
// this harness ends by decision rather than by draining the loop.
process.exit(failures.length > 0 ? 1 : 0);