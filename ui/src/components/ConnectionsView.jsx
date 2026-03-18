import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Download, Trash2, Plus, X, Link, Unlink, Settings, Key, ChevronRight } from 'lucide-react'
import {
  fetchSkillRegistry,
  fetchInstalledSkills,
  fetchGlobalSkills,
  fetchMcpServers,
  installRegistrySkill,
  createCustomSkill,
  deleteSkill,
  fetchAgents,
  fetchAgentSkills,
  assignAgentSkill,
  unassignAgentSkill,
  fetchConnectors,
  configureConnector,
  startConnectorAuth,
  disconnectConnector,
  ensureConnectorBinary,
  fetchAgentConnectors,
  assignAgentConnector,
  unassignAgentConnector,
} from '../api'

const HARNESS_LABELS = {
  claude_code: 'Claude Code',
  codex: 'Codex',
}

const CONNECTOR_STATUS_STYLES = {
  connected: { label: 'Connected', className: 'cn-badge--connected' },
  disconnected: { label: 'Disconnected', className: 'cn-badge--disconnected' },
  needs_config: { label: 'Not configured', className: 'cn-badge--needs-config' },
}

/* Inline SVG logos for connectors */
const CONNECTOR_LOGOS = {
  'google-workspace': (
    <svg className="cn-conn-logo" viewBox="0 0 24 24" fill="none">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 001 12c0 1.77.42 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  ),
  slack: (
    <svg className="cn-conn-logo" viewBox="0 0 24 24" fill="none">
      <path d="M5.042 15.165a2.528 2.528 0 01-2.52 2.523A2.528 2.528 0 010 15.165a2.527 2.527 0 012.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 012.521-2.52 2.527 2.527 0 012.521 2.52v6.313A2.528 2.528 0 018.834 24a2.528 2.528 0 01-2.521-2.522v-6.313z" fill="#E01E5A"/>
      <path d="M8.834 5.042a2.528 2.528 0 01-2.521-2.52A2.528 2.528 0 018.834 0a2.528 2.528 0 012.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 012.521 2.521 2.528 2.528 0 01-2.521 2.521H2.522A2.528 2.528 0 010 8.834a2.528 2.528 0 012.522-2.521h6.312z" fill="#36C5F0"/>
      <path d="M18.956 8.834a2.528 2.528 0 012.522-2.521A2.528 2.528 0 0124 8.834a2.528 2.528 0 01-2.522 2.521h-2.522V8.834zm-1.27 0a2.528 2.528 0 01-2.522 2.521 2.528 2.528 0 01-2.522-2.521V2.522A2.528 2.528 0 0115.164 0a2.528 2.528 0 012.522 2.522v6.312z" fill="#2EB67D"/>
      <path d="M15.164 18.956a2.528 2.528 0 012.522 2.522A2.528 2.528 0 0115.164 24a2.528 2.528 0 01-2.522-2.522v-2.522h2.522zm0-1.27a2.528 2.528 0 01-2.522-2.522 2.528 2.528 0 012.522-2.522h6.313A2.528 2.528 0 0124 15.164a2.528 2.528 0 01-2.523 2.522h-6.313z" fill="#ECB22E"/>
    </svg>
  ),
  notion: (
    <svg className="cn-conn-logo" viewBox="0 0 24 24" fill="none">
      <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L18.09 2.28c-.42-.326-.98-.7-2.055-.607l-12.8.932c-.466.047-.56.28-.374.466l1.598 1.137zm.793 2.712v13.84c0 .746.373 1.026 1.212.98l14.523-.84c.84-.046.932-.56.932-1.166V5.874c0-.606-.233-.886-.746-.84l-15.175.886c-.56.047-.746.28-.746.84v.16zm14.337.42c.093.42 0 .84-.42.886l-.7.14v10.221c-.606.326-1.166.513-1.633.513-.746 0-.932-.233-1.492-.933L11.05 11.48v6.314l1.446.326s0 .84-1.166.84l-3.218.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.833 9.76c-.093-.42.14-1.026.793-1.073l3.452-.233 4.526 6.92V9.481l-1.213-.14c-.093-.513.28-.886.746-.932l3.452-.07z" fill="#000"/>
    </svg>
  ),
}

