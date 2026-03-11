export function SettingsView({ workspaceName, deleting, error, onDelete }) {
  return (
    <section className="settings-view">
      <div className="settings-card">
        <h2>Settings</h2>
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
