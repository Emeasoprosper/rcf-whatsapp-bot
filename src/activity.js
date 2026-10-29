import { config } from './config.js'
import { botApi } from './backend.js'

// What the bot did, for the Activity tab in the admin app. Batched and sent
// every 30 seconds so it never slows a reply down.
const FLUSH_MS = 30 * 1000
let queue = []

// kind: reply | search | chime | birthday | new-month | promo | announcement | welcome | react | send
export function logActivity(kind, groupJid, summary) {
  if (!config.botApiKey) return
  queue.push({ kind, groupJid, summary: String(summary).replace(/\s+/g, ' ').slice(0, 280) })
  if (queue.length > 200) queue = queue.slice(-200)
}

async function flush() {
  if (queue.length === 0) return
  const events = queue.slice(0, 50)
  try {
    await botApi('/activity', { method: 'POST', body: { events } })
    queue = queue.slice(events.length)
  } catch {
    // Backend asleep: keep them and try next time.
  }
}

let started = false

export function startActivityLog() {
  if (started || !config.botApiKey) return
  started = true
  setInterval(flush, FLUSH_MS)
}
