import { useEffect, useState } from 'react'
import { fetchAvailableClis } from '../api'
import { CLI_LABELS } from '../lib/conversationUtils'

export function OnboardingModal({ open, canClose, onClose, onSubmit, loading, error }) {
  const [name, setName] = useState('')
  const [selectedHarness, setSelectedHarness] = useState('')
  const [clis, setClis] = useState(null)
  const [clisLoading, setClisLoading] = useState(false)
  const [clisError, setClisError] = useState('')

  useEffect(() => {
    if (open) {
      setName('')
      setSelectedHarness('')
      setClisLoading(true)
      setClisError('')
      fetchAvailableClis()
        .then((result) => {
          setClis(result)
          const firstAvailable = result.find((cli) => cli.available)
          if (firstAvailable) {
            setSelectedHarness(firstAvailable.id)
          }
        })
        .catch(() => {
          setClisError('Failed to detect available CLIs.')
        })
        .finally(() => {
          setClisLoading(false)
        })
    }
  }, [open])

  if (!open) {
    return null
  }

  const availableClis = clis ? clis.filter((cli) => cli.available) : []
  const hasAnyCli = availableClis.length > 0
  const canCreate = name.trim() && selectedHarness && hasAnyCli

  return (
    <div className="modal-backdrop">
      <div className="modal-card">
        <h2>Create workspace</h2>
        <p>Pick a workspace name and configure the orchestrator.</p>

        <label className="modal-label">Workspace Name</label>
        <input
          className="modal-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Product Launch"
        />

        <div className="orchestrator-config-section">
          <label className="modal-label">Configure Orchestrator</label>
          {clisLoading ? (
            <div className="orchestrator-config-loading">Detecting available CLIs...</div>
          ) : clisError ? (
            <div className="error">{clisError}</div>
          ) : clis ? (
            <>
              <div className="orchestrator-cli-options">
                {clis.map((cli) => (
                  <button
                    key={cli.id}
                    type="button"
                    className={
                      'orchestrator-cli-option' +
                      (selectedHarness === cli.id ? ' orchestrator-cli-option--selected' : '') +
                      (!cli.available ? ' orchestrator-cli-option--disabled' : '')
                    }
                    onClick={() => cli.available && setSelectedHarness(cli.id)}
                    disabled={!cli.available}
                  >
                    <span className="orchestrator-cli-name">{CLI_LABELS[cli.id] || cli.command}</span>
                    <span className="orchestrator-cli-command">{cli.command}</span>
                    {!cli.available && <span className="orchestrator-cli-unavailable">not installed</span>}
                  </button>
                ))}
              </div>
              {!hasAnyCli && (
                <div className="error">
                  No supported CLI found. Install at least one of: claude, codex.
                </div>
              )}
            </>
          ) : null}
        </div>

        {error && <div className="error">Error: {error}</div>}

        <div className="modal-actions">
          {canClose && (
            <button className="modal-cancel" onClick={onClose} disabled={loading}>
              Cancel
            </button>
          )}
          <button
            className="modal-create"
            onClick={() => onSubmit({ name, orchestrator_harness: selectedHarness })}
            disabled={loading || !canCreate}
          >
            {loading ? 'Creating...' : 'Create workspace'}
          </button>
        </div>
      </div>
    </div>
  )
}
