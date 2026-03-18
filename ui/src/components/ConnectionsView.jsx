import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Download, Trash2, Plus, X, Link, Unlink, Settings, Key } from 'lucide-react'
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

const PROVIDER_LABELS = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
}

const HARNESS_LABELS = {
  claude_code: 'Claude Code',
  codex: 'Codex',
}

const CONNECTOR_STATUS_STYLES = {
  connected: { label: 'Connected', className: 'cn-badge--connected' },
  disconnected: { label: 'Disconnected', className: 'cn-badge--disconnected' },
  needs_config: { label: 'Not configured', className: 'cn-badge--needs-config' },
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
          <h1 className="cn-title">Skills</h1>
          <span className="cn-subtitle">
            {installed.length} installed
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
            {/* Agent Cards */}
            {agents.length > 0 && (
              <div className="cn-section">
                <h2 className="cn-section-title">Agents</h2>
                <div className="cn-grid">
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
                      <div key={agent.id} className="cn-card cn-agent-card">
                        <div className="cn-card-header">
                          <div className="cn-agent-card-identity">
                            <span className="cn-agent-card-emoji">{agent.emoji || '🤖'}</span>
                            <span className="cn-card-name">{agent.name}</span>
                          </div>
                        </div>

                        <div className="cn-agent-card-skills">
                          <div className="cn-agents-label">Skills</div>
                          <div className="cn-agents-list">
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
                            {assignedSkills.length === 0 && (
                              <span className="cn-agents-none">No skills assigned</span>
                            )}
                            {availableSkills.length > 0 && (
                              <div className="cn-agent-add-wrap">
                                <button
                                  className="cn-skill-add-btn cn-agent-add-btn"
                                  onClick={() => {
                                    setAddingSkillToAgent(
                                      addingSkillToAgent === agent.id ? null : agent.id,
                                    )
                                    setAddingConnectorToAgent(null)
                                  }}
                                  disabled={assignBusy}
                                  title="Add skill"
                                >
                                  <Plus size={12} />
                                </button>
                                {addingSkillToAgent === agent.id && (
                                  <div className="cn-skill-dropdown cn-agent-dropdown">
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
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Connectors assigned to agent */}
                        <div className="cn-agent-card-skills">
                          <div className="cn-agents-label">Connectors</div>
                          <div className="cn-agents-list">
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
                            {assignedConns.length === 0 && (
                              <span className="cn-agents-none">No connectors assigned</span>
                            )}
                            {availableConns.length > 0 && (
                              <div className="cn-agent-add-wrap">
                                <button
                                  className="cn-connector-add-btn cn-agent-add-btn"
                                  onClick={() => {
                                    setAddingConnectorToAgent(
                                      addingConnectorToAgent === agent.id ? null : agent.id,
                                    )
                                    setAddingSkillToAgent(null)
                                  }}
                                  disabled={assignBusy}
                                  title="Add connector"
                                >
                                  <Plus size={12} />
                                </button>
                                {addingConnectorToAgent === agent.id && (
                                  <div className="cn-connector-dropdown cn-agent-dropdown">
                                    {availableConns.map((conn) => (
                                      <button
                                        key={conn.id}
                                        className="cn-agent-dropdown-item"
                                        onClick={() => handleAssignConnector(conn.id, agent.id)}
                                        disabled={assignBusy}
                                      >
                                        {conn.name}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>

                        {agentGlobalSkills.length > 0 && (
                          <div className="cn-agent-card-skills">
                            <div className="cn-agents-label">{harnessLabel} Skills</div>
                            <div className="cn-agents-list">
                              {agentGlobalSkills.map((skill) => (
                                <span key={`global-${skill.name}`} className="cn-agent-chip cn-agent-chip--global">
                                  <span className="cn-agent-chip-name">{skill.name}</span>
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        {agentMcpServers.length > 0 && (
                          <div className="cn-agent-card-skills">
                            <div className="cn-agents-label">{harnessLabel} MCP Servers</div>
                            <div className="cn-agents-list">
                              {agentMcpServers.map((server) => (
                                <span key={`mcp-${server.name}`} className="cn-agent-chip cn-agent-chip--mcp">
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

            {/* Connectors Section */}
            {connectors.length > 0 && (
              <div className="cn-section">
                <h2 className="cn-section-title">Connectors</h2>
                <div className="cn-grid">
                  {connectors.map((connector) => {
                    const statusInfo = CONNECTOR_STATUS_STYLES[connector.status] ||
                      CONNECTOR_STATUS_STYLES.disconnected
                    const isOAuth = connector.auth_type === 'oauth2'
                    const needsConfig = isOAuth && (!connector.has_client_id || !connector.has_client_secret)
                    const canConnect = isOAuth && connector.has_client_id && connector.has_client_secret && connector.status !== 'connected'
                    const isConnected = connector.status === 'connected'

                    return (
                      <div key={connector.id} className={`cn-card ${isConnected ? 'cn-card--installed' : ''}`}>
                        <div className="cn-card-header">
                          <span className="cn-card-name">{connector.name}</span>
                          <span className={`cn-badge ${statusInfo.className}`}>
                            {statusInfo.label}
                          </span>
                        </div>
                        {connector.description && (
                          <p className="cn-card-desc">{connector.description}</p>
                        )}
                        <div className="cn-card-meta">
                          <span className="cn-card-provider">{connector.provider}</span>
                          <span className="cn-card-auth-type">{isOAuth ? 'OAuth2' : 'API Key'}</span>
                        </div>
                        <div className="cn-card-footer">
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
                </div>
              </div>
            )}

            <div className="cn-section">
                <h2 className="cn-section-title">Skill Catalog</h2>
                <div className="cn-grid">
                  {/* Add Skill card — always first */}
                  <button
                    className="cn-card cn-add-skill-card"
                    onClick={() => setShowCreateModal(true)}
                  >
                    <Plus size={28} strokeWidth={1.5} />
                    <span className="cn-add-skill-label">New Skill</span>
                  </button>

                  {/* Installed skills first */}
                  {installed.map((skill) => (
                    <div key={skill.id} className="cn-card cn-card--installed">
                      <div className="cn-card-header">
                        <span className="cn-card-name">{skill.name}</span>
                        <span className="cn-badge cn-badge--installed">Installed</span>
                      </div>
                      {skill.description && (
                        <p className="cn-card-desc">{skill.description}</p>
                      )}
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
                  ))}

                  {/* Uninstalled catalog skills */}
                  {catalogSkills.filter((s) => !installedNames.has(s.name)).map((skill) => (
                    <div key={`catalog-${skill.provider}-${skill.name}`} className="cn-card">
                      <div className="cn-card-header">
                        <span className="cn-card-name">{skill.name}</span>
                      </div>
                      {skill.description && (
                        <p className="cn-card-desc">{skill.description}</p>
                      )}
                      <div className="cn-card-footer">
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
                  ))}
                </div>
              </div>

            {registry.length === 0 && installed.length === 0 && (
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
            <h2>Configure {showConfigModal.name}</h2>
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
