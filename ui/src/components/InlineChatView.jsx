import { useCallback, useEffect, useRef, useState } from 'react'
import { Sparkles, Info, ChevronRight, Settings } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { InputBar } from './InputBar'

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

  if (entry.type === 'system') {
    return (
      <div key={entry.id} className="conv-msg conv-msg-system">
        <div className="conv-msg-system-icon">
          <Settings size={14} strokeWidth={2} />
        </div>
        <div className="conv-msg-system-body">
          <div className="conv-msg-system-label">System</div>
          <div className="conv-msg-system-text">{entry.content}</div>
        </div>
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
  onSubmit,
  onStop,
  onOpenOrchestratorConfig,
  value,
  onValueChange,
  disabled = false,
}) {
  const bodyRef = useRef(null)
  const isNearBottomRef = useRef(true)

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

  return (
    <div className="inline-chat-view">
      <div className="inline-chat-messages" ref={bodyRef} onScroll={handleMessagesScroll}>
        {entries.length === 0 && (
          <div className="muted" style={{ padding: '8px 0' }}>No messages yet.</div>
        )}
        {entries.map(renderEntry)}
        {loading && (
          <div className="conv-thinking-indicator">
            <span className="conv-thinking-dot" />
            <span className="conv-thinking-dot" />
            <span className="conv-thinking-dot" />
          </div>
        )}
        {error && (
          <div className="error" style={{ padding: '4px 0' }}>Error: {error}</div>
        )}
      </div>
      <InputBar
        disabled={disabled}
        loading={loading}
        onStop={onStop}
        onOpenOrchestratorConfig={onOpenOrchestratorConfig}
        hideMode
        lockedMode="chat"
        embedded
        value={value}
        onValueChange={onValueChange}
        onSubmit={onSubmit}
      />
    </div>
  )
}
