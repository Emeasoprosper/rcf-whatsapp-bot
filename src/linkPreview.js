import sharp from 'sharp'
import { prepareWAMessageMedia } from '@whiskeysockets/baileys'
import { config } from './config.js'

// When one of Bro Paul's messages carries exactly one library book link,
// it goes out with the usual WhatsApp link preview: the book's cover, title
// and author, like a link a person pastes. WhatsApp doesn't make previews
// for messages sent this way, so we build it from the book's public page
// (the same title, description and cover WhatsApp itself would read).
// Messages listing several books stay plain. If anything is slow or fails,
// the message is sent without a preview.

const LIB_LINK = new RegExp(`${config.siteUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/library/([0-9a-f-]{36})`, 'gi')
const CACHE_MS = 6 * 60 * 60 * 1000
const MAX_WAIT_MS = 12000
const cache = new Map() // resource id -> { at, title, description, image }

function decode(s = '') {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

function meta(html, prop) {
  const m = html.match(new RegExp(`<meta property="og:${prop}" content="([^"]*)"`, 'i'))
  return m ? decode(m[1]) : ''
}

async function fetchTimed(url, ms) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) })
  if (!res.ok) throw new Error(`${url} returned ${res.status}`)
  return res
}

async function bookInfo(id) {
  const hit = cache.get(id)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit
  const html = await (await fetchTimed(`${config.backendUrl}/library/${id}`, 8000)).text()
  const title = meta(html, 'title')
  if (!title) throw new Error('no title on the book page')
  let image = null
  const imageUrl = meta(html, 'image')
  if (imageUrl) {
    const raw = Buffer.from(await (await fetchTimed(imageUrl, 10000)).arrayBuffer())
    // A sensible size for the preview: crisp, but small to upload.
    image = await sharp(raw).resize({ width: 600, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer()
  }
  const info = { at: Date.now(), title, description: meta(html, 'description'), image }
  cache.set(id, info)
  if (cache.size > 200) cache.delete(cache.keys().next().value)
  return info
}

// A WhatsApp link card (the tappable picture + title box a pasted link gets).
// Send it as { text: '<something with url>', linkPreview: card }.
export async function linkCard(sock, { url, title, description = '', image = null }) {
  const preview = { 'canonical-url': url, 'matched-text': url, title, description }
  if (image) {
    // Uploaded as a proper link thumbnail so the preview shows the full
    // picture (like a pasted link), with the small inline version as backup.
    const { imageMessage } = await prepareWAMessageMedia(
      { image },
      { upload: sock.waUploadToServer, mediaTypeOverride: 'thumbnail-link' }
    )
    // Our own small version (sharper than the default tiny one).
    preview.jpegThumbnail = await sharp(image).resize({ width: 240, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer()
      .catch(() => (imageMessage?.jpegThumbnail ? Buffer.from(imageMessage.jpegThumbnail) : undefined))
    preview.highQualityThumbnail = imageMessage || undefined
  }
  return preview
}

// Same card, with its picture downloaded from imageUrl (skipped if that fails).
export async function linkCardFromImageUrl(sock, { url, title, description, imageUrl }) {
  let image = null
  if (imageUrl) {
    try {
      const raw = Buffer.from(await (await fetchTimed(imageUrl, 10000)).arrayBuffer())
      image = await sharp(raw).resize({ width: 600, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer()
    } catch (err) {
      console.error('Link card picture skipped:', err.message)
    }
  }
  return linkCard(sock, { url, title, description, image })
}

async function buildPreview(sock, url, id) {
  const info = await bookInfo(id)
  return linkCard(sock, { url, title: info.title, description: info.description, image: info.image })
}

// Returns the message content with a link preview added when it has
// exactly one library book link; otherwise the content unchanged.
export async function withBookPreview(sock, content) {
  if (!content || typeof content.text !== 'string' || 'linkPreview' in content) return content
  const matches = [...content.text.matchAll(LIB_LINK)]
  const ids = new Set(matches.map((m) => m[1].toLowerCase()))
  if (ids.size !== 1) return content
  try {
    const preview = await Promise.race([
      buildPreview(sock, matches[0][0], matches[0][1]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('took too long')), MAX_WAIT_MS)),
    ])
    return { ...content, linkPreview: preview }
  } catch (err) {
    console.error('Book link preview skipped:', err.message)
    return content
  }
}

// Every text message the socket sends gets this check.
export function addBookPreviews(sock) {
  const send = sock.sendMessage.bind(sock)
  sock.sendMessage = async (jid, content, options) => send(jid, await withBookPreview(sock, content), options)
  return sock
}
