import { useState, useEffect, useRef, useCallback } from 'react'
import {
  listChats,
  setCurrentChat,
  getCurrentChatId,
  readChatLog,
  createNewChat,
  deleteChat,
  sendMessage,
  sendMessageStream,
  sendMessageWithFiles,
  appendChatLog,
  getChatsStoragePath,
  setChatsStoragePath,
  getModelSetting,
  setModelSetting,
  getGoogleAuthStatus,
  getGoogleAuthLoginUrl,
  getGmailProfile,
  googleLogout,
  googleDisconnect,
  agentStepsWsUrl,
} from './api'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './App.css'

/** Embedded charts from the coding agent sandbox use data:image/... URLs. */
function markdownUrlTransform(url) {
  if (typeof url === 'string' && url.startsWith('data:image/')) return url
  return defaultUrlTransform(url)
}

/** Hide sandbox chart lines in tool JSON, step timeline, and old chat logs. */
function redactImagePayloadsInText(text) {
  if (!text || typeof text !== 'string') return text
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim()
      if (/^(?:ADA|JARVIS)_IMAGE_(PNG|JPE?G|GIF|WEBP):/i.test(t)) return '[chart image hidden]'
      if (t.length > 200 && /^[A-Za-z0-9+/=]+$/.test(t) && t.startsWith('iVBOR')) return '[chart image hidden]'
      if (t.length > 200 && /^[A-Za-z0-9+/=]+$/.test(t) && t.startsWith('/9j')) return '[chart image hidden]'
      return line
    })
    .join('\n')
}

function formatToolCardResult(raw) {
  const s = String(raw ?? '')
  try {
    const o = JSON.parse(s)
    if (o && typeof o === 'object' && typeof o.stdout === 'string') {
      return JSON.stringify({ ...o, stdout: redactImagePayloadsInText(o.stdout) }, null, 2)
    }
    return JSON.stringify(o, null, 2)
  } catch {
    return redactImagePayloadsInText(s)
  }
}

const TOOL_PREVIEW_MAX_CHARS = 180

function truncateToolPreview(text, maxChars = TOOL_PREVIEW_MAX_CHARS) {
  const s = String(text)
  if (s.length <= maxChars) return s
  const cut = s.slice(0, maxChars)
  const lastNl = cut.lastIndexOf('\n')
  if (lastNl > 48) return `${cut.slice(0, lastNl).trimEnd()}…`
  const sp = cut.lastIndexOf(' ')
  return `${(sp > 56 ? cut.slice(0, sp) : cut).trimEnd()}…`
}

function ToolMessageCard({ content }) {
  const [expanded, setExpanded] = useState(false)
  try {
    const t = typeof content === 'string' ? JSON.parse(content) : content
    const name = t?.name || 'tool'
    const input = t?.input ?? ''
    const result = t?.result ?? ''
    const formatted = formatToolCardResult(result)
    const collapsible =
      name === 'web_search' ||
      (typeof formatted === 'string' && formatted.length > 1400)

    if (!collapsible) {
      return (
        <div className="msg-tool-card">
          <div className="msg-tool-title-row">
            <span className="msg-tool-label">
              🔧 {name}
              {input !== '' && input != null ? ` (${input})` : ''}
            </span>
          </div>
          <div className="msg-tool-result msg-tool-result--body">{formatted}</div>
        </div>
      )
    }

    const showFull = expanded
    const body = showFull ? formatted : truncateToolPreview(formatted)

    return (
      <div className={`msg-tool-card${showFull ? ' msg-tool-card--expanded' : ' msg-tool-card--collapsed'}`}>
        <div className="msg-tool-title-row">
          <span className="msg-tool-label msg-tool-label--grow" title={input ? String(input) : undefined}>
            🔧 {name}
            {input !== '' && input != null ? ` (${input})` : ''}
          </span>
          <button
            type="button"
            className="msg-tool-toggle"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={showFull}
          >
            {showFull ? 'Collapse' : 'View full'}
          </button>
        </div>
        <div className="msg-tool-result msg-tool-result--body">{body}</div>
      </div>
    )
  } catch {
    return <span className="msg-text">{content}</span>
  }
}

/** Copy assistant text without embedding multi‑MB base64 images. */
function stripChartDataUrlsForCopy(md) {
  if (!md || typeof md !== 'string') return md
  return md.replace(
    /!\[[^\]]*]\(data:image\/[^)]+\)/g,
    '![chart]([image omitted — see above])',
  )
}

