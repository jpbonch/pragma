import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import {
  fetchJobOutputChanges,
  fetchJobOutputFiles,
  jobOutputContentUrl,
  jobOutputDownloadUrl,
  openJobOutputFolder,
} from '../api'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])

function ext(path) {
  const index = path.lastIndexOf('.')
  if (index === -1) return ''
  return path.slice(index).toLowerCase()
}

function previewKind(path) {
  const extension = ext(path)
  if (extension === '.md') return 'markdown'
  if (extension === '.html' || extension === '.htm') return 'html'
  if (extension === '.csv') return 'csv'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  return 'download'
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return ''
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function parseCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const filtered = lines.filter((line, index) => line.trim().length > 0 || index === 0)
  return filtered.map((line) => parseCsvLine(line))
}

function parseCsvLine(line) {
  const cells = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    const next = line[i + 1]

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"'
        i += 1
        continue
      }
      inQuotes = !inQuotes
      continue
    }

    if (char === ',' && !inQuotes) {
      cells.push(current)
      current = ''
      continue
    }

    current += char
  }

  cells.push(current)
  return cells
}

function DiffViewer({ diff }) {
  if (!diff || !diff.trim()) {
    return <div className="muted">No changes detected.</div>
  }

  const lines = diff.split('\n')
  return (
    <div className="diff-viewer">
      {lines.map((line, index) => {
        let className = 'diff-line'
        if (line.startsWith('+++') || line.startsWith('---')) {
          className += ' header'
        } else if (line.startsWith('@@')) {
          className += ' hunk'
        } else if (line.startsWith('+')) {
          className += ' add'
        } else if (line.startsWith('-')) {
          className += ' remove'
        }

        return (
          <div key={`diff-${index}`} className={className}>
            {line || ' '}
          </div>
        )
      })}
    </div>
  )
}

