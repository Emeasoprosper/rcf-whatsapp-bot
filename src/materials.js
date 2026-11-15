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

// Only clear signs of study material. Generic words ("lecture", "course",
// "semester", "test") also appear on event flyers ("ETF Lecture Hall"), so
// they don't count; the library AI also looks at every picture/PDF before
// anything is saved.
const ACADEMIC = /\b[A-Za-z]{3}\s?-?\d{3}\b|past\s*questions?|\bp\.?\s?q'?s\b|\bpq\b|lecture\s*notes?|course\s*(notes?|materials?|outline)|handouts?|textbooks?|syllabus|scheme of work/i
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

// The library AI looks at the file first. Returns false when nothing was saved
// because it isn't study material (or we couldn't tell and should ask).
async function upload(sock, { jid, quoted, files, caption, senderId, senderName, isGroup, confirmed = false, reactTo = null }) {
  let result = null
  try {
    result = await botUpload(
      { caption, whatsappId: senderId, whatsappName: senderName, groupJid: isGroup ? jid : '', confirmed: confirmed ? 'true' : '' },
      files.map((f) => ({ buffer: f.buffer, mimetype: f.mimetype, fileName: f.fileName }))
    )
  } catch (err) {
    console.error('Library upload from WhatsApp failed:', err.message)
  }

  if (result?.status === 'not_material') {
    console.log(`Not saved (not study material): ${result.reason || ''}`)
    // In groups people share flyers and photos all the time: stay quiet.
    if (!isGroup) {
      await sock.sendMessage(jid, {
        text: `Thanks ${first(senderName)}! 😊 This doesn't look like study material to me${result.reason ? ` (${result.reason.replace(/\.$/, '')})` : ''}, so I haven't added it to the library. If it *is* for a course, reply with the course code and what it is (e.g. *MTH 211 past questions*) and I'll add it.`,
      }).catch(() => {})
      pending.set(jid, { files, caption, expires: Date.now() + PENDING_MS })
    }
    return false
  }
  if (result?.status === 'unverified') {
    if (!isGroup) {
      pending.set(jid, { files, caption, expires: Date.now() + PENDING_MS })
      await sock.sendMessage(jid, {
        text: `Thanks for this, ${first(senderName)}! 📚 Is it for the library? Reply with the course code and what it is (e.g. *MTH 211 past questions*) and I'll add it for everyone. If it's not, no wahala 😊`,
      }).catch(() => {})
    }
    return false
  }

  if (result) {
    logActivity('upload', isGroup ? jid : null, `Added "${result.title}" to the library (sent by ${senderName || 'a member'})`)
    if (reactTo) await sock.sendMessage(jid, { react: { text: '📥', key: reactTo } }).catch(() => {})
  }
  await sock.sendMessage(jid, { text: thanks(senderName, result) }, quoted ? { quoted } : undefined).catch(() => {})
  return true
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
    // Photos and PDFs go to the library AI, which looks at them (one photo of
    // a past question is caught even with no caption; a flyer is ignored).
    // Word/PowerPoint can't be looked at, so they need a clear caption/name.
    const aiCanCheck = media.kind === 'image' || /pdf/i.test(media.mimetype)
    if (!(mentionedBot || repliedToBot || academic || aiCanCheck)) return false
  }

  let buffer
  try {
    buffer = await download(sock, m)
  } catch (err) {
    console.error('Could not download the shared file:', err.message)
    return false
  }
  const file = { buffer, mimetype: media.mimetype, fileName: media.fileName }

  // Every file goes to the library, whose AI looks at it before saving: a
  // flyer or random photo comes back "not_material" and nothing is added.
  // In a DM, when even the AI can't tell, Bro Paul asks first.
  const send = (files, caption) => upload(sock, { jid, quoted: m, files, caption, senderId, senderName, isGroup, reactTo: m.key })
  const decide = (files, caption) => send(files, caption)

  if (media.kind === 'document') {
    await decide([file], media.caption || media.fileName)
  } else {
    collect(`${jid}|${senderId}`, file, media.caption, (album) => {
      decide(album.files, album.caption).catch((err) => console.error('Album upload failed:', err.message))
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
  await upload(sock, { jid, quoted: null, files: held.files, caption: `${text} ${held.caption || ''}`.trim(), senderId, senderName, isGroup: false, confirmed: true })
  return true
}
