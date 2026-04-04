import { useCallback, useEffect, useMemo, useState } from 'react'
import { applyPatch, structuredPatch } from 'diff'

/**
 * Apply only accepted hunks from a structured patch. Returns null if patch application fails.
 */
export function mergeWithAcceptedHunks(base, proposed, acceptedHunkIndices) {
  const patch = structuredPatch('a', 'b', base ?? '', proposed ?? '', 'a', 'b', { context: 2 })
  const all = patch.hunks || []
  if (all.length === 0) return (proposed ?? '') === (base ?? '') ? base : proposed
  const set = new Set(acceptedHunkIndices)
  const picked = all.filter((_, i) => set.has(i))
  if (picked.length === 0) return base ?? ''
  if (picked.length === all.length) return proposed ?? ''
  try {
    const filtered = { ...patch, hunks: picked }
    const out = applyPatch(base ?? '', filtered)
    return typeof out === 'string' ? out : null
  } catch {
    return null
  }
}

export function WorkspaceFileReview({
  session,
  workspaceLabel,
  resolveBaseContent,
  onWriteFile,
  onDismiss,
  onOpenFile,
}) {
  const [filesState, setFilesState] = useState([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [acceptedByPath, setAcceptedByPath] = useState(() => new Map())
  const [applyError, setApplyError] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!session?.files?.length) {
      setFilesState([])
      return
    }
    let cancelled = false
    ;(async () => {
      const loaded = []
      for (const item of session.files) {
        const path = item.path
        const proposed = item.content ?? ''
        let base = ''
        try {
          base = (await resolveBaseContent(path)) || ''
        } catch {
          base = ''
        }
        if (cancelled) return
        loaded.push({ path, base, proposed })
      }
      if (cancelled) return
      setFilesState(loaded)
      setActiveIndex(0)
      const next = new Map()
      for (const { path, base, proposed } of loaded) {
        const patch = structuredPatch(path, path, base, proposed, path, path, { context: 2 })
        const n = patch.hunks?.length ?? 0
        next.set(path, n ? new Set(Array.from({ length: n }, (_, i) => i)) : new Set())
      }
      setAcceptedByPath(next)
      setApplyError(null)
    })()
    return () => {
      cancelled = true
    }
  }, [session, resolveBaseContent])

  const active = filesState[activeIndex] || null

  const patch = useMemo(() => {
    if (!active) return null
    return structuredPatch(
      active.path,
      active.path,
      active.base,
      active.proposed,
      active.path,
      active.path,
      { context: 2 },
    )
  }, [active])

  const hunks = patch?.hunks || []
  const acceptedSet = active ? acceptedByPath.get(active.path) || new Set() : new Set()

  const toggleHunk = useCallback(
    (hunkIdx) => {
      if (!active) return
      setAcceptedByPath((prev) => {
        const m = new Map(prev)
        const s = new Set(m.get(active.path) || [])
        if (s.has(hunkIdx)) s.delete(hunkIdx)
        else s.add(hunkIdx)
        m.set(active.path, s)
        return m
      })
    },
    [active],
  )

  const keepAllHunksForActive = useCallback(() => {
    if (!active || !hunks.length) return
    setAcceptedByPath((prev) => {
      const m = new Map(prev)
      m.set(active.path, new Set(Array.from({ length: hunks.length }, (_, i) => i)))
      return m
    })
  }, [active, hunks.length])

  const rejectAllHunksForActive = useCallback(() => {
    if (!active) return
    setAcceptedByPath((prev) => {
      const m = new Map(prev)
      m.set(active.path, new Set())
      return m
    })
  }, [active])

  const writeAndContinue = useCallback(
    async (path, content) => {
      setBusy(true)
      setApplyError(null)
      try {
        const r = await onWriteFile(path, content)
        if (!r?.ok) {
          setApplyError(r?.error || 'Could not write file.')
          return false
        }
        setFilesState((fs) => {
          const next = fs.filter((f) => f.path !== path)
          if (next.length === 0) Promise.resolve().then(onDismiss)
          else setActiveIndex(0)
          return next
        })
        setAcceptedByPath((prev) => {
          const m = new Map(prev)
          m.delete(path)
          return m
        })
        return true
      } finally {
        setBusy(false)
      }
    },
    [onDismiss, onWriteFile],
  )

  const onKeepFile = useCallback(async () => {
    if (!active || busy) return
    await writeAndContinue(active.path, active.proposed)
  }, [active, busy, writeAndContinue])

  const onDiscardFile = useCallback(() => {
    if (!active || busy) return
    const ap = active.path
    setFilesState((fs) => {
      const next = fs.filter((f) => f.path !== ap)
      if (next.length === 0) Promise.resolve().then(onDismiss)
      else setActiveIndex(0)
      return next
    })
    setAcceptedByPath((prev) => {
      const m = new Map(prev)
      m.delete(ap)
      return m
    })
  }, [active, busy, onDismiss])

  const onApplyMerged = useCallback(async () => {
    if (!active || busy) return
    const idxArr = [...acceptedSet].sort((a, b) => a - b)
    const merged = mergeWithAcceptedHunks(active.base, active.proposed, idxArr)
    if (merged == null) {
      setApplyError('Could not apply selected hunks (conflict). Try Keep entire file or edit manually.')
      return
    }
    await writeAndContinue(active.path, merged)
  }, [active, acceptedSet, busy, writeAndContinue])

  useEffect(() => {
    const onKey = (e) => {
      if (!session?.files?.length) return
      if (e.target.closest?.('textarea, input:not([type="checkbox"]):not([type="radio"]), [contenteditable="true"]')) {
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        if (!busy) onKeepFile()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [session?.files?.length, busy, onKeepFile])

  if (!session?.files?.length) return null
  if (filesState.length === 0) {
    return (
      <div className="workspace-file-review workspace-file-review--loading" role="status">
        Loading diff…
      </div>
    )
  }

  const fileIdxLabel = `${activeIndex + 1} of ${filesState.length}`
  const title = workspaceLabel ? `${workspaceLabel} — review changes` : 'Review changes'

  return (
    <div className="workspace-file-review" role="region" aria-label="Workspace file changes">
      <div className="workspace-file-review__header">
        <span className="workspace-file-review__title">{title}</span>
        <div className="workspace-file-review__nav">
          <button
            type="button"
            className="workspace-file-review__icon-btn"
            disabled={activeIndex <= 0}
            onClick={() => setActiveIndex((i) => Math.max(0, i - 1))}
            aria-label="Previous file"
          >
            ‹
          </button>
          <span className="workspace-file-review__counter">{fileIdxLabel}</span>
          <button
            type="button"
            className="workspace-file-review__icon-btn"
            disabled={activeIndex >= filesState.length - 1}
            onClick={() => setActiveIndex((i) => Math.min(filesState.length - 1, i + 1))}
            aria-label="Next file"
          >
            ›
          </button>
        </div>
        <div className="workspace-file-review__file-actions">
          <button
            type="button"
            className="workspace-file-review__btn workspace-file-review__btn--ghost"
            disabled={busy}
            onClick={onDiscardFile}
          >
            Discard file
          </button>
          <button
            type="button"
            className="workspace-file-review__btn workspace-file-review__btn--primary"
            disabled={busy}
            onClick={onKeepFile}
            title="Accept all changes in this file (Ctrl+Enter)"
          >
            Keep file
          </button>
        </div>
        <button type="button" className="workspace-file-review__close" onClick={onDismiss} aria-label="Dismiss review">
          ×
        </button>
      </div>

      {applyError ? <div className="workspace-file-review__error">{applyError}</div> : null}

      {active ? (
        <>
          <div className="workspace-file-review__path-row">
            <button
              type="button"
              className="workspace-file-review__path-link"
              onClick={() => onOpenFile?.(active.path)}
              title="Open in file preview"
            >
              {active.path}
            </button>
            <div className="workspace-file-review__bulk">
              <button
                type="button"
                className="workspace-file-review__link-btn"
                onClick={keepAllHunksForActive}
                disabled={!hunks.length}
              >
                Select all hunks
              </button>
              <button
                type="button"
                className="workspace-file-review__link-btn"
                onClick={rejectAllHunksForActive}
                disabled={!hunks.length}
              >
                Reject all hunks
              </button>
              <button
                type="button"
                className="workspace-file-review__btn workspace-file-review__btn--accent"
                disabled={
                  busy ||
                  !hunks.length ||
                  acceptedSet.size === hunks.length ||
                  acceptedSet.size === 0
                }
                onClick={onApplyMerged}
                title="Write merged result using only kept hunks"
              >
                Apply merged
              </button>
            </div>
          </div>

          <div className="workspace-file-review__diff-wrap">
            {hunks.length === 0 ? (
              <p className="workspace-file-review__same">No line differences (or empty file).</p>
            ) : (
              hunks.map((hunk, hi) => {
                const kept = acceptedSet.has(hi)
                return (
                  <div key={`${active.path}-${hi}`} className={`workspace-file-review__hunk${kept ? '' : ' workspace-file-review__hunk--rejected'}`}>
                    <div className="workspace-file-review__hunk-toolbar">
                      <span className="workspace-file-review__hunk-meta">
                        Change {hi + 1} of {hunks.length}
                      </span>
                      <div className="workspace-file-review__hunk-actions">
                        <button
                          type="button"
                          className={
                            kept
                              ? 'workspace-file-review__btn workspace-file-review__btn--small'
                              : 'workspace-file-review__btn workspace-file-review__btn--small workspace-file-review__btn--ghost'
                          }
                          onClick={() => toggleHunk(hi)}
                        >
                          {kept ? 'Undo' : 'Keep'}
                        </button>
                      </div>
                    </div>
                    <pre className="workspace-file-review__hunk-pre">
                      {(hunk.lines || [])
                        .map((line, li) => {
                          const c = line[0]
                          const rest = line.slice(1)
                          let cls = 'workspace-file-review__ln'
                          if (c === '+') cls += ' workspace-file-review__ln--add'
                          else if (c === '-') cls += ' workspace-file-review__ln--del'
                          else cls += ' workspace-file-review__ln--ctx'
                          return (
                            <div key={li} className={cls}>
                              <span className="workspace-file-review__ln-mark">{c}</span>
                              {rest}
                            </div>
                          )
                        })}
                    </pre>
                  </div>
                )
              })
            )}
          </div>
        </>
      ) : null}
    </div>
  )
}
