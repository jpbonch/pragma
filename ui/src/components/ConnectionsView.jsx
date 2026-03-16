import { useEffect, useState } from 'react'
import { AlertCircle, Check, Download, Trash2 } from 'lucide-react'
import {
  fetchSkillRegistry,
  fetchInstalledSkills,
  installRegistrySkill,
  deleteSkill,
} from '../api'

const PROVIDER_LABELS = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
}

export function ConnectionsView() {
  const [registry, setRegistry] = useState([])
  const [installed, setInstalled] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [installing, setInstalling] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [actionError, setActionError] = useState('')

  async function loadData() {
    setLoading(true)
    setError('')
    try {
      const [reg, inst] = await Promise.all([
        fetchSkillRegistry(),
        fetchInstalledSkills(),
      ])
      setRegistry(reg)
      setInstalled(inst)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [])

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
      const inst = await fetchInstalledSkills()
      setInstalled(inst)
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
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setRemoving(null)
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
            {installed.length} installed
          </span>
        </div>
      </div>

      <div className="cn-content">
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

            {registry.length === 0 && installed.length === 0 && (
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
