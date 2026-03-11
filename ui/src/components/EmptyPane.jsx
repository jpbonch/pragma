const PANE_CONFIG = {
  Connections: { icon: '🔗', desc: 'Connect Google Drive, Slack, Stripe, and more' },
  Settings: { icon: '⚙️', desc: 'Team, billing, preferences' },
}

export function EmptyPane({ title }) {
  const config = PANE_CONFIG[title] || { icon: '📦', desc: '' }

  return (
    <section className="empty-pane">
      <div className="empty-pane-inner">
        <div className="empty-pane-icon">{config.icon}</div>
        <div className="empty-pane-title">{title}</div>
        {config.desc && <div className="empty-pane-desc">{config.desc}</div>}
      </div>
    </section>
  )
}
