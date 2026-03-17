import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  planning: '#8A72D8',
  planned: '#9B6DD7',
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
  planning: 'Planning',
  planned: 'Planned',
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
  return status === 'running' || status === 'queued' || status === 'planning'
}

function isDone(status) {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function isPlanTaskStatus(status) {
  return status === 'planning' || status === 'planned'
}

function SectionLabel({ children, count, badge, actionLabel, onAction }) {
  return (
    <div className="section-label">
      <span className="section-label-text">{children}</span>
      {count > 0 && (
        <span className={`section-count${badge ? ' badge' : ''}`}>{count}</span>
      )}
      {actionLabel && (
        <button className="section-label-action" onClick={onAction}>{actionLabel}</button>
      )}
    </div>
  )
}

function FollowupButton({ task, onClickAdd }) {
  if (task.followup_task_id) {
    return null
  }
  return (
    <button
      className="followup-add-btn"
      title="Add follow-up task"
      onClick={(e) => {
        e.stopPropagation()
        onClickAdd?.(task.id)
      }}
    >
      +
    </button>
  )
}

function FollowupPopover({ taskId, onSubmit, onCancel }) {
  const [prompt, setPrompt] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSubmit = () => {
    const text = prompt.trim()
    if (!text) return
    onSubmit(taskId, text)
  }

  return (
    <div className="followup-popover" onClick={(e) => e.stopPropagation()}>
      <div className="followup-popover-header">Follow-up task</div>
      <textarea
        ref={inputRef}
        className="followup-popover-input"
        placeholder="Describe the follow-up task..."
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            handleSubmit()
          }
          if (e.key === 'Escape') {
            onCancel()
          }
        }}
        rows={2}
      />
      <div className="followup-popover-actions">
        <button className="followup-popover-cancel" onClick={onCancel}>Cancel</button>
        <button
          className="followup-popover-submit"
          onClick={handleSubmit}
          disabled={!prompt.trim()}
        >
          Create
        </button>
      </div>
    </div>
  )
}

/**
 * Sort tasks so follow-ups appear directly after their predecessor.
 * Returns an array of { task, chainIndex, chainLength, isFollowup } objects.
 * chainIndex: 1-based position in the chain (1 = root, 2 = first follow-up, etc.)
 * chainLength: total tasks in this chain
 * isFollowup: true if this task has a predecessor
 */
function orderWithFollowupChains(taskList) {
  const byId = new Map()
  for (const t of taskList) byId.set(t.id, t)

  // Find chain roots: tasks that have no predecessor OR whose predecessor is not in this list
  const roots = []
  const visited = new Set()

  for (const t of taskList) {
    if (!t.predecessor_task_id || !byId.has(t.predecessor_task_id)) {
      roots.push(t)
    }
  }

  const result = []

  for (const root of roots) {
    // Walk the chain: root -> followup -> followup -> ...
    const chain = []
    let current = root
    while (current && !visited.has(current.id)) {
      visited.add(current.id)
      chain.push(current)
      current = current.followup_task_id ? byId.get(current.followup_task_id) : null
    }

    const chainLength = chain.length
    for (let i = 0; i < chain.length; i++) {
      result.push({
        task: chain[i],
        chainIndex: chainLength > 1 ? i + 1 : 0, // 0 means not part of a chain
        chainLength,
        isFollowup: i > 0,
        isLast: i === chain.length - 1,
      })
    }
  }

  // Add any tasks that weren't part of any chain (orphans)
  for (const t of taskList) {
    if (!visited.has(t.id)) {
      result.push({ task: t, chainIndex: 0, chainLength: 1, isFollowup: false, isLast: true })
    }
  }

  return result
}

function FollowupChainNumber({ chainIndex, chainLength, isLast }) {
  if (chainIndex === 0) return null
  return (
    <div className={`followup-chain-number-wrap${isLast ? '' : ' has-line'}`}>
      <span className="followup-chain-number">{chainIndex}</span>
    </div>
  )
}

