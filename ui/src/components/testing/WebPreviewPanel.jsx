import { useState } from 'react'

export function WebPreviewPanel({ panel, services, config, processStatuses }) {
  const [device, setDevice] = useState('desktop')
  const [iframeKey, setIframeKey] = useState(0)

  const processName = panel.process || ''
  const svc = services[processName]
  const svcStatus = svc?.id ? (processStatuses[svc.id] || svc.status) : null
  const isReady = svcStatus === 'ready'

  const processConfig = Array.isArray(config?.processes)
    ? config.processes.find((proc) => proc?.name === processName)
    : null
  const port = svc?.port || processConfig?.port || panel.port || null
  const path = panel.path || '/'
  const url = port ? `http://localhost:${port}${path}` : ''

  function handleRefresh() {
    setIframeKey(k => k + 1)
  }

  function handleOpenExternal() {
    window.open(url, '_blank')
  }

  return (
    <div className="web-preview">
      <div className="web-preview-toolbar">
        <button
          className={`web-preview-device-btn ${device === 'desktop' ? 'active' : ''}`}
          onClick={() => setDevice('desktop')}
          title="Desktop"
        >
          Desktop
        </button>
        <button
          className={`web-preview-device-btn ${device === 'tablet' ? 'active' : ''}`}
          onClick={() => setDevice('tablet')}
          title="Tablet"
        >
          Tablet
        </button>
        <button
          className={`web-preview-device-btn ${device === 'mobile' ? 'active' : ''}`}
          onClick={() => setDevice('mobile')}
          title="Mobile"
        >
          Mobile
        </button>
        <button className="web-preview-device-btn" onClick={handleRefresh} title="Refresh">
          Refresh
        </button>
        <button className="web-preview-device-btn" onClick={handleOpenExternal} title="Open in new tab">
          Open
        </button>
        <span className="web-preview-url">{url || 'Waiting for process URL...'}</span>
      </div>

      <div className="web-preview-container">
        {!isReady || !url ? (
          <div className="web-preview-waiting">
            <span className="conv-thinking-dot" />
            <span style={{ marginLeft: 8 }}>
              {!port ? 'Waiting for process port...' : 'Waiting for server to be ready...'}
            </span>
          </div>
        ) : (
          <div className={`web-preview-frame ${device}`}>
            <iframe
              key={iframeKey}
              className="web-preview-iframe"
              src={url}
              title="Web Preview"
            />
          </div>
        )}
      </div>
    </div>
  )
}
