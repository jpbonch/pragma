import { useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import data from '@emoji-mart/data'
import Picker from '@emoji-mart/react'
import { iconForAgent } from '../lib/agentIcon'

const AGENT_COLORS = ['#4B83D6', '#2383e2', '#E09B3D', '#7C6DD7', '#E06B5E', '#9B6DD7']
const AGENT_AVATAR_BG = '#E09B3D12'
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

function EmojiAvatar({ emoji, size = 64, onClick }) {
  return (
    <button
      type="button"
      className="agent-profile-avatar"
      style={{ width: size, height: size, fontSize: size * 0.48 }}
      onClick={onClick}
      title="Change emoji"
    >
      {emoji || '🤖'}
      <span className="agent-profile-avatar-edit">Change</span>
    </button>
  )
}

function EmojiPickerPopover({ open, onClose, onSelect }) {
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="emoji-picker-popover" ref={ref}>
      <Picker
        data={data}
        onEmojiSelect={(emoji) => {
          onSelect(emoji.native)
          onClose()
        }}
        theme="light"
        previewPosition="none"
        skinTonePosition="none"
        maxFrequentRows={1}
      />
    </div>
  )
}

function HumanProfileModal({ open, human, onClose, onSave }) {
  const [emoji, setEmoji] = useState('🌿')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setEmoji(human?.emoji || '🌿')
    setPickerOpen(false)
  }, [open, human])

  if (!open || !human) return null

  const displayName = human._index === 0 ? 'You' : `Human ${human._index + 1}`
  const role = human._index === 0 ? 'Owner' : 'Member'

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="agent-profile-card" onClick={(e) => e.stopPropagation()}>
        <button className="agent-profile-close" onClick={onClose}>×</button>

        <div className="agent-profile-header">
          <div className="agent-profile-avatar-wrap">
            <EmojiAvatar emoji={emoji} size={72} onClick={() => setPickerOpen(true)} />
            <EmojiPickerPopover
              open={pickerOpen}
              onClose={() => setPickerOpen(false)}
              onSelect={setEmoji}
            />
          </div>
          <div className="agent-profile-name-input" style={{ cursor: 'default', pointerEvents: 'none' }}>
            {displayName}
          </div>
          <div className="agent-profile-subtitle">{role}</div>
        </div>

        <div className="agent-profile-actions">
          <button className="agent-profile-cancel" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            className="agent-profile-save"
            onClick={async () => {
              setSaving(true)
              try {
                await onSave(human.id, emoji)
                onClose()
              } finally {
                setSaving(false)
              }
            }}
            disabled={saving}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function AgentProfileModal({ open, loading, error, title, subtitle, agent, onClose, onSubmit }) {
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('🤖')
  const [agentFile, setAgentFile] = useState('')
  const [harness, setHarness] = useState('claude_code')
  const [modelLabel, setModelLabel] = useState('Opus 4.6')
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    if (agent) {
      if (!agent.harness || !agent.model_label) {
        throw new Error('Agent payload is missing harness or model_label.')
      }
      setName(agent.name ?? '')
      setEmoji(agent.emoji ?? '🤖')
      setAgentFile(agent.agent_file ?? '')
      setHarness(agent.harness)
      setModelLabel(agent.model_label)
    } else {
      setName('')
      setEmoji('🤖')
      setAgentFile('')
      setHarness('claude_code')
      setModelLabel('Opus 4.6')
    }
    setPickerOpen(false)
  }, [open, agent])

  useEffect(() => {
    const options = MODELS_BY_HARNESS[harness] || []
    if (!options.includes(modelLabel)) {
      setModelLabel(options[0] || '')
    }
  }, [harness, modelLabel])

  if (!open) return null

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="agent-profile-card" onClick={(e) => e.stopPropagation()}>
        {/* Close button */}
        <button className="agent-profile-close" onClick={onClose}>×</button>

        {/* Avatar + Name - profile style */}
        <div className="agent-profile-header">
          <div className="agent-profile-avatar-wrap">
            <EmojiAvatar emoji={emoji} size={72} onClick={() => setPickerOpen(true)} />
            <EmojiPickerPopover
              open={pickerOpen}
              onClose={() => setPickerOpen(false)}
              onSelect={setEmoji}
            />
          </div>
          <input
            className="agent-profile-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Agent name"
          />
          {subtitle && <div className="agent-profile-subtitle">{subtitle}</div>}
        </div>

        {/* Settings section */}
        <div className="agent-profile-fields">
          <div className="agent-profile-field-row">
            <div className="agent-profile-field">
              <span className="agent-profile-field-label">Runtime</span>
              <select
                className="agent-profile-select"
                value={harness}
                onChange={(e) => setHarness(e.target.value)}
              >
                {HARNESSES.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </select>
            </div>
            <div className="agent-profile-field">
              <span className="agent-profile-field-label">Model</span>
              <select
                className="agent-profile-select"
                value={modelLabel}
                onChange={(e) => setModelLabel(e.target.value)}
              >
                {(MODELS_BY_HARNESS[harness] || []).map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="agent-profile-field">
            <span className="agent-profile-field-label">Instructions</span>
            <textarea
              className="agent-profile-textarea"
              value={agentFile}
              onChange={(e) => setAgentFile(e.target.value)}
              rows={4}
              placeholder="Define this agent's behavior..."
            />
          </div>
        </div>

        {error && <div className="error" style={{ padding: '0 0 4px' }}>Error: {error}</div>}

        {/* Actions */}
        <div className="agent-profile-actions">
          <button className="agent-profile-cancel" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            className="agent-profile-save"
            onClick={() =>
              onSubmit({ name, emoji, agent_file: agentFile, harness, model_label: modelLabel })
            }
            disabled={loading}
          >
            {loading ? 'Saving...' : title === 'Add agent' ? 'Create' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function RightPanel({
  agents,
  loading,
  error,
  onCreateAgent,
  onUpdateAgent,
  humans = [],
  onUpdateHumanEmoji,
  openOrchestratorConfigRequest = 0,
}) {
  const [isAddOpen, setIsAddOpen] = useState(false)
  const [createError, setCreateError] = useState('')
  const [createLoading, setCreateLoading] = useState(false)

  const [editingAgent, setEditingAgent] = useState(null)
  const [editError, setEditError] = useState('')
  const [editLoading, setEditLoading] = useState(false)
  const lastOpenOrchestratorRequestRef = useRef(0)

  const [editingHuman, setEditingHuman] = useState(null)

  useEffect(() => {
    if (
      !openOrchestratorConfigRequest ||
      openOrchestratorConfigRequest === lastOpenOrchestratorRequestRef.current
    ) {
      return
    }

    if (loading) {
      return
    }

    lastOpenOrchestratorRequestRef.current = openOrchestratorConfigRequest
    const orchestrator = agents.find((agent) => agent?.id === 'salmon-orchestrator')
    if (!orchestrator) {
      return
    }

    setEditError('')
    setEditingAgent(orchestrator)
  }, [openOrchestratorConfigRequest, loading, agents])

  async function handleSubmitCreate(agent) {
    setCreateError('')

    if (!agent.name?.trim()) {
      setCreateError('Name is required.')
      return
    }
    if (!agent.emoji?.trim()) {
      setCreateError('Emoji is required.')
      return
    }

    setCreateLoading(true)
    try {
      await onCreateAgent({
        name: agent.name.trim(),
        emoji: agent.emoji.trim(),
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
      {humans.length === 0 && (
        <div className="person-card" style={{ position: 'relative' }}>
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
      )}
      {humans.map((human, i) => (
        <div
          key={human.id}
          className="person-card"
          style={{ position: 'relative' }}
          onClick={() => setEditingHuman({ ...human, _index: i })}
        >
          <div className="person-avatar-wrap">
            <div className="person-avatar" style={{ background: '#2383e215' }}>
              <span>{human.emoji || '🌿'}</span>
            </div>
            <div className="online-dot" />
          </div>
          <div>
            <div className="person-name">{i === 0 ? 'You' : `Human ${i + 1}`}</div>
            <div className="person-role">{i === 0 ? 'Owner' : 'Member'}</div>
          </div>
        </div>
      ))}

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
              <div className="agent-icon" style={{ background: AGENT_AVATAR_BG }}>
                {agent.emoji || iconForAgent(agent.id)}
              </div>
              <div style={{ flex: 1 }}>
                <div className="agent-name">{agent.name}</div>
                <div className="agent-status" style={{ '--agent-color': color }}>
                  <span className="agent-status-dot" style={{ background: color }} />
                  {agent.status}
                </div>
              </div>
            </div>
          )
        })}

      <button
        className="add-agent-ghost"
        onClick={() => {
          setCreateError('')
          setIsAddOpen(true)
        }}
      >
        <Plus size={13} strokeWidth={2} />
        <span>Add agent</span>
      </button>

      <AgentProfileModal
        open={isAddOpen}
        loading={createLoading}
        error={createError}
        title="Add agent"
        subtitle="New agent"
        agent={null}
        onClose={() => setIsAddOpen(false)}
        onSubmit={(agent) => {
          void handleSubmitCreate(agent)
        }}
      />

      <AgentProfileModal
        open={Boolean(editingAgent)}
        loading={editLoading}
        error={editError}
        title="Edit agent"
        subtitle={editingAgent?.id}
        agent={editingAgent}
        onClose={() => setEditingAgent(null)}
        onSubmit={(updates) => {
          void handleSubmitEdit(updates)
        }}
      />

      <HumanProfileModal
        open={Boolean(editingHuman)}
        human={editingHuman}
        onClose={() => setEditingHuman(null)}
        onSave={async (id, emoji) => {
          await onUpdateHumanEmoji?.(id, emoji)
        }}
      />
    </aside>
  )
}
