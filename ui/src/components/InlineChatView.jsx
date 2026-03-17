import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Sparkles, Info, Square, ChevronRight, Plus, X } from 'lucide-react'
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
  const [attachments, setAttachments] = useState([])
  const textareaRef = useRef(null)
  const fileInputRef = useRef(null)

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

  function handleFileSelect(e) {
    const files = Array.from(e.target.files || [])
    for (const file of files) {
      setAttachments((prev) => [...prev, { file, name: file.name }])
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  function handlePaste(e) {
    const items = e.clipboardData?.items
    if (!items) return
    const imageFiles = []
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) imageFiles.push(file)
      }
    }
    if (imageFiles.length === 0) return
    e.preventDefault()
    for (const file of imageFiles) {
      const name = file.name && file.name !== 'image.png'
        ? file.name
        : `pasted-image-${Date.now()}.${file.type.split('/')[1] || 'png'}`
      setAttachments((prev) => [...prev, { file, name }])
    }
  }

  function removeAttachment(index) {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }

  function submitPrompt() {
    if (loading) return
    const message = prompt.trim()
    if (!message && attachments.length === 0) return
    onPromptSubmit?.(message, attachments.length > 0 ? [...attachments] : undefined)
    setPrompt('')
    setAttachments([])
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
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
      <div className="conv-input-container">
        <textarea
          ref={textareaRef}
          className="input-textarea"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Continue this conversation..."
          disabled={loading || disabled}
          rows={1}
          onInput={(e) => {
            e.target.style.height = 'auto'
            e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
          }}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submitPrompt()
            }
          }}
        />
        {attachments.length > 0 && (
          <div className="attachment-chips">
            {attachments.map((att, i) => (
              <span key={i} className="attachment-chip">
                <span className="attachment-chip-name">{att.name}</span>
                <button
                  className="attachment-chip-remove"
                  onClick={() => removeAttachment(i)}
                  aria-label={`Remove ${att.name}`}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileSelect}
        />
        <div className="conv-input-bottom-row">
          <button
            className="attach-btn"
            title="Attach files"
            aria-label="Attach files"
            disabled={loading || disabled}
            onClick={() => fileInputRef.current?.click()}
          >
            <Plus size={14} />
          </button>
          <div className="input-actions">
            {loading ? (
              <button
                className="send-btn send-btn-stop"
                onClick={() => onStop?.()}
                aria-label="Stop"
              >
                <Square size={14} fill="#fff" strokeWidth={0} />
              </button>
            ) : (
              <button
                className="send-btn"
                style={{ background: '#2383e2' }}
                onClick={submitPrompt}
                disabled={(!prompt.trim() && attachments.length === 0) || disabled}
                aria-label="Send"
              >
                <ArrowUp size={18} strokeWidth={2.6} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
