import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Search, ChevronDown, X, Trash2 } from 'lucide-react'
import data from '@emoji-mart/data'
import Picker from '@emoji-mart/react'
import { iconForAgent } from '../lib/agentIcon'
import {
  fetchAgentTemplates,
  fetchAvailableClis,
  fetchInstalledSkills,
  fetchAgentSkills,
  assignAgentSkill,
  unassignAgentSkill,
} from '../api'

const AGENT_COLORS = ['#4B83D6', '#2383e2', '#E09B3D', '#7C6DD7', '#E06B5E', '#9B6DD7']
const AGENT_AVATAR_BG = '#E09B3D12'
const HARNESS_LABELS = {
  claude_code: 'Claude Code',
  codex: 'Codex',
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

function WaitlistModal({ open, onClose }) {
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setEmail('')
    setSubmitting(false)
    setSubmitted(false)
    setError('')
  }, [open])

  if (!open) return null

  async function handleSubmit(e) {
    e.preventDefault()
    if (!email.trim()) {
      setError('Please enter your email.')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const res = await fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_key: '1d5191e9-598a-4499-8e92-8d29f9ab5041',
          email,
          subject: 'Pragma Multiplayer Waitlist',
        }),
      })
      const data = await res.json()
      if (data.success) {
        setSubmitted(true)
      } else {
        setError('Something went wrong. Please try again.')
      }
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="waitlist-modal-card" onClick={(e) => e.stopPropagation()}>
        <button className="agent-profile-close" onClick={onClose}>
          <X size={16} strokeWidth={2} />
        </button>
        {submitted ? (
          <div className="waitlist-modal-body">
            <div className="waitlist-modal-icon">🎉</div>
            <h3 className="waitlist-modal-title">You're on the list!</h3>
            <p className="waitlist-modal-text">
              We'll notify you when multiplayer is ready.
            </p>
            <div className="waitlist-modal-actions">
              <button className="agent-profile-save" onClick={onClose}>Done</button>
            </div>
          </div>
        ) : (
          <form className="waitlist-modal-body" onSubmit={handleSubmit}>
            <div className="waitlist-modal-icon">👥</div>
            <h3 className="waitlist-modal-title">Multiplayer is coming soon</h3>
            <p className="waitlist-modal-text">
              The multiplayer version of Pragma is coming soon. Register for the waitlist to get early access.
            </p>
            <input
              className="waitlist-modal-input"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
            {error && <div className="error" style={{ padding: 0, fontSize: 13 }}>{error}</div>}
            <div className="waitlist-modal-actions">
              <button type="button" className="agent-profile-cancel" onClick={onClose} disabled={submitting}>
                Cancel
              </button>
              <button type="submit" className="agent-profile-save" disabled={submitting}>
                {submitting ? 'Joining...' : 'Join waitlist'}
              </button>
            </div>
          </form>
        )}
      </div>
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
        <button className="agent-profile-close" onClick={onClose}>
          <X size={16} strokeWidth={2} />
        </button>

        <div className="agent-profile-header">
          <div className="agent-profile-avatar-wrap">
            <EmojiAvatar emoji={emoji} size={56} onClick={() => setPickerOpen(true)} />
            <EmojiPickerPopover
              open={pickerOpen}
              onClose={() => setPickerOpen(false)}
              onSelect={setEmoji}
            />
          </div>
          <div className="agent-profile-identity">
            <div className="agent-profile-name-input" style={{ cursor: 'default', pointerEvents: 'none' }}>
              {displayName}
            </div>
            <div className="agent-profile-subtitle">{role}</div>
          </div>
        </div>

        <div className="agent-profile-actions">
          <div className="agent-profile-actions-right">
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
    </div>
  )
}

