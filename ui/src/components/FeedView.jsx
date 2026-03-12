import { useMemo, useState } from 'react'

function normalizeJobTitle(title) {
  const value = String(title || '').trim()
  if (!value) {
    return ''
  }
  return value.replace(/^execute:\s*/i, '')
}

function getTimeAgo(dateStr) {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now - date
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) return 'Yesterday'
  return `${diffDays}d ago`
}

export function FeedView({
  jobs,
  loading,
  error,
  recipientAgents = [],
  onOpenJobConversation,
  onPickJobRecipient,
}) {
  const [pickerJobId, setPickerJobId] = useState('')

  const recipients = useMemo(() => {
    if (!Array.isArray(recipientAgents)) {
      return []
    }
    return recipientAgents.filter((agent) => agent && typeof agent.id === 'string')
  }, [recipientAgents])

  return (
    <section className="feed">
      {loading && <div className="muted">Loading jobs...</div>}
      {error && <div className="error">Error: {error}</div>}

      {!loading && !error && jobs.length === 0 && (
        <div className="muted">No jobs found.</div>
      )}

      {!loading && !error && jobs.length > 0 && (
        <div className="jobs-list">
          {jobs.map((job) => {
            const isNeedsInput = String(job.status || '').toLowerCase() === 'waiting_for_recipient'
            return (
              <div key={job.id} className="job-row">
                <button
                  className="job-row-main"
                  onClick={() => onOpenJobConversation?.(job)}
                  title="Open task review"
                >
                  <div className="job-title">{normalizeJobTitle(job.title)}</div>
                  <div className="job-meta">
                    <span className="job-chip">{job.status || 'queued'}</span>
                    {job.assigned_to && <span>assigned to {job.assigned_to}</span>}
                    {job.output_dir && <span>output: {job.output_dir}</span>}
                  </div>
                </button>

                <div className="job-row-right">
                  <div className="job-time">{getTimeAgo(job.created_at)}</div>
                  {isNeedsInput && (
                    <div className="job-recipient-wrap">
                      <button
                        className="job-recipient-btn"
                        onClick={() =>
                          setPickerJobId((current) => (current === job.id ? '' : job.id))
                        }
                      >
                        Pick recipient
                      </button>
                      {pickerJobId === job.id && (
                        <div className="job-recipient-menu">
                          {recipients.length === 0 && (
                            <div className="job-recipient-empty">No agents available</div>
                          )}
                          {recipients.map((agent) => (
                            <button
                              key={agent.id}
                              className="job-recipient-option"
                              onClick={() => {
                                onPickJobRecipient?.(job.id, agent.id)
                                setPickerJobId('')
                              }}
                            >
                              <span className="job-recipient-name">{agent.name || agent.id}</span>
                              <span className="job-recipient-id">{agent.id}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
