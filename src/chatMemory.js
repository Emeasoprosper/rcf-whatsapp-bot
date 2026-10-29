import { config } from './config.js'

// Last few messages per group, in memory only, so the AI can follow the
// conversation. Nothing here is saved to disk.
const groups = new Map()
const lastHumanAt = new Map()

export function remember(groupId, { name, text, fromBot = false }) {
  if (!groupId || !text) return
  const list = groups.get(groupId) || []
  list.push({ name: fromBot ? config.botName : name || 'Member', text: text.slice(0, 400), fromBot, at: Date.now() })
  if (list.length > config.chatMemorySize) list.shift()
  groups.set(groupId, list)
  if (!fromBot) lastHumanAt.set(groupId, Date.now())
}

export function recentChat(groupId) {
  return [...(groups.get(groupId) || [])]
}

export function lastHumanMessageAt(groupId) {
  return lastHumanAt.get(groupId) || 0
}

// How lively the group is right now: messages and distinct people in the
// last `windowMs`, and when the bot last spoke.
export function activity(groupId, windowMs) {
  const since = Date.now() - windowMs
  const list = groups.get(groupId) || []
  const recent = list.filter((m) => !m.fromBot && m.at >= since)
  const lastBot = [...list].reverse().find((m) => m.fromBot)
  return {
    messages: recent.length,
    people: new Set(recent.map((m) => m.name)).size,
    lastBotAt: lastBot?.at || 0,
  }
}
