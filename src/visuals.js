import sharp from 'sharp'
import pino from 'pino'
import { downloadMediaMessage } from '@whiskeysockets/baileys'
import { describePhoto, interpretExpression } from './ai.js'

// Stickers, GIFs and short videos are expressions: what matters is what the
// person is SAYING with one at that point in the chat. So each is watched
// from start to end together with the recent conversation, and only that
// meaning goes on to the reply. Nothing is kept: the file and what was seen
// in it live in memory for the moment of answering, then they're gone.

const MAX_VIDEO_BYTES = 8 * 1024 * 1024
const MAX_VIDEO_SECONDS = 30
const MAX_FRAMES = 24
const CELL = 224
const COLS = 6
const SAME_FRAME = 1.2 // average pixel difference (0-255) below this = nothing moved

// 'sticker' | 'GIF' | 'video' | 'photo' | null
export function visualKind(msg) {
  if (msg?.stickerMessage) return 'sticker'
  if (msg?.videoMessage) return msg.videoMessage.gifPlayback ? 'GIF' : 'video'
  if (msg?.imageMessage) return 'photo'
  return null
}

function difference(a, b) {
  let sum = 0
  for (let i = 0; i < a.length; i += 7) sum += Math.abs(a[i] - b[i])
  return sum / (a.length / 7)
}

// Every frame of an animated sticker is gone through; the ones where
// something moves (up to 24) go on one sheet, in order, with their times.
export async function stickerSheet(webp) {
  const { pages = 1, delay = [] } = await sharp(webp, { animated: true }).metadata()
  if (pages <= 1) return { image: await sharp(webp).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer(), times: [] }

  const { data, info } = await sharp(webp, { animated: true })
    .resize(CELL, CELL, { fit: 'contain', background: '#ffffff' })
    .flatten({ background: '#ffffff' })
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })
  const size = info.width * CELL * info.channels
  const count = Math.floor(data.length / size)
  // How much has moved by each frame: quick movement gets many frames on the
  // sheet, stillness gets few.
  const frames = []
  let clock = 0
  let moved = 0
  for (let i = 0; i < count; i++) {
    const pixels = data.subarray(i * size, (i + 1) * size)
    const step = i ? difference(pixels, frames[i - 1].pixels) : 0
    if (step > SAME_FRAME) moved += step
    frames.push({ pixels, at: clock, moved })
    clock += delay[i] || 0
  }
  const picks = new Set([0, count - 1])
  if (count <= MAX_FRAMES) frames.forEach((_, i) => picks.add(i))
  else for (let k = 1; k < MAX_FRAMES - 1; k++) {
    const target = (moved * k) / (MAX_FRAMES - 1)
    picks.add(frames.findIndex((f) => f.moved >= target))
  }
  const kept = [...picks].sort((a, b) => a - b).map((i) => frames[i])

  const image = await sharp({
    create: { width: Math.min(kept.length, COLS) * CELL, height: Math.ceil(kept.length / COLS) * CELL, channels: 3, background: '#ffffff' },
  })
    .composite(kept.map((f, i) => ({
      input: Buffer.from(f.pixels),
      raw: { width: info.width, height: CELL, channels: info.channels },
      left: (i % COLS) * CELL,
      top: Math.floor(i / COLS) * CELL,
    })))
    .jpeg({ quality: 82 })
    .toBuffer()
  return { image, times: kept.map((f) => f.at) }
}

// m = the whole message (for downloading), msg = its unwrapped content,
// history = the recent chat, quoted = the message it replies to, if any.
// Returns { text, emoji } (text is never to be saved), or null.
export async function readVisual(sock, m, msg, { history = [], quoted = '', senderName = '' } = {}) {
  const kind = visualKind(msg)
  if (!kind) return null
  const media = msg.stickerMessage || msg.videoMessage || msg.imageMessage
  const isVideo = kind === 'GIF' || kind === 'video'
  if (isVideo && (Number(media.fileLength || 0) > MAX_VIDEO_BYTES || (media.seconds || 0) > MAX_VIDEO_SECONDS)) return null

  const raw = await downloadMediaMessage(m, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage })
  // A photo is content (a place, a timetable), not an expression.
  if (kind === 'photo') {
    const jpeg = await sharp(raw).rotate().resize({ width: 768, withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer()
    const seen = await describePhoto(jpeg)
    return seen ? { text: `[photo: ${seen}]`, emoji: '' } : null
  }
  if (isVideo && raw.length > MAX_VIDEO_BYTES) return null
  const look = isVideo
    ? { media: raw, mimeType: 'video/mp4', seconds: media.seconds || 3 }
    : await stickerSheet(raw).then(({ image, times }) => ({ media: image, mimeType: 'image/jpeg', times }))
  const said = await interpretExpression({ ...look, kind, history, quoted, senderName })
  if (!said) return null
  // People mix it up: sometimes a tap of an emoji, sometimes a few words.
  const style = Math.random() < 0.5 ? 'this time answer in a few words, not REACT' : 'a reaction alone is fine'
  return { text: `[${kind}, what they are saying with it: "${said.saying}"${said.emoji ? ` (fitting reaction: ${said.emoji})` : ''}; ${style}]`, emoji: said.emoji }
}
