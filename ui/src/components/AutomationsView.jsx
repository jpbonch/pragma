import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Plus,
  Trash2,
  ChevronLeft,
  AlertCircle,
  CheckCircle2,
  Clock,
  Activity,
  X,
  Timer,
  Zap,
} from 'lucide-react'
import {
  fetchAutomations,
  createAutomation,
  updateAutomation,
  deleteAutomation as deleteAutomationApi,
  fetchAutomationRuns,
  fetchEvents,
} from '../api'

const TRIGGER_OPTIONS = [
  'task.completed',
  'task.failed',
  'task.created',
  'task.*',
  'plan.approved',
  'plan.created',
  'plan.*',
  'agent.created',
  'agent.deleted',
]

const ACTION_TYPES = [
  { value: 'webhook', label: 'Webhook' },
  { value: 'create_task', label: 'Create Task' },
  { value: 'log', label: 'Log' },
]

const SCHEDULE_PRESETS = [
  { label: 'Every minute', cron: '* * * * *' },
  { label: 'Every 5 minutes', cron: '*/5 * * * *' },
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Every 30 minutes', cron: '*/30 * * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Every day at midnight', cron: '0 0 * * *' },
  { label: 'Every day at 9am', cron: '0 9 * * *' },
  { label: 'Every Monday at 9am', cron: '0 9 * * 1' },
  { label: 'Custom', cron: '' },
]

const EMPTY_FORM = {
  name: '',
  trigger_type: 'event',
  trigger_event: '',
  trigger_filter: '',
  schedule_cron: '',
  schedule_timezone: 'UTC',
  action_type: 'webhook',
  action_config: {},
  enabled: true,
}

function describeCron(cron) {
  if (!cron) return ''
  const preset = SCHEDULE_PRESETS.find((p) => p.cron === cron)
  if (preset && preset.label !== 'Custom') return preset.label
  return cron
}

