/**
 * Git-inspired project edit history (linear commits + HEAD), persisted in IndexedDB.
 *
 * Git stores a DAG of commits; each commit points to a *tree* (directory snapshot as hashes
 * to blob/tree objects). We use a simpler model: a **single-branch** list of *commits*,
 * each commit holds **deltas** `{ relPath, before, after }` (like patch metadata). `headIndex`
 * is which commit is currently applied (like `HEAD` on one branch). Undo moves HEAD back and
 * restores `before`; redo moves HEAD forward and reapplies `after`. New edits after an undo
 * truncate “future” commits (same idea as `git commit` after reset --soft, or detached history).
 *
 * Survives refresh; scoped per linked project `rootLabel`.
 */

const DB_NAME = 'socrates-workspace-undo'
const STORE = 'stacks'
const DB_VERSION = 2
const MAX_COMMITS = 48
/** Max combined before+after chars per delta (skip commit if exceeded). */
const MAX_PAIR_CHARS = 1_200_000

function normLabel(rootLabel) {
  return String(rootLabel || '').trim()
}

function normRel(relPath) {
  return String(relPath || '').replace(/\\/g, '/').trim()
}

function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `c-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function emptyChain() {
  return { v: 2, commits: [], headIndex: -1 }
}

/**
 * @param {any} raw
 * @returns {{ v: 2, commits: Array<{ id: string, at: number, deltas: Array<{ relPath: string, before: string, after: string }> }>, headIndex: number }}
 */
function normalizeState(raw) {
  if (raw && raw.v === 2 && Array.isArray(raw.commits) && typeof raw.headIndex === 'number') {
    const commits = raw.commits
    let headIndex = raw.headIndex
    if (!commits.length) headIndex = -1
    else headIndex = Math.min(Math.max(-1, headIndex), commits.length - 1)
    return { v: 2, commits, headIndex }
  }
  // v1: { undo: [{ relPath, before, after, at? }], redo: [] } → linear commits + HEAD at tip
  if (raw && Array.isArray(raw.undo) && raw.undo.length > 0) {
    const commits = raw.undo.map((e) => ({
      id: newId(),
      at: e.at || Date.now(),
      deltas: [
        {
          relPath: normRel(e.relPath),
          before: e.before == null ? '' : String(e.before),
          after: e.after == null ? '' : String(e.after),
        },
      ],
    }))
    return { v: 2, commits, headIndex: commits.length - 1 }
  }
  return emptyChain()
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onerror = () => reject(req.error)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
  })
}

async function loadState(label) {
  let db
  try {
    db = await openDb()
  } catch {
    return emptyChain()
  }
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const getReq = tx.objectStore(STORE).get(label)
      getReq.onsuccess = () => resolve(normalizeState(getReq.result))
      getReq.onerror = () => reject(getReq.error)
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    return emptyChain()
  } finally {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
}

async function saveState(label, state) {
  const out = { v: 2, commits: state.commits, headIndex: state.headIndex }
  let db
  try {
    db = await openDb()
  } catch {
    return
  }
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.objectStore(STORE).put(out, label)
    })
  } catch {
    /* ignore */
  } finally {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * Record one saved edit as a new commit at HEAD (truncates any redo branch).
 * @param {string} rootLabel
 * @param {string} relPath
 * @param {string} before
 * @param {string} after
 */
export async function pushWorkspaceEdit(rootLabel, relPath, before, after) {
  const label = normLabel(rootLabel)
  const rel = normRel(relPath)
  if (!label || !rel) return
  const b = before == null ? '' : String(before)
  const a = after == null ? '' : String(after)
  if (b === a) return
  if (b.length + a.length > MAX_PAIR_CHARS) return

  await recordWorkspaceCommit(label, [{ relPath: rel, before: b, after: a }])
}

/**
 * Record multiple file changes as a **single** commit (one Undo reverts the whole batch).
 * @param {string} rootLabel
 * @param {Array<{ relPath: string, before: string, after: string }>} deltas
 */
export async function pushWorkspaceCommitBatch(rootLabel, deltas) {
  const label = normLabel(rootLabel)
  if (!label || !deltas?.length) return
  const clean = []
  for (const d of deltas) {
    const rel = normRel(d.relPath)
    if (!rel) continue
    const b = d.before == null ? '' : String(d.before)
    const x = d.after == null ? '' : String(d.after)
    if (b === x) continue
    if (b.length + x.length > MAX_PAIR_CHARS) continue
    clean.push({ relPath: rel, before: b, after: x })
  }
  if (!clean.length) return
  await recordWorkspaceCommit(label, clean)
}

async function recordWorkspaceCommit(label, deltas) {
  let state = await loadState(label)
  const commits = state.commits.slice(0, state.headIndex + 1)
  commits.push({ id: newId(), at: Date.now(), deltas })
  let headIndex = commits.length - 1
  while (commits.length > MAX_COMMITS) {
    commits.shift()
    headIndex = Math.max(-1, headIndex - 1)
  }
  state = { v: 2, commits, headIndex }
  await saveState(label, state)
}

export async function workspaceUndoStatus(rootLabel) {
  const label = normLabel(rootLabel)
  if (!label) return { canUndo: false, canRedo: false }
  const state = await loadState(label)
  return {
    canUndo: state.headIndex >= 0,
    canRedo: state.headIndex < state.commits.length - 1,
  }
}

/**
 * Inspect current HEAD commit: apply these `before` contents to undo it.
 * @returns {Promise<{ deltas: Array<{ relPath: string, content: string }> } | null>}
 */
export async function peekWorkspaceUndo(rootLabel) {
  const label = normLabel(rootLabel)
  if (!label) return null
  const state = await loadState(label)
  if (state.headIndex < 0) return null
  const commit = state.commits[state.headIndex]
  if (!commit?.deltas?.length) return null
  return {
    deltas: commit.deltas.map((d) => ({ relPath: d.relPath, content: d.before })),
  }
}

/** After disk/cache successfully matches the undone state, move HEAD to parent commit. */
export async function finalizeWorkspaceUndoPop(rootLabel) {
  const label = normLabel(rootLabel)
  if (!label) return
  const state = await loadState(label)
  if (state.headIndex < 0) return
  state.headIndex -= 1
  await saveState(label, state)
}

/**
 * @returns {Promise<{ deltas: Array<{ relPath: string, content: string }> } | null>}
 */
export async function peekWorkspaceRedo(rootLabel) {
  const label = normLabel(rootLabel)
  if (!label) return null
  const state = await loadState(label)
  const next = state.headIndex + 1
  if (next >= state.commits.length) return null
  const commit = state.commits[next]
  if (!commit?.deltas?.length) return null
  return {
    deltas: commit.deltas.map((d) => ({ relPath: d.relPath, content: d.after })),
  }
}

export async function finalizeWorkspaceRedoPop(rootLabel) {
  const label = normLabel(rootLabel)
  if (!label) return
  const state = await loadState(label)
  if (state.headIndex >= state.commits.length - 1) return
  state.headIndex += 1
  await saveState(label, state)
}

export async function clearWorkspaceUndo(rootLabel) {
  const label = normLabel(rootLabel)
  if (!label) return
  let db
  try {
    db = await openDb()
  } catch {
    return
  }
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.objectStore(STORE).delete(label)
    })
  } catch {
    /* ignore */
  } finally {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
}
