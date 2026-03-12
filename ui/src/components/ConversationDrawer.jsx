import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { OutputPanel } from './OutputPanel'

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
  onPromptSubmit,
  jobId = '',
  jobStatus = '',
  onReviewAction,
}) {
  const bodyRef = useRef(null)
  const [prompt, setPrompt] = useState('')
  const [approveLoading, setApproveLoading] = useState(false)
  const [approveError, setApproveError] = useState('')
  const showOutputPanel = Boolean(jobId) && mode === 'chat'
  const canApprove = showOutputPanel && jobStatus === 'pending_review'

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
  }, [entries, loading, error, showOutputPanel])

  useEffect(() => {
    if (!open) {
      setPrompt('')
      setApproveLoading(false)
      setApproveError('')
    }
  }, [open])

  function submitPrompt() {
    if (loading) {
      return
    }
    const message = prompt.trim()
    if (!message) {
      return
    }
    onPromptSubmit?.(message)
    setPrompt('')
  }

  async function submitApprove() {
    if (!jobId || !onReviewAction || approveLoading) {
      return
    }
    setApproveError('')
    setApproveLoading(true)
    try {
      await onReviewAction(jobId, 'approve')
    } catch (error) {
      setApproveError(error instanceof Error ? error.message : String(error))
    } finally {
      setApproveLoading(false)
    }
  }

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

        <div className={`conversation-drawer-body ${showOutputPanel ? 'with-output' : ''}`}>
          {showOutputPanel ? (
            <>
              <div className="conversation-chat-pane">
                <div className="conversation-history-pane" ref={bodyRef}>
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
                      <div
                        key={entry.id}
                        className={`conversation-message ${entry.type === 'user' ? 'from-user' : 'from-assistant'}`}
                      >
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
                <div className="conversation-drawer-prompt-row">
                  <input
                    className="conversation-drawer-prompt-input"
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    placeholder="Continue this conversation..."
                    disabled={loading}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        submitPrompt()
                      }
                    }}
                  />
                  <button
                    className="conversation-drawer-prompt-send"
                    onClick={submitPrompt}
                    disabled={loading || !prompt.trim()}
                    title="Send"
                    aria-label="Send"
                  >
                    <ArrowUp size={16} strokeWidth={2.5} />
                  </button>
                </div>
              </div>
              <div className="conversation-output-pane">
                <OutputPanel jobId={jobId} jobStatus={jobStatus} />
              </div>
            </>
          ) : (
            <div className="conversation-history-pane" ref={bodyRef}>
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
                  <div
                    key={entry.id}
                    className={`conversation-message ${entry.type === 'user' ? 'from-user' : 'from-assistant'}`}
                  >
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
          )}
        </div>

        {showOutputPanel ? (
          <div className="conversation-drawer-footer-stack conversation-drawer-review-footer">
            {approveError && <div className="error">Error: {approveError}</div>}
            <div className="conversation-drawer-footer conversation-drawer-footer-end">
              <button
                className="conversation-approve-btn"
                onClick={() => {
                  void submitApprove()
                }}
                disabled={!canApprove || approveLoading}
                title={canApprove ? 'Approve' : 'Job must be pending review to approve'}
              >
                {approveLoading ? 'Approving...' : 'Approve'}
              </button>
            </div>
          </div>
        ) : (
          <div className="conversation-drawer-footer-stack">
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
            <div className="conversation-drawer-prompt-row">
              <input
                className="conversation-drawer-prompt-input"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={mode === 'plan' ? 'Refine this plan...' : 'Continue this conversation...'}
                disabled={loading}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    submitPrompt()
                  }
                }}
              />
              <button
                className="conversation-drawer-prompt-send"
                onClick={submitPrompt}
                disabled={loading || !prompt.trim()}
                title="Send"
                aria-label="Send"
              >
                <ArrowUp size={16} strokeWidth={2.5} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