function AgentProfileModal({ open, loading, error, title, subtitle, agent, onClose, onSubmit, onDelete }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [emoji, setEmoji] = useState('🤖')
  const [agentFile, setAgentFile] = useState('')
  const [harness, setHarness] = useState('claude_code')
  const [modelLabel, setModelLabel] = useState('Opus 4.6')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // CLI / harness data fetched from backend
  const [cliData, setCliData] = useState([])

  // Skills management state
  const [installedSkills, setInstalledSkills] = useState([])
  const [agentSkills, setAgentSkills] = useState([])
  const [skillDropdownOpen, setSkillDropdownOpen] = useState(false)
  const [skillBusy, setSkillBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setConfirmDelete(false)
    setDeleting(false)
    setSkillDropdownOpen(false)
    setSkillBusy(false)
    if (agent) {
      if (!agent.harness || !agent.model_label) {
        throw new Error('Agent payload is missing harness or model_label.')
      }
      setName(agent.name ?? '')
      setDescription(agent.description ?? '')
      setEmoji(agent.emoji ?? '🤖')
      setAgentFile(agent.agent_file ?? '')
      setHarness(agent.harness)
      setModelLabel(agent.model_label)
    } else {
      setName('')
      setDescription('')
      setEmoji('🤖')
      setAgentFile('')
      setHarness('claude_code')
      setModelLabel('Opus 4.6')
    }
    setPickerOpen(false)
  }, [open, agent])

  // Fetch available CLIs (harnesses + models) from backend
  useEffect(() => {
    if (!open) return
    fetchAvailableClis().then(setCliData).catch(() => {})
  }, [open])

  const harnesses = useMemo(
    () => cliData.map((cli) => ({ id: cli.id, label: HARNESS_LABELS[cli.id] || cli.id })),
    [cliData],
  )
  const modelsByHarness = useMemo(
    () => Object.fromEntries(cliData.map((cli) => [cli.id, cli.models || []])),
    [cliData],
  )

  // Load installed skills and agent's assigned skills when editing
  useEffect(() => {
    if (!open) return
    setInstalledSkills([])
    setAgentSkills([])
    fetchInstalledSkills().then(setInstalledSkills).catch(() => {})
    if (agent?.id) {
      fetchAgentSkills(agent.id).then(setAgentSkills).catch(() => {})
    }
  }, [open, agent?.id])

  async function handleAddSkill(skillId) {
    if (!agent?.id || skillBusy) return
    setSkillBusy(true)
    try {
      await assignAgentSkill(agent.id, skillId)
      const skill = installedSkills.find((s) => s.id === skillId)
      if (skill) setAgentSkills((prev) => [...prev, skill])
    } catch {
      // ignore
    } finally {
      setSkillBusy(false)
      setSkillDropdownOpen(false)
    }
  }

  async function handleRemoveSkill(skillId) {
    if (!agent?.id) return
    try {
      await unassignAgentSkill(agent.id, skillId)
      setAgentSkills((prev) => prev.filter((s) => s.id !== skillId))
    } catch {
      // ignore
    }
  }

  // Close skill dropdown on outside click
  useEffect(() => {
    if (!skillDropdownOpen) return
    function onPointerDown(e) {
      if (e.target.closest('.apm-skill-add-btn') || e.target.closest('.apm-skill-dropdown')) return
      setSkillDropdownOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [skillDropdownOpen])

  useEffect(() => {
    const options = modelsByHarness[harness] || []
    if (!options.includes(modelLabel)) {
      setModelLabel(options[0] || '')
    }
  }, [harness, modelLabel, modelsByHarness])

  if (!open) return null

  const isCreating = title === 'Add agent'

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="agent-profile-card" onClick={(e) => e.stopPropagation()}>
        {/* Close button */}
        <button className="agent-profile-close" onClick={onClose}>
          <X size={16} strokeWidth={2} />
        </button>

        {/* Identity section — avatar, name, description */}
        <div className="agent-profile-header">
          <div className="agent-profile-avatar-wrap">
            <EmojiAvatar emoji={emoji} size={56} onClick={() => setPickerOpen(true)} />
            <EmojiPickerPopover
              open={pickerOpen}
              onClose={() => setPickerOpen(false)}
              onSelect={setEmoji}
            />
          </div>
          <div className="agent-profile-identity">
            <input
              className="agent-profile-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Agent name"
              autoFocus={isCreating}
            />
            <input
              className="agent-profile-description-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add a description..."
            />
          </div>
        </div>

        {/* Scrollable body */}
        <div className="agent-profile-body">
          {/* Configuration section */}
          <div className="agent-profile-section">
            <div className="agent-profile-section-title">Configuration</div>
            <div className="agent-profile-field-row">
              <div className="agent-profile-field">
                <span className="agent-profile-field-label">Runtime</span>
                <div className="agent-profile-select-wrap">
                  <select
                    className="agent-profile-select"
                    value={harness}
                    onChange={(e) => setHarness(e.target.value)}
                  >
                    {harnesses.map((item) => (
                      <option key={item.id} value={item.id}>{item.label}</option>
                    ))}
                  </select>
                  <ChevronDown size={13} className="agent-profile-select-icon" />
                </div>
              </div>
              <div className="agent-profile-field">
                <span className="agent-profile-field-label">Model</span>
                <div className="agent-profile-select-wrap">
                  <select
                    className="agent-profile-select"
                    value={modelLabel}
                    onChange={(e) => setModelLabel(e.target.value)}
                  >
                    {(modelsByHarness[harness] || []).map((item) => (
                      <option key={item} value={item}>{item}</option>
                    ))}
                  </select>
                  <ChevronDown size={13} className="agent-profile-select-icon" />
                </div>
              </div>
            </div>
          </div>

          {/* Instructions section */}
          <div className="agent-profile-section">
            <div className="agent-profile-section-title">Instructions</div>
            <textarea
              className="agent-profile-textarea"
              value={agentFile}
              onChange={(e) => setAgentFile(e.target.value)}
              rows={5}
              placeholder="Define this agent's behavior, personality, and capabilities..."
            />
          </div>

          {/* Skills section - only for existing agents */}
          {agent?.id && (
            <div className="agent-profile-section">
              <div className="agent-profile-section-title">Skills</div>
              <div className="apm-skills-list">
                {agentSkills.map((skill) => (
                  <span key={skill.id} className="apm-skill-chip">
                    <span className="apm-skill-chip-name">{skill.name}</span>
                    <button
                      className="apm-skill-chip-remove"
                      title={`Remove ${skill.name}`}
                      onClick={() => handleRemoveSkill(skill.id)}
                    >
                      <X size={11} strokeWidth={2.5} />
                    </button>
                  </span>
                ))}
                {agentSkills.length === 0 && (
                  <span className="apm-skills-none">No skills assigned</span>
                )}
                {(() => {
                  const assignedIds = new Set(agentSkills.map((s) => s.id))
                  const available = installedSkills.filter((s) => !assignedIds.has(s.id))
                  if (available.length === 0) return null
                  return (
                    <div style={{ position: 'relative', display: 'inline-flex' }}>
                      <button
                        className="apm-skill-add-btn"
                        onClick={() => setSkillDropdownOpen(!skillDropdownOpen)}
                        disabled={skillBusy}
                        title="Add skill"
                      >
                        <Plus size={12} />
                      </button>
                      {skillDropdownOpen && (
                        <div className="apm-skill-dropdown">
                          {available.map((skill) => (
                            <button
                              key={skill.id}
                              className="apm-skill-dropdown-item"
                              onClick={() => handleAddSkill(skill.id)}
                              disabled={skillBusy}
                            >
                              {skill.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })()}
              </div>
            </div>
          )}
        </div>

        {error && <div className="agent-profile-error">{error}</div>}

        {/* Footer actions */}
        <div className="agent-profile-actions">
          {onDelete && (
            <button
              className={`agent-profile-delete${confirmDelete ? ' agent-profile-delete--confirm' : ''}`}
              onClick={async () => {
                if (!confirmDelete) {
                  setConfirmDelete(true)
                  return
                }
                setDeleting(true)
                try {
                  await onDelete()
                } catch {
                  setDeleting(false)
                  setConfirmDelete(false)
                }
              }}
              disabled={loading || deleting}
            >
              <Trash2 size={13} strokeWidth={2} />
              {deleting ? 'Deleting...' : confirmDelete ? 'Confirm' : 'Delete'}
            </button>
          )}
          <div className="agent-profile-actions-right">
            <button className="agent-profile-cancel" onClick={onClose} disabled={loading || deleting}>
              Cancel
            </button>
            <button
              className="agent-profile-save"
              onClick={() =>
                onSubmit({ name, description, emoji, agent_file: agentFile, harness, model_label: modelLabel })
              }
              disabled={loading || deleting}
            >
              {loading ? 'Saving...' : isCreating ? 'Create agent' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function AgentTemplatePicker({ open, onClose, onSelectTemplate }) {
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError('')
    setSearch('')
    fetchAgentTemplates()
      .then((t) => setTemplates(t))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [open])

  if (!open) return null

  const query = search.toLowerCase()
  const filtered = query
    ? templates.filter(
        (t) =>
          t.name.toLowerCase().includes(query) ||
          t.description.toLowerCase().includes(query) ||
          t.category.toLowerCase().includes(query),
      )
    : templates

  const grouped = {}
  for (const t of filtered) {
    if (!grouped[t.category]) grouped[t.category] = []
    grouped[t.category].push(t)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="template-picker-card" onClick={(e) => e.stopPropagation()}>
        <button className="agent-profile-close" onClick={onClose}>
          <X size={16} strokeWidth={2} />
        </button>
        <div className="template-picker-header">
          <h3 className="template-picker-title">Browse agent templates</h3>
          <div className="template-picker-search-wrap">
            <Search size={14} className="template-picker-search-icon" />
            <input
              className="template-picker-search"
              type="text"
              placeholder="Search templates..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        <div className="template-picker-body">
          {loading && <div className="muted" style={{ padding: 20, textAlign: 'center' }}>Loading templates...</div>}
          {error && <div className="error" style={{ padding: 20 }}>Error: {error}</div>}
          {!loading && !error && filtered.length === 0 && (
            <div className="muted" style={{ padding: 20, textAlign: 'center' }}>No templates found.</div>
          )}
          {!loading &&
            !error &&
            Object.entries(grouped).map(([category, items]) => (
              <div key={category} className="template-picker-group">
                <div className="template-picker-category">{category}</div>
                {items.map((t, i) => (
                  <div
                    key={`${category}-${i}`}
                    className="template-picker-item"
                    onClick={() => onSelectTemplate(t)}
                  >
                    <span className="template-picker-emoji">{t.emoji}</span>
                    <div className="template-picker-info">
                      <div className="template-picker-name">{t.name}</div>
                      <div className="template-picker-desc">{t.description}</div>
                    </div>
                  </div>
                ))}
              </div>
            ))}
        </div>
      </div>
    </div>
  )
}

function AddAgentChooser({ open, onClose, onCreateFromScratch, onBrowseTemplates }) {
  if (!open) return null
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="agent-chooser-card" onClick={(e) => e.stopPropagation()}>
        <button className="agent-profile-close" onClick={onClose}>
          <X size={16} strokeWidth={2} />
        </button>
        <h3 className="agent-chooser-title">Add an agent</h3>
        <div className="agent-chooser-options">
          <button className="agent-chooser-option" onClick={onCreateFromScratch}>
            <span className="agent-chooser-option-icon">✏️</span>
            <div>
              <div className="agent-chooser-option-label">Create from scratch</div>
              <div className="agent-chooser-option-desc">Start with a blank agent configuration</div>
            </div>
          </button>
          <button className="agent-chooser-option" onClick={onBrowseTemplates}>
            <span className="agent-chooser-option-icon">📚</span>
            <div>
              <div className="agent-chooser-option-label">Browse templates</div>
              <div className="agent-chooser-option-desc">Choose from pre-built agent definitions</div>
            </div>
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
  onDeleteAgent,
  humans = [],
  onUpdateHumanEmoji,
  openOrchestratorConfigRequest = 0,
}) {
  const [isChooserOpen, setIsChooserOpen] = useState(false)
  const [isAddOpen, setIsAddOpen] = useState(false)
  const [isTemplatePickerOpen, setIsTemplatePickerOpen] = useState(false)
  const [templatePrefill, setTemplatePrefill] = useState(null)
  const [createError, setCreateError] = useState('')
  const [createLoading, setCreateLoading] = useState(false)

  const [editingAgent, setEditingAgent] = useState(null)
  const [editError, setEditError] = useState('')
  const [editLoading, setEditLoading] = useState(false)
  const lastOpenOrchestratorRequestRef = useRef(0)

  const [editingHuman, setEditingHuman] = useState(null)
  const [waitlistOpen, setWaitlistOpen] = useState(false)

  const sortedAgents = useMemo(() => {
    return [...agents].sort((a, b) => {
      const aIsOrch = a.name?.toLowerCase() === 'orchestrator' ? 0 : 1
      const bIsOrch = b.name?.toLowerCase() === 'orchestrator' ? 0 : 1
      return aIsOrch - bIsOrch
    })
  }, [agents])

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
    const orchestrator = agents.find((agent) => agent?.name?.toLowerCase() === 'orchestrator')
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
        description: agent.description || undefined,
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
        description: updates.description || undefined,
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

      <button
        className="add-agent-ghost"
        onClick={() => setWaitlistOpen(true)}
      >
        <Plus size={13} strokeWidth={2} />
        <span>Add teammate</span>
      </button>

      <div className="right-section-title" style={{ paddingTop: 20 }}>Agents</div>

      {loading && <div className="muted">Loading agents...</div>}
      {error && <div className="error">Error: {error}</div>}
      {!loading && !error && agents.length === 0 && (
        <div className="muted">No agents found.</div>
      )}

      {!loading &&
        !error &&
        sortedAgents.map((agent, i) => {
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
          setIsChooserOpen(true)
        }}
      >
        <Plus size={13} strokeWidth={2} />
        <span>Add agent</span>
      </button>

      <AddAgentChooser
        open={isChooserOpen}
        onClose={() => setIsChooserOpen(false)}
        onCreateFromScratch={() => {
          setIsChooserOpen(false)
          setTemplatePrefill(null)
          setIsAddOpen(true)
        }}
        onBrowseTemplates={() => {
          setIsChooserOpen(false)
          setIsTemplatePickerOpen(true)
        }}
      />

      <AgentTemplatePicker
        open={isTemplatePickerOpen}
        onClose={() => setIsTemplatePickerOpen(false)}
        onSelectTemplate={(t) => {
          setIsTemplatePickerOpen(false)
          setTemplatePrefill({
            name: t.name,
            description: t.description,
            emoji: t.emoji,
            agent_file: t.content,
            harness: 'claude_code',
            model_label: 'Opus 4.6',
          })
          setIsAddOpen(true)
        }}
      />

      <AgentProfileModal
        open={isAddOpen}
        loading={createLoading}
        error={createError}
        title="Add agent"
        subtitle="New agent"
        agent={templatePrefill}
        onClose={() => {
          setIsAddOpen(false)
          setTemplatePrefill(null)
        }}
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
        onDelete={editingAgent ? async () => {
          await onDeleteAgent(editingAgent.id)
          setEditingAgent(null)
        } : undefined}
      />

      <HumanProfileModal
        open={Boolean(editingHuman)}
        human={editingHuman}
        onClose={() => setEditingHuman(null)}
        onSave={async (id, emoji) => {
          await onUpdateHumanEmoji?.(id, emoji)
        }}
      />

      <WaitlistModal
        open={waitlistOpen}
        onClose={() => setWaitlistOpen(false)}
      />
    </aside>
  )
}
