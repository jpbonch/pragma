import { useEffect, useMemo, useRef } from 'react'
import { X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'

export function ConversationDrawer({
  open,
  mode,
  entries,
  loading,
  error,
  onClose,
  onExecute,
  executeDisabled,
  recipientAgents = [],
  selectedRecipientAgentId = '',
  onSelectRecipientAgentId,
}) {
  const bodyRef = useRef(null)

  const title = useMemo(() => {
    if (mode === 'plan') return 'Plan Conversation'
    if (mode === 'chat') return 'Chat Conversation'
    return 'Conversation'
  }, [mode])

  useEffect(() => {
    if (!bodyRef.current) {
      return
    }
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [entries, loading, error])

  if (!open) {
    return null
  }

  return (
    <div className="conversation-drawer-backdrop">
      <div className="conversation-drawer">
        <div className="conversation-drawer-header">
          <div className="conversation-drawer-title">{title}</div>
          {mode === 'chat' && (
            <button className="conversation-close-btn" onClick={onClose} aria-label="Close chat">
              <X size={14} />
            </button>
          )}
        </div>

        <div className="conversation-drawer-body" ref={bodyRef}>
          {entries.length === 0 && <div className="muted">No messages yet.</div>}

          {entries.map((entry) => {
            if (entry.type === 'tool') {
              return (
                <div key={entry.id} className="conversation-tool-row">
                  <div className="conversation-tool-name">{entry.label || entry.name || 'Tool'}</div>
                  {entry.summary ? (
                    <div className="conversation-tool-summary">{entry.summary}</div>
                  ) : null}
                </div>
              )
            }

            if (entry.type === 'status') {
              return (
                <div key={entry.id} className="conversation-status-row">
                  {entry.content}
                </div>
              )
            }

            return (
              <div key={entry.id} className={`conversation-message ${entry.type === 'user' ? 'from-user' : 'from-assistant'}`}>
                <div className="conversation-role">{entry.type === 'user' ? 'You' : 'Assistant'}</div>
                {entry.type === 'assistant' ? (
                  <div className="conversation-markdown">
                    <ReactMarkdown>{entry.content || ''}</ReactMarkdown>
                  </div>
                ) : (
                  <div className="conversation-content">{entry.content}</div>
                )}
              </div>
            )
          })}

          {loading && <div className="conversation-status">Streaming...</div>}
          {error && <div className="error">Error: {error}</div>}
        </div>

        {mode === 'plan' && (
          <div className="conversation-drawer-footer">
            <div className="conversation-recipient-picker">
              <label className="conversation-recipient-label">Recipient</label>
              <select
                className="conversation-recipient-select"
                value={selectedRecipientAgentId}
                onChange={(event) => onSelectRecipientAgentId?.(event.target.value)}
                disabled={loading}
              >
                <option value="">Auto-select</option>
                {recipientAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name || agent.id}
                  </option>
                ))}
              </select>
            </div>
            <button className="conversation-execute-btn" onClick={onExecute} disabled={executeDisabled || loading}>
              Execute
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
