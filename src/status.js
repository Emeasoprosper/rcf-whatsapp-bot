import { config } from './config.js'
import { botApi } from './backend.js'

// Tells the backend what the bot is doing, so the superadmin "WhatsApp Bot"
// page can show Online / the QR to scan / Offline. Sent on every change and
// every 30s as a heartbeat (no heartbeat for 2 minutes = shown as offline).
const HEARTBEAT_MS = 30 * 1000

let current = { state: 'connecting' }
let onRelink = null
let warned = false

async function push() {
  if (!config.botApiKey) return
  try {
    const { relink } = await botApi('/status', { method: 'POST', body: current })
    warned = false
    if (relink && current.state === 'online' && onRelink) onRelink()
  } catch (err) {
    if (!warned) console.error('Could not reach the backend for status updates:', err.message)
    warned = true
  }
}

// state: 'connecting' | 'qr' | 'online' | 'offline'
export function setStatus(state, { qrDataUrl = null, phone = null } = {}) {
  current = { state, qrDataUrl, phone }
  push()
}

export function currentStatus() {
  return current.state
}

let started = false

// relinkHandler runs when a superadmin taps "Link a different number".
export function startHeartbeat(relinkHandler) {
  onRelink = relinkHandler
  if (started) return
  started = true
  setInterval(push, HEARTBEAT_MS)
}