function timeAgo(value) {
  if (!value) return ''
  const seconds = Math.floor((Date.now() - new Date(value).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function ActionConfigForm({ actionType, config, onChange }) {
  if (actionType === 'webhook') {
    return (
      <div className="aut-action-fields">
        <label className="aut-field-label">URL</label>
        <input
          className="aut-input"
          placeholder="https://example.com/webhook"
          value={config.url || ''}
          onChange={(e) => onChange({ ...config, url: e.target.value })}
        />
        <label className="aut-field-label">Method</label>
        <select
          className="aut-select"
          value={config.method || 'POST'}
          onChange={(e) => onChange({ ...config, method: e.target.value })}
        >
          <option value="POST">POST</option>
          <option value="GET">GET</option>
          <option value="PUT">PUT</option>
          <option value="PATCH">PATCH</option>
        </select>
        <label className="aut-field-label">Headers (JSON)</label>
        <textarea
          className="aut-textarea"
          placeholder='{"Authorization": "Bearer ..."}'
          value={config.headers || ''}
          rows={2}
          onChange={(e) => onChange({ ...config, headers: e.target.value })}
        />
      </div>
    )
  }

  if (actionType === 'create_task') {
    return (
      <div className="aut-action-fields">
        <label className="aut-field-label">Title template</label>
        <input
          className="aut-input"
          placeholder="Follow-up: {{event.task_title}}"
          value={config.title_template || ''}
          onChange={(e) => onChange({ ...config, title_template: e.target.value })}
        />
        <label className="aut-field-label">Description template</label>
        <textarea
          className="aut-textarea"
          placeholder="Automatically created from {{event.type}}"
          value={config.description_template || ''}
          rows={3}
          onChange={(e) => onChange({ ...config, description_template: e.target.value })}
        />
        <label className="aut-field-label">Agent assignment</label>
        <input
          className="aut-input"
          placeholder="agent-id (optional)"
          value={config.agent_id || ''}
          onChange={(e) => onChange({ ...config, agent_id: e.target.value })}
        />
      </div>
    )
  }

  if (actionType === 'log') {
    return (
      <div className="aut-action-fields">
        <label className="aut-field-label">Message template</label>
        <textarea
          className="aut-textarea"
          placeholder="Event {{event.type}} fired for task {{event.task_id}}"
          value={config.message_template || ''}
          rows={3}
          onChange={(e) => onChange({ ...config, message_template: e.target.value })}
        />
      </div>
    )
  }

  return null
}

function ScheduleConfigForm({ cron, timezone, onCronChange, onTimezoneChange }) {
  const isPreset = SCHEDULE_PRESETS.some((p) => p.cron === cron && p.label !== 'Custom')
  const [selectedPreset, setSelectedPreset] = useState(
    isPreset ? cron : (cron ? '' : SCHEDULE_PRESETS[0].cron)
  )

  function handlePresetChange(e) {
    const val = e.target.value
    setSelectedPreset(val)
    if (val !== '') {
      onCronChange(val)
    }
  }

  const showCustomInput = selectedPreset === '' || (!isPreset && cron)

  return (
    <div className="aut-action-fields">
      <label className="aut-field-label">Schedule</label>
      <select
        className="aut-select"
        value={isPreset ? cron : ''}
        onChange={handlePresetChange}
      >
        {SCHEDULE_PRESETS.map((p) => (
          <option key={p.label} value={p.cron}>{p.label}</option>
        ))}
      </select>

      {showCustomInput && (
        <>
          <label className="aut-field-label">Cron expression</label>
          <input
            className="aut-input aut-cron-input"
            placeholder="* * * * *  (min hour dom mon dow)"
            value={cron}
            onChange={(e) => onCronChange(e.target.value)}
          />
          <span className="aut-cron-hint">
            Format: minute hour day-of-month month day-of-week
          </span>
        </>
      )}

      <label className="aut-field-label">Timezone</label>
      <input
        className="aut-input"
        placeholder="UTC"
        value={timezone || 'UTC'}
        onChange={(e) => onTimezoneChange(e.target.value)}
      />
    </div>
  )
}

function RunHistory({ automationId }) {
  const [runs, setRuns] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError('')
      try {
        const data = await fetchAutomationRuns(automationId)
        if (!cancelled) setRuns(data)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [automationId])

  if (loading) return <div className="aut-runs-loading">Loading runs...</div>
  if (error) return <div className="aut-runs-error">{error}</div>
  if (runs.length === 0) return <div className="aut-runs-empty">No runs yet</div>

  return (
    <div className="aut-runs-list">
      {runs.map((run, index) => (
        <div key={run.id || index} className="aut-run-row">
          <span className={`aut-run-status ${run.status === 'success' ? 'success' : 'error'}`}>
            {run.status === 'success' ? (
              <CheckCircle2 size={12} />
            ) : (
              <AlertCircle size={12} />
            )}
            {run.status}
          </span>
          <span className="aut-run-time">{timeAgo(run.created_at || run.timestamp)}</span>
        </div>
      ))}
    </div>
  )
}

function EventLog() {
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [typeFilter, setTypeFilter] = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError('')
      try {
        const params = { limit: 50 }
        if (typeFilter) params.type = typeFilter
        const data = await fetchEvents(params)
        if (!cancelled) setEvents(data)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [typeFilter])

  return (
    <div className="aut-event-log">
      <div className="aut-event-log-header">
        <h3 className="aut-section-heading">Event Log</h3>
        <input
          className="aut-input aut-event-filter"
          placeholder="Filter by event type..."
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
        />
      </div>
      {loading && <div className="aut-runs-loading">Loading events...</div>}
      {error && <div className="aut-runs-error">{error}</div>}
      {!loading && !error && events.length === 0 && (
        <div className="aut-runs-empty">No events found</div>
      )}
      {!loading && !error && events.length > 0 && (
        <div className="aut-event-list">
          {events.map((event, index) => (
            <div key={event.id || index} className="aut-event-row">
              <span className="aut-event-type">{event.type || event.event_type}</span>
              {event.task_id && <span className="aut-event-task">task: {event.task_id.slice(0, 8)}</span>}
              <span className="aut-run-time">{timeAgo(event.created_at || event.timestamp)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function AutomationsView() {
  const [automations, setAutomations] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(null) // null = list view, 'new' or automation id
  const [form, setForm] = useState({ ...EMPTY_FORM })
  const [saveLoading, setSaveLoading] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [expandedRunsId, setExpandedRunsId] = useState('')
  const [subTab, setSubTab] = useState('automations') // 'automations' | 'events'

  const nameInputRef = useRef(null)

  useEffect(() => {
    void loadAutomations()
  }, [])

  useEffect(() => {
    if (editing && nameInputRef.current) {
      nameInputRef.current.focus()
    }
  }, [editing])

  async function loadAutomations() {
    setLoading(true)
    setError('')
    try {
      const data = await fetchAutomations()
      setAutomations(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  function handleNew() {
    setForm({ ...EMPTY_FORM })
    setSaveError('')
    setEditing('new')
  }

  function handleEdit(automation) {
    setForm({
      name: automation.name || '',
      trigger_type: automation.triggerType || 'event',
      trigger_event: automation.trigger?.eventType || automation.trigger_event || '',
      trigger_filter: typeof automation.trigger?.filter === 'string'
        ? automation.trigger.filter
        : automation.trigger?.filter ? JSON.stringify(automation.trigger.filter) : '',
      schedule_cron: automation.schedule?.cron || '',
      schedule_timezone: automation.schedule?.timezone || 'UTC',
      action_type: automation.action?.type || automation.action_type || 'webhook',
      action_config: (() => {
        const action = automation.action || {}
        const { type, ...rest } = action
        return rest
      })(),
      enabled: automation.enabled !== false,
    })
    setSaveError('')
    setEditing(automation.id)
  }

  function handleCancel() {
    setEditing(null)
    setSaveError('')
  }

  async function handleSave() {
    if (!form.name.trim()) { setSaveError('Name is required.'); return }
    if (form.trigger_type === 'event' && !form.trigger_event) { setSaveError('Trigger event is required.'); return }
    if (form.trigger_type === 'schedule' && !form.schedule_cron.trim()) { setSaveError('Cron expression is required for scheduled automations.'); return }
    if (!form.action_type) { setSaveError('Action type is required.'); return }

    setSaveLoading(true)
    setSaveError('')

    const payload = {
      name: form.name.trim(),
      triggerType: form.trigger_type,
      action: {
        type: form.action_type,
        ...form.action_config,
      },
      enabled: form.enabled,
    }

    if (form.trigger_type === 'event') {
      payload.trigger = { eventType: form.trigger_event }
      if (form.trigger_filter.trim()) {
        try {
          payload.trigger.filter = JSON.parse(form.trigger_filter)
        } catch {
          payload.trigger.filter = form.trigger_filter.trim()
        }
      }
    } else {
      payload.schedule = {
        cron: form.schedule_cron.trim(),
        timezone: form.schedule_timezone || 'UTC',
      }
    }

    try {
      if (editing === 'new') {
        await createAutomation(payload)
      } else {
        await updateAutomation(editing, payload)
      }
      await loadAutomations()
      setEditing(null)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaveLoading(false)
    }
  }

  async function handleDelete(id) {
    try {
      await deleteAutomationApi(id)
      setDeleteConfirm('')
      await loadAutomations()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleToggleEnabled(automation) {
    try {
      await updateAutomation(automation.id, { enabled: !automation.enabled })
      await loadAutomations()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  // Editor view
  if (editing) {
    return (
      <section className="aut-view">
        <div className="aut-editor">
          <div className="aut-editor-header">
            <button className="aut-back-btn" onClick={handleCancel}>
              <ChevronLeft size={14} />
              Back
            </button>
            <h2 className="aut-editor-title">
              {editing === 'new' ? 'New Automation' : 'Edit Automation'}
            </h2>
          </div>

          {saveError && <div className="aut-error">{saveError}</div>}

          <div className="aut-form">
            <label className="aut-field-label">Name</label>
            <input
              ref={nameInputRef}
              className="aut-input"
              value={form.name}
              placeholder="My automation"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />

            <label className="aut-field-label">Trigger type</label>
            <div className="aut-trigger-type-row">
              <button
                type="button"
                className={`aut-trigger-type-btn ${form.trigger_type === 'event' ? 'active' : ''}`}
                onClick={() => setForm({ ...form, trigger_type: 'event' })}
              >
                <Zap size={14} />
                Event
              </button>
              <button
                type="button"
                className={`aut-trigger-type-btn ${form.trigger_type === 'schedule' ? 'active' : ''}`}
                onClick={() => setForm({ ...form, trigger_type: 'schedule' })}
              >
                <Timer size={14} />
                Schedule
              </button>
            </div>

            {form.trigger_type === 'event' && (
              <>
                <label className="aut-field-label">Trigger event</label>
                <select
                  className="aut-select"
                  value={form.trigger_event}
                  onChange={(e) => setForm({ ...form, trigger_event: e.target.value })}
                >
                  <option value="">Select event...</option>
                  {TRIGGER_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>

                <label className="aut-field-label">Trigger filter (optional JSON)</label>
                <textarea
                  className="aut-textarea"
                  placeholder='{"status": "completed"}'
                  value={form.trigger_filter}
                  rows={2}
                  onChange={(e) => setForm({ ...form, trigger_filter: e.target.value })}
                />
              </>
            )}

            {form.trigger_type === 'schedule' && (
              <ScheduleConfigForm
                cron={form.schedule_cron}
                timezone={form.schedule_timezone}
                onCronChange={(cron) => setForm({ ...form, schedule_cron: cron })}
                onTimezoneChange={(tz) => setForm({ ...form, schedule_timezone: tz })}
              />
            )}

            <label className="aut-field-label">Action type</label>
            <select
              className="aut-select"
              value={form.action_type}
              onChange={(e) => setForm({ ...form, action_type: e.target.value, action_config: {} })}
            >
              {ACTION_TYPES.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>

            <ActionConfigForm
              actionType={form.action_type}
              config={form.action_config}
              onChange={(config) => setForm({ ...form, action_config: config })}
            />

            <div className="aut-toggle-row">
              <label className="aut-field-label" style={{ marginBottom: 0 }}>Enabled</label>
              <button
                className={`aut-toggle ${form.enabled ? 'on' : ''}`}
                onClick={() => setForm({ ...form, enabled: !form.enabled })}
                type="button"
              >
                <span className="aut-toggle-knob" />
              </button>
            </div>

            <div className="aut-form-actions">
              <button className="aut-cancel-btn" onClick={handleCancel} disabled={saveLoading}>
                Cancel
              </button>
              <button className="aut-save-btn" onClick={handleSave} disabled={saveLoading}>
                {saveLoading ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      </section>
    )
  }

  // List view
  return (
    <section className="aut-view">
      <div className="aut-main">
        <div className="main-topbar">
          <h1>Automations</h1>
        </div>

        <div className="aut-subtabs">
          <button
            className={`aut-subtab ${subTab === 'automations' ? 'active' : ''}`}
            onClick={() => setSubTab('automations')}
          >
            Automations
          </button>
          <button
            className={`aut-subtab ${subTab === 'events' ? 'active' : ''}`}
            onClick={() => setSubTab('events')}
          >
            Event Log
          </button>
        </div>

        {subTab === 'events' && <EventLog />}

        {subTab === 'automations' && (
          <>
            <div className="aut-toolbar">
              <button className="aut-new-btn" onClick={handleNew}>
                <Plus size={14} />
                New Automation
              </button>
            </div>

            {loading && <div className="aut-loading">Loading automations...</div>}
            {error && <div className="aut-error">{error}</div>}

            {!loading && !error && automations.length === 0 && (
              <div className="aut-empty">
                <p>No automations yet.</p>
                <p className="aut-empty-hint">
                  Automations let you trigger actions (webhooks, task creation, logging)
                  when events occur or on a timed schedule.
                </p>
              </div>
            )}

            {!loading && !error && automations.length > 0 && (
              <div className="aut-list">
                {automations.map((automation) => {
                  const isSchedule = automation.triggerType === 'schedule'
                  return (
                    <div key={automation.id} className="aut-card">
                      <div className="aut-card-main" onClick={() => handleEdit(automation)}>
                        <div className="aut-card-left">
                          <div className="aut-card-name">{automation.name}</div>
                          <div className="aut-card-meta">
                            {isSchedule ? (
                              <span className="aut-card-trigger aut-card-trigger-schedule">
                                <Timer size={10} />
                                {describeCron(automation.schedule?.cron)}
                              </span>
                            ) : (
                              <span className="aut-card-trigger">
                                {automation.trigger?.eventType || automation.trigger_event}
                              </span>
                            )}
                            <span className="aut-card-arrow">&rarr;</span>
                            <span className="aut-card-action">
                              {automation.action?.type || automation.action_type}
                            </span>
                          </div>
                        </div>
                        <div className="aut-card-right">
                          {automation.last_run_status && (
                            <span className={`aut-card-status ${automation.last_run_status === 'success' ? 'success' : 'error'}`}>
                              {automation.last_run_status === 'success' ? (
                                <CheckCircle2 size={12} />
                              ) : (
                                <AlertCircle size={12} />
                              )}
                            </span>
                          )}
                          {typeof automation.run_count === 'number' && (
                            <span className="aut-card-count">{automation.run_count} runs</span>
                          )}
                          <button
                            className={`aut-toggle ${automation.enabled ? 'on' : ''}`}
                            onClick={(e) => { e.stopPropagation(); handleToggleEnabled(automation) }}
                            title={automation.enabled ? 'Disable' : 'Enable'}
                          >
                            <span className="aut-toggle-knob" />
                          </button>
                          {deleteConfirm === automation.id ? (
                            <div className="aut-delete-confirm" onClick={(e) => e.stopPropagation()}>
                              <span className="aut-delete-confirm-text">Delete?</span>
                              <button
                                className="aut-delete-yes"
                                onClick={() => handleDelete(automation.id)}
                              >
                                Yes
                              </button>
                              <button
                                className="aut-delete-no"
                                onClick={() => setDeleteConfirm('')}
                              >
                                No
                              </button>
                            </div>
                          ) : (
                            <button
                              className="aut-delete-btn"
                              onClick={(e) => { e.stopPropagation(); setDeleteConfirm(automation.id) }}
                              title="Delete"
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="aut-card-expand">
                        <button
                          className="aut-runs-toggle"
                          onClick={() => setExpandedRunsId(expandedRunsId === automation.id ? '' : automation.id)}
                        >
                          <Activity size={12} />
                          {expandedRunsId === automation.id ? 'Hide runs' : 'Show runs'}
                        </button>
                      </div>

                      {expandedRunsId === automation.id && (
                        <RunHistory automationId={automation.id} />
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}
