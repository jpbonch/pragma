import { useState } from 'react'
import { ChevronUp, ChevronDown, Trash2, Plus, ArrowDown } from 'lucide-react'

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
          />
        ))}
      </div>
      <button
        className="plan-proposal-add-btn"
        onClick={addTask}
        disabled={disabled}
      >
        <Plus size={14} />
        <span>Add Task</span>
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
}) {
  const [promptExpanded, setPromptExpanded] = useState(false)

  return (
    <div className="plan-proposal-task">
      {index > 0 && (
        <div className="plan-proposal-connector">
          <ArrowDown size={14} strokeWidth={2} />
        </div>
      )}
      <div className="plan-proposal-task-card">
        <div className="plan-proposal-task-header">
          <span className="plan-proposal-task-number">{index + 1}</span>
          <input
            className="plan-proposal-task-title-input"
            type="text"
            value={task.title || ''}
            onChange={(e) => onUpdate('title', e.target.value)}
            placeholder="Task title..."
            disabled={disabled}
          />
          <div className="plan-proposal-task-actions">
            <button
              className="plan-proposal-task-action-btn"
              onClick={onMoveUp}
              disabled={disabled || index === 0}
              title="Move up"
            >
              <ChevronUp size={14} />
            </button>
            <button
              className="plan-proposal-task-action-btn"
              onClick={onMoveDown}
              disabled={disabled || index === total - 1}
              title="Move down"
            >
              <ChevronDown size={14} />
            </button>
            <button
              className="plan-proposal-task-action-btn plan-proposal-task-delete-btn"
              onClick={onRemove}
              disabled={disabled || total <= 1}
              title="Remove task"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>

        <div className="plan-proposal-task-field">
          <label className="plan-proposal-task-label">Recipient</label>
          <select
            className="plan-proposal-task-select"
            value={task.recipient || ''}
            onChange={(e) => onUpdate('recipient', e.target.value)}
            disabled={disabled}
          >
            <option value="">Select agent...</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name || agent.id}
              </option>
            ))}
          </select>
        </div>

        <div className="plan-proposal-task-field">
          <button
            className="plan-proposal-prompt-toggle"
            onClick={() => setPromptExpanded((v) => !v)}
          >
            <span className="plan-proposal-task-label">Prompt</span>
            <ChevronDown
              size={12}
              className={`plan-proposal-prompt-chevron${promptExpanded ? ' expanded' : ''}`}
            />
          </button>
          {promptExpanded && (
            <textarea
              className="plan-proposal-task-textarea"
              value={task.prompt || ''}
              onChange={(e) => onUpdate('prompt', e.target.value)}
              placeholder="Implementation instructions..."
              disabled={disabled}
              rows={6}
            />
          )}
        </div>
      </div>
    </div>
  )
}
