/**
 * Persist FileSystemDirectoryHandle across reloads (Chromium File System Access API).
 * Stored handle is tied to workspaceLocalLabel so we don't open the wrong folder after imports.
 */

const DB_NAME = 'socrates-project-fs'
const STORE = 'handles'
const KEY = 'root-directory'

/** @returns {Promise<void>} */
export async function saveProjectRootHandleRecord(handle, rootLabel) {
  const label = String(rootLabel || '').trim()
  if (!handle || !label) return
  await idbPut({ handle, rootLabel: label })
}

/** @returns {Promise<{ handle: FileSystemDirectoryHandle, rootLabel: string } | null>} */
export async function loadProjectRootHandleRecord() {
  return idbGet()
}

/** @returns {Promise<void>} */
export async function clearProjectRootHandleRecord() {
  await idbDelete()
}

/**
 * @param {FileSystemDirectoryHandle} handle
 * @returns {Promise<boolean>}
 */
export async function ensureDirectoryReadPermission(handle) {
  if (!handle || handle.kind !== 'directory') return false
  const opts = { mode: 'read' }
  try {
    if ((await handle.queryPermission(opts)) === 'granted') return true
    if ((await handle.requestPermission(opts)) === 'granted') return true
  } catch {
    return false
  }
  return false
}

/**
 * Required for saving files back through the directory handle (createWritable).
 * @param {FileSystemDirectoryHandle} handle
 * @returns {Promise<boolean>}
 */
export async function ensureDirectoryReadWritePermission(handle) {
  if (!handle || handle.kind !== 'directory') return false
  const opts = { mode: 'readwrite' }
  try {
    if ((await handle.queryPermission(opts)) === 'granted') return true
    if ((await handle.requestPermission(opts)) === 'granted') return true
  } catch {
    return false
  }
  return false
}

function idbPut(value) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onerror = () => reject(req.error)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(STORE, 'readwrite')
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
      tx.objectStore(STORE).put(value, KEY)
    }
  })
}

function idbGet() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onerror = () => reject(req.error)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(STORE, 'readonly')
      const getReq = tx.objectStore(STORE).get(KEY)
      getReq.onsuccess = () => {
        db.close()
        resolve(getReq.result ?? null)
      }
      getReq.onerror = () => reject(getReq.error)
    }
  })
}

function idbDelete() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onerror = () => reject(req.error)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.close()
        resolve()
        return
      }
      const tx = db.transaction(STORE, 'readwrite')
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
      tx.objectStore(STORE).delete(KEY)
    }
  })
}
