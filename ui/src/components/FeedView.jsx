import { useEffect, useMemo, useRef, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { AnimatePresence, motion } from 'framer-motion'

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

function getElapsedShort(dateStr) {
  if (!dateStr) return null
  const date = new Date(dateStr)
  if (Number.isNaN(date.getTime())) return null
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h`
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

function ChevronIcon() {
  return (
    <svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M3 1.5L6.5 5L3 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function SkeletonRows({ count = 3 }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton-row" style={{ opacity: 1 - i * 0.2 }} />
      ))}
    </>
  )
}

function SectionLabel({ children, count, badge, actionLabel, onAction, collapsible, collapsed, onToggleCollapse }) {
  return (
    <div className="section-label">
      {collapsible && (
        <button
          className={`section-collapse-btn${collapsed ? ' collapsed' : ''}`}
          onClick={onToggleCollapse}
          aria-label={collapsed ? 'Expand section' : 'Collapse section'}
        >
          <ChevronIcon />
        </button>
      )}
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

function NeedsYouCard({ task, onClick, onPickTaskRecipient, recipientAgents, pickerTaskId, setPickerTaskId, followupForTaskId, setFollowupForTaskId, onAddFollowup, chainIndex, chainLength, isLast, agentById }) {
  const status = String(task.status).toLowerCase()
  const color = getStatusColor(status)
  const [hovered, setHovered] = useState(false)
  const isRecipientPick = status === 'waiting_for_recipient'
  const isUrgent = status === 'waiting_for_help_response'
  const agent = task.assigned_to && agentById ? agentById[task.assigned_to] : null
  const waitingTime = getElapsedShort(task.created_at)

  return (
    <div
      className="needs-you-card-wrap"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <FollowupChainNumber chainIndex={chainIndex} chainLength={chainLength} isLast={isLast} />
      <div
        className={`needs-you-card${isUrgent ? ' urgent' : ''}`}
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
            <div style={{ fontSize: 11, color: '#B4B3AF', marginTop: 4 }}>
              Assigned to {agent ? `${agent.emoji || ''} ${agent.name}` : task.assigned_to}
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
          {waitingTime && (
            <span style={{ fontSize: 10.5, color: '#B4B3AF', whiteSpace: 'nowrap' }}>{waitingTime}</span>
          )}
          {isRecipientPick ? (
            <div className="task-recipient-wrap">
              <button
                className="needs-you-action"
                style={{ background: color }}
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
              style={{ background: color }}
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
    </div>
  )
}

function ActiveTaskRow({ task, onClick, followupForTaskId, setFollowupForTaskId, onAddFollowup, chainIndex, chainLength, isLast, agentById }) {
  const status = String(task.status).toLowerCase()
  const color = getStatusColor(status)
  const [hovered, setHovered] = useState(false)
  const agent = task.assigned_to && agentById ? agentById[task.assigned_to] : null
  const elapsed = getElapsedShort(task.created_at)
  const isPlan = task._isPlan

  return (
    <div
      className="active-task-row-wrap"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <FollowupChainNumber chainIndex={chainIndex} chainLength={chainLength} isLast={isLast} />
      <div className="task-row" onClick={() => isPlan ? onClick?.(task._planId) : onClick?.(task)}>
        <div className="task-dot">
          <div className="task-dot-inner" style={{ background: color }} />
          {status === 'running' && (
            <div className="task-dot-pulse" style={{ border: `1.5px solid ${color}` }} />
          )}
        </div>
        <span className="task-title active">
          {isPlan ? (task.title || 'New plan') : normalizeTaskTitle(task.title)}
        </span>
        <div className="task-meta-right">
          {hovered && onAddFollowup && !isPlan && (
            <FollowupButton
              task={task}
              onClickAdd={(id) => setFollowupForTaskId?.((c) => c === id ? '' : id)}
            />
          )}
          {elapsed && status === 'running' && (
            <span className="task-elapsed">{elapsed}</span>
          )}
          <span className="type-tag" style={{ color, background: `${color}12` }}>
            {STATUS_LABELS[status]}
          </span>
          {agent ? (
            <span style={{ fontSize: 11, color: '#B4B3AF' }}>{agent.emoji || ''} {agent.name || task.assigned_to}</span>
          ) : task.assigned_to ? (
            <span style={{ fontSize: 11, color: '#B4B3AF' }}>{task.assigned_to}</span>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function DoneTaskRow({ task, onClick }) {
  const status = String(task.status).toLowerCase()
  const color = status === 'failed' ? '#EB5757' : status === 'cancelled' ? '#9B9A97' : '#2FA67E'
  const icon = status === 'failed' ? '\u2715' : status === 'cancelled' ? '\u2014' : '\u2713'
  const titleClass = status === 'failed' ? 'failed' : 'done'
  const completedAt = task.completed_at || task.created_at

  return (
    <div className="task-row" onClick={() => onClick?.(task)}>
      <div className="task-done-check" style={{ background: `${color}20`, color }}>
        {icon}
      </div>
      <span className={`task-title ${titleClass}`}>
        {normalizeTaskTitle(task.title)}
      </span>
      <span className="task-time">{getTimeAgo(completedAt)}</span>
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
          <span style={{ fontSize: 11, color: '#B4B3AF' }}>{getTimeAgo(plan.created_at)}</span>
        )}
        <button
          className="needs-you-action"
          style={{ background: color }}
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

export function FeedView({
  tasks,
  loading,
  error,
  recipientAgents = [],
  agentById = {},
  plans = [],
  onOpenPlan,
  onOpenTaskConversation,
  onPickTaskRecipient,
  onAddFollowup,
  followupForTaskId = '',
  setFollowupForTaskId,
}) {
  const DONE_DISPLAY_LIMIT = 5
  const [pickerTaskId, setPickerTaskId] = useState('')
  const [showAllDone, setShowAllDone] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState({})

  const toggleSection = (section) => {
    setCollapsedSections((prev) => ({ ...prev, [section]: !prev[section] }))
  }

  const recipients = useMemo(() => {
    if (!Array.isArray(recipientAgents)) {
      return []
    }
    return recipientAgents.filter((agent) => agent && typeof agent.id === 'string')
  }, [recipientAgents])

  // Track whether this is the initial render to skip enter animations on first load
  const isInitialRender = useRef(true)
  useEffect(() => {
    // Mark initial render done after first task data arrives
    if (tasks.length > 0 && isInitialRender.current) {
      // Use requestAnimationFrame to let the first paint happen without animations
      requestAnimationFrame(() => { isInitialRender.current = false })
    }
  }, [tasks])

  // On initial render, `initial` is `false` (framer-motion skips the enter animation).
  // After initial render, new tasks get the slide-in animation.
  const taskInitial = isInitialRender.current ? false : { opacity: 0, y: -8 }
  const taskAnimate = { opacity: 1, y: 0 }
  const taskExit = { opacity: 0, y: -6 }
  const taskTransition = { duration: 0.25, ease: [0.22, 1, 0.36, 1] }
  const layoutTransition = { duration: 0.2, ease: [0.22, 1, 0.36, 1] }

  const { readyPlans, remainingPlans } = useMemo(() => {
    const readyPlans = []
    const remainingPlans = []
    for (const plan of plans) {
      if (plan.has_completed_plan_turn && plan.latest_turn_status !== 'running'
          && plan.task_status !== 'waiting_for_question_response'
          && plan.task_status !== 'waiting_for_help_response') {
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
      {loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}>
          <SkeletonRows count={4} />
        </div>
      )}
      {error && <div className="error">Error: {error}</div>}

      {!loading && !error && (
        <>
          <SectionLabel
            count={needsYou.length}
            badge
            collapsible
            collapsed={collapsedSections.needsYou}
            onToggleCollapse={() => toggleSection('needsYou')}
          >Needs you</SectionLabel>
          {!collapsedSections.needsYou && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <AnimatePresence mode="popLayout">
                {orderedNeedsYou.map(({ task, chainIndex, chainLength, isFollowup, isLast }) => (
                  <motion.div
                    key={task.id}
                    layout
                    initial={taskInitial}
                    animate={taskAnimate}
                    exit={taskExit}
                    transition={taskTransition}
                    layoutTransition={layoutTransition}
                    className={isFollowup ? 'followup-item' : undefined}
                  >
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
                      agentById={agentById}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
              {needsYou.length === 0 && (
                <div className="muted">You're all caught up</div>
              )}
            </div>
          )}

          <SectionLabel
            count={plans.length}
            collapsible
            collapsed={collapsedSections.planning}
            onToggleCollapse={() => toggleSection('planning')}
          >Planning</SectionLabel>
          {!collapsedSections.planning && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <AnimatePresence mode="popLayout">
                {readyPlans.map((plan) => (
                  <motion.div
                    key={plan.id}
                    layout
                    initial={taskInitial}
                    animate={taskAnimate}
                    exit={taskExit}
                    transition={taskTransition}
                    layoutTransition={layoutTransition}
                  >
                    <NeedsYouPlanCard
                      plan={plan}
                      onClick={onOpenPlan}
                    />
                  </motion.div>
                ))}
                {remainingPlans.map((plan) => (
                  <motion.div
                    key={`plan-remaining-${plan.id}`}
                    layout
                    initial={taskInitial}
                    animate={taskAnimate}
                    exit={taskExit}
                    transition={taskTransition}
                    layoutTransition={layoutTransition}
                  >
                    <ActiveTaskRow
                      task={{
                        id: `plan-${plan.id}`,
                        title: plan.plan_title || 'New plan',
                        status: plan.latest_turn_status === 'running' ? 'running' : 'planning',
                        created_at: plan.created_at,
                        assigned_to: null,
                        _isPlan: true,
                        _planId: plan.id,
                      }}
                      onClick={onOpenPlan}
                      chainIndex={0}
                      chainLength={1}
                      isLast={true}
                      agentById={agentById}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
              {plans.length === 0 && (
                <div className="muted">No plans in progress</div>
              )}
            </div>
          )}

          <SectionLabel
            count={active.length}
            collapsible
            collapsed={collapsedSections.inProgress}
            onToggleCollapse={() => toggleSection('inProgress')}
          >In progress</SectionLabel>
          {!collapsedSections.inProgress && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <AnimatePresence mode="popLayout">
                {orderedActive.map(({ task, chainIndex, chainLength, isFollowup, isLast }) => (
                  <motion.div
                    key={task.id}
                    layout
                    initial={taskInitial}
                    animate={taskAnimate}
                    exit={taskExit}
                    transition={taskTransition}
                    layoutTransition={layoutTransition}
                    className={isFollowup ? 'followup-item' : undefined}
                  >
                    <ActiveTaskRow
                      task={task}
                      onClick={onOpenTaskConversation}
                      followupForTaskId={followupForTaskId}
                      setFollowupForTaskId={setFollowupForTaskId}
                      onAddFollowup={onAddFollowup}
                      chainIndex={chainIndex}
                      chainLength={chainLength}
                      isLast={isLast}
                      agentById={agentById}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
              {active.length === 0 && (
                <div className="muted">No active tasks</div>
              )}
            </div>
          )}

          <SectionLabel
            count={done.length}
            actionLabel={done.length > DONE_DISPLAY_LIMIT ? (showAllDone ? 'Show less' : 'View all') : undefined}
            onAction={() => setShowAllDone((v) => !v)}
            collapsible
            collapsed={collapsedSections.done}
            onToggleCollapse={() => toggleSection('done')}
          >Done</SectionLabel>
          {!collapsedSections.done && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <AnimatePresence mode="popLayout">
                {(showAllDone ? done : done.slice(0, DONE_DISPLAY_LIMIT)).map((task) => (
                  <motion.div
                    key={task.id}
                    layout
                    initial={taskInitial}
                    animate={taskAnimate}
                    exit={taskExit}
                    transition={taskTransition}
                    layoutTransition={layoutTransition}
                  >
                    <DoneTaskRow
                      task={task}
                      onClick={onOpenTaskConversation}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
              {done.length === 0 && (
                <div className="muted">Completed tasks will appear here</div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
