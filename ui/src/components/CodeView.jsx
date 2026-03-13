import { useMemo, useState } from 'react'

function formatCommitTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return ''
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }
  return parsed.toLocaleString()
}

export function CodeView({
  folders,
  loading,
  error,
  onCloneRepo,
  onCopyLocalFolder,
  onPickLocalFolder,
}) {
  const [gitUrl, setGitUrl] = useState('')
  const [cloneLoading, setCloneLoading] = useState(false)
  const [cloneError, setCloneError] = useState('')
  const [localPath, setLocalPath] = useState('')
  const [copyLoading, setCopyLoading] = useState(false)
  const [copyError, setCopyError] = useState('')
  const [pickLoading, setPickLoading] = useState(false)

  const folderItems = useMemo(() => {
    if (!Array.isArray(folders)) {
      return []
    }
    return folders
      .map((folder) => {
        if (!folder || typeof folder !== 'object') {
          return null
        }

        const name = typeof folder.name === 'string' ? folder.name : ''
        if (!name) {
          return null
        }

        const path = typeof folder.path === 'string' && folder.path ? folder.path : `code/${name}`
        return {
          name,
          path,
          isGitRepo: folder.is_git_repo === true,
          branch: typeof folder.git_branch === 'string' ? folder.git_branch : '',
          defaultBranch: typeof folder.git_default_branch === 'string' ? folder.git_default_branch : '',
          remote: typeof folder.git_remote === 'string' ? folder.git_remote : '',
          dirty: typeof folder.git_dirty === 'boolean' ? folder.git_dirty : null,
          lastCommitHash: typeof folder.git_last_commit_hash === 'string' ? folder.git_last_commit_hash : '',
          lastCommitMessage:
            typeof folder.git_last_commit_message === 'string' ? folder.git_last_commit_message : '',
          lastCommitAt: typeof folder.git_last_commit_at === 'string' ? folder.git_last_commit_at : '',
        }
      })
      .filter(Boolean)
  }, [folders])

  async function handleCloneSubmit(event) {
    event.preventDefault()
    const nextUrl = gitUrl.trim()
    if (!nextUrl || cloneLoading) {
      return
    }

    setCloneLoading(true)
    setCloneError('')
    try {
      await onCloneRepo(nextUrl)
      setGitUrl('')
    } catch (err) {
      setCloneError(err instanceof Error ? err.message : String(err))
    } finally {
      setCloneLoading(false)
    }
  }

  async function handleCopySubmit(event) {
    event.preventDefault()
    const nextPath = localPath.trim()
    if (copyLoading || !nextPath) {
      return
    }

    setCopyLoading(true)
    setCopyError('')
    try {
      await onCopyLocalFolder(nextPath)
      setLocalPath('')
    } catch (err) {
      setCopyError(err instanceof Error ? err.message : String(err))
    } finally {
      setCopyLoading(false)
    }
  }

  async function handlePickFolder() {
    if (copyLoading || pickLoading) {
      return
    }

    setPickLoading(true)
    setCopyError('')
    try {
      const picked = await onPickLocalFolder()
      if (typeof picked === 'string' && picked.trim()) {
        setLocalPath(picked.trim())
      }
    } catch (err) {
      setCopyError(err instanceof Error ? err.message : String(err))
    } finally {
      setPickLoading(false)
    }
  }

  return (
    <section className="code-view">
      <div className="code-view-header">
        <h1>Code</h1>
      </div>

      <div className="code-view-body">
        <aside className="code-view-folders">
          <div className="code-section-title">Folders</div>
          {loading && <div className="muted">Loading...</div>}
          {error && <div className="error">Error: {error}</div>}

          {!loading && !error && folderItems.length === 0 && (
            <div className="muted">No folders in code/ yet.</div>
          )}

          {!loading && !error && folderItems.length > 0 && (
            <ul className="code-folder-list">
              {folderItems.map((folder) => (
                <li key={folder.name} className="code-folder-item">
                  <div className="code-folder-name">{folder.name}</div>
                  <div className="code-folder-meta">{folder.path}</div>

                  {!folder.isGitRepo && (
                    <div className="code-folder-meta">No git repository detected.</div>
                  )}

                  {folder.isGitRepo && (
                    <>
                      <div className="code-folder-meta">
                        Branch: {folder.branch || 'unknown'}
                        {folder.defaultBranch ? ` (default: ${folder.defaultBranch})` : ''}
                        {folder.dirty === null ? '' : folder.dirty ? ' • Dirty' : ' • Clean'}
                      </div>
                      {folder.remote && (
                        <div className="code-folder-meta">Remote: {folder.remote}</div>
                      )}
                      {(folder.lastCommitHash || folder.lastCommitMessage) && (
                        <div className="code-folder-meta">
                          Last: {folder.lastCommitHash || 'unknown'}
                          {folder.lastCommitMessage ? ` - ${folder.lastCommitMessage}` : ''}
                          {folder.lastCommitAt
                            ? ` • ${formatCommitTimestamp(folder.lastCommitAt)}`
                            : ''}
                        </div>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </aside>

        <div className="code-view-actions">
          <form className="code-card" onSubmit={handleCloneSubmit}>
            <div className="code-card-title">Clone Git Repo</div>
            <input
              className="code-input"
              type="text"
              value={gitUrl}
              onChange={(event) => setGitUrl(event.target.value)}
              placeholder="https://github.com/org/repo.git"
              disabled={cloneLoading}
            />
            <button className="code-btn" type="submit" disabled={cloneLoading || !gitUrl.trim()}>
              {cloneLoading ? 'Cloning...' : 'Clone'}
            </button>
            {cloneError && <div className="error">Error: {cloneError}</div>}
          </form>

          <form className="code-card" onSubmit={handleCopySubmit}>
            <div className="code-card-title">Copy Local Folder (On Disk)</div>
            <div className="code-path-picker">
              <button
                className="code-btn code-btn-secondary"
                type="button"
                onClick={handlePickFolder}
                disabled={copyLoading || pickLoading}
              >
                {pickLoading ? 'Selecting...' : 'Select Folder'}
              </button>
            </div>
            <input
              className="code-input"
              type="text"
              value={localPath}
              onChange={(event) => setLocalPath(event.target.value)}
              placeholder="/absolute/path/to/local/folder"
              disabled={copyLoading}
            />
            <button
              className="code-btn"
              type="submit"
              disabled={copyLoading || !localPath.trim()}
            >
              {copyLoading ? 'Copying...' : 'Copy Folder'}
            </button>
            {copyError && <div className="error">Error: {copyError}</div>}
          </form>
        </div>
      </div>
    </section>
  )
}
