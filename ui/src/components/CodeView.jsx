import { useMemo, useRef, useState } from 'react'

function folderLabelFromFiles(files) {
  const first = files[0]
  if (!first || typeof first.webkitRelativePath !== 'string') {
    return ''
  }
  const rel = first.webkitRelativePath
  if (!rel.includes('/')) {
    return ''
  }
  return rel.split('/')[0]
}

export function CodeView({
  folders,
  loading,
  error,
  onCloneRepo,
  onImportFolder,
}) {
  const [gitUrl, setGitUrl] = useState('')
  const [cloneLoading, setCloneLoading] = useState(false)
  const [cloneError, setCloneError] = useState('')
  const [importLoading, setImportLoading] = useState(false)
  const [importError, setImportError] = useState('')
  const [selectedFiles, setSelectedFiles] = useState([])
  const [selectedFolderName, setSelectedFolderName] = useState('')
  const folderInputRef = useRef(null)

  const names = useMemo(() => {
    if (!Array.isArray(folders)) {
      return []
    }
    return folders
      .map((folder) => (folder && typeof folder.name === 'string' ? folder.name : ''))
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

  async function handleImportSubmit(event) {
    event.preventDefault()
    if (importLoading || selectedFiles.length === 0) {
      return
    }

    setImportLoading(true)
    setImportError('')
    try {
      await onImportFolder(selectedFiles)
      setSelectedFiles([])
      setSelectedFolderName('')
      if (folderInputRef.current) {
        folderInputRef.current.value = ''
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err))
    } finally {
      setImportLoading(false)
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

          {!loading && !error && names.length === 0 && (
            <div className="muted">No folders in code/ yet.</div>
          )}

          {!loading && !error && names.length > 0 && (
            <ul className="code-folder-list">
              {names.map((name) => (
                <li key={name} className="code-folder-item">
                  {name}
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

          <form className="code-card" onSubmit={handleImportSubmit}>
            <div className="code-card-title">Import Local Folder</div>
            <input
              ref={folderInputRef}
              className="code-input-file"
              type="file"
              webkitdirectory=""
              directory=""
              multiple
              disabled={importLoading}
              onChange={(event) => {
                const files = Array.from(event.target.files || [])
                setSelectedFiles(files)
                setSelectedFolderName(folderLabelFromFiles(files))
                setImportError('')
              }}
            />
            <div className="code-selected-folder">
              {selectedFolderName || (selectedFiles.length > 0 ? `${selectedFiles.length} files selected` : 'No folder selected')}
            </div>
            <button
              className="code-btn"
              type="submit"
              disabled={importLoading || selectedFiles.length === 0}
            >
              {importLoading ? 'Copying...' : 'Copy Folder'}
            </button>
            {importError && <div className="error">Error: {importError}</div>}
          </form>
        </div>
      </div>
    </section>
  )
}
