/**
 * dsh-session-delete — delete a DSH session completely, without taking the Host down.
 *
 * WHY A PLUGIN. A DSH session is not one file. It is:
 *
 *   $DSH_HOME/sessions/<encoded cwd>/<sessionId>/
 *       session.v4.jsonl.zstd   the append-only log (the only source of truth)
 *       session.lock            the single-writer ownership record
 *   $DSH_HOME/storages/session_projcache/sessions/<sessionId>.json
 *                               the derived projection checkpoint
 *   $DSH_HOME/storages/workspace.json
 *                               the workspace registry: archivedSessionIds plus each
 *                               workspace's ordered sessionIds — this is what the Web
 *                               sidebar lists, so a session deleted without this step
 *                               stays on screen as a row that can no longer be opened
 *
 * Deleting the directory in Finder gets the first two and leaves the other two, and the
 * leftover registry row is what makes the UI look broken afterwards. Deleting a session
 * that is still LIVE is the other failure mode: the Agent keeps appending to a log whose
 * directory is gone, and the writer fails on a missing path.
 *
 * WHAT THIS DOES. One operation, one code path, shared by the `session_admin` tool and the
 * `/session-delete` command:
 *
 *   1. Resolve the session against the store (never by string-concatenating a user path).
 *   2. Refuse when the target is the session the caller is running in — DSH is asked to
 *      take down its own live session, which is the crash this plugin exists to prevent.
 *   3. Inspect: header, log bytes, lock ownership, workspace rows that reference it.
 *   4. Unless `force`, refuse when the session's Agent is live/running, or when its
 *      session.lock is held by a running process (an Agent in another Host or terminal).
 *   5. Cancel a live turn, flush durability, then delete — in that order, so ownership is
 *      released before the bytes go.
 *   6. Forget the session in the workspace registry (through `ctx.workspaceRegistry`,
 *      which owns that store, with direct file surgery only as a fallback), then remove
 *      the projection cache and the log directory.
 *
 * The tool is declared NOT concurrency-safe: two deletes of one session must not interleave
 * between "inspect" and "unlink".
 *
 * Layout-independent discovery. The encoded-cwd bucket name is not decoded or guessed:
 * the sessions root is scanned one level deep for a child directory whose name is exactly
 * the session id, so a change to the encoding cannot delete the wrong thing.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-session-delete';

/** Tool and command services this plugin contributes to. */
export const inject = ['tools', 'commands'];

export const TESTED_DSH_VERSION = '0.2.0-rc.2';

/** Session ids are minted as `session-<uuid>`; ids from older seeds are bare uuids. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// ── paths ──────────────────────────────────────────────────────────────────────────────

/**
 * The DSH home directory, in resolution order: `DSH_HOME` (set for every DSH-launched
 * process), then `$DSH_PROFILE_DIR` two levels up (`<home>/profiles/<name>`), then
 * `~/.dsh`. Each candidate is used only when it exists, so an unrelated `DSH_HOME` cannot
 * point this plugin at a directory it then fails to find sessions in.
 */
function resolveHome() {
  const candidates = [];
  if (process.env.DSH_HOME) candidates.push(process.env.DSH_HOME);
  if (process.env.DSH_PROFILE_DIR) candidates.push(resolve(process.env.DSH_PROFILE_DIR, '..', '..'));
  candidates.push(join(homedir(), '.dsh'));
  for (const candidate of candidates) {
    try {
      if (isAbsolute(candidate) && existsSync(candidate)) return candidate;
    } catch {
      /* unreadable candidate; try the next */
    }
  }
  return candidates[0];
}

const HOME = resolveHome();

/** `<home>/sessions`: one directory per encoded cwd, one directory per session inside it. */
const SESSIONS_ROOT = join(HOME, 'sessions');

/** `<home>/storages`: the KV-store root holding workspace.json and the projection cache. */
const STORAGES_ROOT = join(HOME, 'storages');

const WORKSPACE_STORE = join(STORAGES_ROOT, 'workspace.json');

const PROJ_CACHE_DIR = join(STORAGES_ROOT, 'session_projcache', 'sessions');

// ── small helpers ──────────────────────────────────────────────────────────────────────

/** True when `child` is `parent` itself or strictly inside it. */
function contains(parent, child) {
  const normalizedParent = resolve(parent);
  const normalizedChild = resolve(child);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(normalizedParent + sep);
}

/** Is `pid` a process that is currently alive? Signal 0 tests existence, not permission. */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error?.code === 'EPERM';
  }
}

