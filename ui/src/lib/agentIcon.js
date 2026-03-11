const AGENT_ICONS = ['🔎', '✏️', '📊', '🧠', '🛠', '🧪', '🛰️', '🧩']

export function iconForAgent(id) {
  const text = String(id ?? '')
  let hash = 0
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0
  }
  return AGENT_ICONS[hash % AGENT_ICONS.length]
}