function NeedsYouCard({ task, onClick, onPickTaskRecipient, recipientAgents, pickerTaskId, setPickerTaskId, followupForTaskId, setFollowupForTaskId, onAddFollowup, chainIndex, chainLength, isLast }) {
  const status = String(task.status).toLowerCase()
  const color = getStatusColor(status)
  const [hovered, setHovered] = useState(false)
  const isRecipientPick = status === 'waiting_for_recipient'

  return (
    <div
      className="needs-you-card-wrap"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <FollowupChainNumber chainIndex={chainIndex} chainLength={chainLength} isLast={isLast} />
      <div
        className="needs-you-card"
        style={{ '--accent': color }}
        onClick={() => !isRecipientPick && onClick?.(task)}
      >
        <div style={{ flex: 1, minWidth: 0, cursor: isRecipientPick ? 'default' : 'pointer' }}>
          <div className="needs-you-title">
            {normalizeTaskTitle(task.title)}
          </div>
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
          {hovered && onAddFollowup && (
            <FollowupButton
              task={task}
              onClickAdd={(id) => setFollowupForTaskId?.((c) => c === id ? '' : id)}
            />
          )}
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
      {followupForTaskId === task.id && (
        <FollowupPopover
          taskId={task.id}
          onSubmit={(id, prompt) => {
            onAddFollowup?.(id, prompt)
            setFollowupForTaskId?.('')
          }}
          onCancel={() => setFollowupForTaskId?.('')}
        />
      )}
    </div>
  )
}

