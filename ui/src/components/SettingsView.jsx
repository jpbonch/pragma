import { useState } from 'react'

export function SettingsView({ workspaceName, deleting, error, onDelete }) {
  const [feedback, setFeedback] = useState('')
  const [feedbackStatus, setFeedbackStatus] = useState(null) // 'sending' | 'sent' | 'error'

  async function handleSubmitFeedback(e) {
    e.preventDefault()
    if (!feedback.trim()) return
    setFeedbackStatus('sending')
    try {
      const res = await fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_key: '231f9df9-ea54-4eb0-8bb9-b188b54cc377',
          subject: 'Pragma Feedback',
          message: feedback.trim(),
        }),
      })
      if (!res.ok) throw new Error('Request failed')
      setFeedback('')
      setFeedbackStatus('sent')
    } catch {
      setFeedbackStatus('error')
    }
  }

  return (
    <section className="settings-view">
      <div className="settings-card">
        <h2>Settings</h2>

        <div className="settings-section-title">Feedback</div>
        <form className="settings-feedback-form" onSubmit={handleSubmitFeedback}>
          <textarea
            className="settings-feedback-textarea"
            placeholder="Share your feedback, ideas, or report an issue..."
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={4}
          />
          <div className="settings-feedback-footer">
            {feedbackStatus === 'sent' && (
              <span className="settings-feedback-success">Thanks for your feedback!</span>
            )}
            {feedbackStatus === 'error' && (
              <span className="settings-feedback-error">Failed to send. Please try again.</span>
            )}
            <button
              type="submit"
              className="settings-feedback-btn"
              disabled={feedbackStatus === 'sending' || !feedback.trim()}
            >
              {feedbackStatus === 'sending' ? 'Sending...' : 'Submit feedback'}
            </button>
          </div>
        </form>

        <div className="settings-danger-title">Danger zone</div>
        <div className="settings-danger-row">
          <div>
            <div className="settings-danger-label">Delete workspace</div>
            <div className="settings-danger-help">
              Permanently deletes <strong>{workspaceName || 'current workspace'}</strong> and all of
              its files.
            </div>
          </div>
          <button className="settings-delete-btn" onClick={onDelete} disabled={deleting || !workspaceName}>
            {deleting ? 'Deleting...' : 'Delete workspace'}
          </button>
        </div>
        {error && <div className="error">Error: {error}</div>}
      </div>
    </section>
  )
}
