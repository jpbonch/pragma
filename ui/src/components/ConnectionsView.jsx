import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, Download, Trash2, Plus, X } from 'lucide-react'
import {
  fetchSkillRegistry,
  fetchInstalledSkills,
  fetchGlobalSkills,
  installRegistrySkill,
  deleteSkill,
  fetchAgents,
  fetchAgentSkills,
  assignAgentSkill,
  unassignAgentSkill,
} from '../api'

const PROVIDER_LABELS = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
}

export function ConnectionsView() {
  const [registry, setRegistry] = useState([])
  const [installed, setInstalled] = useState([])
  const [globalSkills, setGlobalSkills] = useState([])
  const [agents, setAgents] = useState([])
  // Map of skill_id -> [{ id, name, emoji }]
  const [skillAgents, setSkillAgents] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [installing, setInstalling] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [actionError, setActionError] = useState('')
  // Track which skill card has the agent-assign dropdown open
  const [assigningSkill, setAssigningSkill] = useState(null)
  const [assignBusy, setAssignBusy] = useState(false)

  async function loadAgentSkillMap(agentList, skills) {
    // Build skill -> agents map by querying each agent's skills
    const map = {}
    for (const s of skills) {
      map[s.id] = []
    }
    await Promise.all(
      agentList.map(async (agent) => {
        try {
          const agentSkills = await fetchAgentSkills(agent.id)
          for (const s of agentSkills) {
            if (map[s.id]) {
              map[s.id].push({ id: agent.id, name: agent.name, emoji: agent.emoji })
            }
          }
        } catch {
          // ignore per-agent errors
        }
      }),
    )
    return map
  }

  async function loadData() {
    setLoading(true)
    setError('')
    try {
      const [reg, inst, global, agentList] = await Promise.all([
        fetchSkillRegistry(),
        fetchInstalledSkills(),
        fetchGlobalSkills().catch(() => []),
        fetchAgents(),
      ])
      setRegistry(reg)
      setInstalled(inst)
      setGlobalSkills(global)
      setAgents(agentList)

      const map = await loadAgentSkillMap(agentList, inst)
      setSkillAgents(map)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const contentRef = useRef(null)

  useEffect(() => {
    loadData()
  }, [])

  // Close agent-assign dropdown on outside click
  useEffect(() => {
    if (!assigningSkill) return
    function onPointerDown(e) {
      const wrap = contentRef.current?.querySelector('.cn-agent-add-wrap .cn-agent-dropdown')
      if (wrap && !wrap.contains(e.target) && !e.target.closest('.cn-agent-add-btn')) {
        setAssigningSkill(null)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [assigningSkill])

  const installedNames = new Set(installed.map((s) => s.name))

  async function handleInstall(skill) {
    if (installing) return
    setInstalling(skill.name)
    setActionError('')
    try {
      await installRegistrySkill({
        name: skill.name,
        provider: skill.provider,
        repo: skill.repo,
        skill_path: skill.skill_path,
      })
      const [inst, agentList] = await Promise.all([
        fetchInstalledSkills(),
        fetchAgents(),
      ])
      setInstalled(inst)
      setAgents(agentList)
      const map = await loadAgentSkillMap(agentList, inst)
      setSkillAgents(map)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(null)
    }
  }

  async function handleRemove(skill) {
    if (removing) return
    setRemoving(skill.id)
    setActionError('')
    try {
      await deleteSkill(skill.id)
      const inst = await fetchInstalledSkills()
      setInstalled(inst)
      setSkillAgents((prev) => {
        const next = { ...prev }
        delete next[skill.id]
        return next
      })
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setRemoving(null)
    }
  }

  async function handleAssignSkill(skillId, agentId) {
    setAssignBusy(true)
    setActionError('')
    try {
      await assignAgentSkill(agentId, skillId)
      const agent = agents.find((a) => a.id === agentId)
      setSkillAgents((prev) => ({
        ...prev,
        [skillId]: [
          ...(prev[skillId] || []),
          { id: agent.id, name: agent.name, emoji: agent.emoji },
        ],
      }))
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setAssignBusy(false)
      setAssigningSkill(null)
    }
  }

  async function handleUnassignSkill(skillId, agentId) {
    setActionError('')
    try {
      await unassignAgentSkill(agentId, skillId)
      setSkillAgents((prev) => ({
        ...prev,
        [skillId]: (prev[skillId] || []).filter((a) => a.id !== agentId),
      }))
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }

  const anthropicSkills = registry.filter((s) => s.provider === 'anthropic')
  const openaiSkills = registry.filter((s) => s.provider === 'openai')

  return (
    <section className="cn">
      <div className="cn-header">
        <div className="cn-header-inner">
          <h1 className="cn-title">Skills</h1>
          <span className="cn-subtitle">
            {installed.length} installed{globalSkills.length > 0 ? ` · ${globalSkills.length} global` : ''}
          </span>
        </div>
      </div>

      <div className="cn-content" ref={contentRef}>
        {loading && (
          <div className="cn-loading">
            <div className="cn-spinner" />
            <span>Loading skill registries...</span>
          </div>
        )}

        {error && (
          <div className="cn-error">
            <AlertCircle size={16} />
            <span>{error}</span>
            <button className="cn-retry-btn" onClick={loadData}>Retry</button>
          </div>
        )}

        {actionError && (
          <div className="cn-error" style={{ margin: '0 0 12px' }}>
            <AlertCircle size={16} />
            <span>{actionError}</span>
          </div>
        )}

        {!loading && !error && (
          <>
            {installed.length > 0 && (
              <div className="cn-section">
                <h2 className="cn-section-title">Installed</h2>
                <div className="cn-grid">
                  {installed.map((skill) => {
                    const assigned = skillAgents[skill.id] || []
                    const assignedIds = new Set(assigned.map((a) => a.id))
                    const available = agents.filter((a) => !assignedIds.has(a.id))
                    return (
                      <div key={skill.id} className="cn-card cn-card--installed">
                        <div className="cn-card-header">
                          <span className="cn-card-name">{skill.name}</span>
                          <span className="cn-badge cn-badge--installed">Installed</span>
                        </div>
                        {skill.description && (
                          <p className="cn-card-desc">{skill.description}</p>
                        )}

                        <div className="cn-agents-section">
                          <div className="cn-agents-label">Agents</div>
                          <div className="cn-agents-list">
                            {assigned.map((agent) => (
                              <span key={agent.id} className="cn-agent-chip">
                                <span className="cn-agent-chip-emoji">{agent.emoji || '🤖'}</span>
                                <span className="cn-agent-chip-name">{agent.name}</span>
                                <button
                                  className="cn-agent-chip-remove"
                                  title={`Remove ${agent.name}`}
                                  onClick={() => handleUnassignSkill(skill.id, agent.id)}
                                >
                                  <X size={11} />
                                </button>
                              </span>
                            ))}
                            {assigned.length === 0 && (
                              <span className="cn-agents-none">No agents assigned</span>
                            )}
                            {available.length > 0 && (
                              <div className="cn-agent-add-wrap">
                                <button
                                  className="cn-agent-add-btn"
                                  onClick={() =>
                                    setAssigningSkill(
                                      assigningSkill === skill.id ? null : skill.id,
                                    )
                                  }
                                  disabled={assignBusy}
                                >
                                  <Plus size={12} />
                                </button>
                                {assigningSkill === skill.id && (
                                  <div className="cn-agent-dropdown">
                                    {available.map((agent) => (
                                      <button
                                        key={agent.id}
                                        className="cn-agent-dropdown-item"
                                        onClick={() => handleAssignSkill(skill.id, agent.id)}
                                        disabled={assignBusy}
                                      >
                                        <span className="cn-agent-chip-emoji">
                                          {agent.emoji || '🤖'}
                                        </span>
                                        {agent.name}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="cn-card-footer">
                          <button
                            className="cn-remove-btn"
                            onClick={() => handleRemove(skill)}
                            disabled={removing === skill.id}
                          >
                            {removing === skill.id ? (
                              <div className="cn-spinner-sm" />
                            ) : (
                              <Trash2 size={13} />
                            )}
                            <span>{removing === skill.id ? 'Removing...' : 'Remove'}</span>
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {globalSkills.length > 0 && (
              <div className="cn-section">
                <h2 className="cn-section-title">Global Skills</h2>
                <p className="cn-section-source">~/.agents/skills · ~/.claude/skills</p>
                <div className="cn-grid">
                  {globalSkills.map((skill) => (
                    <div key={`global-${skill.name}`} className="cn-card cn-card--installed">
                      <div className="cn-card-header">
                        <span className="cn-card-name">{skill.name}</span>
                        <span className="cn-badge cn-badge--global">Global</span>
                      </div>
                      {skill.description && (
                        <p className="cn-card-desc">{skill.description}</p>
                      )}
                      <div className="cn-card-footer">
                        <span className="cn-global-source">{skill.source}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {anthropicSkills.length > 0 && (
              <div className="cn-section">
                <h2 className="cn-section-title">Anthropic Skills</h2>
                <p className="cn-section-source">anthropics/skills</p>
                <div className="cn-grid">
                  {anthropicSkills.map((skill) => {
                    const isInstalled = installedNames.has(skill.name)
                    return (
                      <div key={`anthropic-${skill.name}`} className={`cn-card ${isInstalled ? 'cn-card--installed' : ''}`}>
                        <div className="cn-card-header">
                          <span className="cn-card-name">{skill.name}</span>
                          {isInstalled && <span className="cn-badge cn-badge--installed">Installed</span>}
                        </div>
                        {skill.description && (
                          <p className="cn-card-desc">{skill.description}</p>
                        )}
                        <div className="cn-card-footer">
                          {isInstalled ? (
                            <span className="cn-installed-label">
                              <Check size={13} />
                              Installed
                            </span>
                          ) : (
                            <button
                              className="cn-install-btn"
                              onClick={() => handleInstall(skill)}
                              disabled={installing === skill.name}
                            >
                              {installing === skill.name ? (
                                <div className="cn-spinner-sm" />
                              ) : (
                                <Download size={13} />
                              )}
                              <span>{installing === skill.name ? 'Installing...' : 'Install'}</span>
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {openaiSkills.length > 0 && (
              <div className="cn-section">
                <h2 className="cn-section-title">OpenAI Skills</h2>
                <p className="cn-section-source">openai/skills</p>
                <div className="cn-grid">
                  {openaiSkills.map((skill) => {
                    const isInstalled = installedNames.has(skill.name)
                    return (
                      <div key={`openai-${skill.name}`} className={`cn-card ${isInstalled ? 'cn-card--installed' : ''}`}>
                        <div className="cn-card-header">
                          <span className="cn-card-name">{skill.name}</span>
                          {isInstalled && <span className="cn-badge cn-badge--installed">Installed</span>}
                        </div>
                        {skill.description && (
                          <p className="cn-card-desc">{skill.description}</p>
                        )}
                        <div className="cn-card-footer">
                          {isInstalled ? (
                            <span className="cn-installed-label">
                              <Check size={13} />
                              Installed
                            </span>
                          ) : (
                            <button
                              className="cn-install-btn"
                              onClick={() => handleInstall(skill)}
                              disabled={installing === skill.name}
                            >
                              {installing === skill.name ? (
                                <div className="cn-spinner-sm" />
                              ) : (
                                <Download size={13} />
                              )}
                              <span>{installing === skill.name ? 'Installing...' : 'Install'}</span>
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {registry.length === 0 && installed.length === 0 && globalSkills.length === 0 && (
              <div className="cn-empty">
                <Download size={40} strokeWidth={1.5} />
                <p className="cn-empty-title">No skills available</p>
                <p className="cn-empty-desc">Could not fetch skills from the registries.</p>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}
