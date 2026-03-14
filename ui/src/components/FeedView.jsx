import { useMemo, useState } from 'react'
import { Square } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

function normalizeTaskTitle(title) {
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new Error('Task title is required.')
  }
  const value = title.trim()
  return value.replace(/^execute:\s*/i, '')
}

function getTimeAgo(dateStr) {
  if (typeof dateStr !== 'string' || dateStr.trim().length === 0) {
    throw new Error('Task created_at is required.')
  }

  const date = new Date(dateStr)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${dateStr}`)
  }

  return formatDistanceToNow(date, { addSuffix: true })
}

const STATUS_COLORS = {
  pending_review: '#2FA67E',
  waiting_for_recipient: '#9B6DD7',
  waiting_for_question_response: '#4B83D6',
  waiting_for_help_response: '#E06B5E',
  orchestrating: '#5A6B8A',
  running: '#4B83D6',
  queued: '#7C6DD7',
  needs_fix: '#D9534F',
  completed: '#2FA67E',
  failed: '#EB5757',
  cancelled: '#9B9A97',
}

const STATUS_LABELS = {
  pending_review: 'Review',
  waiting_for_recipient: 'Assign',
  waiting_for_question_response: 'Answer',
  waiting_for_help_response: 'Help',
  orchestrating: 'Orchestrating',
  running: 'Running',
  queued: 'Queued',
  needs_fix: 'Needs Fix',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

const NEEDS_YOU_ACTIONS = {
  pending_review: 'Review',
  waiting_for_recipient: 'Assign',
  waiting_for_question_response: 'Answer',
  waiting_for_help_response: 'Help',
}

const NEEDS_YOU_SUBTITLES = {
  pending_review: 'Ready for your review',
  waiting_for_recipient: 'Waiting for you to pick a recipient',
  waiting_for_question_response: 'Agent is blocked until you answer',
  waiting_for_help_response: 'Agent needs your help to continue',
}

function getStatusColor(status) {
  const color = STATUS_COLORS[status]
  if (!color) {
    throw new Error(`Unsupported status: ${status}`)
  }
  return color
}

function isNeedsYou(status) {
  return (
    status === 'pending_review' ||
    status === 'waiting_for_recipient' ||
    status === 'waiting_for_question_response' ||
    status === 'waiting_for_help_response'
  )
}

function isActive(status) {
  return status === 'running' || status === 'queued'
}

function isDone(status) {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function SectionLabel({ children, count, badge }) {
  return (
    <div className="section-label">
      <span className="section-label-text">{children}</span>
      {count > 0 && (
        <span className={`section-count${badge ? ' badge' : ''}`}>{count}</span>
      )}
    </div>
  )
}

function NeedsYouCard({ task, onClick, onPickTaskRecipient, recipientAgents, pickerTaskId, setPickerTaskId }) {
  const status = String(task.status).toLowerCase()
  const color = getStatusColor(status)
  const [hovered, setHovered] = useState(false)
  const isRecipientPick = status === 'waiting_for_recipient'

  return (
    <div
      className="needs-you-card"
      style={{ '--accent': color }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => !isRecipientPick && onClick?.(task)}
    >
      <div style={{ flex: 1, minWidth: 0, cursor: isRecipientPick ? 'default' : 'pointer' }}>
        <div className="needs-you-title">{normalizeTaskTitle(task.title)}</div>
        <div className="needs-you-subtitle">
          {NEEDS_YOU_SUBTITLES[status]}
        </div>
        {task.assigned_to && (
          <div style={{ fontSize: 11, color: '#C4C3BF', marginTop: 4 }}>
            Assigned to {task.assigned_to}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={{ fontSize: 11, color: '#C4C3BF' }}>{getTimeAgo(task.created_at)}</span>
        {isRecipientPick ? (
          <div className="task-recipient-wrap">
            <button
              className="needs-you-action"
              style={{ background: color, opacity: hovered ? 1 : 0.88 }}
              onClick={(e) => {
                e.stopPropagation()
                setPickerTaskId((current) => (current === task.id ? '' : task.id))
              }}
            >
              {NEEDS_YOU_ACTIONS[status]}
            </button>
            {pickerTaskId === task.id && (
              <div className="task-recipient-menu">
                {(!recipientAgents || recipientAgents.length === 0) && (
                  <div className="task-recipient-empty">No agents available</div>
                )}
                {recipientAgents?.map((agent) => (
                  <button
                    key={agent.id}
                    className="task-recipient-option"
                    onClick={(e) => {
                      e.stopPropagation()
                      onPickTaskRecipient?.(task.id, agent.id)
                      setPickerTaskId('')
                    }}
                  >
                    <span className="task-recipient-name">{agent.name}</span>
                    <span className="task-recipient-id">{agent.id}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <button
            className="needs-you-action"
            style={{ background: color, opacity: hovered ? 1 : 0.88 }}
            onClick={(e) => {
              e.stopPropagation()
              onClick?.(task)
            }}
          >
            {NEEDS_YOU_ACTIONS[status]}
          </button>
        )}
      </div>
    </div>
  )
}

function ActiveTaskRow({ task, onClick, onCancelTask }) {
  const status = String(task.status).toLowerCase()
  const color = getStatusColor(status)
  const canStop = status === 'running' || status === 'orchestrating'

  return (
    <div className="task-row" onClick={() => onClick?.(task)}>
      <div className="task-dot">
        <div className="task-dot-inner" style={{ background: color }} />
        {status === 'running' && (
          <div className="task-dot-pulse" style={{ border: `1.5px solid ${color}` }} />
        )}
      </div>
      <span className="task-title active">{normalizeTaskTitle(task.title)}</span>
      <div className="task-meta-right">
        <span className="type-tag" style={{ color, background: `${color}12` }}>
          {STATUS_LABELS[status]}
        </span>
        {task.assigned_to && (
          <span style={{ fontSize: 11, color: '#C4C3BF' }}>{task.assigned_to}</span>
        )}
        <span className="task-time">{getTimeAgo(task.created_at)}</span>
        {canStop && onCancelTask && (
          <button
            className="task-row-stop"
            onClick={(e) => {
              e.stopPropagation()
              onCancelTask(task.id)
            }}
            title="Cancel task"
            aria-label="Cancel task"
          >
            <Square size={10} fill="currentColor" strokeWidth={0} />
          </button>
        )}
      </div>
    </div>
  )
}

function DoneTaskRow({ task, onClick }) {
  const status = String(task.status).toLowerCase()
  const color = status === 'failed' ? '#EB5757' : status === 'cancelled' ? '#9B9A97' : '#2FA67E'
  const icon = status === 'failed' ? '✕' : status === 'cancelled' ? '—' : '✓'
  const titleClass = status === 'failed' ? 'failed' : status === 'cancelled' ? 'done' : 'done'

  return (
    <div className="task-row" onClick={() => onClick?.(task)}>
      <div className="task-done-check" style={{ background: `${color}15`, color }}>
        {icon}
      </div>
      <span className={`task-title ${titleClass}`}>
        {normalizeTaskTitle(task.title)}
      </span>
      <span className="task-time">{getTimeAgo(task.created_at)}</span>
    </div>
  )
}

function PlanRow({ plan, isActive, onClick }) {
  return (
    <div
      className={`plan-row ${isActive ? 'active' : ''}`}
      onClick={() => onClick?.(plan.id)}
    >
      <div className="plan-row-dot">
        <div className="plan-row-dot-inner" />
      </div>
      <span className="plan-row-title">{plan.plan_title || 'New plan'}</span>
      {plan.plan_preview && (
        <span className="plan-row-preview">{plan.plan_preview}</span>
      )}
    </div>
  )
}

export function FeedView({
  tasks,
  loading,
  error,
  recipientAgents = [],
  plans = [],
  plansLoading = false,
  activePlanThreadId = '',
  onOpenPlan,
  onOpenTaskConversation,
  onPickTaskRecipient,
  onCancelTask,
}) {
  const [pickerTaskId, setPickerTaskId] = useState('')

  const recipients = useMemo(() => {
    if (!Array.isArray(recipientAgents)) {
      return []
    }
    return recipientAgents.filter((agent) => agent && typeof agent.id === 'string')
  }, [recipientAgents])

  const { needsYou, active, done } = useMemo(() => {
    const needsYou = []
    const active = []
    const done = []

    for (const task of tasks) {
      const status = String(task.status).toLowerCase()
      if (isNeedsYou(status)) {
        needsYou.push(task)
      } else if (isDone(status)) {
        done.push(task)
      } else {
        active.push(task)
      }
    }

    return { needsYou, active, done }
  }, [tasks])

  return (
    <section className="feed">
      {loading && <div className="muted">Loading tasks...</div>}
      {error && <div className="error">Error: {error}</div>}

      {!plansLoading && plans.length > 0 && (
        <>
          <SectionLabel count={plans.length}>Plans</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {plans.map((plan) => (
              <PlanRow
                key={plan.id}
                plan={plan}
                isActive={activePlanThreadId === plan.id}
                onClick={onOpenPlan}
              />
            ))}
          </div>
        </>
      )}

      {!loading && !error && tasks.length === 0 && (
        <div className="muted">No tasks found.</div>
      )}

      {!loading && !error && tasks.length > 0 && (
        <>
          {needsYou.length > 0 && (
            <>
              <SectionLabel count={needsYou.length} badge>Needs you</SectionLabel>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {needsYou.map((task) => (
                  <NeedsYouCard
                    key={task.id}
                    task={task}
                    onClick={onOpenTaskConversation}
                    onPickTaskRecipient={onPickTaskRecipient}
                    recipientAgents={recipients}
                    pickerTaskId={pickerTaskId}
                    setPickerTaskId={setPickerTaskId}
                  />
                ))}
              </div>
            </>
          )}

          {active.length > 0 && (
            <>
              <SectionLabel count={active.length}>Working on</SectionLabel>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {active.map((task) => (
                  <ActiveTaskRow
                    key={task.id}
                    task={task}
                    onClick={onOpenTaskConversation}
                    onCancelTask={onCancelTask}
                  />
                ))}
              </div>
            </>
          )}

          {done.length > 0 && (
            <>
              <SectionLabel count={done.length}>Done</SectionLabel>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                {done.map((task) => (
                  <DoneTaskRow
                    key={task.id}
                    task={task}
                    onClick={onOpenTaskConversation}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}
