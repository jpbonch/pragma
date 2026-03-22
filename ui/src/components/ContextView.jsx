import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FilePlus2, FileText, Folder, FolderPlus, Pencil } from 'lucide-react'

function ensureMdName(name) {
  const trimmed = name.trim()
  if (!trimmed) return ''
  return trimmed.toLowerCase().endsWith('.md') ? trimmed : `${trimmed}.md`
}

export function ContextView({
  folders,
  files,
  loading,
  error,
  onSave,
  onCreateFile,
  onCreateFolder,
}) {
  const [selectedPath, setSelectedPath] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saveLoading, setSaveLoading] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [createLoading, setCreateLoading] = useState(false)
  const [createError, setCreateError] = useState('')
  const [createDraft, setCreateDraft] = useState(null)

  const createInputRef = useRef(null)

  const selected = useMemo(() => {
    if (files.length === 0) return null
    if (!selectedPath) return files[0]
    return files.find((file) => file.path === selectedPath) ?? files[0]
  }, [files, selectedPath])

  const rootFiles = useMemo(() => files.filter((file) => !file.folder), [files])

  useEffect(() => {
    if (!selected) {
      setIsEditing(false)
      setDraft('')
      setSaveError('')
      return
    }

    if (!selectedPath) {
      setSelectedPath(selected.path)
    }

    if (!isEditing) {
      setDraft(selected.content ?? '')
    }
  }, [selected, selectedPath, isEditing])

  useEffect(() => {
    if (createDraft && createInputRef.current) {
      createInputRef.current.focus()
      createInputRef.current.select()
    }
  }, [createDraft?.kind, createDraft?.folder])

  async function handleSave() {
    if (!selected) return

    setSaveLoading(true)
    setSaveError('')
    try {
      await onSave(selected.path, draft)
      setIsEditing(false)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaveLoading(false)
    }
  }

  function startCreateFile(folder = null) {
    setCreateError('')
    setCreateDraft({ kind: 'file', folder, value: '' })
  }

  function startCreateFolder() {
    setCreateError('')
    setCreateDraft({ kind: 'folder', folder: null, value: '' })
  }

  function cancelCreateDraft() {
    setCreateDraft(null)
  }

  async function submitCreateDraft() {
    if (!createDraft) return

    setCreateLoading(true)
    setCreateError('')
    try {
      if (createDraft.kind === 'folder') {
        const folderName = createDraft.value.trim()
        if (!folderName) {
          setCreateError('Folder name is required.')
          return
        }
        await onCreateFolder(folderName)
      } else {
        const normalizedName = ensureMdName(createDraft.value)
        if (!normalizedName) {
          setCreateError('File name is required.')
          return
        }

        const folder = createDraft.folder || undefined
        await onCreateFile(normalizedName, folder)
        const path = folder ? `${folder}/${normalizedName}` : normalizedName
        setSelectedPath(path)
      }

      setCreateDraft(null)
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreateLoading(false)
    }
  }

  function renderDraftInput(isNested = false) {
    if (!createDraft) return null

    const icon = createDraft.kind === 'folder' ? <Folder size={13} /> : <FileText size={13} />
    const placeholder = createDraft.kind === 'folder' ? 'folder name' : 'file name'

    return (
      <div className={`context-draft-row ${isNested ? 'context-item-nested' : ''}`}>
        <span className="context-node-icon">{icon}</span>
        <input
          ref={createInputRef}
          className="context-draft-input"
          value={createDraft.value}
          placeholder={placeholder}
          onChange={(e) => {
            setCreateDraft((prev) => (prev ? { ...prev, value: e.target.value } : prev))
          }}
          onBlur={cancelCreateDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void submitCreateDraft()
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              cancelCreateDraft()
            }
          }}
        />
      </div>
    )
  }

  return (
    <section className="context-view">
      <aside className="context-sidebar">
        <div className="context-sidebar-header">
          <div className="context-section-title">Pages</div>
          <div className="context-sidebar-actions">
            <button
              className="context-top-action"
              onClick={() => startCreateFile(null)}
              disabled={createLoading || loading}
              title="New file"
            >
              <FilePlus2 size={14} />
            </button>
            <button
              className="context-icon-action"
              onClick={startCreateFolder}
              disabled={createLoading || loading}
              title="New folder"
            >
              <FolderPlus size={14} />
            </button>
          </div>
        </div>


        {loading && <div className="muted">Loading...</div>}
        {error && <div className="error">Error: {error}</div>}
        {createError && <div className="error">Error: {createError}</div>}

        {!loading && !error && files.length === 0 && (
          <div className="muted">No context files found.</div>
        )}

        {!loading &&
          !error &&
          rootFiles.map((file) => (
            <button
              key={file.path}
              className={`context-item ${selected?.path === file.path ? 'active' : ''}`}
              onClick={() => {
                setSelectedPath(file.path)
                setIsEditing(false)
                setSaveError('')
              }}
            >
              <span className="context-node-icon">
                <FileText size={13} />
              </span>
              {file.title}
            </button>
          ))}

        {createDraft?.kind === 'file' && !createDraft.folder && renderDraftInput(false)}
        {createDraft?.kind === 'folder' && renderDraftInput(false)}

        {!loading &&
          !error &&
          folders.map((folder) => (
            <div key={folder.name} className="context-folder-group">
              <div className="context-folder-row">
                <div className="context-folder-label">
                  <span className="context-node-icon">
                    <Folder size={13} />
                  </span>
                  <span>{folder.name}</span>
                </div>
                <button
                  className="context-folder-add-file"
                  title={`Add file to ${folder.name}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => startCreateFile(folder.name)}
                >
                  <FilePlus2 size={12} />
                </button>
              </div>

              {createDraft?.kind === 'file' && createDraft.folder === folder.name &&
                renderDraftInput(true)}

              {files
                .filter((file) => file.folder === folder.name)
                .map((file) => (
                  <button
                    key={file.path}
                    className={`context-item context-item-nested ${selected?.path === file.path ? 'active' : ''}`}
                    onClick={() => {
                      setSelectedPath(file.path)
                      setIsEditing(false)
                      setSaveError('')
                    }}
                  >
                    <span className="context-node-icon">
                      <FileText size={13} />
                    </span>
                    {file.title}
                  </button>
                ))}
            </div>
          ))}
      </aside>

      <article className="context-content">
        {selected ? (
          <>
            <div className="context-header-row">
              <div className="context-file-name">{selected.filename}</div>
              {!isEditing ? (
                <button className="context-edit-btn" onClick={() => setIsEditing(true)}>
                  <Pencil size={14} /> Edit
                </button>
              ) : (
                <div className="context-edit-actions">
                  <button
                    className="context-cancel-btn"
                    onClick={() => {
                      setDraft(selected.content ?? '')
                      setSaveError('')
                      setIsEditing(false)
                    }}
                    disabled={saveLoading}
                  >
                    Cancel
                  </button>
                  <button className="context-save-btn" onClick={handleSave} disabled={saveLoading}>
                    {saveLoading ? 'Saving...' : 'Save'}
                  </button>
                </div>
              )}
            </div>

            {saveError && <div className="error">Error: {saveError}</div>}

            {!isEditing ? (
              <div className="context-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{selected.content}</ReactMarkdown>
              </div>
            ) : (
              <textarea
                className="context-editor"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
              />
            )}
          </>
        ) : (
          <>
            <h1>Context</h1>
            <div className="context-body">Select a page to view its content.</div>
          </>
        )}
      </article>
    </section>
  )
}
