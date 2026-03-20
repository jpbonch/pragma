import { useMemo, useState } from 'react'
import { GitBranch, GitCommit, ArrowUpCircle, FolderGit2, Globe, Copy, FolderOpen, Upload, AlertCircle, Check, Play, Square, Trash2, Plus, Search, TerminalSquare } from 'lucide-react'

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

function ProcessList({ processes, folders, onStartProcess, onStopProcess, onAddWorkspaceProcess, onDeleteProcess, onDetectProcesses }) {
  const [showAddForm, setShowAddForm] = useState(false)
  const [addLabel, setAddLabel] = useState('')
  const [addCommand, setAddCommand] = useState('')
  const [addCwd, setAddCwd] = useState('.')
  const [addType, setAddType] = useState('service')
  const [addLoading, setAddLoading] = useState(false)
  const [addError, setAddError] = useState('')
  const [actionLoading, setActionLoading] = useState('')
  const [detectLoading, setDetectLoading] = useState(false)
  const [detectFolder, setDetectFolder] = useState('')

  const workspaceProcesses = useMemo(() => {
    if (!Array.isArray(processes)) return []
    return processes.filter((p) => p && !p.task_id)
  }, [processes])

  async function handleAdd(event) {
    event.preventDefault()
    if (!addLabel.trim() || !addCommand.trim() || addLoading) return
    setAddLoading(true)
    setAddError('')
    try {
      await onAddWorkspaceProcess({ label: addLabel.trim(), command: addCommand.trim(), cwd: addCwd.trim() || '.', type: addType })
      setAddLabel('')
      setAddCommand('')
      setAddCwd('.')
      setAddType('service')
      setShowAddForm(false)
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err))
    } finally {
      setAddLoading(false)
    }
  }

  async function handleStart(processId) {
    if (actionLoading) return
    setActionLoading(processId)
    try { await onStartProcess(processId) } catch {} finally { setActionLoading('') }
  }

  async function handleStop(processId) {
    if (actionLoading) return
    setActionLoading(processId)
    try { await onStopProcess(processId) } catch {} finally { setActionLoading('') }
  }

  async function handleDelete(processId) {
    if (actionLoading) return
    setActionLoading(processId)
    try { await onDeleteProcess(processId) } catch {} finally { setActionLoading('') }
  }

  async function handleDetect(folderName) {
    if (detectLoading) return
    setDetectLoading(true)
    setDetectFolder(folderName)
    try { await onDetectProcesses(folderName) } catch {} finally { setDetectLoading(false); setDetectFolder('') }
  }

  return (
    <div className="cv-processes">
      <div className="cv-processes-header">
        <TerminalSquare size={13} />
        <span className="cv-processes-title">Processes</span>
        <div className="cv-processes-actions">
          {Array.isArray(folders) && folders.length > 0 && (
            folders.length === 1 ? (
              <button className="cv-proc-btn cv-proc-btn-ghost" onClick={() => handleDetect(folders[0].name)} disabled={detectLoading} title="Auto-detect start commands">
                <Search size={12} />
                <span>{detectLoading ? 'Detecting...' : 'Detect'}</span>
              </button>
            ) : (
              <div className="cv-proc-detect-group">
                <span className="cv-proc-detect-label"><Search size={12} /> Detect in:</span>
                {folders.map((f) => (
                  <button
                    key={f.name}
                    className="cv-proc-btn cv-proc-btn-ghost"
                    onClick={() => handleDetect(f.name)}
                    disabled={detectLoading}
                    title={`Auto-detect in ${f.name}`}
                  >
                    <span>{detectLoading && detectFolder === f.name ? 'Detecting...' : f.name}</span>
                  </button>
                ))}
              </div>
            )
          )}
          <button className="cv-proc-btn cv-proc-btn-ghost" onClick={() => setShowAddForm(!showAddForm)} title="Add process">
            <Plus size={12} />
            <span>Add</span>
          </button>
        </div>
      </div>

      {workspaceProcesses.length === 0 && !showAddForm && (
        <div className="cv-processes-empty">No processes configured</div>
      )}

      {workspaceProcesses.map((proc) => {
        const isRunning = proc.status === 'running'
        const isExited = proc.status === 'exited'
        const isBusy = actionLoading === proc.id
        return (
          <div key={proc.id} className="cv-proc-row">
            <span className={`cv-proc-dot ${isRunning ? 'running' : ''} ${isExited ? 'exited' : ''}`} />
            <div className="cv-proc-info">
              <span className="cv-proc-label">{proc.label}</span>
              <span className="cv-proc-command">{proc.command}</span>
            </div>
            <span className={`cv-proc-type-badge cv-proc-type-${proc.type}`}>{proc.type}</span>
            <div className="cv-proc-actions">
              {isRunning ? (
                <button className="cv-proc-btn cv-proc-btn-stop" onClick={() => handleStop(proc.id)} disabled={isBusy} title="Stop">
                  <Square size={11} />
                </button>
              ) : (
                <button className="cv-proc-btn cv-proc-btn-start" onClick={() => handleStart(proc.id)} disabled={isBusy} title="Start">
                  <Play size={11} />
                </button>
              )}
              <button className="cv-proc-btn cv-proc-btn-delete" onClick={() => handleDelete(proc.id)} disabled={isBusy} title="Delete">
                <Trash2 size={11} />
              </button>
            </div>
          </div>
        )
      })}

      {showAddForm && (
        <form className="cv-proc-add-form" onSubmit={handleAdd}>
          <div className="cv-proc-add-row">
            <input className="cv-input cv-proc-add-input" placeholder="Label" value={addLabel} onChange={(e) => setAddLabel(e.target.value)} disabled={addLoading} />
            <select className="cv-input cv-proc-add-select" value={addType} onChange={(e) => setAddType(e.target.value)} disabled={addLoading}>
              <option value="service">service</option>
              <option value="script">script</option>
            </select>
          </div>
          <input className="cv-input cv-proc-add-input" placeholder="Command (e.g. npm run dev)" value={addCommand} onChange={(e) => setAddCommand(e.target.value)} disabled={addLoading} />
          <div className="cv-proc-add-row">
            <input className="cv-input cv-proc-add-input" placeholder="cwd (relative to code/, default .)" value={addCwd} onChange={(e) => setAddCwd(e.target.value)} disabled={addLoading} />
            <button className="cv-btn cv-btn-primary cv-proc-add-submit" type="submit" disabled={addLoading || !addLabel.trim() || !addCommand.trim()}>
              {addLoading ? 'Adding...' : 'Add'}
            </button>
            <button className="cv-btn cv-btn-secondary" type="button" onClick={() => setShowAddForm(false)} disabled={addLoading}>Cancel</button>
          </div>
          {addError && (
            <div className="cv-inline-error">
              <AlertCircle size={13} />
              <span>{addError}</span>
            </div>
          )}
        </form>
      )}
    </div>
  )
}

export function CodeView({
  folders,
  loading,
  error,
  onCloneRepo,
  onCopyLocalFolder,
  onPickLocalFolder,
  onPushFolder,
  processes,
  processesLoading,
  onStartProcess,
  onStopProcess,
  onAddProcess,
  onAddWorkspaceProcess,
  onUpdateProcess,
  onDeleteProcess,
  onDetectProcesses,
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

            <ProcessList
              processes={processes}
              folders={folderItems}
              onStartProcess={onStartProcess}
              onStopProcess={onStopProcess}
              onAddWorkspaceProcess={onAddWorkspaceProcess}
              onDeleteProcess={onDeleteProcess}
              onDetectProcesses={onDetectProcesses}
            />

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
