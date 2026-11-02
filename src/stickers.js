import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { config } from './config.js'
import { getPool } from './authStore.js'
import { describeSticker } from './ai.js'
import { logActivity } from './activity.js'

// Bro Paul's sticker pack, taught by the owner: they send stickers to the
// bot's number in a private chat, the AI looks at each one and decides what
// it means (laughing, celebrating, thank you...), and the bot uses them at
// fitting moments, at most one per chat every 20 minutes.
// Kept in the database (whatsapp_stickers) on the server, or in the
// stickers/ folder when running on a PC without DATABASE_URL.

export const MOODS = ['funny', 'celebrate', 'thanks', 'love', 'greeting', 'goodnight', 'prayer', 'wow', 'agree', 'encourage', 'sad', 'sorry', 'study', 'other']
const LOCAL_DIR = 'stickers'
const LOCAL_INDEX = path.join(LOCAL_DIR, 'index.json')
const COOLDOWN_MS = 20 * 60 * 1000

let pack = [] // { id, sha, mood, emoji, description, webp }
const lastSentAt = new Map()
const lastUsedId = new Map() // mood -> id, so the same sticker doesn't repeat back to back
let lastLearnedId = null

const useDb = () => Boolean(process.env.DATABASE_URL)

export async function initStickers() {
  try {
    if (useDb()) {
      const db = getPool()
      await db.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_stickers (
          id SERIAL PRIMARY KEY,
          sha TEXT UNIQUE NOT NULL,
          mood TEXT NOT NULL,
          emoji TEXT,
          description TEXT,
          webp BYTEA NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`)
      const rows = (await db.query(`SELECT id, sha, mood, emoji, description, webp FROM whatsapp_stickers ORDER BY id`)).rows
      pack = rows.map((r) => ({ ...r, webp: Buffer.from(r.webp) }))
    } else if (fs.existsSync(LOCAL_INDEX)) {
      pack = JSON.parse(fs.readFileSync(LOCAL_INDEX, 'utf8')).map((s) => ({ ...s, webp: fs.readFileSync(path.join(LOCAL_DIR, `${s.sha}.webp`)) }))
    }
    if (pack.length) console.log(`[stickers] ${pack.length} sticker${pack.length === 1 ? '' : 's'} loaded`)
  } catch (err) {
    console.error('Could not load stickers:', err.message)
  }
}

function saveLocalIndex() {
  fs.mkdirSync(LOCAL_DIR, { recursive: true })
  fs.writeFileSync(LOCAL_INDEX, JSON.stringify(pack.map(({ webp, ...rest }) => rest), null, 2))
}

// Teaches one sticker. Returns { sticker, isNew }.
export async function learnSticker(webp) {
  const sha = crypto.createHash('sha256').update(webp).digest('hex')
  const existing = pack.find((s) => s.sha === sha)
  if (existing) return { sticker: existing, isNew: false }

  // First frame as PNG for the AI (animated stickers included).
  const png = await sharp(webp, { animated: false }).png().toBuffer()
  const seen = await describeSticker(png)
  const mood = MOODS.includes(seen.mood) ? seen.mood : 'other'
  const entry = { sha, mood, emoji: seen.emoji || '', description: seen.description || '', webp }

  if (useDb()) {
    const r = await getPool().query(
      `INSERT INTO whatsapp_stickers (sha, mood, emoji, description, webp) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (sha) DO UPDATE SET mood = EXCLUDED.mood RETURNING id`,
      [sha, mood, entry.emoji, entry.description, webp]
    )
    entry.id = r.rows[0].id
  } else {
    entry.id = (pack.reduce((m, s) => Math.max(m, s.id || 0), 0) || 0) + 1
    fs.mkdirSync(LOCAL_DIR, { recursive: true })
    fs.writeFileSync(path.join(LOCAL_DIR, `${sha}.webp`), webp)
  }
  pack.push(entry)
  if (!useDb()) saveLocalIndex()
  lastLearnedId = entry.id
  return { sticker: entry, isNew: true }
}

// "forget last sticker" / correcting a mood ("that one is thanks").
export async function forgetLastSticker() {
  const s = pack.find((x) => x.id === lastLearnedId) || pack[pack.length - 1]
  if (!s) return null
  pack = pack.filter((x) => x !== s)
  if (useDb()) await getPool().query(`DELETE FROM whatsapp_stickers WHERE id = $1`, [s.id])
  else {
    fs.rmSync(path.join(LOCAL_DIR, `${s.sha}.webp`), { force: true })
    saveLocalIndex()
  }
  lastLearnedId = null
  return s
}

export async function relabelLastSticker(mood) {
  const s = pack.find((x) => x.id === lastLearnedId) || pack[pack.length - 1]
  if (!s || !MOODS.includes(mood)) return null
  s.mood = mood
  if (useDb()) await getPool().query(`UPDATE whatsapp_stickers SET mood = $2 WHERE id = $1`, [s.id, mood])
  else saveLocalIndex()
  return s
}

export function stickerSummary() {
  if (!pack.length) return 'My sticker pack is empty. Send me some stickers here and I\'ll learn what each one means 🙂'
  const counts = {}
  for (const s of pack) counts[s.mood] = (counts[s.mood] || 0) + 1
  const lines = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([mood, n]) => `• ${mood}: ${n}`)
  return `I know ${pack.length} sticker${pack.length === 1 ? '' : 's'} 🗂️\n\n${lines.join('\n')}\n\nSend more anytime. Say *forget last sticker* to remove the last one, or *last sticker is thanks* (or funny, celebrate, prayer...) to correct it.`
}

function pick(mood) {
  const options = pack.filter((s) => s.mood === mood)
  if (!options.length) return null
  const fresh = options.length > 1 ? options.filter((s) => s.id !== lastUsedId.get(mood)) : options
  const s = fresh[Math.floor(Math.random() * fresh.length)]
  lastUsedId.set(mood, s.id)
  return s
}

// Sends a sticker for that mood if there is one, stickers are on, the chat
// hasn't had one in the last 20 minutes, and the dice say yes. Returns true if sent.
export async function maybeSendSticker(sock, jid, mood, { chance = 1 } = {}) {
  if (!sock || !config.stickers || !mood || !pack.length) return false
  if (Date.now() - (lastSentAt.get(jid) || 0) < COOLDOWN_MS) return false
  if (Math.random() >= chance) return false
  const s = pick(mood)
  if (!s) return false
  try {
    await sock.sendMessage(jid, { sticker: s.webp })
    lastSentAt.set(jid, Date.now())
    logActivity('sticker', jid.endsWith('@g.us') ? jid : null, `${s.emoji || '🎟️'} ${mood} sticker${s.description ? `: ${s.description}` : ''}`)
    return true
  } catch (err) {
    console.error('Sticker send failed:', err.message)
    return false
  }
}

// The AI may end a reply with "[sticker: funny]". Splits that off.
export function splitStickerTag(text) {
  const m = /\s*\[\s*sticker\s*:\s*([a-z]+)\s*\]\s*$/i.exec(text || '')
  if (!m) return { text, sticker: null }
  const mood = m[1].toLowerCase()
  return { text: text.slice(0, m.index).trim(), sticker: MOODS.includes(mood) ? mood : null }
}
