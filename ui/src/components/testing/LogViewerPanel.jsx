import { useEffect, useRef, useState } from 'react'

export function LogViewerPanel({ panel, services, processLogs }) {
  const [filter, setFilter] = useState('all')
  const [autoScroll, setAutoScroll] = useState(true)
  const contentRef = useRef(null)

  const serviceName = panel._serviceName || ''
  const svc = services[serviceName]
  const serviceId = svc?.id || null

  const rawLogs = serviceId && processLogs[serviceId] ? processLogs[serviceId] : []

  const filteredLogs = filter === 'all'
    ? rawLogs
    : rawLogs.filter(entry => (entry?.stream || 'stdout') === filter)

  useEffect(() => {
    if (autoScroll && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [filteredLogs.length, autoScroll])

  return (
    <div className="log-viewer">
      <div className="log-viewer-filters">
        {['all', 'stdout', 'stderr', 'system'].map(f => (
          <button
            key={f}
            className={`log-viewer-filter-btn ${filter === f ? 'active' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? 'All' : f}
          </button>
        ))}
        <button
          className={`log-viewer-filter-btn ${autoScroll ? 'active' : ''}`}
          onClick={() => setAutoScroll(v => !v)}
          style={{ marginLeft: 'auto' }}
        >
          Auto-scroll
        </button>
      </div>

      <div className="log-viewer-content" ref={contentRef}>
        {filteredLogs.length === 0 ? (
          <div className="muted" style={{ fontSize: 12 }}>No logs yet.</div>
        ) : (
          filteredLogs.map((entry, i) => {
            const stream = entry?.stream || 'stdout'
            const text = entry?.text || ''
            const ts = entry?.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : ''
            return (
              <div key={i} className={`log-entry log-entry-${stream}`}>
                {ts && <span style={{ opacity: 0.5, marginRight: 8 }}>[{ts}]</span>}
                {text}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
