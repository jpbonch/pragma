import { useEffect, useRef, useState } from 'react'
import { startTestingApp, fetchTestingAppStatus } from '../api'

export function TestingPane({ taskId }) {
  const iframeRef = useRef(null)
  const [port, setPort] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!taskId) return
    let cancelled = false

    async function init() {
      setLoading(true)
      setError('')
      try {
        // Check if already running
        const status = await fetchTestingAppStatus(taskId)
        if (!cancelled && status?.running && status?.port) {
          setPort(status.port)
          setLoading(false)
          return
        }

        // Start the testing dev server
        const result = await startTestingApp(taskId)
        if (!cancelled) {
          if (result?.port) {
            setPort(result.port)
          } else {
            setError('Testing app failed to start — no port returned.')
          }
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    init()
    return () => { cancelled = true }
  }, [taskId])

  if (loading) {
    return <div className="muted" style={{ padding: 12 }}>Starting testing app...</div>
  }

  if (error) {
    return <div className="error" style={{ padding: 12 }}>Error: {error}</div>
  }

  if (!port) {
    return <div className="muted" style={{ padding: 12 }}>No testing app available.</div>
  }

  return (
    <iframe
      ref={iframeRef}
      src={`http://localhost:${port}`}
      style={{ width: '100%', height: '100%', border: 'none' }}
    />
  )
}
