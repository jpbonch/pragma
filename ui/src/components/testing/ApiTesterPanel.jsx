import { useState } from 'react'
import { proxyTestingRequest } from '../../api'

function statusClass(code) {
  if (code >= 200 && code < 300) return 'success'
  if (code >= 400 && code < 500) return 'client-error'
  return 'server-error'
}

function hasBody(method) {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method?.toUpperCase())
}

function EndpointCard({ taskId, endpoint, panel, services, processStatuses, defaultExpanded }) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [bodyText, setBodyText] = useState(() => {
    if (endpoint.body == null) return ''
    if (typeof endpoint.body === 'string') return endpoint.body
    return JSON.stringify(endpoint.body, null, 2)
  })
  const [headersEntries, setHeadersEntries] = useState(() => {
    if (endpoint.headers && typeof endpoint.headers === 'object') {
      return Object.entries(endpoint.headers).map(([k, v]) => ({ key: k, value: v }))
    }
    return []
  })
  const [responseData, setResponseData] = useState(null)
  const [responseLoading, setResponseLoading] = useState(false)
  const [responseError, setResponseError] = useState('')

  const method = (endpoint.method || 'GET').toUpperCase()
  const path = endpoint.path || '/'
  const description = endpoint.description || ''

  const serviceName = panel._serviceName || ''
  const svc = services[serviceName]
  const svcStatus = svc?.id ? (processStatuses[svc.id] || svc.status) : null
  const isReady = svcStatus === 'ready'

  function addHeader() {
    setHeadersEntries(prev => [...prev, { key: '', value: '' }])
  }

  function removeHeader(index) {
    setHeadersEntries(prev => prev.filter((_, i) => i !== index))
  }

  function updateHeader(index, field, value) {
    setHeadersEntries(prev => prev.map((h, i) => i === index ? { ...h, [field]: value } : h))
  }

  async function handleSend() {
    if (responseLoading || !isReady) return
    setResponseLoading(true)
    setResponseError('')
    setResponseData(null)

    const hdrs = {}
    for (const h of headersEntries) {
      if (h.key.trim()) hdrs[h.key.trim()] = h.value
    }

    try {
      const result = await proxyTestingRequest(taskId, {
        process_name: serviceName,
        method,
        path,
        headers: Object.keys(hdrs).length > 0 ? hdrs : undefined,
        body: hasBody(method) && bodyText.trim() ? bodyText.trim() : undefined,
      })
      setResponseData(result)
    } catch (err) {
      setResponseError(err instanceof Error ? err.message : String(err))
    } finally {
      setResponseLoading(false)
    }
  }

  return (
    <div className="api-endpoint-card">
      <div className="api-endpoint-header" onClick={() => setExpanded(v => !v)}>
        <span className={`api-method-badge ${method.toLowerCase()}`}>{method}</span>
        <span className="api-endpoint-path">{path}</span>
        {description && <span className="api-endpoint-desc">{description}</span>}
        <span style={{ marginLeft: 'auto', opacity: 0.4, fontSize: 11 }}>{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div className="api-endpoint-body">
          <div className="api-headers-editor">
            <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4, opacity: 0.7 }}>Headers</div>
            {headersEntries.map((h, i) => (
              <div key={i} className="api-header-row">
                <input
                  className="api-header-input"
                  placeholder="Key"
                  value={h.key}
                  onChange={e => updateHeader(i, 'key', e.target.value)}
                />
                <input
                  className="api-header-input"
                  placeholder="Value"
                  value={h.value}
                  onChange={e => updateHeader(i, 'value', e.target.value)}
                />
                <button
                  className="api-header-remove-btn"
                  onClick={() => removeHeader(i)}
                  title="Remove header"
                >
                  x
                </button>
              </div>
            ))}
            <button className="api-header-add-btn" onClick={addHeader}>+ Add Header</button>
          </div>

          {hasBody(method) && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4, opacity: 0.7 }}>Body</div>
              <textarea
                className="api-body-editor"
                value={bodyText}
                onChange={e => setBodyText(e.target.value)}
                placeholder='{ "key": "value" }'
              />
            </div>
          )}

          <button
            className="api-send-btn"
            onClick={handleSend}
            disabled={responseLoading || !isReady}
          >
            {responseLoading ? 'Sending...' : !isReady ? 'Waiting for server...' : 'Send Request'}
          </button>

          {responseError && (
            <div className="error" style={{ marginTop: 8, fontSize: 12 }}>Error: {responseError}</div>
          )}

          {responseData && (
            <div className="api-response">
              <div className="api-response-status">
                <span className={`api-response-status-code ${statusClass(responseData.status)}`}>
                  {responseData.status}
                </span>
                {responseData.elapsed_ms != null && (
                  <span style={{ opacity: 0.6 }}>{responseData.elapsed_ms}ms</span>
                )}
              </div>
              <pre className="api-response-body">
                {typeof responseData.body === 'string'
                  ? responseData.body
                  : JSON.stringify(responseData.body, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function ApiTesterPanel({ taskId, panel, services, processStatuses }) {
  const endpoints = Array.isArray(panel?.endpoints) ? panel.endpoints : []

  if (endpoints.length === 0) {
    return <div className="muted" style={{ padding: 12 }}>No endpoints configured.</div>
  }

  return (
    <div className="api-tester">
      {endpoints.map((ep, i) => (
        <EndpointCard
          key={`${ep.method}-${ep.path}-${i}`}
          taskId={taskId}
          endpoint={ep}
          panel={panel}
          services={services}
          processStatuses={processStatuses}
          defaultExpanded={i === 0}
        />
      ))}
    </div>
  )
}
