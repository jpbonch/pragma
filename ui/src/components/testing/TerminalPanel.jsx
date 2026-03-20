import { useEffect, useRef, useState } from 'react'
import { sendServiceStdin, openRuntimeServiceStream } from '../../api'

export function TerminalPanel({ taskId, panel, services, processStatuses }) {
  const [logs, setLogs] = useState([])
  const [inputValue, setInputValue] = useState('')
  const outputRef = useRef(null)
  const cleanupRef = useRef(null)

  const processName = panel.process || ''
  const svc = services[processName]
  const serviceId = svc?.id || null
  const svcStatus = serviceId ? (processStatuses[serviceId] || svc?.status) : null

  const suggestedInputs = Array.isArray(panel?.suggested_inputs) ? panel.suggested_inputs : []

  useEffect(() => {
    if (!serviceId) return

    setLogs([])
    const cleanup = openRuntimeServiceStream(serviceId, {
      onLog(entry) {
        if (!entry) return
        setLogs(prev => [...prev, entry])
      },
      onStatus() {},
      onReady() {},
    })
    cleanupRef.current = cleanup

    return () => {
      cleanup()
      cleanupRef.current = null
    }
  }, [serviceId])

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [logs])

  async function handleSend(text) {
    if (!serviceId || !text) return
    try {
      await sendServiceStdin(serviceId, text + '\n')
    } catch (err) {
      console.error('Failed to send stdin:', err)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend(inputValue)
      setInputValue('')
    }
  }

  return (
    <div className="terminal-panel">
      <pre className="terminal-output" ref={outputRef}>
        {logs.length === 0
          ? (svcStatus ? 'Waiting for output...' : 'Process not started.')
          : logs.map((entry, i) => {
              const text = entry?.text || ''
              const stream = entry?.stream || 'stdout'
              return (
                <span key={i} className={stream === 'stderr' ? 'log-entry-stderr' : ''}>
                  {text}
                </span>
              )
            })
        }
      </pre>

      {suggestedInputs.length > 0 && (
        <div className="terminal-suggested">
          {suggestedInputs.map((input, i) => (
            <button
              key={i}
              className="terminal-suggested-btn"
              onClick={() => handleSend(input)}
              disabled={!serviceId}
            >
              {input}
            </button>
          ))}
        </div>
      )}

      <div className="terminal-input-row">
        <input
          className="terminal-input"
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={serviceId ? 'Type a command...' : 'Process not started'}
          disabled={!serviceId}
        />
      </div>
    </div>
  )
}
