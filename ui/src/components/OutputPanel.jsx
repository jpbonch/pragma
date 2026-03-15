import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FileCode2, FileImage, FileSpreadsheet, FileText, FileType2 } from 'lucide-react'
import Papa from 'papaparse'
import ReactMarkdown from 'react-markdown'
import {
  fetchTaskOutputChanges,
  fetchTaskOutputFiles,
  taskOutputContentUrl,
  taskOutputDownloadUrl,
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

function fileName(path) {
  const segments = String(path || '').split('/').filter(Boolean)
  return segments[segments.length - 1] || path
}

function outputIcon(path) {
  const extension = ext(path)
  if (extension === '.md' || extension === '.txt') return FileText
  if (extension === '.html' || extension === '.htm' || extension === '.js' || extension === '.ts') return FileCode2
  if (extension === '.csv') return FileSpreadsheet
  if (IMAGE_EXTENSIONS.has(extension)) return FileImage
  return FileType2
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return ''
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function parseCsv(text) {
  const parsed = Papa.parse(text, {
    skipEmptyLines: 'greedy',
  })

  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors[0].message || 'Failed to parse CSV.')
  }

  if (!Array.isArray(parsed.data)) {
    return []
  }

  return parsed.data.map((row) => (Array.isArray(row) ? row : [String(row)]))
}

function parseDiffIntoFiles(diff) {
  if (!diff || !diff.trim()) return []

  const lines = diff.split('\n')
  const files = []
  let current = null

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git a\/.+ b\/(.+)$/)
      current = {
        path: match ? match[1] : 'unknown file',
        additions: 0,
        deletions: 0,
        lines: [],
      }
      files.push(current)
      current.lines.push(line)
    } else if (current) {
      current.lines.push(line)
      if (line.startsWith('+') && !line.startsWith('+++')) {
        current.additions++
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        current.deletions++
      }
    }
  }

  // Fallback: if the diff has content but no `diff --git` markers, treat as one file
  if (files.length === 0 && diff.trim()) {
    let additions = 0
    let deletions = 0
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions++
      else if (line.startsWith('-') && !line.startsWith('---')) deletions++
    }
    files.push({ path: 'changes', additions, deletions, lines })
  }

  return files
}

