import { config } from './config.js'
import { isPrayerLike, isBirthdayWish } from './reactions.js'
import { logChat } from './chatLog.js'

// Last few messages per group, in memory only, so the AI can follow the
// conversation. Nothing here is saved to disk.
const groups = new Map()
const lastHumanAt = new Map()
const prayerMarks = new Map() // groupId -> [{ name, at }] of recent prayer-like messages

// A prayer session: at least 3 prayer-like messages from 2+ people within
// 10 minutes. It's treated as still going until 15 minutes after the last one.
const PRAYER_WINDOW_MS = 10 * 60 * 1000
const PRAYER_TAIL_MS = 15 * 60 * 1000

// Everything Bro Paul says is also saved to the chat log (admin Chats tab);
// members' messages are saved by the caller only when they're for him.
export function remember(groupId, { name, text, fromBot = false, kind = 'text' }) {
  if (!groupId || !text) return
  if (fromBot) logChat({ chatJid: groupId, fromBot: true, kind, text })
  const list = groups.get(groupId) || []
  list.push({ name: fromBot ? config.botName : name || 'Member', text: text.slice(0, 400), fromBot, at: Date.now() })
  if (list.length > config.chatMemorySize) list.shift()
  groups.set(groupId, list)
  if (!fromBot) lastHumanAt.set(groupId, Date.now())
  // Birthday wishes ("more grace IJN", "Amen") aren't a prayer session.
  if (!fromBot && isPrayerLike(text) && !isBirthdayWish(text)) {
    const marks = (prayerMarks.get(groupId) || []).filter((m) => Date.now() - m.at < PRAYER_TAIL_MS + PRAYER_WINDOW_MS)
    marks.push({ name: name || 'Member', at: Date.now() })
    prayerMarks.set(groupId, marks.slice(-50))
  }
}

// True while the group is praying together.
export function inPrayer(groupId) {
  const marks = prayerMarks.get(groupId) || []
  if (marks.length === 0 || Date.now() - marks[marks.length - 1].at > PRAYER_TAIL_MS) return false
  // Any 10-minute stretch with 3+ prayer messages from 2+ people.
  for (let i = 0; i < marks.length; i++) {
    const burst = marks.filter((m) => m.at >= marks[i].at && m.at - marks[i].at <= PRAYER_WINDOW_MS)
    if (burst.length >= 3 && new Set(burst.map((m) => m.name)).size >= 2) return true
  }
  return false
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
