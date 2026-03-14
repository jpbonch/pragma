import { useMemo, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'

function normalizeJobTitle(title) {
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new Error('Job title is required.')
  }
  const value = title.trim()
  return value.replace(/^execute:\s*/i, '')
}

function getTimeAgo(dateStr) {
  if (typeof dateStr !== 'string' || dateStr.trim().length === 0) {
    throw new Error('Job created_at is required.')
  }

  const date = new Date(dateStr)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${dateStr}`)
  }

  return formatDistanceToNow(date, { addSuffix: true })
}

const STATUS_COLORS = {
  pending_review: '#E09B3D',
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

function NeedsYouCard({ job, onClick, onPickJobRecipient, recipientAgents, pickerJobId, setPickerJobId }) {
  const status = String(job.status).toLowerCase()
  const color = getStatusColor(status)
  const [hovered, setHovered] = useState(false)
  const isRecipientPick = status === 'waiting_for_recipient'

  return (
    <div
      className="needs-you-card"
      style={{ '--accent': color }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => !isRecipientPick && onClick?.(job)}
    >
      <div style={{ flex: 1, minWidth: 0, cursor: isRecipientPick ? 'default' : 'pointer' }}>
        <div className="needs-you-title">{normalizeJobTitle(job.title)}</div>
        <div className="needs-you-subtitle">
          {NEEDS_YOU_SUBTITLES[status]}
        </div>
        {job.assigned_to && (
          <div style={{ fontSize: 11, color: '#C4C3BF', marginTop: 4 }}>
            Assigned to {job.assigned_to}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={{ fontSize: 11, color: '#C4C3BF' }}>{getTimeAgo(job.created_at)}</span>
        {isRecipientPick ? (
          <div className="job-recipient-wrap">
            <button
              className="needs-you-action"
              style={{ background: color, opacity: hovered ? 1 : 0.88 }}
              onClick={(e) => {
                e.stopPropagation()
                setPickerJobId((current) => (current === job.id ? '' : job.id))
              }}
            >
              {NEEDS_YOU_ACTIONS[status]}
            </button>
            {pickerJobId === job.id && (
              <div className="job-recipient-menu">
                {(!recipientAgents || recipientAgents.length === 0) && (
                  <div className="job-recipient-empty">No agents available</div>
                )}
                {recipientAgents?.map((agent) => (
                  <button
                    key={agent.id}
                    className="job-recipient-option"
                    onClick={(e) => {
                      e.stopPropagation()
                      onPickJobRecipient?.(job.id, agent.id)
                      setPickerJobId('')
                    }}
                  >
                    <span className="job-recipient-name">{agent.name}</span>
                    <span className="job-recipient-id">{agent.id}</span>
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
              onClick?.(job)
            }}
          >
            {NEEDS_YOU_ACTIONS[status]}
          </button>
        )}
      </div>
    </div>
  )
}

function ActiveTaskRow({ job, onClick }) {
  const status = String(job.status).toLowerCase()
  const color = getStatusColor(status)

  return (
    <div className="task-row" onClick={() => onClick?.(job)}>
      <div className="task-dot">
        <div className="task-dot-inner" style={{ background: color }} />
        {status === 'running' && (
          <div className="task-dot-pulse" style={{ border: `1.5px solid ${color}` }} />
        )}
      </div>
      <span className="task-title active">{normalizeJobTitle(job.title)}</span>
      <div className="task-meta-right">
        <span className="type-tag" style={{ color, background: `${color}12` }}>
          {STATUS_LABELS[status]}
        </span>
        {job.assigned_to && (
          <span style={{ fontSize: 11, color: '#C4C3BF' }}>{job.assigned_to}</span>
        )}
        <span className="task-time">{getTimeAgo(job.created_at)}</span>
      </div>
    </div>
  )
}

function DoneTaskRow({ job, onClick }) {
  const status = String(job.status).toLowerCase()
  const color = status === 'failed' ? '#EB5757' : status === 'cancelled' ? '#9B9A97' : '#2FA67E'
  const icon = status === 'failed' ? '✕' : status === 'cancelled' ? '—' : '✓'
  const titleClass = status === 'failed' ? 'failed' : status === 'cancelled' ? 'done' : 'done'

  return (
    <div className="task-row" onClick={() => onClick?.(job)}>
      <div className="task-done-check" style={{ background: `${color}15`, color }}>
        {icon}
      </div>
      <span className={`task-title ${titleClass}`}>
        {normalizeJobTitle(job.title)}
      </span>
      <span className="task-time">{getTimeAgo(job.created_at)}</span>
    </div>
  )
}

export function FeedView({
  jobs,
  loading,
  error,
  recipientAgents = [],
  onOpenJobConversation,
  onPickJobRecipient,
}) {
  const [pickerJobId, setPickerJobId] = useState('')

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

    for (const job of jobs) {
      const status = String(job.status).toLowerCase()
      if (isNeedsYou(status)) {
        needsYou.push(job)
      } else if (isDone(status)) {
        done.push(job)
      } else {
        active.push(job)
      }
    }

    return { needsYou, active, done }
  }, [jobs])

  return (
    <section className="feed">
      {loading && <div className="muted">Loading jobs...</div>}
      {error && <div className="error">Error: {error}</div>}

      {!loading && !error && jobs.length === 0 && (
        <div className="muted">No jobs found.</div>
      )}

      {!loading && !error && jobs.length > 0 && (
        <>
          {needsYou.length > 0 && (
            <>
              <SectionLabel count={needsYou.length} badge>Needs you</SectionLabel>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {needsYou.map((job) => (
                  <NeedsYouCard
                    key={job.id}
                    job={job}
                    onClick={onOpenJobConversation}
                    onPickJobRecipient={onPickJobRecipient}
                    recipientAgents={recipients}
                    pickerJobId={pickerJobId}
                    setPickerJobId={setPickerJobId}
                  />
                ))}
              </div>
            </>
          )}

          {active.length > 0 && (
            <>
              <SectionLabel count={active.length}>Working on</SectionLabel>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {active.map((job) => (
                  <ActiveTaskRow
                    key={job.id}
                    job={job}
                    onClick={onOpenJobConversation}
                  />
                ))}
              </div>
            </>
          )}

          {done.length > 0 && (
            <>
              <SectionLabel count={done.length}>Done</SectionLabel>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                {done.map((job) => (
                  <DoneTaskRow
                    key={job.id}
                    job={job}
                    onClick={onOpenJobConversation}
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