/** Pull every plausible pid out of an unknown lock-file record shape. */
function lockOwnerPids(record) {
  const pids = new Set();
  const seen = new Set();
  const walk = (value, depth) => {
    if (value === null || value === undefined || depth > 4) return;
    if (typeof value === 'object') {
      if (seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        for (const item of value) walk(item, depth + 1);
        return;
      }
      for (const [key, item] of Object.entries(value)) {
        if (/pid/i.test(key) && Number.isInteger(item)) pids.add(item);
        else if (/pid/i.test(key) && typeof item === 'string' && /^\d+$/.test(item)) pids.add(Number(item));
        else walk(item, depth + 1);
      }
      return;
    }
  };
  walk(record, 0);
  return [...pids];
}

/** Read and JSON-parse a file, returning `undefined` for absent or invalid content. */
function readJson(path) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Directory size in bytes, best effort, for reporting only. */
function directoryBytes(path) {
  let total = 0;
  const walk = (target) => {
    let info;
    try {
      info = lstatSync(target);
    } catch {
      return;
    }
    if (info.isDirectory()) {
      let entries = [];
      try {
        entries = readdirSync(target);
      } catch {
        return;
      }
      for (const entry of entries) walk(join(target, entry));
      return;
    }
    total += info.size;
  };
  walk(path);
  return total;
}

/** readdir that keeps this file's walkers total: an unreadable directory is empty, not a throw. */
function readdir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

// ── the store ──────────────────────────────────────────────────────────────────────────

/**
 * Every directory that claims to be this session: the exact path under the sessions root.
 * Scanned, never constructed, so the cwd-encoding scheme is not a dependency.
 */
function sessionLogDirs(sessionId) {
  const found = [];
  if (!existsSync(SESSIONS_ROOT)) return found;
  let buckets = [];
  try {
    buckets = readdir(SESSIONS_ROOT);
  } catch {
    return found;
  }
  for (const bucket of buckets) {
    const bucketPath = join(SESSIONS_ROOT, bucket);
    let info;
    try {
      info = lstatSync(bucketPath);
    } catch {
      continue;
    }
    if (!info.isDirectory()) continue;
    const candidate = join(bucketPath, sessionId);
    try {
      if (lstatSync(candidate).isDirectory()) found.push(candidate);
    } catch {
      /* not this bucket */
    }
  }
  return found;
}

/** The projection-cache checkpoint path for one session. */
function projectionCachePath(sessionId) {
  return join(PROJ_CACHE_DIR, `${sessionId}.json`);
}

function validateSessionId(raw) {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (id === '') throw new Error('session_admin: "sessionId" is required.');
  if (!SESSION_ID.test(id) || id.includes('..') || id.includes('/') || id.includes('\\')) {
    throw new Error(`session_admin: "${raw}" is not a valid session id.`);
  }
  return id;
}

function readLock(dir) {
  const path = join(dir, 'session.lock');
  if (!existsSync(path)) return undefined;
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { path, unreadable: true };
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    record = { raw: raw.slice(0, 200) };
  }
  const pids = lockOwnerPids(record);
  return {
    path,
    record,
    pids,
    heldByRunningProcess: pids.some(processAlive),
  };
}

/** Workspace-store rows that reference this session, read from the durable store. */
function workspaceReferences(sessionId) {
  const store = readJson(WORKSPACE_STORE);
  if (store === undefined) return { store: undefined, workspaces: [], archived: false };
  const global = store.global ?? {};
  const tables = store.tables ?? {};
  const archivedList = Array.isArray(global.archivedSessionIds) ? global.archivedSessionIds : [];
  const workspaces = [];
  for (const [id, row] of Object.entries(tables.workspaces ?? {})) {
    const sessionIds = Array.isArray(row?.sessionIds) ? row.sessionIds : [];
    if (!sessionIds.includes(sessionId)) continue;
    workspaces.push({
      workspaceId: id,
      title: typeof row?.title === 'string' ? row.title : '',
      path: typeof row?.path === 'string' ? row.path : '',
    });
  }
  return {
    store,
    workspaces,
    archived: archivedList.includes(sessionId),
    pinned: Array.isArray(global.pinnedSessionIds) && global.pinnedSessionIds.includes(sessionId),
  };
}

