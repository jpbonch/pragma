import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, ArrowLeft, X, Sparkles, User, Info, Square, ChevronRight, Plus } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { OutputPanel } from './OutputPanel'
import { PlanProposalPanel } from './PlanProposalPanel'
import { fetchTaskPlan, fetchTaskTestCommands, runTaskTestCommand, updateTaskTestCommands } from '../api'

const HEADER_STATUS_LABELS = {
  pending_review: 'Review',
  waiting_for_recipient: 'Recipient Needed',
  waiting_for_question_response: 'Answer Needed',
  waiting_for_help_response: 'Help Needed',
  orchestrating: 'Executing',
  running: 'Executing',
  queued: 'Queued',
  merging: 'Merging',
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

export function ConversationDrawer({
  open,
  mode,
  entries,
  loading,
  planReady,
  error,
  onClose,
  onExecute,
  onDeletePlan,
  executeDisabled,
  recipientAgents = [],
  onPromptSubmit,
  taskId,
  taskStatus,
  taskTitle = '',
  headerAgentName = '',
  headerAgentEmoji = '',
  onReviewAction,
  onDeleteTask,
  isFollowupTask = false,
  runtimeService = null,
  runtimeServiceLogs = [],
  runtimeServiceError = '',
  onStopRuntimeService,
  onServiceStarted,
  onStop,
  planProposal = null,
  onUpdatePlanProposal,
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

  const [prompt, setPrompt] = useState('')
  const [attachments, setAttachments] = useState([])
  const textareaRef = useRef(null)
  const fileInputRef = useRef(null)
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
  const [hasChanges, setHasChanges] = useState(null)
  const [hasOutputFiles, setHasOutputFiles] = useState(null)
  const showOutputPanel = Boolean(taskId) && (mode === 'chat' || mode === 'execute')
  const showProposalPanel = mode === 'plan' && planProposal != null && Array.isArray(planProposal.tasks) && planProposal.tasks.length > 0
  const isPendingReview = showOutputPanel && taskStatus === 'pending_review'
  const hasOutputs = hasChanges === true || hasOutputFiles === true
  const canApprove = isPendingReview && hasOutputs
  const canMarkCompleted = (isPendingReview && hasChanges === false && hasOutputFiles === false) || (showOutputPanel && taskStatus === 'completed')
  const isCompletedTask = showOutputPanel && taskStatus === 'completed'
  const headerStatusLabel = useMemo(
    () => getHeaderStatusLabel({ taskStatus, mode, loading, planReady }),
    [taskStatus, mode, loading, planReady],
  )
  const activeQuestionOptions = useMemo(() => {
    const isWaiting = taskStatus === 'waiting_for_question_response' || taskStatus === 'waiting_for_help_response'
    if (!isWaiting) return null
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]
      if (e.type === 'question' && Array.isArray(e.options) && e.options.length > 0) {
        return { question: e.content, options: e.options }
      }
    }
    return null
  }, [entries, taskStatus])
  const displayHeaderAgentName =
    typeof headerAgentName === 'string' ? headerAgentName.trim() : ''
  const displayHeaderAgentEmoji =
    typeof headerAgentEmoji === 'string' && headerAgentEmoji.trim()
      ? headerAgentEmoji.trim()
      : '🤖'

  useEffect(() => {
    const el = textareaRef.current
    if (el && prompt) {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 120) + 'px'
    }
  }, [prompt, open])

  useEffect(() => {
    if (!bodyRef.current || !isNearBottomRef.current) {
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
      setHasChanges(null)
      setHasOutputFiles(null)
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
    if (loading) {
      return
    }
    const message = prompt.trim()
    if (!message && attachments.length === 0) {
      return
    }
    onPromptSubmit?.(message, attachments.length > 0 ? [...attachments] : undefined)
    setPrompt('')
    setAttachments([])
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
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

    if (entry.type === 'question') {
      return (
        <div key={entry.id} className="conv-question-card">
          <div className="conv-question-text">{entry.content}</div>
          {entry.details && (
            <div className="conv-question-details">{entry.details}</div>
          )}
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

  return (
    <div className="conv-page">
      {/* Header */}
      <div className="conv-header">
        <div className="conv-header-left">
          <button className="conv-back-btn" onClick={onClose} aria-label="Back to tasks">
            <ArrowLeft size={16} strokeWidth={2} />
            <span>Tasks</span>
          </button>
          <div className="conv-header-separator" />
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
        </div>
      </div>

        {/* Body */}
        <div className={`conv-body ${showOutputPanel || showProposalPanel ? 'conv-body-split' : ''}`}>
          {showProposalPanel ? (
            <>
              <div className="conv-chat-side">
                <div className="conv-messages" ref={bodyRef} onScroll={handleMessagesScroll}>
                  {entries.length === 0 && <div className="muted" style={{ padding: '8px 0' }}>No messages yet.</div>}
                  {entries.map(renderEntry)}
                  {loading && <div className="conv-thinking-indicator"><span className="conv-thinking-dot" /><span className="conv-thinking-dot" /><span className="conv-thinking-dot" /></div>}
                  {error && <div className="error" style={{ padding: '4px 0' }}>Error: {error}</div>}
                </div>
                <div className={`conv-input-container${activeQuestionOptions ? ' conv-input-has-options' : ''}`}>
                  {activeQuestionOptions && (
                    <div className="conv-input-options">
                      <div className="conv-input-options-title">{activeQuestionOptions.question}</div>
                      {activeQuestionOptions.options.map((opt, i) => (
                        <button
                          key={i}
                          className="conv-input-option-btn"
                          onClick={() => onPromptSubmit?.(opt)}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  )}
                  <textarea
                    ref={textareaRef}
                    className="input-textarea"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder={
                      activeQuestionOptions
                        ? 'Or type a custom response...'
                        : 'Refine this plan...'
                    }
                    disabled={loading}
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
                      disabled={loading}
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
                          disabled={!prompt.trim() && attachments.length === 0}
                          aria-label="Send"
                        >
                          <ArrowUp size={18} strokeWidth={2.6} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
              <div className="conv-output-side conv-output-side-plan">
                <PlanProposalPanel
                  proposal={planProposal}
                  agents={recipientAgents}
                  onUpdate={onUpdatePlanProposal}
                  disabled={loading}
                />
                <div className="conv-plan-actions">
                  <button className="conv-delete-plan-btn" onClick={onDeletePlan} disabled={loading}>
                    Delete Plan
                  </button>
                  <button className="conv-execute-btn" onClick={onExecute} disabled={executeDisabled || loading}>
                    Execute →
                  </button>
                </div>
              </div>
            </>
          ) : showOutputPanel ? (
            <>
              <div className="conv-chat-side">
                <div className="conv-messages" ref={bodyRef} onScroll={handleMessagesScroll}>
                  {entries.length === 0 && <div className="muted" style={{ padding: '8px 0' }}>No messages yet.</div>}
                  {entries.map(renderEntry)}
                  {loading && <div className="conv-thinking-indicator"><span className="conv-thinking-dot" /><span className="conv-thinking-dot" /><span className="conv-thinking-dot" /></div>}
                  {error && <div className="error" style={{ padding: '4px 0' }}>Error: {error}</div>}
                </div>
                <div className={`conv-input-container${activeQuestionOptions ? ' conv-input-has-options' : ''}`}>
                  {activeQuestionOptions && (
                    <div className="conv-input-options">
                      <div className="conv-input-options-title">{activeQuestionOptions.question}</div>
                      {activeQuestionOptions.options.map((opt, i) => (
                        <button
                          key={i}
                          className="conv-input-option-btn"
                          onClick={() => onPromptSubmit?.(opt)}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  )}
                  <textarea
                    ref={textareaRef}
                    className="input-textarea"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder={
                      isCompletedTask
                        ? 'Send a follow-up message...'
                        : activeQuestionOptions
                          ? 'Or type a custom response...'
                          : 'Continue this conversation...'
                    }
                    disabled={loading}
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
                      disabled={loading}
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
                          disabled={!prompt.trim() && attachments.length === 0}
                          aria-label="Send"
                        >
                          <ArrowUp size={18} strokeWidth={2.6} />
                        </button>
                      )}
                    </div>
                  </div>
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
                  onChangesLoaded={setHasChanges}
                  onFilesLoaded={setHasOutputFiles}
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
            <div className="conv-messages" ref={bodyRef} onScroll={handleMessagesScroll}>
              {entries.length === 0 && <div className="muted" style={{ padding: '8px 0' }}>No messages yet.</div>}
              {entries.map(renderEntry)}
              {loading && <div className="conv-thinking-indicator"><span className="conv-thinking-dot" /><span className="conv-thinking-dot" /><span className="conv-thinking-dot" /></div>}
              {error && <div className="error" style={{ padding: '4px 0' }}>Error: {error}</div>}
            </div>
          )}
        </div>

        {/* Footer */}
        {showProposalPanel ? null : showOutputPanel ? (
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
                    onClick={() => { void submitReviewAction(isFollowupTask ? 'approve_chain' : 'approve') }}
                    disabled={approveLoading}
                    title={isFollowupTask ? 'Approve chain' : 'Approve'}
                  >
                    {approveLoading ? 'Approving...' : isFollowupTask ? 'Approve Chain ✓' : 'Approve ✓'}
                  </button>
                )}
                {canApprove && hasChanges === true && (
                  <button
                    className="conv-approve-btn"
                    onClick={() => { void submitReviewAction(isFollowupTask ? 'approve_chain_and_push' : 'approve_and_push') }}
                    disabled={approveLoading}
                    title={isFollowupTask ? 'Approve chain and push to origin' : 'Approve and push to origin'}
                  >
                    {approveLoading ? 'Approving...' : isFollowupTask ? 'Approve Chain & Push' : 'Approve & Push'}
                  </button>
                )}
                {canMarkCompleted && !isCompletedTask && (
                  <button
                    className="conv-approve-btn"
                    onClick={() => { void submitReviewAction(isFollowupTask ? 'mark_chain_completed' : 'mark_completed') }}
                    disabled={approveLoading}
                    title={isFollowupTask ? 'Mark task and predecessors as completed' : 'Mark task as completed'}
                  >
                    {approveLoading ? 'Completing...' : isFollowupTask ? 'Mark Task and Predecessors Completed' : 'Mark Task Completed'}
                  </button>
                )}
                {isCompletedTask && (
                  <button
                    className="conv-approve-btn"
                    onClick={() => { void submitReviewAction('reopen') }}
                    disabled={approveLoading}
                    title="Reopen task"
                  >
                    {approveLoading ? 'Reopening...' : 'Reopen'}
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="conv-footer">
            <div className={`conv-input-container${activeQuestionOptions ? ' conv-input-has-options' : ''}`}>
              {activeQuestionOptions && (
                <div className="conv-input-options">
                  <div className="conv-input-options-title">{activeQuestionOptions.question}</div>
                  {activeQuestionOptions.options.map((opt, i) => (
                    <button
                      key={i}
                      className="conv-input-option-btn"
                      onClick={() => onPromptSubmit?.(opt)}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              )}
              <textarea
                ref={textareaRef}
                className="input-textarea"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={
                  activeQuestionOptions
                    ? 'Or type a custom response...'
                    : mode === 'plan'
                      ? 'Refine this plan...'
                      : 'Continue this conversation...'
                }
                disabled={loading}
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
                  disabled={loading}
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
                      disabled={!prompt.trim() && attachments.length === 0}
                      aria-label="Send"
                    >
                      <ArrowUp size={18} strokeWidth={2.6} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
    </div>
  )
}
