import sharp from 'sharp'
import pino from 'pino'
import { downloadMediaMessage } from '@whiskeysockets/baileys'
import { describeVisual } from './ai.js'

// Stickers, GIFs and photos people send: what they show and what the sender
// means by them ("confused face; means huh?"), so Bro Paul can respond to
// them like a person who saw them. The same sticker is sent again and again,
// so each one is only looked at once (remembered by its file fingerprint).

const MAX_GIF_BYTES = 6 * 1024 * 1024
const seen = new Map() // fingerprint -> description

// 'sticker' | 'GIF' | 'photo' | null
export function visualKind(msg) {
  if (msg?.stickerMessage) return 'sticker'
  if (msg?.videoMessage?.gifPlayback) return 'GIF'
  if (msg?.imageMessage) return 'photo'
  return null
}

// m = the whole message (for downloading), msg = its unwrapped content.
// Returns one short line, or '' when it couldn't be read.
export async function readVisual(sock, m, msg) {
  const kind = visualKind(msg)
  if (!kind) return ''
  const media = msg.stickerMessage || msg.videoMessage || msg.imageMessage
  const key = media.fileSha256 ? Buffer.from(media.fileSha256).toString('base64') : ''
  if (key && seen.has(key)) return seen.get(key)

  const raw = await downloadMediaMessage(m, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage })
  let data
  let mime
  if (kind === 'sticker') {
    // First frame is enough to read an animated sticker's meaning.
    data = await sharp(raw, { animated: false }).png().toBuffer()
    mime = 'image/png'
  } else if (kind === 'GIF') {
    if (raw.length > MAX_GIF_BYTES) return ''
    data = raw
    mime = 'video/mp4'
  } else {
    data = await sharp(raw).rotate().resize({ width: 768, withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer()
    mime = 'image/jpeg'
  }

  const description = await describeVisual(data, mime, kind)
  if (key && description) {
    seen.set(key, description)
    if (seen.size > 500) seen.delete(seen.keys().next().value)
  }
  return description
}
