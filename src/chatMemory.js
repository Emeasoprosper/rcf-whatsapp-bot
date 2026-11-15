import { config } from './config.js'
import { isPrayerLike, isBirthdayWish } from './reactions.js'
import { logChat } from './chatLog.js'
import { getPool } from './authStore.js'

// Recent messages per chat, so the AI can follow the conversation.
// Also saved to the database (bot_chat_memory) when DATABASE_URL is set, so
// a restart or redeploy doesn't wipe his memory: the first time a chat is
// touched after a start, its recent history is loaded back (loadChat).
// Private chats keep more (a person's own conversation with him) than groups.
const PRIVATE_KEEP = 40
const KEEP_DAYS = 120
const GROUP_KEEP_DAYS = 3
const keepFor = (jid) => (String(jid).endsWith('@g.us') ? Math.max(config.chatMemorySize, 20) : PRIVATE_KEEP)
const db = () => (process.env.DATABASE_URL ? getPool() : null)

let tableReady = null
function ensureTable() {
  const pool = db()
  if (!pool) return Promise.resolve(false)
  tableReady ||= pool
    .query(`
      CREATE TABLE IF NOT EXISTS bot_chat_memory (
        id BIGSERIAL PRIMARY KEY,
        chat_jid TEXT NOT NULL,
        name TEXT,
        text TEXT NOT NULL,
        from_bot BOOLEAN NOT NULL DEFAULT false,
        at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS bot_chat_memory_chat_at ON bot_chat_memory (chat_jid, at DESC);
    `)
    .then(() => {
      // Old chatter is let go now and then, like a person forgets.
      // Group chatter only matters for a few days; private chats much longer.
      pool
        .query(
          `DELETE FROM bot_chat_memory
           WHERE at < now() - make_interval(days => CASE WHEN chat_jid LIKE '%@g.us' THEN $2 ELSE $1 END)`,
          [KEEP_DAYS, GROUP_KEEP_DAYS]
        )
        .catch(() => {})
      return true
    })
    .catch((err) => {
      tableReady = null
      console.error('Chat memory table unavailable:', err.message)
      return false
    })
  return tableReady
}

const loaded = new Set()
const loading = new Map()

// Brings a chat's saved history back into memory (once per chat per start).
// Safe to await before every reply: after the first time it's instant.
export async function loadChat(jid) {
  if (!jid || loaded.has(jid)) return
  if (loading.has(jid)) return loading.get(jid)
  const job = (async () => {
    try {
      if (!(await ensureTable())) return
      const { rows } = await db().query(
        `SELECT name, text, from_bot, at FROM bot_chat_memory WHERE chat_jid = $1 ORDER BY at DESC LIMIT $2`,
        [jid, keepFor(jid)]
      )
      const saved = rows.reverse().map((r) => ({ name: r.from_bot ? config.botName : r.name || 'Member', text: r.text, fromBot: r.from_bot, at: new Date(r.at).getTime() }))
      // Anything said since the start (already in memory) stays after the saved part.
      const now = groups.get(jid) || []
      const firstNew = now.length ? now[0].at : Infinity
      const merged = [...saved.filter((s) => s.at < firstNew), ...now].slice(-keepFor(jid))
      groups.set(jid, merged)
      loaded.add(jid)
    } catch (err) {
      console.error('Could not load chat memory:', err.message)
    } finally {
      loading.delete(jid)
    }
  })()
  loading.set(jid, job)
  return job
}

function save(jid, entry) {
  ensureTable()
    .then((ok) => ok && db().query(`INSERT INTO bot_chat_memory (chat_jid, name, text, from_bot) VALUES ($1, $2, $3, $4)`, [jid, entry.name, entry.text, entry.fromBot]))
    .catch((err) => console.error('Could not save chat memory:', err.message))
}

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
  const entry = { name: fromBot ? config.botName : name || 'Member', text: text.slice(0, 600), fromBot, at: Date.now() }
  list.push(entry)
  while (list.length > keepFor(groupId)) list.shift()
  groups.set(groupId, list)
  save(groupId, entry)
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
