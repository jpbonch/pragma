import { useMemo, useState } from 'react'
import { GitBranch, GitCommit, ArrowUpCircle, FolderGit2, Globe, Copy, FolderOpen, Upload, AlertCircle, Check } from 'lucide-react'

function timeAgo(value) {
  if (typeof value !== 'string' || !value.trim()) return ''
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  const seconds = Math.floor((Date.now() - parsed.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`
  return parsed.toLocaleDateString()
}

export function CodeView({
  folders,
  loading,
  error,
  onCloneRepo,
  onCopyLocalFolder,
  onPickLocalFolder,
  onPushFolder,
}) {
  const [gitUrl, setGitUrl] = useState('')
  const [cloneLoading, setCloneLoading] = useState(false)
  const [cloneError, setCloneError] = useState('')
  const [localPath, setLocalPath] = useState('')
  const [copyLoading, setCopyLoading] = useState(false)
  const [copyError, setCopyError] = useState('')
  const [pickLoading, setPickLoading] = useState(false)
  const [pushingFolder, setPushingFolder] = useState(null)
  const [pushError, setPushError] = useState('')
  const [pushSuccess, setPushSuccess] = useState('')

  const folderItems = useMemo(() => {
    if (!Array.isArray(folders)) return []
    return folders
      .map((folder) => {
        if (!folder || typeof folder !== 'object') return null
        const name = typeof folder.name === 'string' ? folder.name : ''
        if (!name) return null
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
          lastCommitMessage: typeof folder.git_last_commit_message === 'string' ? folder.git_last_commit_message : '',
          lastCommitAt: typeof folder.git_last_commit_at === 'string' ? folder.git_last_commit_at : '',
          unpushedCount: typeof folder.git_unpushed_count === 'number' ? folder.git_unpushed_count : null,
        }
      })
      .filter(Boolean)
  }, [folders])

  async function handleCloneSubmit(event) {
    event.preventDefault()
    const nextUrl = gitUrl.trim()
    if (!nextUrl || cloneLoading) return
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
    if (copyLoading || !nextPath) return
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
    if (copyLoading || pickLoading) return
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

  async function handlePush(folderName) {
    if (pushingFolder) return
    setPushingFolder(folderName)
    setPushError('')
    setPushSuccess('')
    try {
      await onPushFolder(folderName)
      setPushSuccess(folderName)
      setTimeout(() => setPushSuccess(''), 3000)
    } catch (err) {
      setPushError(err instanceof Error ? err.message : String(err))
    } finally {
      setPushingFolder(null)
    }
  }

  return (
    <section className="cv">
      <div className="cv-header">
        <div className="cv-header-inner">
          <h1 className="cv-title">Code</h1>
          <span className="cv-subtitle">{folderItems.length} {folderItems.length === 1 ? 'repository' : 'repositories'}</span>
        </div>
      </div>

      <div className="cv-content">
        {loading && (
          <div className="cv-loading">
            <div className="cv-spinner" />
            <span>Loading repositories...</span>
          </div>
        )}

        {error && (
          <div className="cv-error">
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        )}

        {!loading && !error && (
          <>
            {pushError && (
              <div className="cv-error" style={{ margin: '0 0 12px' }}>
                <AlertCircle size={16} />
                <span>Push failed: {pushError}</span>
              </div>
            )}

            {folderItems.length === 0 ? (
              <div className="cv-empty">
                <FolderGit2 size={40} strokeWidth={1.5} />
                <p className="cv-empty-title">No repositories yet</p>
                <p className="cv-empty-desc">Clone a repo or copy a local folder to get started.</p>
              </div>
            ) : (
              <div className="cv-repos">
                {folderItems.map((folder) => (
                  <div key={folder.name} className="cv-repo-card">
                    <div className="cv-repo-header">
                      <div className="cv-repo-name-row">
                        <FolderGit2 size={16} className="cv-repo-icon" />
                        <span className="cv-repo-name">{folder.name}</span>
                        {folder.dirty === false && (
                          <span className="cv-badge cv-badge-clean">Clean</span>
                        )}
                        {folder.dirty === true && (
                          <span className="cv-badge cv-badge-dirty">Modified</span>
                        )}
                      </div>
                      {folder.isGitRepo && folder.unpushedCount > 0 && (
                        <button
                          className="cv-push-btn"
                          onClick={() => handlePush(folder.name)}
                          disabled={pushingFolder === folder.name}
                          title="Push to origin main"
                        >
                          {pushingFolder === folder.name ? (
                            <div className="cv-spinner-sm" />
                          ) : pushSuccess === folder.name ? (
                            <Check size={14} />
                          ) : (
                            <ArrowUpCircle size={14} />
                          )}
                          <span>
                            {pushingFolder === folder.name
                              ? 'Pushing...'
                              : pushSuccess === folder.name
                                ? 'Pushed!'
                                : 'Push to main'}
                          </span>
                        </button>
                      )}
                    </div>

                    {!folder.isGitRepo ? (
                      <div className="cv-repo-nogit">Not a git repository</div>
                    ) : (
                      <div className="cv-repo-details">
                        <div className="cv-repo-detail-row">
                          <GitBranch size={13} />
                          <span className="cv-repo-detail-label">Branch</span>
                          <span className="cv-repo-detail-value">{folder.branch || 'unknown'}</span>
                          {folder.defaultBranch && folder.branch !== folder.defaultBranch && (
                            <span className="cv-repo-detail-secondary">default: {folder.defaultBranch}</span>
                          )}
                        </div>

                        {folder.remote && (
                          <div className="cv-repo-detail-row">
                            <Globe size={13} />
                            <span className="cv-repo-detail-label">Remote</span>
                            <span className="cv-repo-detail-value cv-repo-remote">{folder.remote}</span>
                          </div>
                        )}

                        {(folder.lastCommitHash || folder.lastCommitMessage) && (
                          <div className="cv-repo-detail-row">
                            <GitCommit size={13} />
                            <span className="cv-repo-detail-label">Commit</span>
                            <code className="cv-repo-hash">{folder.lastCommitHash}</code>
                            <span className="cv-repo-detail-value cv-repo-commit-msg">{folder.lastCommitMessage}</span>
                            {folder.lastCommitAt && (
                              <span className="cv-repo-detail-secondary">{timeAgo(folder.lastCommitAt)}</span>
                            )}
                          </div>
                        )}

                        {folder.unpushedCount !== null && (
                          <div className="cv-repo-detail-row">
                            <ArrowUpCircle size={13} />
                            <span className="cv-repo-detail-label">Unpushed</span>
                            <span className={`cv-repo-detail-value ${folder.unpushedCount > 0 ? 'cv-unpushed-highlight' : ''}`}>
                              {folder.unpushedCount === 0 ? 'Up to date' : `${folder.unpushedCount} commit${folder.unpushedCount !== 1 ? 's' : ''}`}
                            </span>
                          </div>
                        )}
                      </div>
                    )}

                  </div>
                ))}
              </div>
            )}

            <div className="cv-actions">
              <form className="cv-action-card" onSubmit={handleCloneSubmit}>
                <div className="cv-action-header">
                  <Copy size={16} />
                  <span className="cv-action-title">Clone Repository</span>
                </div>
                <div className="cv-action-body">
                  <input
                    className="cv-input"
                    type="text"
                    value={gitUrl}
                    onChange={(event) => setGitUrl(event.target.value)}
                    placeholder="https://github.com/org/repo.git"
                    disabled={cloneLoading}
                  />
                  <button className="cv-btn cv-btn-primary" type="submit" disabled={cloneLoading || !gitUrl.trim()}>
                    {cloneLoading ? 'Cloning...' : 'Clone'}
                  </button>
                </div>
                {cloneError && (
                  <div className="cv-inline-error">
                    <AlertCircle size={13} />
                    <span>{cloneError}</span>
                  </div>
                )}
              </form>

              <form className="cv-action-card" onSubmit={handleCopySubmit}>
                <div className="cv-action-header">
                  <FolderOpen size={16} />
                  <span className="cv-action-title">Add Local Folder</span>
                </div>
                <div className="cv-action-body">
                  <button
                    className="cv-btn cv-btn-secondary"
                    type="button"
                    onClick={handlePickFolder}
                    disabled={copyLoading || pickLoading}
                  >
                    {pickLoading ? 'Selecting...' : 'Browse...'}
                  </button>
                  <input
                    className="cv-input"
                    type="text"
                    value={localPath}
                    onChange={(event) => setLocalPath(event.target.value)}
                    placeholder="/path/to/local/folder"
                    disabled={copyLoading}
                  />
                  <button className="cv-btn cv-btn-primary" type="submit" disabled={copyLoading || !localPath.trim()}>
                    {copyLoading ? 'Copying...' : 'Copy'}
                  </button>
                </div>
                {copyError && (
                  <div className="cv-inline-error">
                    <AlertCircle size={13} />
                    <span>{copyError}</span>
                  </div>
                )}
              </form>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
