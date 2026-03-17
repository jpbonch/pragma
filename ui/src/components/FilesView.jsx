import { useEffect, useMemo, useState } from 'react'
import { FileCode2, FileImage, FileSpreadsheet, FileText, FileType2 } from 'lucide-react'
import Papa from 'papaparse'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  fetchWorkspaceOutputFiles,
  workspaceOutputContentUrl,
  workspaceOutputDownloadUrl,
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

function fileIcon(path) {
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
  const parsed = Papa.parse(text, { skipEmptyLines: 'greedy' })
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors[0].message || 'Failed to parse CSV.')
  }
  if (!Array.isArray(parsed.data)) return []
  return parsed.data.map((row) => (Array.isArray(row) ? row : [String(row)]))
}

export function FilesView() {
  const [files, setFiles] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedPath, setSelectedPath] = useState('')
  const [previewText, setPreviewText] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')

  useEffect(() => {
    void loadFiles()
  }, [])

  async function loadFiles() {
    setLoading(true)
    setError('')
    try {
      const data = await fetchWorkspaceOutputFiles()
      const nextFiles = Array.isArray(data.files) ? data.files : []
      setFiles(nextFiles)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setFiles([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!files.length) {
      setSelectedPath('')
      return
    }
    setSelectedPath((current) => {
      if (current && files.some((f) => f.path === current)) return current
      return files[0].path
    })
  }, [files])

  const selectedFile = useMemo(() => {
    return files.find((f) => f.path === selectedPath) || null
  }, [files, selectedPath])

  const selectedKind = previewKind(selectedPath || '')

  useEffect(() => {
    if (!selectedPath) {
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

    void fetch(workspaceOutputContentUrl(selectedPath), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.text()
      })
      .then((text) => setPreviewText(text))
      .catch((err) => {
        if (controller.signal.aborted) return
        setPreviewError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!controller.signal.aborted) setPreviewLoading(false)
      })

    return () => controller.abort()
  }, [selectedPath, selectedKind])

  const contentUrl = selectedPath ? workspaceOutputContentUrl(selectedPath) : ''
  const downloadUrl = selectedPath ? workspaceOutputDownloadUrl(selectedPath) : ''

  if (loading) {
    return (
      <div className="files-view">
        <div className="files-empty"><div className="muted">Loading files...</div></div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="files-view">
        <div className="files-empty"><div className="error">Error: {error}</div></div>
      </div>
    )
  }

  if (files.length === 0) {
    return (
      <div className="files-view">
        <div className="files-empty">
          <div className="files-empty-inner">
            <div className="files-empty-icon">
              <FileType2 size={32} strokeWidth={1.4} />
            </div>
            <div className="files-empty-title">No output files yet</div>
            <div className="files-empty-desc">Files generated by tasks will appear here.</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="files-view">
      <div className="files-sidebar">
        <div className="files-sidebar-header">
          <span className="files-section-title">Output Files</span>
          <span className="files-count">{files.length}</span>
        </div>
        <div className="files-list">
          {files.map((file) => {
            const Icon = fileIcon(file.path)
            return (
              <button
                key={file.path}
                className={`files-item ${selectedPath === file.path ? 'active' : ''}`}
                onClick={() => setSelectedPath(file.path)}
                title={file.path}
              >
                <span className="files-item-icon"><Icon size={15} strokeWidth={1.8} /></span>
                <span className="files-item-name">{fileName(file.path)}</span>
                <span className="files-item-size">{formatBytes(file.size)}</span>
              </button>
            )
          })}
        </div>
      </div>
      <div className="files-content">
        {selectedFile && (
          <>
            <div className="files-preview-header">
              <div className="files-preview-path">{selectedFile.path}</div>
              <a className="output-download-btn" href={downloadUrl}>
                Save to Downloads
              </a>
            </div>

            {previewLoading && <div className="muted">Loading preview...</div>}
            {previewError && <div className="error">Error: {previewError}</div>}

            {!previewLoading && !previewError && selectedKind === 'markdown' && (
              <div className="output-markdown-preview">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{previewText}</ReactMarkdown>
              </div>
            )}

            {!previewLoading && !previewError && selectedKind === 'html' && (
              <iframe className="output-html-preview" src={contentUrl} title={selectedFile.path} />
            )}

            {!previewLoading && !previewError && selectedKind === 'image' && (
              <div className="output-image-wrap">
                <img src={contentUrl} alt={selectedFile.path} className="output-image-preview" />
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
                <a className="output-download-btn" href={downloadUrl}>
                  Save to Downloads
                </a>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