function FileDiff({ file, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="diff-file">
      <button className="diff-file-header" onClick={() => setOpen((v) => !v)}>
        <span className="diff-file-chevron">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="diff-file-path">{file.path}</span>
        <span className="diff-file-stats">
          {file.additions > 0 && <span className="diff-stat-add">+{file.additions}</span>}
          {file.deletions > 0 && <span className="diff-stat-remove">-{file.deletions}</span>}
        </span>
      </button>
      {open && (
        <div className="diff-file-body">
          {file.lines.map((line, index) => {
            let className = 'diff-line'
            if (line.startsWith('diff --git')) {
              className += ' meta'
            } else if (line.startsWith('+++') || line.startsWith('---')) {
              className += ' header'
            } else if (line.startsWith('@@')) {
              className += ' hunk'
            } else if (line.startsWith('+')) {
              className += ' add'
            } else if (line.startsWith('-')) {
              className += ' remove'
            }

            return (
              <div key={`line-${index}`} className={className}>
                {line || ' '}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function DiffViewer({ diff }) {
  const files = useMemo(() => parseDiffIntoFiles(diff), [diff])

  if (files.length === 0) {
    return <div className="muted">No changes detected.</div>
  }

  return (
    <div className="diff-viewer">
      <div className="diff-summary">
        {files.length} {files.length === 1 ? 'file' : 'files'} changed
      </div>
      {files.map((file, index) => (
        <FileDiff key={`${file.path}-${index}`} file={file} defaultOpen={files.length <= 5} />
      ))}
    </div>
  )
}

function formatRuntimeLogEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return ''
  }
  const stream = typeof entry.stream === 'string' ? entry.stream : 'log'
  const text = typeof entry.text === 'string' ? entry.text : ''
  return `[${stream}] ${text}`
}

export function OutputPanel({
  taskId,
  taskStatus,
  testCommands = [],
  testCommandsLoading = false,
  testCommandsError = '',
  runningTestCommand = '',
  onRunTestCommand,
  onUpdateTestCommand,
  planData = null,
  planLoading = false,
  planError = '',
  runtimeService = null,
  runtimeServiceLogs = [],
  runtimeServiceError = '',
  onStopRuntimeService,
}) {
  const [tab, setTab] = useState('outputs')
  const runtimeLogRef = useRef(null)
  const [commandDrafts, setCommandDrafts] = useState({})
  const [savingCommandIndex, setSavingCommandIndex] = useState(-1)
  const [editingCommandIndex, setEditingCommandIndex] = useState(-1)

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

  useEffect(() => {
    if (!taskId) return
    setTab('outputs')
    void loadChanges(taskId)
    void loadFiles(taskId)
  }, [taskId])

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
    if (!taskId || !selectedPath) {
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

    void fetch(taskOutputContentUrl(taskId, selectedPath), { signal: controller.signal })
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
  }, [taskId, selectedPath, selectedKind])

  async function loadChanges(targetTaskId) {
    setChangesLoading(true)
    setChangesError('')

    try {
      const data = await fetchTaskOutputChanges(targetTaskId)
      setChanges(typeof data.diff === 'string' ? data.diff : '')
    } catch (error) {
      setChangesError(error instanceof Error ? error.message : String(error))
      setChanges('')
    } finally {
      setChangesLoading(false)
    }
  }

  async function loadFiles(targetTaskId) {
    setFilesLoading(true)
    setFilesError('')

    try {
      const data = await fetchTaskOutputFiles(targetTaskId)
      const nextFiles = Array.isArray(data.files) ? data.files : []
      setFiles(nextFiles)
    } catch (error) {
      setFilesError(error instanceof Error ? error.message : String(error))
      setFiles([])
    } finally {
      setFilesLoading(false)
    }
  }

  const outputDownloadUrl = selectedPath ? taskOutputDownloadUrl(taskId, selectedPath) : ''
  const outputContentUrl = selectedPath ? taskOutputContentUrl(taskId, selectedPath) : ''
  const runtimeLogText = useMemo(() => {
    if (!Array.isArray(runtimeServiceLogs) || runtimeServiceLogs.length === 0) {
      return ''
    }
    return runtimeServiceLogs.map((entry) => formatRuntimeLogEntry(entry)).join('')
  }, [runtimeServiceLogs])

  useEffect(() => {
    if (!runtimeLogRef.current) {
      return
    }
    runtimeLogRef.current.scrollTop = runtimeLogRef.current.scrollHeight
  }, [runtimeLogText])

  useEffect(() => {
    const next = {}
    testCommands.forEach((item, index) => {
      next[index] = typeof item?.command === 'string' ? item.command : ''
    })
    setCommandDrafts(next)
  }, [testCommands])

  function commandDraft(index, fallback) {
    const value = commandDrafts[index]
    if (typeof value === 'string') {
      return value
    }
    return fallback
  }

  async function commitCommandEdit(index, fallbackCommand) {
    const current = typeof fallbackCommand === 'string' ? fallbackCommand.trim() : ''
    const nextValue = commandDraft(index, fallbackCommand).trim()
    if (!nextValue || nextValue === current) {
      setCommandDrafts((prev) => ({
        ...prev,
        [index]: current,
      }))
      return
    }

    setSavingCommandIndex(index)
    try {
      await onUpdateTestCommand?.(index, nextValue)
      setEditingCommandIndex((current) => (current === index ? -1 : current))
    } finally {
      setSavingCommandIndex(-1)
    }
  }

  return (
    <div className="output-panel">
      <div className="output-tabs">
        <button
          className={`output-tab-btn ${tab === 'outputs' ? 'active' : ''}`}
          onClick={() => setTab('outputs')}
        >
          Outputs
        </button>
        <button
          className={`output-tab-btn ${tab === 'changes' ? 'active' : ''}`}
          onClick={() => setTab('changes')}
        >
          Changes
        </button>
        {planData && (
          <button
            className={`output-tab-btn ${tab === 'plan' ? 'active' : ''}`}
            onClick={() => setTab('plan')}
          >
            Plan
          </button>
        )}
      </div>

      {tab === 'changes' && (
        <div className="output-tab-body">
          {changesLoading && <div className="muted">Loading diff...</div>}
          {changesError && <div className="error">Error: {changesError}</div>}
          {!changesLoading && !changesError && <DiffViewer diff={changes} />}
        </div>
      )}

      {tab === 'outputs' && (
        <div className="output-tab-body output-outputs-layout">
          {testCommandsLoading && <div className="muted">Loading test commands...</div>}
          {!testCommandsLoading && testCommands.length > 0 && (
            <div className="output-run-card">
              <div className="output-run-list">
                {testCommands.map((item, index) => {
                  const command = typeof item?.command === 'string' ? item.command : ''
                  const cwd = typeof item?.cwd === 'string' ? item.cwd : ''
                  const runKey = `${cwd}\n${command}`
                  const label = typeof item?.label === 'string' && item.label.trim()
                    ? item.label.trim()
                    : command || `Test ${index + 1}`
                  if (!command || !cwd) {
                    return null
                  }
                  return (
                    <div key={`${runKey}-${index}`} className="output-run-item">
                      <button
                        className="output-run-btn"
                        title={`${command}\nCWD: ${cwd}`}
                        onClick={() => {
                          void onRunTestCommand?.({
                            ...item,
                            command,
                          })
                        }}
                        disabled={
                          Boolean(runningTestCommand) ||
                          savingCommandIndex === index ||
                          editingCommandIndex === index
                        }
                      >
                        {runningTestCommand === runKey ? `Running: ${label}...` : `Run: ${label}`}
                      </button>
                      {editingCommandIndex === index ? (
                        <>
                          <input
                            className="output-run-command-input"
                            value={commandDraft(index, command)}
                            title={`${command}\nCWD: ${cwd}`}
                            onChange={(event) => {
                              const value = event.target.value
                              setCommandDrafts((prev) => ({
                                ...prev,
                                [index]: value,
                              }))
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Escape') {
                                event.preventDefault()
                                setCommandDrafts((prev) => ({
                                  ...prev,
                                  [index]: command,
                                }))
                                setEditingCommandIndex(-1)
                              }
                            }}
                            disabled={Boolean(runningTestCommand) || savingCommandIndex === index}
                          />
                          <button
                            className="output-run-save-btn"
                            onClick={() => {
                              void commitCommandEdit(index, command)
                            }}
                            disabled={Boolean(runningTestCommand) || savingCommandIndex === index}
                            title="Save command"
                          >
                            ✓
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="output-run-command" title={`${command}\nCWD: ${cwd}`}>
                            {command}
                          </span>
                          <button
                            className="output-run-edit-btn"
                            onClick={() => {
                              setCommandDrafts((prev) => ({
                                ...prev,
                                [index]: command,
                              }))
                              setEditingCommandIndex(index)
                            }}
                            disabled={Boolean(runningTestCommand) || savingCommandIndex === index}
                            title="Edit command"
                          >
                            Edit
                          </button>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
          {testCommandsError && <div className="error">Error: {testCommandsError}</div>}

          {runtimeService && runtimeService.task_id === taskId && (
            <div className="output-runtime-card">
              <div className="output-runtime-header">
                <div className="output-runtime-title-wrap">
                  <div className="output-runtime-title">{runtimeService.label || runtimeService.command}</div>
                  <div className="output-runtime-meta">
                    {runtimeService.status} · {runtimeService.cwd}
                  </div>
                </div>
                {runtimeService.status === 'running' && (
                  <button
                    className="output-runtime-stop"
                    onClick={() => onStopRuntimeService?.(runtimeService.id)}
                  >
                    Stop
                  </button>
                )}
              </div>
              {runtimeServiceError && <div className="error">Error: {runtimeServiceError}</div>}
              <pre className="output-runtime-log" ref={runtimeLogRef}>
                {runtimeLogText || 'No terminal output yet.'}
              </pre>
            </div>
          )}

          {filesLoading && <div className="muted">Loading files...</div>}
          {filesError && <div className="error">Error: {filesError}</div>}

          {!filesLoading && !filesError && files.length > 0 && (
            <>
              <div className="output-file-grid">
                {files.map((file) => {
                  const Icon = outputIcon(file.path)
                  return (
                    <button
                      key={file.path}
                      className={`output-file-tile ${selectedPath === file.path ? 'active' : ''}`}
                      onClick={() => setSelectedPath(file.path)}
                      title={file.path}
                    >
                      <span className="output-file-tile-icon">
                        <Icon size={24} strokeWidth={1.9} />
                      </span>
                      <span className="output-file-tile-name">{fileName(file.path)}</span>
                      <span className="output-file-tile-size">{formatBytes(file.size)}</span>
                    </button>
                  )
                })}
              </div>

              {selectedFile && (
                <div className="output-preview-card">
                  <div className="output-preview-header">
                    <div className="output-preview-path">{selectedFile.path}</div>
                    <div className="output-preview-actions">
                      <a className="output-download-btn" href={outputDownloadUrl}>
                        Save to Downloads
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
                        Save to Downloads
                      </a>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {!testCommandsLoading && testCommands.length === 0 && !filesLoading && files.length === 0 &&
            !(runtimeService && runtimeService.task_id === taskId) && (
            <div className="muted">No outputs yet.</div>
          )}
        </div>
      )}

      {tab === 'plan' && (
        <div className="output-tab-body">
          {planLoading && <div className="muted">Loading plan...</div>}
          {planError && <div className="error">Error: {planError}</div>}
          {!planLoading && !planError && planData && (
            <>
              <h3 className="output-plan-title">{planData.title}</h3>
              <p className="output-plan-summary">{planData.summary}</p>
              {Array.isArray(planData.steps) && planData.steps.length > 0 && (
                <ol className="output-plan-steps">
                  {planData.steps.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
