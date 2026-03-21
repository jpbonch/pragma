import { useEffect, useRef, useState } from 'react'
import { startTaskTesting, stopTaskTesting, openRuntimeServiceStream, updateTaskTestingConfig, fetchTaskTestingServices } from '../api'
import { ApiTesterPanel } from './testing/ApiTesterPanel'
import { WebPreviewPanel } from './testing/WebPreviewPanel'
import { TerminalPanel } from './testing/TerminalPanel'
import { LogViewerPanel } from './testing/LogViewerPanel'

function ProcessBadge({ name, status }) {
  let dotClass = 'testing-process-dot'
  if (status === 'ready') dotClass += ' ready'
  else if (status === 'exited' || status === 'stopped') dotClass += ' exited'
  else dotClass += ' starting'

  return (
    <div className="testing-process-badge">
      <span className={dotClass} />
      <span>{name}</span>
    </div>
  )
}

export function TestingPane({ taskId, config, onConfigUpdated, initialServices }) {
  const [services, setServices] = useState({})
  const [started, setStarted] = useState(false)
  const [starting, setStarting] = useState(false)
  const [activePanel, setActivePanel] = useState(0)
  const [showLogs, setShowLogs] = useState(false)
  const [processLogs, setProcessLogs] = useState({})
  const [processStatuses, setProcessStatuses] = useState({})
  const [editing, setEditing] = useState(false)
  const [editDraft, setEditDraft] = useState('')
  const [editError, setEditError] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const cleanupRef = useRef([])

  const panels = Array.isArray(config?.services)
    ? config.services.flatMap((svc, i) =>
        (svc.panels || []).map(p => ({ ...p, _serviceName: svc.name || `service-${i}` }))
      )
    : []
  const services_list = Array.isArray(config?.services) ? config.services : []

  useEffect(() => {
    return () => {
      for (const cleanup of cleanupRef.current) {
        cleanup()
      }
      cleanupRef.current = []
    }
  }, [])

  useEffect(() => {
    if (!taskId) return
    let cancelled = false
    // Check for already-running services (auto-started on config submission)
    const initSvcs = initialServices && typeof initialServices === 'object' && Object.keys(initialServices).length > 0
      ? initialServices
      : null
    if (initSvcs) {
      setServices(initSvcs)
      setStarted(true)
      const initialStatuses = {}
      for (const [, svc] of Object.entries(initSvcs)) {
        if (svc && svc.id) {
          initialStatuses[svc.id] = svc.status || 'running'
          subscribeToService(svc.id)
        }
      }
      setProcessStatuses(initialStatuses)
      return
    }
    void fetchTaskTestingServices(taskId).then(data => {
      if (cancelled) return
      const svcMap = data?.services && typeof data.services === 'object' ? data.services : {}
      if (Object.keys(svcMap).length > 0) {
        setServices(svcMap)
        setStarted(true)
        const initialStatuses = {}
        for (const [, svc] of Object.entries(svcMap)) {
          if (svc && svc.id) {
            initialStatuses[svc.id] = svc.status || 'running'
            subscribeToService(svc.id)
          }
        }
        setProcessStatuses(initialStatuses)
      }
    }).catch(() => {})
    return () => { cancelled = true }
  }, [taskId])

  function subscribeToService(serviceId) {
    const cleanup = openRuntimeServiceStream(serviceId, {
      onLog(entry) {
        if (!entry) return
        setProcessLogs(prev => ({
          ...prev,
          [serviceId]: [...(prev[serviceId] || []), entry],
        }))
      },
      onStatus(data) {
        if (data && typeof data.status === 'string') {
          setProcessStatuses(prev => ({ ...prev, [serviceId]: data.status }))
        }
      },
      onReady() {
        setProcessStatuses(prev => ({ ...prev, [serviceId]: 'ready' }))
      },
    })
    cleanupRef.current.push(cleanup)
  }

  async function handleStart() {
    if (starting) return
    setStarting(true)
    try {
      const result = await startTaskTesting(taskId)
      const svcMap = result?.services && typeof result.services === 'object' ? result.services : {}
      setServices(svcMap)
      setStarted(true)

      const initialStatuses = {}
      for (const [, svc] of Object.entries(svcMap)) {
        if (svc && svc.id) {
          initialStatuses[svc.id] = svc.status || 'running'
          subscribeToService(svc.id)
        }
      }
      setProcessStatuses(initialStatuses)
    } catch (err) {
      console.error('Failed to start testing:', err)
    } finally {
      setStarting(false)
    }
  }

  async function handleStop() {
    try {
      await stopTaskTesting(taskId)
    } catch (err) {
      console.error('Failed to stop testing:', err)
    }
    for (const cleanup of cleanupRef.current) {
      cleanup()
    }
    cleanupRef.current = []
    setStarted(false)
    setServices({})
    setProcessStatuses({})
    setProcessLogs({})
  }

  function getServiceStatus(serviceName) {
    const svc = services[serviceName]
    if (!svc || !svc.id) return null
    return processStatuses[svc.id] || svc.status || 'running'
  }

  function handleEditOpen() {
    setEditDraft(JSON.stringify(config, null, 2))
    setEditError('')
    setEditing(true)
  }

  function handleEditCancel() {
    setEditing(false)
    setEditError('')
  }

  async function handleEditSave() {
    setEditError('')
    let parsed
    try {
      parsed = JSON.parse(editDraft)
    } catch {
      setEditError('Invalid JSON')
      return
    }
    setEditSaving(true)
    try {
      await updateTaskTestingConfig(taskId, parsed)
      setEditing(false)
      if (onConfigUpdated) onConfigUpdated(parsed)
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err))
    } finally {
      setEditSaving(false)
    }
  }

  function renderPanel() {
    const panel = panels[activePanel]
    if (!panel) return null

    const type = panel.type
    if (type === 'api-tester') {
      return <ApiTesterPanel taskId={taskId} panel={panel} services={services} processStatuses={processStatuses} />
    }
    if (type === 'web-preview') {
      return <WebPreviewPanel taskId={taskId} panel={panel} services={services} processStatuses={processStatuses} />
    }
    if (type === 'terminal') {
      return <TerminalPanel taskId={taskId} panel={panel} services={services} processStatuses={processStatuses} />
    }
    if (type === 'log-viewer') {
      return <LogViewerPanel panel={panel} services={services} processLogs={processLogs} />
    }
    return <div className="muted" style={{ padding: 12 }}>Unknown panel type: {type}</div>
  }

  const logEntries = Object.entries(processLogs).flatMap(([, logs]) => logs)

  return (
    <div className="testing-pane">
      <div className="testing-toolbar">
        {!started ? (
          <button className="testing-start-btn" onClick={handleStart} disabled={starting}>
            {starting ? 'Starting...' : 'Start Testing'}
          </button>
        ) : (
          <button className="testing-stop-btn" onClick={handleStop}>
            Stop
          </button>
        )}
        <div className="testing-process-badges">
          {services_list.map((svc, i) => {
            const svcName = svc.name || `service-${i}`
            return (
              <ProcessBadge
                key={svcName}
                name={svc.name || svc.command}
                status={started ? (getServiceStatus(svcName) || 'starting') : 'stopped'}
              />
            )
          })}
        </div>
        <button className="testing-edit-btn" onClick={handleEditOpen} disabled={editing} title="Edit testing config">
          Edit Config
        </button>
      </div>

      {editing && (
        <div className="testing-edit-overlay">
          <div className="testing-edit-header">
            <span>Edit Testing Config</span>
            <div className="testing-edit-actions">
              <button className="testing-edit-cancel" onClick={handleEditCancel} disabled={editSaving}>Cancel</button>
              <button className="testing-edit-save" onClick={handleEditSave} disabled={editSaving}>
                {editSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
          {editError && <div className="testing-edit-error">{editError}</div>}
          <textarea
            className="testing-edit-textarea"
            value={editDraft}
            onChange={e => setEditDraft(e.target.value)}
            spellCheck={false}
          />
        </div>
      )}

      {panels.length > 1 && (
        <div className="testing-panel-tabs">
          {panels.map((panel, i) => (
            <button
              key={i}
              className={`testing-panel-tab ${activePanel === i ? 'active' : ''}`}
              onClick={() => setActivePanel(i)}
            >
              {panel.title || panel.type}
            </button>
          ))}
        </div>
      )}

      <div className="testing-panel-content">
        {renderPanel()}
      </div>

      <div className="testing-log-drawer-wrap">
        <button className="testing-log-toggle" onClick={() => setShowLogs(v => !v)}>
          {showLogs ? '▼' : '▶'} Logs ({logEntries.length})
        </button>
        {showLogs && (
          <div className="testing-log-drawer">
            {logEntries.length === 0 ? (
              <div className="muted" style={{ padding: '4px 12px', fontSize: 12 }}>No logs yet.</div>
            ) : (
              logEntries.map((entry, i) => {
                const stream = entry?.stream || 'stdout'
                const text = entry?.text || ''
                return (
                  <div key={i} className={`log-entry log-entry-${stream}`}>
                    {text}
                  </div>
                )
              })
            )}
          </div>
        )}
      </div>
    </div>
  )
}
