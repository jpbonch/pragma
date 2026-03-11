import { useEffect, useState } from 'react'
import { iconForAgent } from '../lib/agentIcon'

const AGENT_COLORS = ['#4B83D6', '#2383e2', '#E09B3D', '#7C6DD7', '#E06B5E', '#9B6DD7']
const HARNESSES = [
  { id: 'claude_code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
]

const MODELS_BY_HARNESS = {
  claude_code: ['Opus 4.6', 'Sonnet 4.6', 'Haiku 4.5'],
  codex: ['GPT-5', 'GPT-5.3-Codex'],
}

function getAgentColor(index) {
  return AGENT_COLORS[index % AGENT_COLORS.length]
}

function AddAgentModal({ open, loading, error, onClose, onSubmit }) {
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('🤖')
  const [agentFile, setAgentFile] = useState('')
  const [harness, setHarness] = useState('claude_code')
  const [modelLabel, setModelLabel] = useState('Opus 4.6')

  useEffect(() => {
    if (!open) {
      return
    }
    setName('')
    setEmoji('🤖')
    setAgentFile('')
    setHarness('claude_code')
    setModelLabel('Opus 4.6')
  }, [open])

  useEffect(() => {
    const options = MODELS_BY_HARNESS[harness] || []
    if (!options.includes(modelLabel)) {
      setModelLabel(options[0] || '')
    }
  }, [harness, modelLabel])

  if (!open) {
    return null
  }

  return (
    <div className="modal-backdrop">
      <div className="modal-card">
        <h2>Add agent</h2>
        <p>Create a new agent record in this workspace.</p>

        <label className="modal-label">Name</label>
        <input
          className="modal-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Research Agent"
        />

        <label className="modal-label">Emoji</label>
        <input
          className="modal-input"
          value={emoji}
          onChange={(e) => setEmoji(e.target.value)}
          placeholder="🤖"
        />

        <label className="modal-label">Agent file (markdown)</label>
        <textarea
          className="modal-textarea"
          value={agentFile}
          onChange={(e) => setAgentFile(e.target.value)}
          rows={6}
          placeholder="# Agent\n\nInstructions..."
        />

        <label className="modal-label">Harness</label>
        <select className="modal-input" value={harness} onChange={(e) => setHarness(e.target.value)}>
          {HARNESSES.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>

        <label className="modal-label">Model</label>
        <select
          className="modal-input"
          value={modelLabel}
          onChange={(e) => setModelLabel(e.target.value)}
        >
          {(MODELS_BY_HARNESS[harness] || []).map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>

        {error && <div className="error">Error: {error}</div>}

        <div className="modal-actions">
          <button className="modal-cancel" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            className="modal-create"
            onClick={() =>
              onSubmit({ name, emoji, agent_file: agentFile, harness, model_label: modelLabel })
            }
            disabled={loading}
          >
            {loading ? 'Creating...' : 'Create agent'}
          </button>
        </div>
      </div>
    </div>
  )
}

function EditAgentModal({ open, loading, error, agent, onClose, onSubmit }) {
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('🤖')
  const [agentFile, setAgentFile] = useState('')
  const [harness, setHarness] = useState('claude_code')
  const [modelLabel, setModelLabel] = useState('Opus 4.6')

  useEffect(() => {
    if (!open || !agent) {
      return
    }

    setName(agent.name ?? '')
    setEmoji(agent.emoji ?? '🤖')
    setAgentFile(agent.agent_file ?? '')
    setHarness(agent.harness ?? 'claude_code')
    setModelLabel(agent.model_label ?? 'Opus 4.6')
  }, [open, agent])

  useEffect(() => {
    const options = MODELS_BY_HARNESS[harness] || []
    if (!options.includes(modelLabel)) {
      setModelLabel(options[0] || '')
    }
  }, [harness, modelLabel])

  if (!open || !agent) {
    return null
  }

  return (
    <div className="modal-backdrop">
      <div className="modal-card">
        <h2>Edit agent</h2>
        <p>{agent.id}</p>

        <label className="modal-label">Name</label>
        <input
          className="modal-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Agent name"
        />

        <label className="modal-label">Emoji</label>
        <input
          className="modal-input"
          value={emoji}
          onChange={(e) => setEmoji(e.target.value)}
          placeholder="🤖"
        />

        <label className="modal-label">Agent file (markdown)</label>
        <textarea
          className="modal-textarea"
          value={agentFile}
          onChange={(e) => setAgentFile(e.target.value)}
          rows={6}
        />

        <label className="modal-label">Harness</label>
        <select className="modal-input" value={harness} onChange={(e) => setHarness(e.target.value)}>
          {HARNESSES.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>

        <label className="modal-label">Model</label>
        <select
          className="modal-input"
          value={modelLabel}
          onChange={(e) => setModelLabel(e.target.value)}
        >
          {(MODELS_BY_HARNESS[harness] || []).map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>

        {error && <div className="error">Error: {error}</div>}

        <div className="modal-actions">
          <button className="modal-cancel" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            className="modal-create"
            onClick={() =>
              onSubmit({ name, emoji, agent_file: agentFile, harness, model_label: modelLabel })
            }
            disabled={loading}
          >
            {loading ? 'Saving...' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function RightPanel({ agents, loading, error, onCreateAgent, onUpdateAgent }) {
  const [isAddOpen, setIsAddOpen] = useState(false)
  const [createError, setCreateError] = useState('')
  const [createLoading, setCreateLoading] = useState(false)

  const [editingAgent, setEditingAgent] = useState(null)
  const [editError, setEditError] = useState('')
  const [editLoading, setEditLoading] = useState(false)

  async function handleSubmitCreate(agent) {
    setCreateError('')

    if (!agent.name?.trim()) {
      setCreateError('Name is required.')
      return
    }

    setCreateLoading(true)
    try {
      await onCreateAgent({
        name: agent.name.trim(),
        emoji: (agent.emoji || '🤖').trim(),
        agent_file: agent.agent_file ?? '',
        harness: agent.harness,
        model_label: agent.model_label,
      })
      setIsAddOpen(false)
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreateLoading(false)
    }
  }

  async function handleSubmitEdit(updates) {
    if (!editingAgent) {
      return
    }

    setEditError('')

    if (!updates.name?.trim()) {
      setEditError('Name is required.')
      return
    }
    if (!updates.emoji?.trim()) {
      setEditError('Emoji is required.')
      return
    }
    if (!updates.harness) {
      setEditError('Harness is required.')
      return
    }
    if (!updates.model_label?.trim()) {
      setEditError('Model is required.')
      return
    }

    setEditLoading(true)
    try {
      await onUpdateAgent(editingAgent.id, {
        name: updates.name.trim(),
        emoji: updates.emoji.trim(),
        agent_file: updates.agent_file ?? '',
        harness: updates.harness,
        model_label: updates.model_label.trim(),
      })
      setEditingAgent(null)
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err))
    } finally {
      setEditLoading(false)
    }
  }

  return (
    <aside className="right-panel">
      <div className="right-section-title">Humans</div>
      <div className="person-card">
        <div className="person-avatar-wrap">
          <div className="person-avatar" style={{ background: '#2383e215' }}>
            <span>🌿</span>
          </div>
          <div className="online-dot" />
        </div>
        <div>
          <div className="person-name">You</div>
          <div className="person-role">Owner</div>
        </div>
      </div>

      <div className="right-section-title" style={{ paddingTop: 20 }}>Agents</div>

      {loading && <div className="muted">Loading agents...</div>}
      {error && <div className="error">Error: {error}</div>}
      {!loading && !error && agents.length === 0 && (
        <div className="muted">No agents found.</div>
      )}

      {!loading &&
        !error &&
        agents.map((agent, i) => {
          const color = getAgentColor(i)
          return (
            <div
              key={agent.id}
              className="agent-row"
              onClick={() => {
                setEditError('')
                setEditingAgent(agent)
              }}
            >
              <div className="agent-icon" style={{ background: '#E09B3D18' }}>
                {agent.emoji || iconForAgent(agent.id)}
              </div>
              <div style={{ flex: 1 }}>
                <div className="agent-name">{agent.name}</div>
                <div className="agent-status" style={{ '--agent-color': color }}>
                  <span className="agent-status-dot" style={{ background: color }} />
                  {agent.status || 'unknown'}
                </div>
                <div className="agent-model">
                  {(agent.harness || 'claude_code') + ' · ' + (agent.model_label || 'Opus 4.6')}
                </div>
              </div>
            </div>
          )
        })}

      <button className="add-agent-btn" onClick={() => {
        setCreateError('')
        setIsAddOpen(true)
      }}>
        + Add agent
      </button>

      <AddAgentModal
        open={isAddOpen}
        loading={createLoading}
        error={createError}
        onClose={() => setIsAddOpen(false)}
        onSubmit={(agent) => {
          void handleSubmitCreate(agent)
        }}
      />

      <EditAgentModal
        open={Boolean(editingAgent)}
        loading={editLoading}
        error={editError}
        agent={editingAgent}
        onClose={() => setEditingAgent(null)}
        onSubmit={(updates) => {
          void handleSubmitEdit(updates)
        }}
      />
    </aside>
  )
}