/** What the live Host thinks of this session, without activating its Agent. */
async function liveState(ctx, sessionId) {
  const state = { inStore: false, running: false, agentAvailable: false, title: '', cwd: '', unknown: false };
  const controller = ctx.get('sessionController');
  if (!controller) {
    state.unknown = true;
    return state;
  }
  try {
    const listed = await controller.list({}, AbortSignal.timeout(5000));
    const row = (listed?.items ?? []).find((item) => item?.sessionId === sessionId);
    if (row) {
      state.inStore = true;
      state.running = row.running === true;
      state.agentAvailable = row.agentAvailable === true;
      state.cwd = typeof row.cwd === 'string' ? row.cwd : '';
    }
  } catch {
    // A failed listing must not turn into a failed delete; the lock check still guards it.
    state.unknown = true;
  }
  const inspector = ctx.get('sessionQuery');
  if (inspector?.readTitle) {
    try {
      const title = await inspector.readTitle(sessionId, AbortSignal.timeout(5000));
      if (typeof title?.title === 'string') state.title = title.title;
    } catch {
      /* a session without a title event is normal */
    }
  }
  return state;
}

/** One row of store-level facts for the list output. Declared keys only, never `undefined`. */
function describeSession(sessionId) {
  const dirs = sessionLogDirs(sessionId);
  const primary = dirs[0];
  const lock = primary ? readLock(primary) : undefined;
  const workspaces = workspaceReferences(sessionId);
  const cache = projectionCachePath(sessionId);
  const row = {
    sessionId,
    present: dirs.length > 0,
    bucketCount: dirs.length,
    logBytes: primary ? directoryBytes(primary) : 0,
    lockHeld: lock?.heldByRunningProcess === true,
    lockPids: (lock?.pids ?? []).filter(processAlive),
    projectionCache: existsSync(cache),
    workspaceIds: workspaces.workspaces.map((workspace) => workspace.workspaceId),
    archived: workspaces.archived,
    pinned: workspaces.pinned === true,
    logDirs: dirs,
  };
  if (primary !== undefined) row.logDir = primary;
  return row;
}

