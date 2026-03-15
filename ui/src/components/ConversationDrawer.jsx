import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, X, Sparkles, User, Wrench, Info, Square } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { OutputPanel } from './OutputPanel'
import { fetchTaskPlan, fetchTaskTestCommands, runTaskTestCommand, updateTaskTestCommands } from '../api'

const HEADER_STATUS_LABELS = {
  pending_review: 'Review',
  waiting_for_recipient: 'Recipient Needed',
  waiting_for_question_response: 'Answer Needed',
  waiting_for_help_response: 'Help Needed',
  orchestrating: 'Executing',
  running: 'Executing',
  queued: 'Queued',
  needs_fix: 'Needs Fix',
  completed: 'Completed',
  failed: 'Failed',
}

function toTitleCaseStatus(value) {
  const parts = value.split('_').filter(Boolean)
  if (parts.length === 0) {
    return 'Ready'
  }
  return parts.map((part) => part[0].toUpperCase() + part.slice(1)).join(' ')
}

function getHeaderStatusLabel({ taskStatus, mode, loading, planReady }) {
  const normalizedStatus = typeof taskStatus === 'string' ? taskStatus.trim().toLowerCase() : ''
  if (normalizedStatus) {
    return HEADER_STATUS_LABELS[normalizedStatus] || toTitleCaseStatus(normalizedStatus)
  }
  if (loading) {
    return mode === 'plan' ? 'Planning' : 'Executing'
  }
  if (mode === 'plan') {
    return planReady ? 'Plan Ready' : 'Planning'
  }
  return 'Ready'
}

