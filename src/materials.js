// Files people send Bro Paul for the library (past questions, notes…).
//  - In DM: a PDF/Word/PowerPoint or photos that clearly look academic
//    (course code, "past questions", "notes"…) are added straight away. If
//    it isn't clear, he asks for the course code first and adds it when they
//    reply.
//  - In a group (only groups with "Ask for materials" on): when they tag him,
//    reply to his message (e.g. his "who has…?" ask) or the caption/file name
//    is clearly a course material.
// Photos sent together (an album of past-question pages) become one PDF.
// The backend (POST /api/bot/uploads) names it, files it and fulfils any
// open requests for that course; Bro Paul thanks the sender with the link.
import { downloadMediaMessage } from '@whiskeysockets/baileys'
import pino from 'pino'
import { config } from './config.js'
import { botUpload } from './backend.js'
import { groupSettings } from './groups.js'
import { logActivity } from './activity.js'

const ACADEMIC = /\b[A-Za-z]{3}\s?-?\d{3}\b|past\s*questions?|\bp\.?\s?q'?s?\b|lecture|\bnotes?\b|handouts?|\bexams?\b|\btests?\b|assignments?|tutorials?|textbooks?|syllabus|scheme of work|semester|course/i
const COURSE_CODE = /\b[A-Za-z]{3}\s?-?\d{3}\b/
const DOC_TYPES = /pdf|msword|officedocument|powerpoint|presentation/i
const ALBUM_WAIT_MS = 20 * 1000 // photos sent together arrive one by one
const PENDING_MS = 15 * 60 * 1000

const albums = new Map() // `${jid}|${sender}` -> { files, caption, timer, last }
const pending = new Map() // DM jid -> { files, caption, expires }

const first = (name) => (String(name || '').trim().split(/\s+/)[0] || 'friend')

function mediaOf(msg) {
  const doc = msg.documentMessage || msg.documentWithCaptionMessage?.message?.documentMessage
  if (doc) {
    return { kind: 'document', caption: doc.caption || '', fileName: doc.fileName || doc.title || 'document', mimetype: doc.mimetype || 'application/octet-stream' }
  }
  if (msg.imageMessage) return { kind: 'image', caption: msg.imageMessage.caption || '', fileName: 'photo.jpg', mimetype: msg.imageMessage.mimetype || 'image/jpeg' }
  return null
}

async function download(sock, m) {
  return downloadMediaMessage(m, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage })
}

function thanks(name, result) {
  const n = first(name)
  if (!result) return `Thank you so much, ${n}! 🙏 I couldn't add it just now (network wahala 😅). Please send it again in a little while.`
  if (result.status === 'duplicate') return `Thank you, ${n}! ❤️ We already have this one in the library:\n👉 ${result.url}`
  if (result.status === 'pending') return `Thank you so much, ${n}! 🙏 I've passed *${result.title}* to the library team; it'll be live once they've had a quick look.`
  let text = `Thank you so much, ${n}! 🙏❤️ I've added *${result.title}* to the library so everyone can use it:\n👉 ${result.url}`
  if (result.fulfilled) text += `\n\nI've also let the ${result.fulfilled === 1 ? 'person' : `${result.fulfilled} people`} who asked for it know 🎉 You're a blessing!`
  return text
}

async function upload(sock, { jid, quoted, files, caption, senderId, senderName, isGroup }) {
  let result = null
  try {
    result = await botUpload(
      { caption, whatsappId: senderId, whatsappName: senderName, groupJid: isGroup ? jid : '' },
      files.map((f) => ({ buffer: f.buffer, mimetype: f.mimetype, fileName: f.fileName }))
    )
    logActivity('upload', isGroup ? jid : null, `Added "${result.title}" to the library (sent by ${senderName || 'a member'})`)
  } catch (err) {
    console.error('Library upload from WhatsApp failed:', err.message)
  }
  await sock.sendMessage(jid, { text: thanks(senderName, result) }, quoted ? { quoted } : undefined).catch(() => {})
}

// Photos are collected for a short while (an album arrives one by one).
function collect(key, file, caption, flush) {
  const album = albums.get(key) || { files: [], caption: '' }
  album.files.push(file)
  if (caption) album.caption = album.caption ? `${album.caption} ${caption}` : caption
  clearTimeout(album.timer)
  album.timer = setTimeout(() => {
    albums.delete(key)
    flush(album)
  }, ALBUM_WAIT_MS)
  albums.set(key, album)
}

// Call for every incoming message before any text handling.
// Returns true when the message was a library file and has been dealt with.
export async function handleIncomingMaterial(sock, m, msg, { jid, isGroup, senderId, senderName, mentionedBot = false, repliedToBot = false }) {
  if (!config.autoUploadMaterials || !config.botApiKey || m.key.fromMe) return false
  const media = mediaOf(msg)
  if (!media) return false
  if (media.kind === 'document' && !DOC_TYPES.test(media.mimetype)) return false

  const hint = `${media.caption} ${media.fileName}`
  const academic = media.kind === 'document' ? ACADEMIC.test(hint) : ACADEMIC.test(media.caption)

  if (isGroup) {
    if (!groupSettings(jid).askForMaterials) return false
    if (!(mentionedBot || repliedToBot || academic)) return false
  }

  let buffer
  try {
    buffer = await download(sock, m)
  } catch (err) {
    console.error('Could not download the shared file:', err.message)
    return false
  }
  const file = { buffer, mimetype: media.mimetype, fileName: media.fileName }
  await sock.sendMessage(jid, { react: { text: '📥', key: m.key } }).catch(() => {})

  const send = (files, caption) => upload(sock, { jid, quoted: m, files, caption, senderId, senderName, isGroup })
  const decide = async (files, caption, clearlyAcademic) => {
    if (isGroup || clearlyAcademic) return send(files, caption)
    // DM and not clear: ask first, keep the files for a while.
    pending.set(jid, { files, caption, expires: Date.now() + PENDING_MS })
    await sock.sendMessage(jid, {
      text: `Thanks for this, ${first(senderName)}! 📚 Is it for the library? Reply with the course code and what it is (e.g. *MTH 211 past questions*) and I'll add it for everyone. If it's not for the library, no wahala, just ignore this 😊`,
    }).catch(() => {})
  }

  if (media.kind === 'document') {
    await decide([file], media.caption || media.fileName, academic)
  } else {
    collect(`${jid}|${senderId}`, file, media.caption, (album) => {
      decide(album.files, album.caption, ACADEMIC.test(album.caption)).catch((err) => console.error('Album upload failed:', err.message))
    })
  }
  return true
}

// A DM reply to "Is it for the library?". Returns true if it was handled.
export async function completePendingMaterial(sock, jid, text, { senderId, senderName }) {
  const held = pending.get(jid)
  if (!held) return false
  if (Date.now() > held.expires) {
    pending.delete(jid)
    return false
  }
  if (/^\s*(no|nope|not|nah|it'?s not|not for)\b/i.test(text)) {
    pending.delete(jid)
    await sock.sendMessage(jid, { text: 'No wahala 😊' }).catch(() => {})
    return true
  }
  if (!COURSE_CODE.test(text) && !ACADEMIC.test(text) && !/^\s*(yes|yeah|yep|sure|ok(ay)?)\b/i.test(text)) return false
  pending.delete(jid)
  await upload(sock, { jid, quoted: null, files: held.files, caption: `${text} ${held.caption || ''}`.trim(), senderId, senderName, isGroup: false })
  return true
}