const CHAT_ICON = (
  <svg className="chat-history-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
)

function escapeHtml(text) {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

const COPY_ICON = (
  <svg className="msg-copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)

const CLIP_MENU_ICON = (
  <svg className="chat-add-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
  </svg>
)

const GLOBE_MENU_ICON = (
  <svg className="chat-add-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
  </svg>
)

/** Sidebar / footer folder mark (stroke, matches other UI icons). */
const REPO_FOLDER_ICON = (
  <svg className="repo-folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 7.5V19a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-7l-2-2H5a2 2 0 00-2 2v.5" />
  </svg>
)

function workspaceBasename(path) {
  const p = (path || '').trim().replace(/[/\\]+$/, '')
  if (!p) return ''
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

function CopyResponseButton({ text }) {
  const [copied, setCopied] = useState(false)
  const plain = typeof text === 'string' ? text : String(text ?? '')
  const handleCopy = async () => {
    const toCopy = stripChartDataUrlsForCopy(plain)
    if (!toCopy.trim()) return
    try {
      await navigator.clipboard.writeText(toCopy)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      try {
        const ta = document.createElement('textarea')
        ta.value = toCopy
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.left = '-9999px'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 2000)
      } catch {
        /* ignore */
      }
    }
  }
  return (
    <div className="msg-copy-row">
      <button
        type="button"
        className={`msg-copy-btn${copied ? ' msg-copy-btn--done' : ''}`}
        onClick={handleCopy}
        disabled={!stripChartDataUrlsForCopy(plain).trim()}
        aria-label={copied ? 'Copied to clipboard' : 'Copy response to clipboard'}
      >
        {COPY_ICON}
        <span>{copied ? 'Copied' : 'Copy'}</span>
      </button>
    </div>
  )
}

function App() {
  const [panel, setPanel] = useState('chats')
  const [chats, setChats] = useState([])
  const [currentChatId, setCurrentChatIdState] = useState(null)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState([])
  const [storagePath, setStoragePath] = useState('')
  const [modelProvider, setModelProvider] = useState('openai')
  const [googleAuth, setGoogleAuth] = useState({
    configured: false,
    connected: false,
    user: null,
  })
  const [gmailStatus, setGmailStatus] = useState(null)
  const [googleAuthBusy, setGoogleAuthBusy] = useState(false)
  const [sending, setSending] = useState(false)
  const [liveReply, setLiveReply] = useState(null)
  const [streamTimeline, setStreamTimeline] = useState([])
  /** Screenshots arrive on WebSocket; SSE step may arrive first or second — stash by step id */
  const screenshotPendingRef = useRef({})
  const wsRef = useRef(null)
  const messagesEndRef = useRef(null)
  const fileInputRef = useRef(null)
  const addMenuRef = useRef(null)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [webSearchMode, setWebSearchMode] = useState(() => {
    try {
      return sessionStorage.getItem('ada-web-search-mode') === '1'
    } catch {
      return false
    }
  })
  /** Absolute path on the API host — same idea as VS Code “Open Folder…”. */
  const [workspaceFolder, setWorkspaceFolder] = useState(() => {
    try {
      return (
        localStorage.getItem('ada-workspace-folder') ||
        sessionStorage.getItem('ada-workspace-folder') ||
        sessionStorage.getItem('ada-coding-project-path') ||
        ''
      )
    } catch {
      return ''
    }
  })
  const [workspaceFolderPickerOpen, setWorkspaceFolderPickerOpen] = useState(false)
  const [workspaceFolderDraft, setWorkspaceFolderDraft] = useState('')

  const refreshChatList = useCallback(async () => {
    try {
      const list = await listChats()
      setChats(list)
    } catch {
      setChats([])
    }
  }, [])

  const refreshStoragePath = useCallback(async () => {
    try {
      const path = await getChatsStoragePath()
      setStoragePath(path || '')
    } catch {
      setStoragePath('')
    }
  }, [])

  const refreshModelSetting = useCallback(async () => {
    try {
      const provider = await getModelSetting()
      setModelProvider(provider || 'openai')
    } catch {
      setModelProvider('openai')
    }
  }, [])

  const refreshGoogleAuth = useCallback(async () => {
    try {
      const status = await getGoogleAuthStatus()
      const connected = !!status?.connected
      setGoogleAuth({
        configured: !!status?.configured,
        connected,
        user: status?.user || null,
      })
      if (connected) {
        try {
          const g = await getGmailProfile()
          if (g?.ok) {
            setGmailStatus({
              ok: true,
              emailAddress: g.emailAddress,
              messagesTotal: g.messagesTotal,
            })
          } else {
            setGmailStatus({ ok: false, error: g?.error || 'Gmail unavailable' })
          }
        } catch (e) {
          setGmailStatus({ ok: false, error: e?.message || 'Gmail check failed' })
        }
      } else {
        setGmailStatus(null)
      }
    } catch {
      setGoogleAuth({ configured: false, connected: false, user: null })
      setGmailStatus(null)
    }
  }, [])

  const refreshSettings = useCallback(async () => {
    await refreshStoragePath()
    await refreshModelSetting()
    await refreshGoogleAuth()
  }, [refreshStoragePath, refreshModelSetting, refreshGoogleAuth])

  const selectChat = useCallback(async (chatId) => {
    try {
      await setCurrentChat(chatId)
      setCurrentChatIdState(chatId)
      const msgs = await readChatLog(chatId)
      setMessages(msgs || [])
    } catch (e) {
      console.error(e)
    }
  }, [])

  useEffect(() => {
    refreshChatList()
    getCurrentChatId()
      .then((id) => {
        setCurrentChatIdState(id)
        if (id) selectChat(id)
      })
      .catch(() => {
        setCurrentChatIdState(null)
      })
  }, [refreshChatList, selectChat])

  useEffect(() => {
    if (panel === 'settings') refreshSettings()
  }, [panel, refreshSettings])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const connected = params.get('google_connected')
    const err = params.get('google_auth_error')
    if (connected === '1' || err) {
      if (connected === '1') refreshGoogleAuth()
      if (err) alert(`Google sign-in failed: ${err}`)
      params.delete('google_connected')
      params.delete('google_auth_error')
      const q = params.toString()
      const next = `${window.location.pathname}${q ? `?${q}` : ''}${window.location.hash || ''}`
      window.history.replaceState({}, '', next)
    }
  }, [refreshGoogleAuth])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamTimeline])

  useEffect(() => {
    if (!addMenuOpen) return
    const onDown = (e) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target)) setAddMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [addMenuOpen])

  useEffect(() => {
    const url = agentStepsWsUrl()
    const ws = new WebSocket(url)
    ws.onmessage = (e) => {
      try {
        const p = JSON.parse(e.data)
        if (p.screenshot == null || p.screenshot === '') return
        const step = p.step
        setStreamTimeline((prev) => {
          const i = prev.findIndex((x) => x.kind === 'step' && x.step === step)
          if (i >= 0) {
            const next = [...prev]
            next[i] = { ...next[i], screenshot: p.screenshot }
            return next
          }
          screenshotPendingRef.current[step] = p.screenshot
          return prev
        })
      } catch {}
    }
    ws.onclose = () => {}
    wsRef.current = ws
    return () => {
      ws.close()
      wsRef.current = null
    }
  }, [])

  const handleStorageChange = async () => {
    const path = prompt('Enter folder path for chat storage:', storagePath)
    if (path == null || path === '') return
    try {
      await setChatsStoragePath(path)
      setStoragePath(path)
      refreshChatList()
    } catch (err) {
      alert(err?.message || 'Could not change storage location.')
    }
  }

  const handleModelChange = async (e) => {
    const provider = e.target.value
    if (provider !== 'openai' && provider !== 'xai') return
    try {
      await setModelSetting(provider)
      setModelProvider(provider)
    } catch (err) {
      alert(err?.message || 'Could not save model setting.')
    }
  }

  const handleAttach = () => {
    fileInputRef.current?.click()
  }

  const onFileChange = (e) => {
    const files = Array.from(e.target.files || [])
    setAttachments((prev) => [...prev, ...files])
    e.target.value = ''
  }

  const removeAttachment = (index) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }

  const appendMessage = (text, isUser) => {
    setMessages((prev) => [...prev, { role: isUser ? 'user' : 'assistant', content: text }])
  }

  const appendToolMessage = (toolUsed) => {
    setMessages((prev) => [...prev, { role: 'tool', content: JSON.stringify(toolUsed) }])
  }

  const toggleWebSearchMode = () => {
    setWebSearchMode((m) => {
      const next = !m
      try {
        if (next) sessionStorage.setItem('ada-web-search-mode', '1')
        else sessionStorage.removeItem('ada-web-search-mode')
      } catch {
        /* ignore */
      }
      return next
    })
    setAddMenuOpen(false)
  }

  const persistWorkspaceFolder = (value) => {
    const next = (value || '').trim()
    setWorkspaceFolder(next)
    try {
      if (next) {
        localStorage.setItem('ada-workspace-folder', next)
        sessionStorage.setItem('ada-workspace-folder', next)
        sessionStorage.removeItem('ada-coding-project-path')
        sessionStorage.removeItem('ada-coding-project-mode')
      } else {
        localStorage.removeItem('ada-workspace-folder')
        sessionStorage.removeItem('ada-workspace-folder')
        sessionStorage.removeItem('ada-coding-project-path')
        sessionStorage.removeItem('ada-coding-project-mode')
      }
    } catch {
      /* ignore */
    }
  }

  const openWorkspaceFolderPicker = () => {
    setWorkspaceFolderDraft(workspaceFolder)
    setWorkspaceFolderPickerOpen(true)
  }

  const confirmWorkspaceFolder = () => {
    persistWorkspaceFolder(workspaceFolderDraft)
    setWorkspaceFolderPickerOpen(false)
  }

  const closeWorkspaceFolder = () => {
    persistWorkspaceFolder('')
    setWorkspaceFolderPickerOpen(false)
    setWorkspaceFolderDraft('')
  }

  const handleSend = async (opts = {}) => {
    const raw = input.trim()
    const explicitWs = (opts.webSearchQuery || '').trim()
    const extraWs =
      explicitWs || (webSearchMode && raw ? raw : '')
    const filesToSend = [...attachments]
    const pathForCoding = workspaceFolder.trim()
    const workspaceContextActive = pathForCoding.length > 0
    if (!raw && filesToSend.length === 0 && !extraWs && !workspaceContextActive) {
      return
    }
    setInput('')
    setAttachments([])

    let displayText = raw
    if (filesToSend.length === 1 && !displayText) displayText = filesToSend[0].name
    else if (filesToSend.length > 1 && !displayText) displayText = filesToSend.map((f) => f.name).join(', ')
    if (explicitWs && !webSearchMode) {
      displayText = displayText ? `${displayText} · Web: ${explicitWs}` : `Web search: ${explicitWs}`
    }
    const cPath = pathForCoding
    if (workspaceContextActive && cPath) {
      const label = workspaceBasename(cPath) || cPath
      displayText = displayText
        ? `${displayText} · Project: ${label}`
        : `Project: ${label}`
    }
    appendMessage(displayText, true)
    setSending(true)
    setLiveReply('')
    setStreamTimeline([])
    screenshotPendingRef.current = {}

    try {
      await appendChatLog('user', displayText)
    } catch {}

    try {
      let chatId = currentChatId
      if (!chatId) {
        chatId = (await getCurrentChatId()) || null
        setCurrentChatIdState(chatId)
      }
      let reply
      if (filesToSend.length > 0) {
        reply = await sendMessageWithFiles(
          raw || 'Please summarize or answer based on the attached documents.',
          filesToSend,
          chatId,
          extraWs.trim() || null,
          workspaceContextActive,
          cPath || null,
        )
        appendMessage(reply, false)
        await appendChatLog('assistant', reply)
      } else {
        const formatAgentStep = (d) => {
          const n = d.step
          const thought = (d.thought || '').trim()
          const desc = (d.description || '').trim()
          const res = d.result != null ? String(d.result).trim() : ''
          const lower = `${desc} ${thought}`.toLowerCase()
          const retry = lower.includes('retry') || lower.includes('trying again')
          if (n === 0) {
            return {
              kind: 'step',
              phase: 'plan',
              message: 'Forming a plan',
              detail: desc || thought,
              step: 0,
              screenshot: d.screenshot || null,
            }
          }
          let message = `Implementing step ${n}: ${d.action || 'action'}`
          if (retry) message = `Step ${n} failed — trying again`
          const detail = [desc || thought, res ? `→ ${res}` : ''].filter(Boolean).join(' ').slice(0, 600)
          return {
            kind: 'step',
            phase: 'run',
            message,
            detail,
            step: n,
            screenshot: d.screenshot || null,
          }
        }

        const streamMsg =
          raw ||
          (extraWs
            ? ''
            : workspaceContextActive && cPath
              ? ''
              : 'Please summarize or answer based on the attached documents.')
        const streamResult = await sendMessageStream(streamMsg, null, chatId, {
            webSearchQuery: extraWs.trim() || null,
            codingMode: workspaceContextActive,
            codingProjectPath: cPath || null,
            onChunk: (delta) => setLiveReply((prev) => (prev || '') + delta),
            onStatus: (d) => {
              if (d.phase === 'done') return
              setStreamTimeline((prev) => [
                ...prev,
                {
                  kind: 'status',
                  phase: d.phase,
                  message: d.message || d.phase,
                  detail:
                    d.next_steps ||
                    d.reasoning ||
                    (d.goal && d.phase === 'supervisor_done' ? `Goal: ${d.goal}` : '') ||
                    '',
                },
              ])
            },
            onAgentStep: (d) => {
              const row = formatAgentStep(d)
              const pending = screenshotPendingRef.current[d.step]
              if (pending != null) {
                delete screenshotPendingRef.current[d.step]
              }
              const screenshot = d.screenshot || pending || row.screenshot || null
              setStreamTimeline((prev) => [...prev, { ...row, screenshot }])
            },
        })
        reply = streamResult?.reply ?? streamResult ?? ''
        if (streamResult?.tool_used) appendToolMessage(streamResult.tool_used)
        appendMessage(reply || '', false)
        await appendChatLog('assistant', reply || '')
      }
      setLiveReply(null)
      setStreamTimeline([])
    } catch (err) {
      setLiveReply(null)
      setStreamTimeline([])
      screenshotPendingRef.current = {}
      const msg = err?.message || 'Sorry, something went wrong. Please try again.'
      appendMessage(msg, false)
      try {
        await appendChatLog('assistant', msg)
      } catch {}
    }
    setSending(false)
    refreshChatList()
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend({})
    }
  }

  return (
    <div className="app">
      <header className="titlebar">
        <div className="titlebar-brand">
          <img src="/Ada.jpg" alt="" className="titlebar-logo" />
          <span className="titlebar-title">Ada</span>
        </div>
      </header>
      <div className="app-body">
        <aside className="sidebar">
          <div className="sidebar-tabs" role="tablist">
            <button
              type="button"
              className={`sidebar-tab ${panel === 'chats' ? 'active' : ''}`}
              onClick={() => setPanel('chats')}
              aria-selected={panel === 'chats'}
            >
              Chats
            </button>
            <button
              type="button"
              className={`sidebar-tab ${panel === 'activity' ? 'active' : ''}`}
              onClick={() => setPanel('activity')}
              aria-selected={panel === 'activity'}
            >
              Activity
            </button>
            <button
              type="button"
              className={`sidebar-tab ${panel === 'settings' ? 'active' : ''}`}
              onClick={() => setPanel('settings')}
              aria-selected={panel === 'settings'}
            >
              Settings
            </button>
          </div>
          <div className="sidebar-panel sidebar-panel--chats" style={{ display: panel === 'chats' ? 'flex' : 'none' }}>
            <div className="repo-context-card" aria-label="Project context">
              <div className="repo-context-card__head">
                <span className="repo-context-card__pulse" aria-hidden />
                <h2 className="repo-context-card__title">Project context</h2>
              </div>
              <p className="repo-context-card__subtitle">Folder on the server for coding answers</p>
              <div className="repo-context-card__body">
                {!workspaceFolder.trim() && !workspaceFolderPickerOpen ? (
                  <div className="repo-context-empty">
                    <p className="repo-context-empty__hint">
                      Link a folder so Ada can read its structure and files when you ask coding questions.
                    </p>
                    <button type="button" className="repo-context-btn repo-context-btn--primary" onClick={openWorkspaceFolderPicker}>
                      Link folder
                    </button>
                  </div>
                ) : null}
                {!workspaceFolder.trim() && workspaceFolderPickerOpen ? (
                  <div className="repo-context-form">
                    <p className="repo-context-form__help">Absolute path on the machine running the API.</p>
                    <input
                      type="text"
                      className="repo-context-input"
                      placeholder="/home/you/repo or E:\path\to\repo"
                      value={workspaceFolderDraft}
                      onChange={(e) => setWorkspaceFolderDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          confirmWorkspaceFolder()
                        }
                        if (e.key === 'Escape') {
                          setWorkspaceFolderPickerOpen(false)
                          setWorkspaceFolderDraft('')
                        }
                      }}
                      autoFocus
                      autoComplete="off"
                    />
                    <div className="repo-context-form__actions">
                      <button type="button" className="repo-context-btn repo-context-btn--primary" onClick={confirmWorkspaceFolder}>
                        Save
                      </button>
                      <button
                        type="button"
                        className="repo-context-btn repo-context-btn--ghost"
                        onClick={() => {
                          setWorkspaceFolderPickerOpen(false)
                          setWorkspaceFolderDraft('')
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
                {workspaceFolder.trim() ? (
                  <div className="repo-context-linked">
                    <div className="repo-context-linked__row" title={workspaceFolder}>
                      <span className="repo-context-linked__icon-wrap" aria-hidden>
                        {REPO_FOLDER_ICON}
                      </span>
                      <div className="repo-context-linked__meta">
                        <span className="repo-context-linked__name">{workspaceBasename(workspaceFolder) || workspaceFolder}</span>
                        <span className="repo-context-linked__path">{workspaceFolder}</span>
                      </div>
                      <div className="repo-context-linked__actions">
                        <button
                          type="button"
                          className="repo-context-icon-btn"
                          title="Change folder"
                          aria-label="Change linked folder"
                          onClick={openWorkspaceFolderPicker}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="repo-context-icon-btn"
                          title="Unlink folder"
                          aria-label="Unlink folder"
                          onClick={closeWorkspaceFolder}
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                    {workspaceFolderPickerOpen ? (
                      <div className="repo-context-form repo-context-form--nested">
                        <input
                          type="text"
                          className="repo-context-input"
                          value={workspaceFolderDraft}
                          onChange={(e) => setWorkspaceFolderDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              confirmWorkspaceFolder()
                            }
                            if (e.key === 'Escape') {
                              setWorkspaceFolderPickerOpen(false)
                              setWorkspaceFolderDraft(workspaceFolder)
                            }
                          }}
                          autoFocus
                          autoComplete="off"
                        />
                        <div className="repo-context-form__actions">
                          <button type="button" className="repo-context-btn repo-context-btn--primary" onClick={confirmWorkspaceFolder}>
                            Save
                          </button>
                          <button
                            type="button"
                            className="repo-context-btn repo-context-btn--ghost"
                            onClick={() => {
                              setWorkspaceFolderPickerOpen(false)
                              setWorkspaceFolderDraft(workspaceFolder)
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
            <button
              type="button"
              className="chat-new-btn"
              onClick={async () => {
                try {
                  const chatId = await createNewChat()
                  setCurrentChatIdState(chatId)
                  setMessages([])
                  await refreshChatList()
                } catch (e) {
                  console.error(e)
                }
              }}
            >
              + New chat
            </button>
            <div className="sidebar-list chat-history-list">
              {chats.length === 0 ? (
                <p className="chat-history-empty">No conversations yet. Start chatting to see them here.</p>
              ) : (
                chats.map((chat) => (
                  <div
                    key={chat.id}
                    className={`chat-history-item-wrap ${currentChatId === chat.id ? 'active' : ''}`}
                  >
                    <button
                      type="button"
                      className="chat-history-item"
                      onClick={() => selectChat(chat.id)}
                    >
                      {CHAT_ICON}
                      <span className="chat-history-title" title={escapeHtml(chat.title)}>
                        {chat.title}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="chat-history-delete"
                      aria-label="Delete chat"
                      onClick={async (e) => {
                        e.stopPropagation()
                        if (!confirm('Delete this chat?')) return
                        try {
                          await deleteChat(chat.id)
                          if (currentChatId === chat.id) {
                            setCurrentChatIdState(null)
                            setMessages([])
                          }
                          await refreshChatList()
                        } catch (err) {
                          console.error(err)
                          alert(err?.message || 'Could not delete chat.')
                        }
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="sidebar-panel" style={{ display: panel === 'activity' ? 'flex' : 'none' }}>
            <div className="sidebar-list activity-list">
              <p className="activity-empty">No actions yet. Actions the chatbot takes will appear here.</p>
            </div>
          </div>
          <div className="sidebar-panel" style={{ display: panel === 'settings' ? 'flex' : 'none' }}>
            <div className="sidebar-list settings-panel">
              <div className="settings-section">
                <label className="settings-label">Storage location</label>
                <p className="settings-description">Where chat logs are saved.</p>
                <div className="settings-storage-row">
                  <input
                    type="text"
                    readOnly
                    className="settings-storage-input"
                    value={storagePath}
                    aria-label="Chats storage path"
                  />
                  <button type="button" className="settings-storage-btn" onClick={handleStorageChange}>
                    Change
                  </button>
                </div>
              </div>
              <div className="settings-section">
                <label className="settings-label">Model</label>
                <p className="settings-description">LLM used for chat and agents.</p>
                <select
                  className="settings-model-select"
                  value={modelProvider}
                  onChange={handleModelChange}
                  aria-label="Model provider"
                >
                  <option value="openai">OpenAI (GPT-4o)</option>
                  <option value="xai">xAI (Grok)</option>
                </select>
              </div>
              <div className="settings-section">
                <label className="settings-label">Google Calendar + Gmail</label>
                {googleAuth.connected ? (
                  <div className="settings-auth-connected settings-auth-connected--col">
                    <div className="settings-auth-row">
                      <span className="settings-auth-pill">Connected</span>
                      <span className="settings-auth-user">
                        {googleAuth.user?.email || googleAuth.user?.name || 'Google account'}
                      </span>
                    </div>
                    {gmailStatus?.ok ? (
                      <div className="settings-gmail-line">
                        Gmail · {gmailStatus.emailAddress || 'linked'}
                        {gmailStatus.messagesTotal != null ? ` · ${gmailStatus.messagesTotal} messages` : ''}
                      </div>
                    ) : gmailStatus && !gmailStatus.ok ? (
                      <div className="settings-gmail-line settings-gmail-line--warn">{gmailStatus.error}</div>
                    ) : null}
                  </div>
                ) : (
                  <div className="settings-auth-connected">
                    <span className="settings-auth-pill settings-auth-pill--idle">
                      {googleAuth.configured ? 'Not connected' : 'Unavailable'}
                    </span>
                  </div>
                )}
                <div className="settings-auth-actions">
                  {!googleAuth.connected ? (
                    <button
                      type="button"
                      className="settings-storage-btn"
                      disabled={!googleAuth.configured}
                      title={!googleAuth.configured ? 'OAuth is not configured on the server' : undefined}
                      onClick={() => {
                        window.location.href = getGoogleAuthLoginUrl('/settings')
                      }}
                    >
                      Sign in with Google
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="settings-storage-btn"
                        disabled={googleAuthBusy}
                        onClick={async () => {
                          setGoogleAuthBusy(true)
                          try {
                            await googleLogout()
                            await refreshGoogleAuth()
                          } finally {
                            setGoogleAuthBusy(false)
                          }
                        }}
                      >
                        Log out
                      </button>
                      <button
                        type="button"
                        className="settings-storage-btn"
                        disabled={googleAuthBusy}
                        onClick={async () => {
                          if (!confirm('Disconnect Google account and revoke stored access?')) return
                          setGoogleAuthBusy(true)
                          try {
                            await googleDisconnect()
                            await refreshGoogleAuth()
                          } finally {
                            setGoogleAuthBusy(false)
                          }
                        }}
                      >
                        Disconnect
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </aside>
        <div className="main-column">
        <div className="chat-container">
          <div className="chat-messages">
            {messages.map((msg, i) => (
              <div key={i} className={`msg ${msg.role === 'user' ? 'msg-user' : msg.role === 'tool' ? 'msg-tool' : 'msg-bot'}`}>
                {msg.role === 'user' ? (
                  <span className="msg-text">{msg.content}</span>
                ) : msg.role === 'tool' ? (
                  <ToolMessageCard content={msg.content} />
                ) : (
                  <div className="msg-bot-body">
                    <div className="msg-markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={markdownUrlTransform}>
                        {msg.content}
                      </ReactMarkdown>
                    </div>
                    <CopyResponseButton text={msg.content} />
                  </div>
                )}
              </div>
            ))}
            {(sending || liveReply || streamTimeline.length > 0) && (
              <div className="msg msg-bot msg-streaming">
                {streamTimeline.length > 0 && (
                  <div className="stream-timeline" aria-live="polite">
                    {streamTimeline.map((item, i) => (
                      <div
                        key={i}
                        className={`stream-timeline-row stream-timeline-${item.kind} stream-phase-${item.phase || ''}${item.screenshot ? ' stream-timeline-has-screenshot' : ''}`}
                      >
                        <span className="stream-timeline-dot" aria-hidden />
                        <div className="stream-timeline-body">
                          <div className="stream-timeline-title">{item.message}</div>
                          {item.detail ? (
                            <div className="stream-timeline-detail">{item.detail}</div>
                          ) : null}
                          {item.screenshot ? (
                            <div className="stream-timeline-screenshot-wrap">
                              <img
                                src={`data:image/png;base64,${item.screenshot}`}
                                alt={`Step ${item.step ?? i} screenshot`}
                                className="stream-timeline-screenshot"
                                loading="lazy"
                              />
                              <span className="stream-timeline-screenshot-label">Screenshot used for this step</span>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {liveReply ? (
                  <div className="msg-bot-body msg-stream-reply-body">
                    <div className="msg-markdown stream-reply-md">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={markdownUrlTransform}>
                      {liveReply}
                    </ReactMarkdown>
                    </div>
                    <CopyResponseButton text={liveReply} />
                  </div>
                ) : null}
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
          <div className="chat-input-area">
            {attachments.length > 0 && (
              <div className="chat-attachments">
                {attachments.map((f, i) => (
                  <span key={i} className="chat-attachment">
                    <span className="chat-attachment-name" title={f.name}>
                      {f.name}
                    </span>
                    <button
                      type="button"
                      className="chat-attachment-remove"
                      aria-label="Remove"
                      onClick={() => removeAttachment(i)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="chat-input-row">
              <div className="chat-add-wrap" ref={addMenuRef}>
                <button
                  type="button"
                  id="chat-add"
                  className="chat-add-btn"
                  aria-label="Attach files or enable web search"
                  aria-expanded={addMenuOpen}
                  aria-haspopup="menu"
                  onClick={() => setAddMenuOpen((o) => !o)}
                >
                  +
                </button>
                {addMenuOpen ? (
                  <div className="chat-add-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      className="chat-add-menu-item"
                      onClick={() => {
                        setAddMenuOpen(false)
                        handleAttach()
                      }}
                    >
                      {CLIP_MENU_ICON}
                      <span className="chat-add-menu-label">Attach</span>
                      <span className="chat-add-menu-hint">files</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className={`chat-add-menu-item${webSearchMode ? ' chat-add-menu-item--active' : ''}`}
                      aria-pressed={webSearchMode}
                      onClick={toggleWebSearchMode}
                    >
                      {GLOBE_MENU_ICON}
                      <span className="chat-add-menu-label">Web search</span>
                      <span className="chat-add-menu-hint">{webSearchMode ? 'on' : 'off'}</span>
                    </button>
                  </div>
                ) : null}
              </div>
              <input type="file" ref={fileInputRef} style={{ display: 'none' }} multiple onChange={onFileChange} />
              <textarea
                id="chat-input"
                placeholder={
                  workspaceFolder.trim()
                    ? 'Message Ada… (linked project included when relevant)'
                    : webSearchMode
                      ? 'Message Ada… (each send uses the web: top results inform the reply)'
                      : 'Message Ada…'
                }
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={sending}
              />
              <button type="button" id="chat-send" onClick={() => handleSend({})} disabled={sending}>
                Send
              </button>
            </div>
          </div>
        </div>
        <footer className="app-context-footer" role="status">
          <div className="app-context-footer__cluster">
            {workspaceFolder.trim() ? (
              <>
                <span className="app-context-footer__badge" title={workspaceFolder}>
                  {REPO_FOLDER_ICON}
                  <span className="app-context-footer__badge-text">{workspaceBasename(workspaceFolder)}</span>
                </span>
                <span className="app-context-footer__path" title={workspaceFolder}>
                  {workspaceFolder}
                </span>
              </>
            ) : (
              <span className="app-context-footer__idle">No project folder linked</span>
            )}
          </div>
          <button type="button" className="app-context-footer__linkish" onClick={openWorkspaceFolderPicker}>
            {workspaceFolder.trim() ? 'Change folder' : 'Link folder'}
          </button>
        </footer>
        </div>
      </div>
    </div>
  )
}

export default App