export function ConversationDrawer({
  open,
  mode,
  entries,
  loading,
  planReady,
  error,
  onClose,
  onExecute,
  executeDisabled,
  recipientAgents = [],
  selectedRecipientAgentId = '',
  onSelectRecipientAgentId,
  onPromptSubmit,
  taskId,
  taskStatus,
  taskTitle = '',
  headerAgentName = '',
  headerAgentEmoji = '',
  onReviewAction,
  onDeleteTask,
  runtimeService = null,
  runtimeServiceLogs = [],
  runtimeServiceError = '',
  onStopRuntimeService,
  onServiceStarted,
  onStop,
}) {
  const bodyRef = useRef(null)
  const [prompt, setPrompt] = useState('')
  const [approveLoading, setApproveLoading] = useState(false)
  const [approveError, setApproveError] = useState('')
  const [testCommands, setTestCommands] = useState([])
  const [testCommandsLoading, setTestCommandsLoading] = useState(false)
  const [testCommandsError, setTestCommandsError] = useState('')
  const [runningTestCommand, setRunningTestCommand] = useState('')
  const [planData, setPlanData] = useState(null)
  const [planLoading, setPlanLoading] = useState(false)
  const [planError, setPlanError] = useState('')
  const [deleteConfirming, setDeleteConfirming] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const showOutputPanel = Boolean(taskId) && mode === 'chat'
  const canApprove = showOutputPanel && taskStatus === 'pending_review'
  const canReopenCompleted = showOutputPanel && taskStatus === 'completed'
  const isCompletedTask = showOutputPanel && taskStatus === 'completed'
  const headerStatusLabel = useMemo(
    () => getHeaderStatusLabel({ taskStatus, mode, loading, planReady }),
    [taskStatus, mode, loading, planReady],
  )
  const displayHeaderAgentName =
    typeof headerAgentName === 'string' ? headerAgentName.trim() : ''
  const displayHeaderAgentEmoji =
    typeof headerAgentEmoji === 'string' && headerAgentEmoji.trim()
      ? headerAgentEmoji.trim()
      : '🤖'

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
      setTestCommands([])
      setTestCommandsLoading(false)
      setTestCommandsError('')
      setRunningTestCommand('')
      setPlanData(null)
      setPlanLoading(false)
      setPlanError('')
      setDeleteConfirming(false)
      setDeleteLoading(false)
    }
  }, [open])

  useEffect(() => {
    if (!open || !taskId || !showOutputPanel) {
      return
    }

    let cancelled = false
    setTestCommandsLoading(true)
    setTestCommandsError('')
    void fetchTaskTestCommands(taskId)
      .then((data) => {
        if (cancelled) {
          return
        }
        const list = Array.isArray(data?.commands) ? data.commands : []
        setTestCommands(list)
      })
      .catch((error) => {
        if (cancelled) {
          return
        }
        setTestCommands([])
        setTestCommandsError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!cancelled) {
          setTestCommandsLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [open, taskId, showOutputPanel, entries.length, taskStatus])

  useEffect(() => {
    if (!open || !taskId || !showOutputPanel) {
      return
    }

    let cancelled = false
    setPlanLoading(true)
    setPlanError('')
    void fetchTaskPlan(taskId)
      .then((data) => {
        if (cancelled) {
          return
        }
        setPlanData(data?.plan ?? null)
      })
      .catch((error) => {
        if (cancelled) {
          return
        }
        setPlanData(null)
        setPlanError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!cancelled) {
          setPlanLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [open, taskId, showOutputPanel])

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

  async function submitReviewAction(action) {
    if (!taskId || !onReviewAction || approveLoading) {
      return
    }
    setApproveError('')
    setApproveLoading(true)
    try {
      await onReviewAction(taskId, action)
    } catch (error) {
      setApproveError(error instanceof Error ? error.message : String(error))
    } finally {
      setApproveLoading(false)
    }
  }

  async function handleDeleteTask() {
    if (!taskId || !onDeleteTask || deleteLoading) {
      return
    }
    setDeleteLoading(true)
    try {
      await onDeleteTask(taskId)
    } catch {
      setDeleteLoading(false)
      setDeleteConfirming(false)
    }
  }

  async function handleRunTestCommand(item) {
    const command = typeof item?.command === 'string' ? item.command : ''
    const cwd = typeof item?.cwd === 'string' ? item.cwd : ''
    const runKey = `${cwd}\n${command}`
    if (!taskId || !command || !cwd || runningTestCommand) {
      return
    }
    setRunningTestCommand(runKey)
    setTestCommandsError('')
    try {
      const result = await runTaskTestCommand(taskId, command, cwd)
      const service = result?.service && typeof result.service === 'object' ? result.service : null
      if (service) {
        onServiceStarted?.(service)
      }
    } catch (error) {
      setTestCommandsError(error instanceof Error ? error.message : String(error))
    } finally {
      setRunningTestCommand('')
    }
  }

  async function handleUpdateTestCommand(index, nextCommand) {
    if (!taskId || !Number.isInteger(index) || index < 0) {
      return
    }
    const trimmed = typeof nextCommand === 'string' ? nextCommand.trim() : ''
    if (!trimmed) {
      return
    }

    const existing = Array.isArray(testCommands) ? testCommands[index] : null
    if (!existing || typeof existing !== 'object') {
      return
    }
    const currentCommand = typeof existing.command === 'string' ? existing.command : ''
    if (currentCommand === trimmed) {
      return
    }

    const nextCommands = testCommands
      .map((item, itemIndex) => {
        const command =
          itemIndex === index
            ? trimmed
            : (typeof item?.command === 'string' ? item.command.trim() : '')
        const cwd = typeof item?.cwd === 'string' ? item.cwd.trim() : ''
        const label = typeof item?.label === 'string' ? item.label.trim() : command
        return { label, command, cwd }
      })
      .filter((item) => item.command && item.cwd)

    if (nextCommands.length === 0) {
      return
    }

    setTestCommandsError('')
    try {
      const data = await updateTaskTestCommands(taskId, nextCommands)
      const updated = Array.isArray(data?.commands) ? data.commands : nextCommands
      setTestCommands(updated)
    } catch (error) {
      setTestCommandsError(error instanceof Error ? error.message : String(error))
    }
  }

  if (!open) {
    return null
  }

  function renderEntry(entry) {
    if (entry.type === 'tool') {
      return (
        <div key={entry.id} className="conv-tool">
          <Wrench size={12} strokeWidth={2} className="conv-tool-icon" />
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

    return (
      <div key={entry.id} className={`conv-msg ${isUser ? 'conv-msg-user' : 'conv-msg-assistant'}`}>
        <div className="conv-msg-avatar">
          {isUser ? (
            <User size={14} strokeWidth={2} />
          ) : assistantEmoji ? (
            <span className="conv-msg-avatar-emoji">{assistantEmoji}</span>
          ) : (
            <Sparkles size={14} strokeWidth={2} />
          )}
        </div>
        <div className="conv-msg-body">
          <div className="conv-msg-role">{isUser ? 'You' : assistantName}</div>
          {isUser ? (
            <div className="conv-msg-text">{entry.content}</div>
          ) : (
            <div className="conv-msg-markdown">
              <ReactMarkdown>{entry.content || ''}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="conversation-drawer-backdrop">
      <div className="conv-drawer">
        {/* Header */}
        <div className="conv-header">
          <div className="conv-header-left">
            <div className={`conv-mode-indicator ${mode}`} />
            <span className="conv-header-title">{taskTitle || headerStatusLabel}</span>
            {loading && <span className="conv-streaming-dot" />}
          </div>
          <div className="conv-header-right">
            {displayHeaderAgentName && (
              <div className="conv-header-agent" title={displayHeaderAgentName}>
                <span className="conv-header-agent-avatar">{displayHeaderAgentEmoji}</span>
                <span className="conv-header-agent-name">{displayHeaderAgentName}</span>
              </div>
            )}
            {(mode === 'chat' || mode === 'plan') && (
              <button className="conv-close" onClick={onClose} aria-label="Close">
                <X size={15} strokeWidth={2} />
              </button>
            )}
          </div>
        </div>

        {/* Body */}
        <div className={`conv-body ${showOutputPanel ? 'conv-body-split' : ''}`}>
          {showOutputPanel ? (
            <>
              <div className="conv-chat-side">
                <div className="conv-messages" ref={bodyRef}>
                  {entries.length === 0 && <div className="muted" style={{ padding: '8px 0' }}>No messages yet.</div>}
                  {entries.map(renderEntry)}
                  {loading && <div className="conv-status"><span className="conv-streaming-label">Thinking...</span></div>}
                  {error && <div className="error" style={{ padding: '4px 0' }}>Error: {error}</div>}
                </div>
                <div className="conv-prompt-row">
                  <input
                    className="conv-prompt-input"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder={
                      isCompletedTask
                        ? 'Task is completed. Mark it as not completed to continue.'
                        : 'Continue this conversation...'
                    }
                    disabled={loading || isCompletedTask}
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
                      disabled={isCompletedTask || !prompt.trim()}
                      aria-label="Send"
                    >
                      <ArrowUp size={15} strokeWidth={2.5} />
                    </button>
                  )}
                </div>
              </div>
              <div className="conv-output-side">
                <OutputPanel
                  taskId={taskId}
                  taskStatus={taskStatus}
                  testCommands={testCommands}
                  testCommandsLoading={testCommandsLoading}
                  testCommandsError={testCommandsError}
                  runningTestCommand={runningTestCommand}
                  onRunTestCommand={handleRunTestCommand}
                  onUpdateTestCommand={handleUpdateTestCommand}
                  planData={planData}
                  planLoading={planLoading}
                  planError={planError}
                  runtimeService={runtimeService}
                  runtimeServiceLogs={runtimeServiceLogs}
                  runtimeServiceError={runtimeServiceError}
                  onStopRuntimeService={onStopRuntimeService}
                />
              </div>
            </>
          ) : (
            <div className="conv-messages" ref={bodyRef}>
              {entries.length === 0 && <div className="muted" style={{ padding: '8px 0' }}>No messages yet.</div>}
              {entries.map(renderEntry)}
              {loading && <div className="conv-status"><span className="conv-streaming-label">Thinking...</span></div>}
              {error && <div className="error" style={{ padding: '4px 0' }}>Error: {error}</div>}
            </div>
          )}
        </div>

        {/* Footer */}
        {showOutputPanel ? (
          <div className="conv-footer">
            {approveError && <div className="error" style={{ padding: '0 4px 4px' }}>Error: {approveError}</div>}
            <div className="conv-footer-row">
              <div>
                {deleteConfirming ? (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      className="conv-delete-btn"
                      onClick={() => { void handleDeleteTask() }}
                      disabled={deleteLoading}
                    >
                      {deleteLoading ? 'Deleting...' : 'Confirm Delete'}
                    </button>
                    <button
                      className="conv-delete-cancel-btn"
                      onClick={() => setDeleteConfirming(false)}
                      disabled={deleteLoading}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    className="conv-delete-btn"
                    onClick={() => setDeleteConfirming(true)}
                  >
                    Delete Task
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {canApprove && (
                  <button
                    className="conv-approve-btn"
                    onClick={() => { void submitReviewAction('approve') }}
                    disabled={approveLoading}
                    title="Approve"
                  >
                    {approveLoading ? 'Approving...' : 'Approve ✓'}
                  </button>
                )}
                {canApprove && (
                  <button
                    className="conv-approve-btn"
                    onClick={() => { void submitReviewAction('approve_and_push') }}
                    disabled={approveLoading}
                    title="Approve and push to origin"
                  >
                    {approveLoading ? 'Approving...' : 'Approve & Push'}
                  </button>
                )}
                {canReopenCompleted && (
                  <button
                    className="conv-reopen-btn"
                    onClick={() => { void submitReviewAction('reopen') }}
                    disabled={approveLoading}
                    title="Mark task as not completed"
                  >
                    {approveLoading ? 'Reopening...' : 'Mark Not Completed'}
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="conv-footer">
            {mode === 'plan' && (
              <div className="conv-footer-row">
                <div className="conv-recipient-picker">
                  <label className="conv-recipient-label">Recipient</label>
                  <select
                    className="conv-recipient-select"
                    value={selectedRecipientAgentId}
                    onChange={(e) => onSelectRecipientAgentId?.(e.target.value)}
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
                <button className="conv-execute-btn" onClick={onExecute} disabled={executeDisabled || loading}>
                  Execute →
                </button>
              </div>
            )}
            <div className="conv-prompt-row">
              <input
                className="conv-prompt-input"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={mode === 'plan' ? 'Refine this plan...' : 'Continue this conversation...'}
                disabled={loading}
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
                  disabled={!prompt.trim()}
                  aria-label="Send"
                >
                  <ArrowUp size={15} strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