/** Every session id the durable stores know about, newest first. */
function listStoredSessions() {
  const ids = new Map();
  const note = (id, source) => {
    if (typeof id !== 'string' || id === '') return;
    const row = ids.get(id) ?? { sessionId: id, inLog: false, inWorkspace: false, inCache: false };
    row[source] = true;
    ids.set(id, row);
  };  if (existsSync(SESSIONS_ROOT)) {
    for (const bucket of readdir(SESSIONS_ROOT)) {
      const bucketPath = join(SESSIONS_ROOT, bucket);
      try {
        if (!lstatSync(bucketPath).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const entry of readdir(bucketPath)) {
        try {
          if (lstatSync(join(bucketPath, entry)).isDirectory()) note(entry, 'inLog');
        } catch {
          /* skip */
        }
      }
    }
  }
  const store = readJson(WORKSPACE_STORE);
  for (const [id, row] of Object.entries(store?.tables?.workspaces ?? {})) {
    for (const sessionId of row?.sessionIds ?? []) note(sessionId, 'inWorkspace');
  }
  if (existsSync(PROJ_CACHE_DIR)) {
    for (const file of readdir(PROJ_CACHE_DIR)) {
      if (file.endsWith('.json')) note(file.slice(0, -'.json'.length), 'inCache');
    }
  }
  return [...ids.values()];
}

/** Drop keys whose value is `undefined`: a tool result must be lossless JSON. */
function materialize(value) {
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out;
}

// ── workspace registry ─────────────────────────────────────────────────────────────────

/**
 * Drop the session from the workspace registry through the registry's OWN write path.
 *
 * This is the whole reason the row disappears without a restart. The registry keeps its
 * records in a storage domain: `table.update()` writes the medium AND emits
 * `domain/changed`, which is what the Host forwards to the browser. Editing
 * `workspace.json` as a file changes the medium but emits nothing, so the page keeps
 * rendering the row it already has until the app restarts and re-reads the store.
 *
 * The registry exposes no `detachSession` here — archive/unarchive/pin are its whole
 * public mutation surface — so this uses the domain table directly, which is exactly what
 * the registry's own `Entity.mutate()` does:
 *
 *   table.update(workspaceId, (record) => ({ ...record, sessionIds: without }))
 *   global.set({ ...state, archivedSessionIds, pinnedSessionIds })
 */
async function forgetInWorkspaceRegistry(ctx, sessionId) {
  const report = { viaService: false, viaFile: false, removedFrom: [], unarchived: false, error: undefined };
  const registry = ctx.get('workspaceRegistry');

  if (registry === undefined) {
    report.error = 'workspaceRegistry is unavailable';
  } else {
    // The registry-global sets: archived and pinned. An id can be in either without any
    // workspace accounting it, so both are checked independently of the workspace rows.
    const global = registry.global ?? registry.table_store;
    try {
      const state = global?.get?.();
      if (state !== undefined) {
        const next = {};
        if (Array.isArray(state.archivedSessionIds) && state.archivedSessionIds.includes(sessionId)) {
          next.archivedSessionIds = state.archivedSessionIds.filter((id) => id !== sessionId);
          report.unarchived = true;
        }
        if (Array.isArray(state.pinnedSessionIds) && state.pinnedSessionIds.includes(sessionId)) {
          next.pinnedSessionIds = state.pinnedSessionIds.filter((id) => id !== sessionId);
        }
        if (Object.keys(next).length > 0) {
          await global.set({ ...state, ...next });
          report.viaService = true;
        }
      }
    } catch (error) {
      report.error = `workspace global sets: ${error?.message ?? String(error)}`;
    }

    // The accounting row: drop the id from whichever workspace lists it.
    const table = registry.table ?? ctx.get('storageDomain')?.get?.('workspace')?.table?.('workspaces');
    if (table === undefined || typeof table.update !== 'function') {
      if (report.error === undefined) report.error = 'the workspace domain table is unreachable';
    } else {
      try {
        const ids = typeof table.keys === 'function' ? [...table.keys()] : [];
        for (const workspaceId of ids) {
          const record = table.get(workspaceId);
          if (!record || !Array.isArray(record.sessionIds) || !record.sessionIds.includes(sessionId)) continue;
          await table.update(workspaceId, (current) => ({
            ...current,
            sessionIds: current.sessionIds.filter((id) => id !== sessionId),
            updatedAt: new Date().toISOString(),
          }));
          report.removedFrom.push(workspaceId);
          report.viaService = true;
        }
      } catch (error) {
        report.error = `workspace accounting row: ${error?.message ?? String(error)}`;
      }
    }
  }

  // FALLBACK FOR A DIFFERENT DSH VERSION. The service path relies on registry internals
  // (`registry.table`, `registry.global`) that another build may not expose, and on a box
  // with no registry service at all there is nothing to call. In either case the row is
  // still removed from the store file, so the session leaves the list on the next
  // refresh/restart instead of surviving forever. This emits no change event, which is
  // the whole reason the service path is preferred.
  if (report.removedFrom.length === 0) {
    const viaFile = forgetInStoreFile(sessionId);
    if (viaFile.changed) {
      report.viaFile = true;
      report.removedFrom = viaFile.removedFrom;
      report.unarchived = report.unarchived || viaFile.unarchived;
      report.error = undefined; // the row is gone from the store; the service path was the only thing missing
    } else if (report.error !== undefined) {
      report.error = `${report.error}; the store file held no row for it either`;
    }
  }

  return report;
}

/** Remove the session's rows from `workspace.json` directly; the no-service fallback. */
function forgetInStoreFile(sessionId) {
  const outcome = { changed: false, removedFrom: [], unarchived: false };
  const store = readJson(WORKSPACE_STORE);
  if (!store || typeof store !== 'object') return outcome;

  const global = store.global ?? {};
  if (Array.isArray(global.archivedSessionIds) && global.archivedSessionIds.includes(sessionId)) {
    global.archivedSessionIds = global.archivedSessionIds.filter((id) => id !== sessionId);
    outcome.unarchived = true;
    outcome.changed = true;
  }
  if (Array.isArray(global.pinnedSessionIds) && global.pinnedSessionIds.includes(sessionId)) {
    global.pinnedSessionIds = global.pinnedSessionIds.filter((id) => id !== sessionId);
    outcome.changed = true;
  }
  store.global = global;

  for (const [workspaceId, row] of Object.entries(store.tables?.workspaces ?? {})) {
    if (!Array.isArray(row?.sessionIds) || !row.sessionIds.includes(sessionId)) continue;
    row.sessionIds = row.sessionIds.filter((id) => id !== sessionId);
    outcome.removedFrom.push(workspaceId);
    outcome.changed = true;
  }

  if (!outcome.changed) return outcome;
  try {
    const temporary = `${WORKSPACE_STORE}.tmp-session-delete`;
    writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`);
    renameSync(temporary, WORKSPACE_STORE);
  } catch (error) {
    return { changed: false, removedFrom: [], unarchived: false, error: error?.message ?? String(error) };
  }
  return outcome;
}

// ── the operation ──────────────────────────────────────────────────────────────────────

/**
 * Inspect one session. Pure reads: no Agent is resumed, nothing is written.
 *
 * Every field is materialized (never `undefined`): the Host refuses a tool result that is
 * not lossless JSON, and the declared schema marks absent fields optional, so a field with
 * nothing to report is omitted rather than set to `undefined`.
 */
export async function inspectSession(ctx, rawId) {
  const sessionId = validateSessionId(rawId);
  const described = describeSession(sessionId);
  const live = await liveState(ctx, sessionId);
  const workspaces = workspaceReferences(sessionId);
  const finding = {
    sessionId,
    exists: described.present || workspaces.workspaces.length > 0 || described.projectionCache,
    present: described.present,
    bucketCount: described.bucketCount,
    logBytes: described.logBytes,
    live: live.inStore === true,
    running: live.running === true,
    agentAvailable: live.agentAvailable === true,
    liveStateUnknown: live.unknown === true,
    lockHeld: described.lockHeld === true,
    lockPids: described.lockPids,
    projectionCache: described.projectionCache === true,
    workspaceIds: described.workspaceIds,
    workspaceTitles: workspaces.workspaces.map((workspace) => workspace.title || workspace.workspaceId),
    archived: described.archived === true,
    pinned: described.pinned === true,
  };
  const title = live.title || undefined;
  if (title !== undefined) finding.title = title;
  const cwd = live.cwd || described.cwd || undefined;
  if (cwd !== undefined) finding.cwd = cwd;
  if (described.logDir !== undefined) finding.logDir = described.logDir;
  if (described.logDirs.length > 0) finding.logDirs = described.logDirs;
  return finding;
}

/**
 * Delete one session. Every guard is checked before anything is removed, so a refusal
 * leaves the store exactly as it was.
 */
export async function deleteSession(ctx, rawId, options = {}) {
  const sessionId = validateSessionId(rawId);
  const force = options.force === true;
  const dryRun = options.dryRun === true;
  const callerSessionId = typeof options.callerSessionId === 'string' ? options.callerSessionId : undefined;

  const described = describeSession(sessionId);
  const live = await liveState(ctx, sessionId);
  const workspaces = workspaceReferences(sessionId);

  // Guard 1, checked before existence: never delete the session the caller is running in.
  // This is the crash case — the Agent would keep appending to a log this call just
  // unlinked — so it holds whether or not the log is still on disk.
  if (callerSessionId !== undefined && callerSessionId === sessionId) {
    return materialize({
      ok: false,
      sessionId,
      reason: 'self',
      message: `Refusing to delete ${sessionId}: it is the live session running this call.`,
    });
  }

  const exists = described.present || workspaces.workspaces.length > 0 || described.projectionCache;
  if (!exists) {
    return materialize({
      ok: false,
      sessionId,
      reason: 'not-found',
      message: `No stored session ${sessionId} in ${HOME}.`,
    });
  }

  // Guard 2: a live or running Agent owns the log. `force` releases it first.
  const activity = {
    agentLive: live.inStore,
    running: live.running,
    lockHeld: described.lockHeld,
    lockPids: described.lockPids,
  };
  const busy = live.running || described.lockHeld;

  if (dryRun) {
    return materialize({
      ok: true,
      dryRun: true,
      sessionId,
      actionable: !busy || force,
      wouldBlock: busy && !force,
      activity,
      files: materialize({
        logDirs: described.logDirs,
        projectionCache: described.projectionCache ? projectionCachePath(sessionId) : undefined,
        logBytes: described.logBytes,
      }),
      workspaceIds: described.workspaceIds,
      archived: described.archived,
      title: live.title || undefined,
      message: busy
        ? `${sessionId} is ${live.running ? 'running' : 'lock-held by pid ' + described.lockPids.join(', ')}; a real delete would need force: true.`
        : `${sessionId} can be deleted.`,
    });
  }

  if (busy && !force) {
    const who = live.running
      ? 'its Agent is running'
      : `its session.lock is held by a running process (pid ${described.lockPids.join(', ') || 'unknown'})`;
    return materialize({
      ok: false,
      sessionId,
      reason: live.running ? 'running' : 'locked',
      message: `Refusing to delete ${sessionId} while ${who}. Finish or cancel that work, or pass force: true to release it first.`,
      activity,
    });
  }

  const steps = [];
  const errors = [];

  // Step 1: release whatever owns the log before the bytes go. A cancellation is
  // asynchronous by nature; this is the point where a crash would otherwise happen.
  if (busy && force) {
    const controller = ctx.get('sessionController');
    if (live.running && controller?.cancel) {
      try {
        controller.cancel({ sessionId });
        steps.push('cancelled the running turn');
      } catch (error) {
        errors.push(`cancel failed: ${error?.message ?? String(error)}`);
      }
    }
    const sessions = ctx.get('sessions');
    const liveSession = sessions?.get?.(sessionId);
    if (liveSession) {
      try {
        const flushed = await sessions.flush(liveSession);
        steps.push(flushed ? 'flushed the live session log' : 'nothing to flush');
      } catch (error) {
        errors.push(`flush failed: ${error?.message ?? String(error)}`);
      }
    }
  }

  // Step 2: take the session off the sidebar. Doing this before the unlink means a UI that
  // refreshes mid-delete sees a session that is gone rather than a row with no log.
  const registry = await forgetInWorkspaceRegistry(ctx, sessionId);
  if (registry.viaService) {
    steps.push(
      registry.removedFrom.length > 0
        ? `removed the workspace row in ${registry.removedFrom.join(', ')}`
        : 'cleared the archived/pinned entry',
    );
  }
  if (registry.error) errors.push(registry.error);

  // Step 3: derived state.
  const cache = projectionCachePath(sessionId);
  let cacheDeleted = false;
  if (existsSync(cache)) {
    try {
      rmSync(cache, { force: true });
      cacheDeleted = true;
      steps.push('deleted the projection cache');
    } catch (error) {
      errors.push(`projection cache: ${error?.message ?? String(error)}`);
    }
  }

  // Step 4: the log itself. Guarded by containment so a resolved path can never escape
  // the sessions root, whatever the store reports.
  const deletedDirs = [];
  for (const dir of described.logDirs) {
    if (!contains(SESSIONS_ROOT, dir)) {
      errors.push(`refused a path outside ${SESSIONS_ROOT}: ${dir}`);
      continue;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
      deletedDirs.push(dir);
      steps.push(`deleted ${dir}`);
    } catch (error) {
      errors.push(`log directory ${dir}: ${error?.message ?? String(error)}`);
    }
  }

  const remaining = sessionLogDirs(sessionId);
  const after = workspaceReferences(sessionId);
  const complete = remaining.length === 0 && !after.archived && after.workspaces.length === 0 && !existsSync(cache);

  return materialize({
    ok: complete && deletedDirs.length > 0,
    sessionId,
    title: live.title || undefined,
    deleted: complete,
    activity,
    steps,
    errors: errors.length > 0 ? errors : undefined,
    removed: materialize({
      logDirs: deletedDirs,
      projectionCache: cacheDeleted ? cache : undefined,
      workspaceIds: registry.viaService ? registry.removedFrom : [],
    }),
    remaining: {
      logDirs: remaining,
      workspaceIds: after.workspaces.map((workspace) => workspace.workspaceId),
      archived: after.archived,
      projectionCache: existsSync(cache),
    },
    message: complete
      ? `Deleted ${sessionId}${live.title ? ` (${live.title})` : ''}: log, lock, projection cache and workspace rows are gone.`
      : `Deleted what it could of ${sessionId}; see errors for what remains.`,
  });
}

// ── output shapes (declared so the tool result matches its schema exactly) ─────────────

const ACTIVITY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agentLive: { type: 'boolean' },
    running: { type: 'boolean' },
    lockHeld: { type: 'boolean' },
    lockPids: { type: 'array', items: { type: 'integer' } },
  },
};

const LIST_ROW = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string' },
    title: { type: 'string' },
    cwd: { type: 'string' },
    inLog: { type: 'boolean' },
    inWorkspace: { type: 'boolean' },
    inCache: { type: 'boolean' },
    archived: { type: 'boolean' },
    running: { type: 'boolean' },
    lockHeld: { type: 'boolean' },
    logBytes: { type: 'integer' },
  },
};

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string' },
    title: { type: 'string' },
    exists: { type: 'boolean' },
    present: { type: 'boolean' },
    bucketCount: { type: 'integer' },
    logBytes: { type: 'integer' },
    live: { type: 'boolean' },
    running: { type: 'boolean' },
    agentAvailable: { type: 'boolean' },
    liveStateUnknown: { type: 'boolean' },
    lockHeld: { type: 'boolean' },
    lockPids: { type: 'array', items: { type: 'integer' } },
    projectionCache: { type: 'boolean' },
    workspaceIds: { type: 'array', items: { type: 'string' } },
    workspaceTitles: { type: 'array', items: { type: 'string' } },
    archived: { type: 'boolean' },
    pinned: { type: 'boolean' },
    cwd: { type: 'string' },
    logDir: { type: 'string' },
    logDirs: { type: 'array', items: { type: 'string' } },
  },
};

// ── the tool ───────────────────────────────────────────────────────────────────────────

function renderResult(value) {
  const lines = [];
  if (value.action === 'list') {
    lines.push(`${value.sessions.length} stored session(s) in ${HOME}`);
    for (const row of value.sessions) {
      const flags = [
        row.running ? 'running' : undefined,
        row.lockHeld ? 'locked' : undefined,
        row.archived ? 'archived' : undefined,
        row.inLog ? undefined : 'log-missing',
        row.inWorkspace ? undefined : 'not-in-workspace',
      ].filter(Boolean);
      lines.push(`- ${row.sessionId}${row.title ? ` — ${row.title}` : ''}${flags.length ? ` [${flags.join(', ')}]` : ''}`);
    }
    lines.push('', 'Delete one with session_admin action="delete".');
    return [{ type: 'text', text: lines.join('\n') }];
  }
  if (value.action === 'inspect') {
    const finding = value.session;
    lines.push(`${finding.sessionId}${finding.title ? ` — ${finding.title}` : ''}`);
    lines.push(`exists: ${finding.exists} | log directories: ${finding.bucketCount} | bytes: ${finding.logBytes}`);
    lines.push(`live: ${finding.live} | running: ${finding.running} | lock held: ${finding.lockHeld}`);
    lines.push(`projection cache: ${finding.projectionCache} | workspace rows: ${finding.workspaceIds.length}`);
    if (finding.archived) lines.push('archived: yes');
    if (finding.logDir) lines.push(`log: ${finding.logDir}`);
    if (finding.cwd) lines.push(`cwd: ${finding.cwd}`);
    return [{ type: 'text', text: lines.join('\n') }];
  }
  if (value.action === 'delete') {
    const result = value.result;
    lines.push(result.message);
    lines.push(`ok: ${result.ok}${result.reason ? ` | reason: ${result.reason}` : ''}`);
    for (const step of result.steps ?? []) lines.push(`✓ ${step}`);
    for (const error of result.errors ?? []) lines.push(`✗ ${error}`);
    if (result.dryRun && result.files) {
      lines.push('', 'Would remove:');
      for (const dir of result.files.logDirs ?? []) lines.push(`- ${dir}`);
      if (result.files.projectionCache) lines.push(`- ${result.files.projectionCache}`);
      for (const id of result.workspaceIds ?? []) lines.push(`- workspace row in ${id}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  }
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

function createSessionAdminTool(ctx) {
  return {
    name: 'session_admin',
    description:
      'List, inspect and FULLY delete stored DSH sessions. A session is the log directory plus its lock, its projection-cache checkpoint, and its workspace-registry row; "delete" removes all of them, which deleting the folder by hand does not. Use action="list" to see ids, action="inspect" to see exactly what a delete would remove, and action="delete" to remove it. Deleting a running or lock-held session is refused unless force is true; deleting the session this call runs in is always refused, because that would take the live Agent down with it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'inspect', 'delete'],
          description: 'list every stored session; inspect one session without changing anything; delete one session.',
        },
        sessionId: {
          type: 'string',
          description: 'The session id (for inspect and delete), e.g. session-2cfd2cf0-32bc-40c7-a99c-925c44c761e3.',
        },
        force: {
          type: 'boolean',
          description: 'For delete: cancel the running turn and delete even though the Agent is live or the lock is held. Without it, such a delete is refused.',
        },
        dryRun: {
          type: 'boolean',
          description: 'For delete: report exactly what would be removed and whether it would be blocked, without removing anything.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['list', 'inspect', 'delete'] },
          home: { type: 'string' },
          sessions: { type: 'array', items: LIST_ROW },
          session: { type: 'object', additionalProperties: false, properties: FINDING_SCHEMA.properties },
          result: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              sessionId: { type: 'string' },
              title: { type: 'string' },
              reason: { type: 'string' },
              message: { type: 'string' },
              dryRun: { type: 'boolean' },
              actionable: { type: 'boolean' },
              wouldBlock: { type: 'boolean' },
              deleted: { type: 'boolean' },
              activity: ACTIVITY_SCHEMA,
              steps: { type: 'array', items: { type: 'string' } },
              errors: { type: 'array', items: { type: 'string' } },
              files: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  logDirs: { type: 'array', items: { type: 'string' } },
                  projectionCache: { type: 'string' },
                  logBytes: { type: 'integer' },
                },
              },
              workspaceIds: { type: 'array', items: { type: 'string' } },
              archived: { type: 'boolean' },
              removed: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  logDirs: { type: 'array', items: { type: 'string' } },
                  projectionCache: { type: 'string' },
                  workspaceIds: { type: 'array', items: { type: 'string' } },
                },
              },
              remaining: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  logDirs: { type: 'array', items: { type: 'string' } },
                  workspaceIds: { type: 'array', items: { type: 'string' } },
                  archived: { type: 'boolean' },
                  projectionCache: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => renderResult(value),
    },
    async execute(args, exec) {
      const action = args?.action;
      if (action !== 'list' && action !== 'inspect' && action !== 'delete') {
        throw new Error('session_admin: "action" must be one of "list", "inspect", "delete".');
      }
      if (action === 'list') {
        return { action, home: HOME, sessions: listStoredSessions() };
      }
      if (action === 'inspect') {
        const session = await inspectSession(ctx, args?.sessionId);
        return { action, home: HOME, session };
      }
      // The caller's own session id is the correlation the ExecContext exposes; when it is
      // absent the self-delete guard cannot be evaluated, so the tool refuses to guess.
      const callerSessionId = exec?.agent?.session?.header?.id;
      if (typeof callerSessionId !== 'string') {
        throw new Error('session_admin: could not resolve the calling session; refusing to delete.');
      }
      const result = await deleteSession(ctx, args?.sessionId, {
        force: args?.force === true,
        dryRun: args?.dryRun === true,
        callerSessionId,
      });
      return { action, home: HOME, result };
    },
    presentCall(args) {
      const label = { list: 'List sessions', inspect: 'Inspect session', delete: 'Delete session' }[args?.action] ?? 'Sessions';
      return {
        card: 'generic',
        title: args?.sessionId ? `${label} ${args.sessionId}` : label,
        kind: 'other',
        rawInput: args?.sessionId,
      };
    },
    // Two deletes must not interleave between "inspect" and "unlink".
    isConcurrencySafe() {
      return false;
    },
    timeoutMs: 60000,
  };
}

