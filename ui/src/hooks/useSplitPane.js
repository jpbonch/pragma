import { useCallback, useEffect, useRef, useState } from 'react'

const MIN_LEFT_PCT = 25
const MAX_LEFT_PCT = 75

function loadStoredRatio(storageKey, fallback) {
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw == null) return fallback
    const val = parseFloat(raw)
    if (Number.isFinite(val) && val >= MIN_LEFT_PCT && val <= MAX_LEFT_PCT) {
      return val
    }
  } catch {}
  return fallback
}

/**
 * Hook for a resizable split pane. Returns the left-pane width percentage
 * and handlers for a drag handle.
 *
 * @param {string} storageKey  - localStorage key to persist the ratio
 * @param {number} [defaultPct=54] - default left-pane percentage (0-100)
 */
export function useSplitPane(storageKey, defaultPct = 54) {
  const [leftPct, setLeftPct] = useState(() => loadStoredRatio(storageKey, defaultPct))
  const draggingRef = useRef(false)
  const containerRef = useRef(null)

  const handlePointerDown = useCallback((e) => {
    e.preventDefault()
    draggingRef.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  useEffect(() => {
    function handlePointerMove(e) {
      if (!draggingRef.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      if (rect.width === 0) return
      const x = e.clientX - rect.left
      let pct = (x / rect.width) * 100
      pct = Math.max(MIN_LEFT_PCT, Math.min(MAX_LEFT_PCT, pct))
      setLeftPct(pct)
    }

    function handlePointerUp() {
      if (!draggingRef.current) return
      draggingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [])

  // Persist ratio when dragging stops (debounced by storing on value change)
  const prevPctRef = useRef(leftPct)
  useEffect(() => {
    if (prevPctRef.current === leftPct) return
    prevPctRef.current = leftPct
    try {
      localStorage.setItem(storageKey, String(Math.round(leftPct * 100) / 100))
    } catch {}
  }, [leftPct, storageKey])

  return { leftPct, containerRef, handlePointerDown }
}