function ActiveTaskRow({ task, onClick, followupForTaskId, setFollowupForTaskId, onAddFollowup, chainIndex, chainLength, isLast }) {
  const status = String(task.status).toLowerCase()
  const color = getStatusColor(status)
  const [hovered, setHovered] = useState(false)

  return (
    <div
      className="active-task-row-wrap"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <FollowupChainNumber chainIndex={chainIndex} chainLength={chainLength} isLast={isLast} />
      <div className="task-row" onClick={() => onClick?.(task)}>
        <div className="task-dot">
          <div className="task-dot-inner" style={{ background: color }} />
          {status === 'running' && (
            <div className="task-dot-pulse" style={{ border: `1.5px solid ${color}` }} />
          )}
        </div>
        <span className="task-title active">
          {normalizeTaskTitle(task.title)}
        </span>
        <div className="task-meta-right">
          {hovered && onAddFollowup && (
            <FollowupButton
              task={task}
              onClickAdd={(id) => setFollowupForTaskId?.((c) => c === id ? '' : id)}
            />
          )}
          <span className="type-tag" style={{ color, background: `${color}12` }}>
            {STATUS_LABELS[status]}
          </span>
          {task.assigned_to && (
            <span style={{ fontSize: 11, color: '#C4C3BF' }}>{task.assigned_to}</span>
          )}
          <span className="task-time">{getTimeAgo(task.created_at)}</span>
        </div>
      </div>
      {followupForTaskId === task.id && (
        <FollowupPopover
          taskId={task.id}
          onSubmit={(id, prompt) => {
            onAddFollowup?.(id, prompt)
            setFollowupForTaskId?.('')
          }}
          onCancel={() => setFollowupForTaskId?.('')}
        />
      )}
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

function NeedsYouPlanCard({ plan, onClick }) {
  const color = '#9B6DD7'
  const [hovered, setHovered] = useState(false)

  return (
    <div
      className="needs-you-card"
      style={{ '--accent': color }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onClick?.(plan.id)}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="needs-you-title">{plan.plan_title || 'New plan'}</div>
        <div className="needs-you-subtitle">Plan ready for review</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {plan.created_at && (
          <span style={{ fontSize: 11, color: '#C4C3BF' }}>{getTimeAgo(plan.created_at)}</span>
        )}
        <button
          className="needs-you-action"
          style={{ background: color, opacity: hovered ? 1 : 0.88 }}
          onClick={(e) => {
            e.stopPropagation()
            onClick?.(plan.id)
          }}
        >
          Execute
        </button>
      </div>
    </div>
  )
}

function PlanRow({ plan, isActive, onClick }) {
  const isPlanning = plan.latest_turn_status === 'running'
  return (
    <div
      className={`plan-row ${isActive ? 'active' : ''}`}
      onClick={() => onClick?.(plan.id)}
    >
      <div className="plan-row-dot">
        <div className={`plan-row-dot-inner${isPlanning ? ' planning' : ''}`} />
      </div>
      <span className="plan-row-title">{plan.plan_title || 'New plan'}</span>
      {isPlanning ? (
        <span className="plan-row-preview" style={{ color: '#9B6DD7' }}>Planning…</span>
      ) : plan.plan_preview ? (
        <span className="plan-row-preview">{plan.plan_preview}</span>
      ) : null}
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
  onAddFollowup,
}) {
  const DONE_DISPLAY_LIMIT = 5
  const [pickerTaskId, setPickerTaskId] = useState('')
  const [showAllDone, setShowAllDone] = useState(false)
  const [followupForTaskId, setFollowupForTaskId] = useState('')

  const recipients = useMemo(() => {
    if (!Array.isArray(recipientAgents)) {
      return []
    }
    return recipientAgents.filter((agent) => agent && typeof agent.id === 'string')
  }, [recipientAgents])

  const prevTaskIdsRef = useRef(null)
  const [newTaskIds, setNewTaskIds] = useState(new Set())
  const prevCategoriesRef = useRef({})
  const [exitingTasks, setExitingTasks] = useState([])

  useEffect(() => {
    const currentIds = new Set(tasks.map((t) => t.id))
    if (prevTaskIdsRef.current !== null) {
      const added = new Set()
      for (const id of currentIds) {
        if (!prevTaskIdsRef.current.has(id)) {
          added.add(id)
        }
      }
      if (added.size > 0) {
        setNewTaskIds(added)
        const timer = setTimeout(() => setNewTaskIds(new Set()), 500)
        return () => clearTimeout(timer)
      }
    }
    prevTaskIdsRef.current = currentIds
  }, [tasks])

  useEffect(() => {
    if (newTaskIds.size > 0) {
      prevTaskIdsRef.current = new Set(tasks.map((t) => t.id))
    }
  }, [newTaskIds, tasks])

  useEffect(() => {
    const currentCategories = {}
    for (const task of tasks) {
      const status = String(task.status).toLowerCase()
      if (isPlanTaskStatus(status)) continue
      if (isNeedsYou(status)) currentCategories[task.id] = 'needsYou'
      else if (isDone(status)) currentCategories[task.id] = 'done'
      else currentCategories[task.id] = 'active'
    }

    const prev = prevCategoriesRef.current
    if (Object.keys(prev).length > 0) {
      const moving = []
      for (const [id, oldCat] of Object.entries(prev)) {
        const newCat = currentCategories[id]
        if (newCat && newCat !== oldCat) {
          const task = tasks.find((t) => t.id === id)
          if (task) moving.push({ ...task, _fromCategory: oldCat })
        }
      }
      if (moving.length > 0) {
        setExitingTasks(moving)
        const timer = setTimeout(() => setExitingTasks([]), 220)
        return () => clearTimeout(timer)
      }
    }
    prevCategoriesRef.current = currentCategories
  }, [tasks])

  const { readyPlans, remainingPlans } = useMemo(() => {
    const readyPlans = []
    const remainingPlans = []
    for (const plan of plans) {
      if (plan.has_completed_plan_turn && plan.latest_turn_status !== 'running') {
        readyPlans.push(plan)
      } else {
        remainingPlans.push(plan)
      }
    }
    return { readyPlans, remainingPlans }
  }, [plans])

  const { needsYou, active, done } = useMemo(() => {
    const needsYou = []
    const active = []
    const done = []

    for (const task of tasks) {
      const status = String(task.status).toLowerCase()
      if (isPlanTaskStatus(status)) {
        continue
      } else if (isNeedsYou(status)) {
        needsYou.push(task)
      } else if (isDone(status)) {
        done.push(task)
      } else {
        active.push(task)
      }
    }

    done.sort((a, b) => {
      const aTime = a.completed_at ? new Date(a.completed_at).getTime() : 0
      const bTime = b.completed_at ? new Date(b.completed_at).getTime() : 0
      return bTime - aTime
    })

    return { needsYou, active, done }
  }, [tasks])

  const orderedNeedsYou = useMemo(() => orderWithFollowupChains(needsYou), [needsYou])
  const orderedActive = useMemo(() => orderWithFollowupChains(active), [active])

  return (
    <section className="feed">
      {loading && <div className="muted">Loading tasks...</div>}
      {error && <div className="error">Error: {error}</div>}

      {!loading && !error && (
        <>
          <SectionLabel count={remainingPlans.length}>Plans</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {plansLoading ? (
              <div className="muted">Loading plans...</div>
            ) : remainingPlans.length > 0 ? (
              remainingPlans.map((plan) => (
                <PlanRow
                  key={plan.id}
                  plan={plan}
                  isActive={activePlanThreadId === plan.id}
                  onClick={onOpenPlan}
                />
              ))
            ) : (
              <div className="muted">No tasks yet.</div>
            )}
          </div>

          <SectionLabel count={needsYou.length + readyPlans.length} badge>Needs you</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {readyPlans.map((plan) => (
              <NeedsYouPlanCard
                key={plan.id}
                plan={plan}
                onClick={onOpenPlan}
              />
            ))}
            {exitingTasks.filter((t) => t._fromCategory === 'needsYou').map((task) => (
              <div key={`exit-${task.id}`} className="task-exit">
                <NeedsYouCard
                  task={task}
                  onClick={onOpenTaskConversation}
                  onPickTaskRecipient={onPickTaskRecipient}
                  recipientAgents={recipients}
                  pickerTaskId={pickerTaskId}
                  setPickerTaskId={setPickerTaskId}
                  followupForTaskId={followupForTaskId}
                  setFollowupForTaskId={setFollowupForTaskId}
                  onAddFollowup={onAddFollowup}
                />
              </div>
            ))}
            {orderedNeedsYou.map(({ task, chainIndex, chainLength, isFollowup, isLast }) => (
              <div key={task.id} className={`${newTaskIds.has(task.id) ? 'task-enter' : ''}${isFollowup ? ' followup-item' : ''}`}>
                <NeedsYouCard
                  task={task}
                  onClick={onOpenTaskConversation}
                  onPickTaskRecipient={onPickTaskRecipient}
                  recipientAgents={recipients}
                  pickerTaskId={pickerTaskId}
                  setPickerTaskId={setPickerTaskId}
                  followupForTaskId={followupForTaskId}
                  setFollowupForTaskId={setFollowupForTaskId}
                  onAddFollowup={onAddFollowup}
                  chainIndex={chainIndex}
                  chainLength={chainLength}
                  isLast={isLast}
                />
              </div>
            ))}
            {needsYou.length + readyPlans.length === 0 && exitingTasks.filter((t) => t._fromCategory === 'needsYou').length === 0 && (
              <div className="muted">No tasks yet.</div>
            )}
          </div>

          <SectionLabel count={active.length}>Working on</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {exitingTasks.filter((t) => t._fromCategory === 'active').map((task) => (
              <div key={`exit-${task.id}`} className="task-exit">
                <ActiveTaskRow task={task} onClick={onOpenTaskConversation} followupForTaskId={followupForTaskId} setFollowupForTaskId={setFollowupForTaskId} onAddFollowup={onAddFollowup} />
              </div>
            ))}
            {orderedActive.length > 0 ? (
              orderedActive.map(({ task, chainIndex, chainLength, isFollowup, isLast }) => (
                <div key={task.id} className={`${newTaskIds.has(task.id) ? 'task-enter' : ''}${isFollowup ? ' followup-item' : ''}`}>
                  <ActiveTaskRow
                    task={task}
                    onClick={onOpenTaskConversation}
                    followupForTaskId={followupForTaskId}
                    setFollowupForTaskId={setFollowupForTaskId}
                    onAddFollowup={onAddFollowup}
                    chainIndex={chainIndex}
                    chainLength={chainLength}
                    isLast={isLast}
                  />
                </div>
              ))
            ) : exitingTasks.filter((t) => t._fromCategory === 'active').length === 0 ? (
              <div className="muted">No tasks yet.</div>
            ) : null}
          </div>

          <SectionLabel
            count={done.length}
            actionLabel={done.length > DONE_DISPLAY_LIMIT ? (showAllDone ? 'Show less' : 'View all') : undefined}
            onAction={() => setShowAllDone((v) => !v)}
          >Done</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {exitingTasks.filter((t) => t._fromCategory === 'done').map((task) => (
              <div key={`exit-${task.id}`} className="task-exit">
                <DoneTaskRow task={task} onClick={onOpenTaskConversation} />
              </div>
            ))}
            {done.length > 0 ? (
              (showAllDone ? done : done.slice(0, DONE_DISPLAY_LIMIT)).map((task) => (
                <div key={task.id} className={newTaskIds.has(task.id) ? 'task-enter' : undefined}>
                  <DoneTaskRow
                    task={task}
                    onClick={onOpenTaskConversation}
                  />
                </div>
              ))
            ) : exitingTasks.filter((t) => t._fromCategory === 'done').length === 0 ? (
              <div className="muted">No tasks yet.</div>
            ) : null}
          </div>
        </>
      )}
    </section>
  )
}
