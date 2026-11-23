import sharp from 'sharp'
import pino from 'pino'
import { downloadMediaMessage } from '@whiskeysockets/baileys'
import { describeVisual } from './ai.js'

// Stickers, GIFs, short videos and photos people send: what happens in them
// and the feeling they show, so Bro Paul can respond like a person who
// watched them. Animated stickers are played: frames from start to end go to
// the AI as one sheet (it can't open animated WebP files itself). The same
// sticker is sent again and again, so each is only looked at once.

const MAX_VIDEO_BYTES = 8 * 1024 * 1024
const MAX_VIDEO_SECONDS = 30
const FRAMES = 8
const CELL = 256
const COLS = 4
const seen = new Map() // fingerprint -> description

// 'sticker' | 'GIF' | 'video' | 'photo' | null
export function visualKind(msg) {
  if (msg?.stickerMessage) return 'sticker'
  if (msg?.videoMessage) return msg.videoMessage.gifPlayback ? 'GIF' : 'video'
  if (msg?.imageMessage) return 'photo'
  return null
}

// A sticker as one PNG: itself, or (animated) up to 8 frames in time order.
export async function stickerSheet(webp) {
  const { pages = 1 } = await sharp(webp, { animated: true }).metadata()
  if (pages <= 1) return { png: await sharp(webp).flatten({ background: '#ffffff' }).png().toBuffer(), frames: 1 }
  const n = Math.min(FRAMES, pages)
  const cells = []
  for (let i = 0; i < n; i++) {
    const page = Math.round((i * (pages - 1)) / (n - 1))
    const input = await sharp(webp, { page, pages: 1 })
      .resize(CELL, CELL, { fit: 'contain', background: '#ffffff' })
      .flatten({ background: '#ffffff' })
      .png()
      .toBuffer()
    cells.push({ input, left: (i % COLS) * CELL, top: Math.floor(i / COLS) * CELL })
  }
  const png = await sharp({
    create: { width: Math.min(n, COLS) * CELL, height: Math.ceil(n / COLS) * CELL, channels: 3, background: '#ffffff' },
  })
    .composite(cells)
    .png()
    .toBuffer()
  return { png, frames: n }
}

// m = the whole message (for downloading), msg = its unwrapped content.
// Returns one short line, or '' when it can't be watched.
export async function readVisual(sock, m, msg) {
  const kind = visualKind(msg)
  if (!kind) return ''
  const media = msg.stickerMessage || msg.videoMessage || msg.imageMessage
  const key = media.fileSha256 ? Buffer.from(media.fileSha256).toString('base64') : ''
  if (key && seen.has(key)) return seen.get(key)
  const isVideo = kind === 'GIF' || kind === 'video'
  if (isVideo && (Number(media.fileLength || 0) > MAX_VIDEO_BYTES || (media.seconds || 0) > MAX_VIDEO_SECONDS)) return ''

  const raw = await downloadMediaMessage(m, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage })
  let data
  let mime
  let frames = 1
  if (kind === 'sticker') {
    const sheet = await stickerSheet(raw)
    data = sheet.png
    frames = sheet.frames
    mime = 'image/png'
  } else if (isVideo) {
    if (raw.length > MAX_VIDEO_BYTES) return ''
    data = raw // sent whole, so the AI watches it play
    mime = 'video/mp4'
  } else {
    data = await sharp(raw).rotate().resize({ width: 768, withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer()
    mime = 'image/jpeg'
  }

  const description = await describeVisual(data, mime, kind, frames)
  if (key && description) {
    seen.set(key, description)
    if (seen.size > 500) seen.delete(seen.keys().next().value)
  }
  return description
}
