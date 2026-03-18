import { useState } from 'react'
import { ChevronUp, ChevronDown, Trash2, Plus, ChevronRight } from 'lucide-react'

export function PlanProposalPanel({
  proposal,
  agents = [],
  onUpdate,
  disabled = false,
}) {
  const tasks = Array.isArray(proposal?.tasks) ? proposal.tasks : []

  function updateTask(index, field, value) {
    const next = tasks.map((t, i) =>
      i === index ? { ...t, [field]: value } : t,
    )
    onUpdate?.({ tasks: next })
  }

  function removeTask(index) {
    if (tasks.length <= 1) return
    const next = tasks.filter((_, i) => i !== index)
    onUpdate?.({ tasks: next })
  }

  function moveTask(index, direction) {
    const targetIndex = index + direction
    if (targetIndex < 0 || targetIndex >= tasks.length) return
    const next = [...tasks]
    const temp = next[index]
    next[index] = next[targetIndex]
    next[targetIndex] = temp
    onUpdate?.({ tasks: next })
  }

  function addTask() {
    const next = [
      ...tasks,
      { title: '', prompt: '', recipient: agents[0]?.id || '' },
    ]
    onUpdate?.({ tasks: next })
  }

  if (tasks.length === 0) {
    return (
      <div className="plan-proposal-panel">
        <div className="plan-proposal-empty">No proposal submitted yet.</div>
      </div>
    )
  }

  return (
    <div className="plan-proposal-panel">
      <div className="plan-proposal-header">
        <span className="plan-proposal-title">Task Chain</span>
        <span className="plan-proposal-count">{tasks.length} task{tasks.length !== 1 ? 's' : ''}</span>
      </div>
      <div className="plan-proposal-tasks">
        {tasks.map((task, index) => (
          <PlanProposalTask
            key={index}
            task={task}
            index={index}
            total={tasks.length}
            agents={agents}
            disabled={disabled}
            onUpdate={(field, value) => updateTask(index, field, value)}
            onRemove={() => removeTask(index)}
            onMoveUp={() => moveTask(index, -1)}
            onMoveDown={() => moveTask(index, 1)}
            isLast={index === tasks.length - 1}
          />
        ))}
      </div>
      <button
        className="plan-proposal-add-btn"
        onClick={addTask}
        disabled={disabled}
      >
        <Plus size={14} />
      </button>
    </div>
  )
}

function PlanProposalTask({
  task,
  index,
  total,
  agents,
  disabled,
  onUpdate,
  onRemove,
  onMoveUp,
  onMoveDown,
  isLast,
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="plan-task-item">
      <div className={`plan-task-chain-line-wrap${isLast ? '' : ' has-line'}`}>
        <span className="plan-task-chain-number">{index + 1}</span>
      </div>
      <div className="plan-task-content">
        <div className="plan-task-row" onClick={() => setExpanded((v) => !v)}>
          <ChevronRight
            size={12}
            className={`plan-task-expand-icon${expanded ? ' expanded' : ''}`}
          />
          <input
            className="plan-task-title-input"
            type="text"
            value={task.title || ''}
            onChange={(e) => onUpdate('title', e.target.value)}
            onClick={(e) => e.stopPropagation()}
            placeholder="Task title..."
            disabled={disabled}
          />
          <div className="plan-task-right">
            <select
              className="plan-task-recipient-select"
              value={task.recipient || ''}
              onChange={(e) => onUpdate('recipient', e.target.value)}
              onClick={(e) => e.stopPropagation()}
              disabled={disabled}
            >
              <option value="">Assign...</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name || agent.id}
                </option>
              ))}
            </select>
            <div className="plan-task-actions">
              <button
                className="plan-task-action-btn"
                onClick={(e) => { e.stopPropagation(); onMoveUp() }}
                disabled={disabled || index === 0}
                title="Move up"
              >
                <ChevronUp size={13} />
              </button>
              <button
                className="plan-task-action-btn"
                onClick={(e) => { e.stopPropagation(); onMoveDown() }}
                disabled={disabled || index === total - 1}
                title="Move down"
              >
                <ChevronDown size={13} />
              </button>
              <button
                className="plan-task-action-btn plan-task-delete-btn"
                onClick={(e) => { e.stopPropagation(); onRemove() }}
                disabled={disabled || total <= 1}
                title="Remove task"
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        </div>
        {expanded && (
          <div className="plan-task-prompt-section">
            <textarea
              className="plan-task-prompt-textarea"
              value={task.prompt || ''}
              onChange={(e) => onUpdate('prompt', e.target.value)}
              placeholder="Implementation instructions..."
              disabled={disabled}
              rows={4}
            />
          </div>
        )}
      </div>
    </div>
  )
}
