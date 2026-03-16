import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Sparkles, Info, Square, ChevronRight } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

function ToolGroup({ entry }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div>
      <div className="conv-tool-group" onClick={() => setExpanded((e) => !e)}>
        <ChevronRight
          size={12}
          strokeWidth={2}
          className={`conv-tool-group-chevron${expanded ? ' expanded' : ''}`}
        />
        <span className="conv-tool-group-summary">{entry.summary}</span>
      </div>
      {expanded && (
        <div className="conv-tool-group-items">
          {entry.tools.map((t) => (
            <div key={t.id} className="conv-tool">
              <span className="conv-tool-label">{t.label || t.name || 'Tool'}</span>
              {t.summary ? <span className="conv-tool-summary">{t.summary}</span> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function renderEntry(entry) {
  if (entry.type === 'tool_group') {
    return <ToolGroup key={entry.id} entry={entry} />
  }

  if (entry.type === 'tool') {
    return (
      <div key={entry.id} className="conv-tool">
        <span className="conv-tool-label">{entry.label || entry.name || 'Tool'}</span>
        {entry.summary ? (
          <span className="conv-tool-summary">{entry.summary}</span>
        ) : null}
      </div>
    )
  }

  if (entry.type === 'status') {
    return (
      <div key={entry.id} className="conv-status">
        <Info size={12} strokeWidth={2} />
        <span>{entry.content}</span>
      </div>
    )
  }

  const isUser = entry.type === 'user'
  const assistantName =
    typeof entry.agentName === 'string' && entry.agentName.trim()
      ? entry.agentName.trim()
      : 'Assistant'
  const assistantEmoji =
    typeof entry.agentEmoji === 'string' && entry.agentEmoji.trim()
      ? entry.agentEmoji.trim()
      : ''

  if (isUser) {
    return (
      <div key={entry.id} className="conv-msg conv-msg-user">
        <div className="conv-msg-bubble">
          <div className="conv-msg-text">{entry.content}</div>
        </div>
      </div>
    )
  }

  return (
    <div key={entry.id} className="conv-msg conv-msg-assistant">
      <div className="conv-msg-avatar">
        {assistantEmoji ? (
          <span className="conv-msg-avatar-emoji">{assistantEmoji}</span>
        ) : (
          <Sparkles size={14} strokeWidth={2} />
        )}
      </div>
      <div className="conv-msg-body">
        <div className="conv-msg-role">{assistantName}</div>
        <div className="conv-msg-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.content || ''}</ReactMarkdown>
        </div>
      </div>
    </div>
  )
}

export function InlineChatView({
  entries = [],
  loading = false,
  error = '',
  onPromptSubmit,
  onStop,
  disabled = false,
}) {
  const bodyRef = useRef(null)
  const isNearBottomRef = useRef(true)
  const [prompt, setPrompt] = useState('')

  const handleMessagesScroll = useCallback(() => {
    const el = bodyRef.current
    if (!el) return
    const threshold = 80
    isNearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
  }, [])

  useEffect(() => {
    if (!bodyRef.current || !isNearBottomRef.current) {
      return
    }
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [entries, loading, error])

  function submitPrompt() {
    if (loading) return
    const message = prompt.trim()
    if (!message) return
    onPromptSubmit?.(message)
    setPrompt('')
  }

  return (
    <div className="inline-chat-view">
      <div className="inline-chat-messages" ref={bodyRef} onScroll={handleMessagesScroll}>
        {entries.length === 0 && (
          <div className="muted" style={{ padding: '8px 0' }}>No messages yet.</div>
        )}
        {entries.map(renderEntry)}
        {loading && (
          <div className="conv-status">
            <span className="conv-streaming-label">Thinking...</span>
          </div>
        )}
        {error && (
          <div className="error" style={{ padding: '4px 0' }}>Error: {error}</div>
        )}
      </div>
      <div className="inline-chat-input-row">
        <input
          className="conv-prompt-input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Continue this conversation..."
          disabled={loading || disabled}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submitPrompt()
            }
          }}
        />
        {loading ? (
          <button
            className="conv-prompt-send conv-prompt-send-stop"
            onClick={() => onStop?.()}
            aria-label="Stop"
          >
            <Square size={12} fill="#fff" strokeWidth={0} />
          </button>
        ) : (
          <button
            className="conv-prompt-send"
            onClick={submitPrompt}
            disabled={!prompt.trim() || disabled}
            aria-label="Send"
          >
            <ArrowUp size={15} strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  )
}
