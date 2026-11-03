import { config } from './config.js'
import { botApi } from './backend.js'

// Conversations for the admin app's Chats tab: every private chat, and in
// groups the messages Bro Paul answers plus everything he posts. Batched and
// sent every 15 seconds so it never slows a reply down. Switched off with
// "Save chats" in the Control Center settings.
const FLUSH_MS = 15 * 1000
let queue = []

// kind: text | voice | image | sticker | post
export function logChat({ chatJid, chatName = null, senderName = null, fromBot = false, kind = 'text', text }) {
  if (!config.botApiKey || config.saveChats === false || !chatJid || !text) return
  queue.push({
    chatJid,
    chatType: chatJid.endsWith('@g.us') ? 'group' : 'private',
    chatName,
    senderName: fromBot ? config.botName : senderName,
    fromBot,
    kind,
    text: String(text).slice(0, 4000),
    at: Date.now(),
  })
  if (queue.length > 500) queue = queue.slice(-500)
}

async function flush() {
  if (queue.length === 0) return
  const messages = queue.slice(0, 40)
  try {
    await botApi('/messages', { method: 'POST', body: { messages } })
    queue = queue.slice(messages.length)
  } catch {
    // Backend asleep: keep them and try next time.
  }
}

let started = false

export function startChatLog() {
  if (started || !config.botApiKey) return
  started = true
  setInterval(flush, FLUSH_MS)
}