function connectorDisplayName(connector) {
  return connector.display_name || connector.name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

export function ConnectionsView() {
  const [registry, setRegistry] = useState([])
  const [installed, setInstalled] = useState([])
  const [harnessGlobalSkills, setHarnessGlobalSkills] = useState({})
  const [harnessMcpServers, setHarnessMcpServers] = useState({})
  const [agents, setAgents] = useState([])
  const [skillAgents, setSkillAgents] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [installing, setInstalling] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [actionError, setActionError] = useState('')
  const [assignBusy, setAssignBusy] = useState(false)
  const [addingSkillToAgent, setAddingSkillToAgent] = useState(null)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [createForm, setCreateForm] = useState({ name: '', description: '', content: '' })
  const [creating, setCreating] = useState(false)

  const [expandedSkillId, setExpandedSkillId] = useState(null)

  // Connector state
  const [connectors, setConnectors] = useState([])
  const [connectorAgents, setConnectorAgents] = useState({})
  const [showConfigModal, setShowConfigModal] = useState(null)
  const [configForm, setConfigForm] = useState({ oauth_client_id: '', oauth_client_secret: '', access_token: '' })
  const [configuring, setConfiguring] = useState(false)
  const [connecting, setConnecting] = useState(null)
  const [addingConnectorToAgent, setAddingConnectorToAgent] = useState(null)

  const agentSkillsMap = useMemo(() => {
    const map = {}
    for (const agent of agents) {
      map[agent.id] = []
    }
    for (const [skillId, agentsList] of Object.entries(skillAgents)) {
      const skill = installed.find((s) => s.id === skillId)
      if (!skill) continue
      for (const agent of agentsList) {
        if (map[agent.id]) {
          map[agent.id].push({ id: skill.id, name: skill.name, description: skill.description })
        }
      }
    }
    return map
  }, [agents, skillAgents, installed])

  const agentConnectorsMap = useMemo(() => {
    const map = {}
    for (const agent of agents) {
      map[agent.id] = []
    }
    for (const [connId, agentsList] of Object.entries(connectorAgents)) {
      const conn = connectors.find((c) => c.id === connId)
      if (!conn) continue
      for (const agent of agentsList) {
        if (map[agent.id]) {
          map[agent.id].push({ id: conn.id, name: conn.name, description: conn.description })
        }
      }
    }
    return map
  }, [agents, connectorAgents, connectors])

  async function loadAgentSkillMap(agentList, skills) {
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

  async function loadConnectorAgentMap(agentList, connectorList) {
    const map = {}
    for (const c of connectorList) {
      map[c.id] = []
    }
    await Promise.all(
      agentList.map(async (agent) => {
        try {
          const agentConns = await fetchAgentConnectors(agent.id)
          for (const c of agentConns) {
            if (map[c.id]) {
              map[c.id].push({ id: agent.id, name: agent.name, emoji: agent.emoji })
            }
          }
        } catch {
          // ignore
        }
      }),
    )
    return map
  }

  async function loadData() {
    setLoading(true)
    setError('')
    try {
      const [reg, inst, agentList, connList] = await Promise.all([
        fetchSkillRegistry(),
        fetchInstalledSkills(),
        fetchAgents(),
        fetchConnectors(),
      ])
      setRegistry(reg)
      setInstalled(inst)
      setAgents(agentList)
      setConnectors(connList)

      const uniqueHarnesses = [...new Set(agentList.map((a) => a.harness).filter(Boolean))]
      const [harnessSkillsEntries, harnessMcpEntries] = await Promise.all([
        Promise.all(
          uniqueHarnesses.map(async (harness) => {
            const skills = await fetchGlobalSkills(harness).catch(() => [])
            return [harness, skills]
          }),
        ),
        Promise.all(
          uniqueHarnesses.map(async (harness) => {
            const servers = await fetchMcpServers(harness).catch(() => [])
            return [harness, servers]
          }),
        ),
      ])
      setHarnessGlobalSkills(Object.fromEntries(harnessSkillsEntries))
      setHarnessMcpServers(Object.fromEntries(harnessMcpEntries))

      const [skillMap, connMap] = await Promise.all([
        loadAgentSkillMap(agentList, inst),
        loadConnectorAgentMap(agentList, connList),
      ])
      setSkillAgents(skillMap)
      setConnectorAgents(connMap)
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

  useEffect(() => {
    if (!addingSkillToAgent && !addingConnectorToAgent) return
    function onPointerDown(e) {
      if (e.target.closest('.cn-agent-add-btn') || e.target.closest('.cn-skill-add-btn') || e.target.closest('.cn-connector-add-btn')) return
      const dropdown = e.target.closest('.cn-agent-dropdown') || e.target.closest('.cn-skill-dropdown') || e.target.closest('.cn-connector-dropdown')
      if (!dropdown) {
        setAddingSkillToAgent(null)
        setAddingConnectorToAgent(null)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [addingSkillToAgent, addingConnectorToAgent])

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
      setAddingSkillToAgent(null)
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

  async function handleCreateSkill(e) {
    e.preventDefault()
    if (creating) return
    setCreating(true)
    setActionError('')
    try {
      await createCustomSkill({
        name: createForm.name.trim(),
        description: createForm.description.trim() || undefined,
        content: createForm.content,
      })
      const [inst, agentList] = await Promise.all([
        fetchInstalledSkills(),
        fetchAgents(),
      ])
      setInstalled(inst)
      setAgents(agentList)
      const map = await loadAgentSkillMap(agentList, inst)
      setSkillAgents(map)
      setShowCreateModal(false)
      setCreateForm({ name: '', description: '', content: '' })
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  // ── Connector handlers ─────────────────────────────────────────────

  function handleOpenConfig(connector) {
    setConfigForm({ oauth_client_id: '', oauth_client_secret: '', access_token: '' })
    setShowConfigModal(connector)
  }

  async function handleSaveConfig(e) {
    e.preventDefault()
    if (configuring) return
    setConfiguring(true)
    setActionError('')
    try {
      const connector = showConfigModal
      if (connector.auth_type === 'api_key') {
        await configureConnector(connector.id, { access_token: configForm.access_token })
      } else {
        await configureConnector(connector.id, {
          oauth_client_id: configForm.oauth_client_id,
          oauth_client_secret: configForm.oauth_client_secret,
        })
      }
      const connList = await fetchConnectors()
      setConnectors(connList)
      setShowConfigModal(null)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setConfiguring(false)
    }
  }

  async function handleConnect(connector) {
    if (connecting) return
    setConnecting(connector.id)
    setActionError('')
    try {
      await ensureConnectorBinary(connector.id)
      const { url } = await startConnectorAuth(connector.id)
      window.open(url, '_blank')

      const poll = setInterval(async () => {
        try {
          const connList = await fetchConnectors()
          const updated = connList.find((c) => c.id === connector.id)
          if (updated?.status === 'connected') {
            clearInterval(poll)
            setConnectors(connList)
            setConnecting(null)
          }
        } catch {
          // ignore polling errors
        }
      }, 2000)

      setTimeout(() => {
        clearInterval(poll)
        setConnecting(null)
      }, 300000)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
      setConnecting(null)
    }
  }

  async function handleDisconnect(connector) {
    setActionError('')
    try {
      await disconnectConnector(connector.id)
      const connList = await fetchConnectors()
      setConnectors(connList)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleAssignConnector(connectorId, agentId) {
    setAssignBusy(true)
    setActionError('')
    try {
      await assignAgentConnector(agentId, connectorId)
      const agent = agents.find((a) => a.id === agentId)
      setConnectorAgents((prev) => ({
        ...prev,
        [connectorId]: [
          ...(prev[connectorId] || []),
          { id: agent.id, name: agent.name, emoji: agent.emoji },
        ],
      }))
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setAssignBusy(false)
      setAddingConnectorToAgent(null)
    }
  }

  async function handleUnassignConnector(connectorId, agentId) {
    setActionError('')
    try {
      await unassignAgentConnector(agentId, connectorId)
      setConnectorAgents((prev) => ({
        ...prev,
        [connectorId]: (prev[connectorId] || []).filter((a) => a.id !== agentId),
      }))
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }

  const connectedConnectors = connectors.filter((c) => c.status === 'connected')
  const catalogSkills = registry

  return (
    <section className="cn">
      <div className="cn-header">
        <div className="cn-header-inner">
          <h1 className="cn-title">Skills &amp; Connections</h1>
        </div>
      </div>

      <div className="cn-content" ref={contentRef}>
        {loading && (
          <div className="cn-loading">
            <div className="cn-spinner" />
            <span>Loading...</span>
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
            {/* Agents Section */}
            {agents.length > 0 && (
              <div className="cn-section">
                <h2 className="cn-section-title">Agents</h2>
                <div className="cn-list">
                  {agents.map((agent) => {
                    const assignedSkills = agentSkillsMap[agent.id] || []
                    const assignedSkillIds = new Set(assignedSkills.map((s) => s.id))
                    const availableSkills = installed.filter((s) => !assignedSkillIds.has(s.id))
                    const assignedConns = agentConnectorsMap[agent.id] || []
                    const assignedConnIds = new Set(assignedConns.map((c) => c.id))
                    const availableConns = connectedConnectors.filter((c) => !assignedConnIds.has(c.id))
                    const agentGlobalSkills = (agent.harness && harnessGlobalSkills[agent.harness]) || []
                    const agentMcpServers = (agent.harness && harnessMcpServers[agent.harness]) || []
                    const harnessLabel = HARNESS_LABELS[agent.harness] || agent.harness
                    return (
                      <div key={agent.id} className="cn-agent-block">
                        <div className="cn-row cn-agent-row">
                          <div className="cn-row-left">
                            <span className="cn-agent-card-emoji">{agent.emoji || '🤖'}</span>
                            <span className="cn-row-name">{agent.name}</span>
                          </div>
                          <div className="cn-row-chips">
                            {assignedSkills.map((skill) => (
                              <span key={skill.id} className="cn-agent-chip">
                                <span className="cn-agent-chip-name">{skill.name}</span>
                                <button
                                  className="cn-agent-chip-remove"
                                  title={`Remove ${skill.name}`}
                                  onClick={() => handleUnassignSkill(skill.id, agent.id)}
                                >
                                  <X size={11} />
                                </button>
                              </span>
                            ))}
                            {assignedConns.map((conn) => (
                              <span key={conn.id} className="cn-agent-chip cn-agent-chip--connector">
                                <span className="cn-agent-chip-name">{conn.name}</span>
                                <button
                                  className="cn-agent-chip-remove"
                                  title={`Remove ${conn.name}`}
                                  onClick={() => handleUnassignConnector(conn.id, agent.id)}
                                >
                                  <X size={11} />
                                </button>
                              </span>
                            ))}
                            {agentGlobalSkills.map((skill) => (
                              <span key={`global-${skill.name}`} className="cn-agent-chip cn-agent-chip--global">
                                <span className="cn-agent-chip-name">{skill.name}</span>
                              </span>
                            ))}
                            {agentMcpServers.map((server) => (
                              <span key={`mcp-${server.name}`} className="cn-agent-chip cn-agent-chip--mcp">
                                <span className="cn-agent-chip-name">{server.name}</span>
                              </span>
                            ))}
                            {assignedSkills.length === 0 && assignedConns.length === 0 &&
                              agentGlobalSkills.length === 0 && agentMcpServers.length === 0 && (
                              <span className="cn-agents-none">No skills assigned</span>
                            )}
                            {(availableSkills.length > 0 || availableConns.length > 0) && (
                              <div className="cn-agent-add-wrap">
                                <button
                                  className="cn-skill-add-btn cn-agent-add-btn"
                                  onClick={() => {
                                    const key = `skill-${agent.id}`
                                    setAddingSkillToAgent(addingSkillToAgent === key ? null : key)
                                    setAddingConnectorToAgent(null)
                                  }}
                                  disabled={assignBusy}
                                  title="Add skill or connector"
                                >
                                  <Plus size={12} />
                                </button>
                                {addingSkillToAgent === `skill-${agent.id}` && (
                                  <div className="cn-skill-dropdown cn-agent-dropdown">
                                    {availableSkills.length > 0 && (
                                      <div className="cn-dropdown-group-label">Skills</div>
                                    )}
                                    {availableSkills.map((skill) => (
                                      <button
                                        key={skill.id}
                                        className="cn-agent-dropdown-item"
                                        onClick={() => handleAssignSkill(skill.id, agent.id)}
                                        disabled={assignBusy}
                                      >
                                        {skill.name}
                                      </button>
                                    ))}
                                    {availableConns.length > 0 && (
                                      <div className="cn-dropdown-group-label">Connectors</div>
                                    )}
                                    {availableConns.map((conn) => (
                                      <button
                                        key={conn.id}
                                        className="cn-agent-dropdown-item"
                                        onClick={() => handleAssignConnector(conn.id, agent.id)}
                                        disabled={assignBusy}
                                      >
                                        {connectorDisplayName(connectors.find(c => c.id === conn.id) || conn)}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                        {(agentGlobalSkills.length > 0 || agentMcpServers.length > 0) && (
                          <div className="cn-runtime-row">
                            <span className="cn-runtime-label">{harnessLabel}</span>
                            <div className="cn-row-chips">
                              {agentGlobalSkills.map((skill) => (
                                <span key={`g-${skill.name}`} className="cn-agent-chip cn-agent-chip--global">
                                  <span className="cn-agent-chip-name">{skill.name}</span>
                                </span>
                              ))}
                              {agentMcpServers.map((server) => (
                                <span key={`m-${server.name}`} className="cn-agent-chip cn-agent-chip--mcp">
                                  <span className="cn-agent-chip-name">{server.name}</span>
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Two-column: Skills left, Connector Skills right */}
            <div className="cn-columns">
              {/* Left column: Skill Catalog */}
              <div className="cn-col">
                <div className="cn-section">
                  <div className="cn-section-header">
                    <h2 className="cn-section-title">Skills</h2>
                    <button
                      className="cn-create-skill-btn"
                      onClick={() => setShowCreateModal(true)}
                    >
                      <Plus size={14} strokeWidth={2} />
                      <span>New Skill</span>
                    </button>
                  </div>
                  <div className="cn-list">
                    {installed.map((skill) => {
                      const isExpanded = expandedSkillId === skill.id
                      return (
                        <div key={skill.id} className={`cn-skill-block ${isExpanded ? 'cn-skill-block--expanded' : ''}`}>
                          <div
                            className="cn-row cn-row--installed cn-row--clickable"
                            onClick={() => setExpandedSkillId(isExpanded ? null : skill.id)}
                          >
                            <div className="cn-row-left">
                              <ChevronRight size={13} className={`cn-skill-chevron ${isExpanded ? 'cn-skill-chevron--open' : ''}`} />
                              <span className="cn-row-name">{skill.name}</span>
                              <span className="cn-badge cn-badge--installed">Installed</span>
                              {!isExpanded && skill.description && (
                                <span className="cn-row-desc">{skill.description}</span>
                              )}
                            </div>
                            <div className="cn-row-actions" onClick={(e) => e.stopPropagation()}>
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
                          {isExpanded && (
                            <div className="cn-skill-detail">
                              {skill.description && (
                                <div className="cn-skill-detail-desc">{skill.description}</div>
                              )}
                              {skill.content && (
                                <pre className="cn-skill-detail-content">{skill.content}</pre>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}

                    {catalogSkills.filter((s) => !installedNames.has(s.name)).map((skill) => {
                      const catalogKey = `catalog-${skill.provider}-${skill.name}`
                      const isExpanded = expandedSkillId === catalogKey
                      return (
                        <div key={catalogKey} className={`cn-skill-block ${isExpanded ? 'cn-skill-block--expanded' : ''}`}>
                          <div
                            className={`cn-row cn-row--clickable`}
                            onClick={() => setExpandedSkillId(isExpanded ? null : catalogKey)}
                          >
                            <div className="cn-row-left">
                              <ChevronRight size={13} className={`cn-skill-chevron ${isExpanded ? 'cn-skill-chevron--open' : ''}`} />
                              <span className="cn-row-name">{skill.name}</span>
                              {!isExpanded && skill.description && (
                                <span className="cn-row-desc">{skill.description}</span>
                              )}
                            </div>
                            <div className="cn-row-actions" onClick={(e) => e.stopPropagation()}>
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
                            </div>
                          </div>
                          {isExpanded && skill.description && (
                            <div className="cn-skill-detail">
                              <div className="cn-skill-detail-desc">{skill.description}</div>
                            </div>
                          )}
                        </div>
                      )
                    })}

                    {installed.length === 0 && catalogSkills.length === 0 && (
                      <div className="cn-list-empty">No skills available</div>
                    )}
                  </div>
                </div>
              </div>

              {/* Right column: Connector Skills */}
              <div className="cn-col">
                <div className="cn-section">
                  <h2 className="cn-section-title">Connector Skills</h2>
                  <div className="cn-list">
                    {connectors.map((connector) => {
                      const statusInfo = CONNECTOR_STATUS_STYLES[connector.status] ||
                        CONNECTOR_STATUS_STYLES.disconnected
                      const isOAuth = connector.auth_type === 'oauth2'
                      const hasProxy = !!connector.has_proxy
                      const needsConfig = isOAuth && !hasProxy && (!connector.has_client_id || !connector.has_client_secret)
                      const canConnect = isOAuth && (hasProxy || (connector.has_client_id && connector.has_client_secret)) && connector.status !== 'connected'
                      const isConnected = connector.status === 'connected'

                      return (
                        <div key={connector.id} className={`cn-conn-row ${isConnected ? 'cn-conn-row--connected' : ''}`}>
                          <div className="cn-conn-info">
                            <div className="cn-conn-logo-wrap">
                              {CONNECTOR_LOGOS[connector.name] || (
                                <div className="cn-conn-logo-fallback">
                                  {connectorDisplayName(connector).charAt(0)}
                                </div>
                              )}
                            </div>
                            <div className="cn-conn-details">
                              <div className="cn-conn-name-row">
                                <span className="cn-conn-name">{connectorDisplayName(connector)}</span>
                                <span className={`cn-badge ${statusInfo.className}`}>
                                  {statusInfo.label}
                                </span>
                              </div>
                              {connector.description && (
                                <span className="cn-conn-desc">{connector.description}</span>
                              )}
                            </div>
                          </div>
                          <div className="cn-row-actions">
                            {needsConfig && (
                              <button
                                className="cn-config-btn"
                                onClick={() => handleOpenConfig(connector)}
                              >
                                <Settings size={13} />
                                <span>Configure</span>
                              </button>
                            )}
                            {!isOAuth && !isConnected && (
                              <button
                                className="cn-config-btn"
                                onClick={() => handleOpenConfig(connector)}
                              >
                                <Key size={13} />
                                <span>Set API Key</span>
                              </button>
                            )}
                            {canConnect && (
                              <button
                                className="cn-connect-btn"
                                onClick={() => handleConnect(connector)}
                                disabled={connecting === connector.id}
                              >
                                {connecting === connector.id ? (
                                  <div className="cn-spinner-sm" />
                                ) : (
                                  <Link size={13} />
                                )}
                                <span>{connecting === connector.id ? 'Connecting...' : 'Connect'}</span>
                              </button>
                            )}
                            {isConnected && (
                              <button
                                className="cn-disconnect-btn"
                                onClick={() => handleDisconnect(connector)}
                              >
                                <Unlink size={13} />
                                <span>Disconnect</span>
                              </button>
                            )}
                          </div>
                        </div>
                      )
                    })}

                    {connectors.length === 0 && (
                      <div className="cn-list-empty">No connector skills available</div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {registry.length === 0 && installed.length === 0 && connectors.length === 0 && (
              <div className="cn-empty">
                <Download size={40} strokeWidth={1.5} />
                <p className="cn-empty-title">No skills available</p>
                <p className="cn-empty-desc">Create a custom skill or check your registry configuration.</p>
              </div>
            )}
          </>
        )}
      </div>

      {showCreateModal && (
        <div className="modal-backdrop" onClick={() => setShowCreateModal(false)}>
          <form
            className="modal-card"
            onClick={(e) => e.stopPropagation()}
            onSubmit={handleCreateSkill}
          >
            <h2>New Custom Skill</h2>
            <p>Define a reusable skill that can be assigned to agents.</p>

            <label className="modal-label">Name</label>
            <input
              className="modal-input"
              placeholder="e.g. code-reviewer"
              value={createForm.name}
              onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
              required
              autoFocus
            />

            <label className="modal-label">Description</label>
            <input
              className="modal-input"
              placeholder="Brief description (optional)"
              value={createForm.description}
              onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
            />

            <label className="modal-label">Content</label>
            <textarea
              className="modal-textarea"
              placeholder="Skill instructions / prompt content"
              value={createForm.content}
              onChange={(e) => setCreateForm({ ...createForm, content: e.target.value })}
              required
            />

            <div className="modal-actions">
              <button
                type="button"
                className="modal-cancel"
                onClick={() => setShowCreateModal(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="modal-create"
                disabled={!createForm.name.trim() || !createForm.content.trim() || creating}
              >
                {creating ? 'Creating...' : 'Create Skill'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Configure Connector Modal */}
      {showConfigModal && (
        <div className="modal-backdrop" onClick={() => setShowConfigModal(null)}>
          <form
            className="modal-card"
            onClick={(e) => e.stopPropagation()}
            onSubmit={handleSaveConfig}
          >
            <h2>Configure {connectorDisplayName(showConfigModal)}</h2>
            <p>{showConfigModal.description}</p>

            {showConfigModal.auth_type === 'api_key' ? (
              <>
                <label className="modal-label">API Key / Integration Token</label>
                <input
                  className="modal-input"
                  type="password"
                  placeholder="Paste your integration token"
                  value={configForm.access_token}
                  onChange={(e) => setConfigForm({ ...configForm, access_token: e.target.value })}
                  required
                  autoFocus
                />
              </>
            ) : (
              <>
                <label className="modal-label">Client ID</label>
                <input
                  className="modal-input"
                  placeholder="e.g. xxx.apps.googleusercontent.com"
                  value={configForm.oauth_client_id}
                  onChange={(e) => setConfigForm({ ...configForm, oauth_client_id: e.target.value })}
                  required
                  autoFocus
                />

                <label className="modal-label">Client Secret</label>
                <input
                  className="modal-input"
                  type="password"
                  placeholder="e.g. GOCSPX-xxx"
                  value={configForm.oauth_client_secret}
                  onChange={(e) => setConfigForm({ ...configForm, oauth_client_secret: e.target.value })}
                  required
                />
              </>
            )}

            <div className="modal-actions">
              <button
                type="button"
                className="modal-cancel"
                onClick={() => setShowConfigModal(null)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="modal-create"
                disabled={configuring || (
                  showConfigModal.auth_type === 'api_key'
                    ? !configForm.access_token.trim()
                    : !configForm.oauth_client_id.trim() || !configForm.oauth_client_secret.trim()
                )}
              >
                {configuring ? 'Saving...' : (showConfigModal.auth_type === 'api_key' ? 'Connect' : 'Save')}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  )
}