export function OutputPanel({ jobId, jobStatus = '', onReviewAction }) {
  const [tab, setTab] = useState('changes')

  const [changes, setChanges] = useState('')
  const [changesLoading, setChangesLoading] = useState(false)
  const [changesError, setChangesError] = useState('')

  const [files, setFiles] = useState([])
  const [filesLoading, setFilesLoading] = useState(false)
  const [filesError, setFilesError] = useState('')

  const [selectedPath, setSelectedPath] = useState('')
  const [previewText, setPreviewText] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')

  const [reviewError, setReviewError] = useState('')
  const [reviewLoadingAction, setReviewLoadingAction] = useState('')
  const [openFolderLoading, setOpenFolderLoading] = useState(false)

  useEffect(() => {
    if (!jobId) return
    setTab('changes')
    void loadChanges(jobId)
    void loadFiles(jobId)
  }, [jobId])

  useEffect(() => {
    if (!files.length) {
      setSelectedPath('')
      return
    }

    setSelectedPath((current) => {
      if (current && files.some((item) => item.path === current)) {
        return current
      }
      return files[0].path
    })
  }, [files])

  const selectedFile = useMemo(() => {
    return files.find((file) => file.path === selectedPath) || null
  }, [files, selectedPath])

  const selectedKind = previewKind(selectedPath || '')

  useEffect(() => {
    if (!jobId || !selectedPath) {
      setPreviewText('')
      setPreviewError('')
      setPreviewLoading(false)
      return
    }

    if (selectedKind !== 'markdown' && selectedKind !== 'csv') {
      setPreviewText('')
      setPreviewError('')
      setPreviewLoading(false)
      return
    }

    const controller = new AbortController()
    setPreviewLoading(true)
    setPreviewError('')

    void fetch(jobOutputContentUrl(jobId, selectedPath), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
        return response.text()
      })
      .then((text) => {
        setPreviewText(text)
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          return
        }
        setPreviewError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setPreviewLoading(false)
        }
      })

    return () => {
      controller.abort()
    }
  }, [jobId, selectedPath, selectedKind])

  async function loadChanges(targetJobId) {
    setChangesLoading(true)
    setChangesError('')

    try {
      const data = await fetchJobOutputChanges(targetJobId)
      setChanges(typeof data.diff === 'string' ? data.diff : '')
    } catch (error) {
      setChangesError(error instanceof Error ? error.message : String(error))
      setChanges('')
    } finally {
      setChangesLoading(false)
    }
  }

  async function loadFiles(targetJobId) {
    setFilesLoading(true)
    setFilesError('')

    try {
      const data = await fetchJobOutputFiles(targetJobId)
      const nextFiles = Array.isArray(data.files) ? data.files : []
      setFiles(nextFiles)
    } catch (error) {
      setFilesError(error instanceof Error ? error.message : String(error))
      setFiles([])
    } finally {
      setFilesLoading(false)
    }
  }

  async function handleReview(action) {
    if (!jobId || !onReviewAction) {
      return
    }

    setReviewError('')
    setReviewLoadingAction(action)
    try {
      await onReviewAction(jobId, action)
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : String(error))
    } finally {
      setReviewLoadingAction('')
    }
  }

  async function handleOpenFolder(path = '') {
    if (!jobId) {
      return
    }

    setOpenFolderLoading(true)
    try {
      await openJobOutputFolder(jobId, path)
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : String(error))
    } finally {
      setOpenFolderLoading(false)
    }
  }

  const outputDownloadUrl = selectedPath ? jobOutputDownloadUrl(jobId, selectedPath) : ''
  const outputContentUrl = selectedPath ? jobOutputContentUrl(jobId, selectedPath) : ''

  return (
    <div className="output-panel">
      <div className="output-tabs">
        <button
          className={`output-tab-btn ${tab === 'changes' ? 'active' : ''}`}
          onClick={() => setTab('changes')}
        >
          Changes
        </button>
        <button
          className={`output-tab-btn ${tab === 'outputs' ? 'active' : ''}`}
          onClick={() => setTab('outputs')}
        >
          Outputs
        </button>
      </div>

      {tab === 'changes' && (
        <div className="output-tab-body">
          <div className="output-toolbar">
            <div className="output-status">Status: {jobStatus || 'queued'}</div>
            <div className="output-actions">
              <button
                className="output-review-btn approve"
                onClick={() => {
                  void handleReview('approve')
                }}
                disabled={Boolean(reviewLoadingAction) || changesLoading}
              >
                {reviewLoadingAction === 'approve' ? 'Approving...' : 'Approve'}
              </button>
            </div>
          </div>

          {reviewError && <div className="error">Error: {reviewError}</div>}
          {changesLoading && <div className="muted">Loading diff...</div>}
          {changesError && <div className="error">Error: {changesError}</div>}
          {!changesLoading && !changesError && <DiffViewer diff={changes} />}
        </div>
      )}

      {tab === 'outputs' && (
        <div className="output-tab-body output-files-layout">
          <div className="output-files-column">
            <div className="output-toolbar compact">
              <div className="output-status">Files</div>
              <button
                className="output-open-folder-btn"
                onClick={() => {
                  void handleOpenFolder()
                }}
                disabled={openFolderLoading}
              >
                {openFolderLoading ? 'Opening...' : 'Open Folder'}
              </button>
            </div>

            {filesLoading && <div className="muted">Loading files...</div>}
            {filesError && <div className="error">Error: {filesError}</div>}
            {!filesLoading && !filesError && files.length === 0 && (
              <div className="muted">No output files found.</div>
            )}

            {!filesLoading && !filesError && files.length > 0 && (
              <div className="output-file-list">
                {files.map((file) => (
                  <button
                    key={file.path}
                    className={`output-file-row ${selectedPath === file.path ? 'active' : ''}`}
                    onClick={() => setSelectedPath(file.path)}
                    title={file.path}
                  >
                    <span className="output-file-name">{file.path}</span>
                    <span className="output-file-size">{formatBytes(file.size)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="output-preview-column">
            {!selectedFile && <div className="muted">Select a file to preview.</div>}

            {selectedFile && (
              <div className="output-preview-card">
                <div className="output-preview-header">
                  <div className="output-preview-path">{selectedFile.path}</div>
                  <div className="output-preview-actions">
                    <button
                      className="output-open-folder-btn"
                      onClick={() => {
                        void handleOpenFolder(selectedFile.path)
                      }}
                      disabled={openFolderLoading}
                    >
                      Open Folder
                    </button>
                    <a className="output-download-btn" href={outputDownloadUrl}>
                      Download
                    </a>
                  </div>
                </div>

                {previewLoading && <div className="muted">Loading preview...</div>}
                {previewError && <div className="error">Error: {previewError}</div>}

                {!previewLoading && !previewError && selectedKind === 'markdown' && (
                  <div className="output-markdown-preview">
                    <ReactMarkdown>{previewText}</ReactMarkdown>
                  </div>
                )}

                {!previewLoading && !previewError && selectedKind === 'html' && (
                  <iframe className="output-html-preview" src={outputContentUrl} title={selectedFile.path} />
                )}

                {!previewLoading && !previewError && selectedKind === 'image' && (
                  <div className="output-image-wrap">
                    <img src={outputContentUrl} alt={selectedFile.path} className="output-image-preview" />
                  </div>
                )}

                {!previewLoading && !previewError && selectedKind === 'csv' && (
                  <div className="output-csv-wrap">
                    <table className="output-csv-table">
                      <tbody>
                        {parseCsv(previewText).map((row, rowIndex) => (
                          <tr key={`row-${rowIndex}`}>
                            {row.map((cell, cellIndex) => (
                              <td key={`cell-${rowIndex}-${cellIndex}`}>{cell}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {!previewLoading && !previewError && selectedKind === 'download' && (
                  <div className="output-fallback-preview">
                    <div className="muted">Preview is not supported for this file type.</div>
                    <a className="output-download-btn" href={outputDownloadUrl}>
                      Download file
                    </a>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