// ── commands ───────────────────────────────────────────────────────────────────────────

const COMMANDS = [
  {
    name: 'session-list',
    description: 'List every stored DSH session with the flags that decide whether it can be deleted.',
    input: { hint: '[nothing]' },
  },
  {
    name: 'session-delete',
    description: 'Fully delete a DSH session: log, lock, projection cache and workspace row. Add "force" to release a running session first.',
    input: { hint: '<session-id> [force]' },
  },
];

function parseDeleteInput(rawInput) {
  const tokens = String(rawInput ?? '')
    .trim()
    .split(/\s+/)
    .filter((token) => token !== '');
  const force = tokens.includes('force') || tokens.includes('--force');
  const sessionId = tokens.find((token) => token !== 'force' && token !== '--force');
  return { sessionId, force };
}

/**
 * Register the plugin's tool and commands. Everything is registered on the global layer,
 * so every agent and the Web composer see it, and every disposer is yielded as an effect.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(createSessionAdminTool(ctx)), 'session_admin tool registration');

  for (const command of COMMANDS) {
    ctx.effect(
      () =>
        ctx.commands.register({
          name: command.name,
          description: command.description,
          input: command.input,
          handler: async (invocation) => {
            try {
              if (command.name === 'session-list') {
                const rows = listStoredSessions();
                if (rows.length === 0) return { kind: 'success', text: `No stored sessions in ${HOME}.` };
                const text = rows
                  .map((row) => {
                    const flags = [
                      row.running ? 'running' : undefined,
                      row.lockHeld ? 'locked' : undefined,
                      row.archived ? 'archived' : undefined,
                      row.inLog ? undefined : 'log-missing',
                    ].filter(Boolean);
                    return `${row.sessionId}${flags.length ? `  [${flags.join(', ')}]` : ''}`;
                  })
                  .join('\n');
                return { kind: 'success', text: `${rows.length} stored session(s):\n${text}` };
              }

              const { sessionId, force } = parseDeleteInput(invocation.rawInput);
              if (sessionId === undefined) {
                return { kind: 'error', text: 'Usage: /session-delete <session-id> [force]' };
              }
              const result = await deleteSession(ctx, sessionId, {
                force,
                callerSessionId: invocation.agent?.id,
              });
              return { kind: result.ok ? 'success' : 'error', text: result.message };
            } catch (error) {
              return { kind: 'error', text: `${command.name}: ${error?.message ?? String(error)}` };
            }
          },
        }),
      `${command.name} command registration`,
    );
  }
}
