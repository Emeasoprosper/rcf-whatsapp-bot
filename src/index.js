import makeWASocket, { DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys'
import QRCode from 'qrcode'
import pino from 'pino'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { config } from './config.js'
import { handleMessage, handlePrivateMessage, maybeChimeIn } from './handler.js'
import { remember, recentChat } from './chatMemory.js'
import { startPoster, queueWelcome } from './poster.js'
import { loadAuth } from './authStore.js'
import { isAllowedGroup, refreshGroups, reportGroup, reportAllGroups } from './groups.js'
import { setStatus, startHeartbeat, currentStatus } from './status.js'
import { HEART, isThanksOnly, isBirthdayWish, isGoodNews, shouldReact } from './reactions.js'
import { initStickers, learnSticker, forgetLastSticker, relabelLastSticker, stickerSummary, maybeSendSticker, splitStickerTag, MOODS } from './stickers.js'
import { handleBirthdayWish } from './birthday.js'
import { initState } from './state.js'
import { startLiveSettings } from './liveSettings.js'
import { startActivityLog, logActivity } from './activity.js'

const QR_FILE = 'qr.png'
const GROUP_REFRESH_MS = 60 * 1000

const announcedGroups = new Set()
let currentSock = null

const bareId = (jid) => String(jid || '').split('@')[0].split(':')[0]
const botIds = (sock) => [sock.user?.id, sock.user?.lid].filter(Boolean).map(bareId)

// Disappearing-message and view-once wrappers hide the real message inside.
function unwrap(msg) {
  return msg?.ephemeralMessage?.message || msg?.viewOnceMessageV2?.message || msg?.viewOnceMessage?.message || msg
}

function readText(msg) {
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    ''
  )
}

function readContext(msg) {
  return (
    msg.extendedTextMessage?.contextInfo ||
    msg.imageMessage?.contextInfo ||
    msg.videoMessage?.contextInfo ||
    msg.documentMessage?.contextInfo ||
    {}
  )
}

// One-to-one chat (phone number or WhatsApp's newer @lid ids). Status
// updates, channels and broadcast lists are not chats and are ignored.
const isPrivateChat = (jid) => /@(s\.whatsapp\.net|lid)$/.test(jid)

// The owner (CREATOR_PHONE, or anyone in STICKER_TEACHERS) can teach stickers.
// WhatsApp may show a private chat as an @lid id; the phone number then
// comes in remoteJidAlt / senderPn.
function isStickerTeacher(m, jid) {
  const digits = config.creatorPhone.replace(/\D/g, '')
  const owner = digits.startsWith('0') ? `234${digits.slice(1)}` : digits
  const allowed = [owner, ...config.stickerTeachers]
  const ids = [jid, m.key.remoteJidAlt, m.key.senderPn, m.key.participantAlt].filter(Boolean).map(bareId)
  return ids.some((id) => allowed.includes(id))
}

const MOOD_WORD = MOODS.join('|')

// Owner-only text commands about the sticker pack. Returns a reply or null.
async function stickerCommand(text) {
  const t = text.trim().toLowerCase()
  if (/^(my\s+|your\s+)?stickers\??$|^sticker\s+pack\??$/.test(t)) return stickerSummary()
  if (/\b(forget|delete|remove)\s+(the\s+)?last\s+sticker\b/.test(t)) {
    const gone = await forgetLastSticker()
    return gone ? `Done, I've forgotten that ${gone.mood} sticker 🗑️` : 'There is no sticker to forget yet.'
  }
  const relabel = new RegExp(`\\blast\\s+sticker\\s+(is|=|means|for)\\s+(${MOOD_WORD})\\b`).exec(t)
  if (relabel) {
    const s = await relabelLastSticker(relabel[2])
    return s ? `Got it, I'll use that one for *${s.mood}* ✅` : 'There is no sticker to correct yet.'
  }
  return null
}

async function learnFromOwner(sock, m, jid) {
  try {
    const webp = await downloadMediaMessage(m, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage })
    const { sticker, isNew } = await learnSticker(webp)
    const reply = isNew
      ? `Got it ${sticker.emoji || '✅'} I see: _${sticker.description || 'a sticker'}_.\nI'll use it for *${sticker.mood}* moments.\n\nWrong? Say *last sticker is thanks* (or funny, celebrate, prayer, greeting...).`
      : `I already have this one (${sticker.mood}) 👍`
    await sock.sendMessage(jid, { text: reply })
  } catch (err) {
    console.error('Learning sticker failed:', err.message)
    await sock.sendMessage(jid, { text: "I couldn't read that sticker. Please send it again in a minute 🙏" }).catch(() => {})
  }
}

async function onPrivateMessage(sock, m, jid) {
  if (!config.privateChats || m.key.fromMe) return
  const msg = unwrap(m.message)
  if (!msg) return

  // Stickers sent to the bot: the owner is teaching the pack. Others are ignored.
  if (msg.stickerMessage) {
    if (isStickerTeacher(m, jid)) return learnFromOwner(sock, m, jid)
    console.log(`[stickers] Sticker from ${bareId(jid)} ignored. To let this number teach stickers, add it to STICKER_TEACHERS.`)
    return
  }

  const text = readText(msg)
  if (!text) return

  if (isStickerTeacher(m, jid)) {
    const answer = await stickerCommand(text)
    if (answer) return void sock.sendMessage(jid, { text: answer })
  }

  const senderName = m.pushName || ''
  const history = recentChat(jid)
  remember(jid, { name: senderName, text })

  if (isThanksOnly(text)) {
    // Now and then a "thank you" sticker instead of the heart.
    if (await maybeSendSticker(sock, jid, 'thanks', { chance: 0.35 })) return
    if (config.reactions) await sock.sendMessage(jid, { react: { text: HEART, key: m.key } }).catch(() => {})
    return
  }

  // Blue ticks + "typing…" while the AI thinks, like a real person.
  sock.readMessages([m.key]).catch(() => {})
  sock.sendPresenceUpdate('composing', jid).catch(() => {})
  const raw = await handlePrivateMessage({ id: m.key.id, senderId: jid, senderName, text, history })
  sock.sendPresenceUpdate('paused', jid).catch(() => {})
  if (!raw) return

  const { text: reply, sticker } = splitStickerTag(raw)
  if (reply) {
    await sock.sendMessage(jid, { text: reply })
    remember(jid, { text: reply, fromBot: true })
  }
  if (sticker) await maybeSendSticker(sock, jid, sticker)
  // Private chats stay private: the admin Activity tab only sees that one happened.
  logActivity('private', null, 'Answered a private chat')
}

async function onMessage(sock, m) {
  const jid = m.key?.remoteJid
  if (jid && isPrivateChat(jid)) return onPrivateMessage(sock, m, jid)
  if (!jid || !jid.endsWith('@g.us')) return
  const msg = unwrap(m.message)
  if (!msg) return

  if (!isAllowedGroup(jid)) {
    if (config.botApiKey) {
      // New group: register it. The backend switches it on and notifies the
      // superadmins, so the bot answers from the next message on.
      reportGroup(sock, jid)
    } else if (!announcedGroups.has(jid)) {
      // Safety without the backend: never reply until ALLOWED_GROUP_JID is set.
      announcedGroups.add(jid)
      const hint = config.allowedGroups.length
        ? `add it to ALLOWED_GROUP_JID in .env (comma separated) to enable replies there too`
        : `put ALLOWED_GROUP_JID=${jid} in .env to enable replies there`
      console.log(`[setup] Message seen in group ${jid} -> ${hint}`)
    }
    return
  }

  const fromMe = Boolean(m.key.fromMe)
  const hasDocument = Boolean(msg.documentMessage || msg.documentWithCaptionMessage)
  const react = async () => {
    if (!config.reactions) return
    try {
      await sock.sendMessage(jid, { react: { text: HEART, key: m.key } })
      logActivity('react', jid, `🤍 on ${m.pushName || 'a member'}'s message`)
    } catch (err) {
      console.error('React failed:', err.message)
    }
  }

  const text = readText(msg)
  if (!text) {
    // A shared file with no caption: probably materials, worth a heart.
    if (!fromMe && hasDocument && shouldReact(jid, { text: '', hasDocument })) await react()
    return
  }

  const ctx = readContext(msg)
  const ids = botIds(sock)
  const mentioned = ctx.mentionedJid || []
  const mentionedBot = mentioned.some((j) => ids.includes(bareId(j)))
  const repliedToBot = Boolean(ctx.quotedMessage) && ids.includes(bareId(ctx.participant))
  const senderName = m.pushName || ''
  const senderId = m.key.participant || jid

  // History is taken before this message is added, so the AI sees it once.
  const history = recentChat(jid)
  if (!fromMe) remember(jid, { name: senderName, text })

  if (!fromMe && (mentionedBot || repliedToBot) && isThanksOnly(text)) {
    // "thanks Bro Paul" gets a heart (or now and then a thank-you sticker), not a speech.
    if (!(await maybeSendSticker(sock, jid, 'thanks', { chance: 0.35 }))) await react()
    return
  }

  if (!fromMe && config.birthdayWishes && isBirthdayWish(text)) {
    if (shouldReact(jid, { text, birthday: true })) await react()
    handleBirthdayWish({
      groupId: jid,
      text,
      mentioned: mentioned.filter((j) => !ids.includes(bareId(j))),
      quotedParticipant: ctx.quotedMessage ? ctx.participant : null,
      senderId,
      send: async (content) => {
        const live = currentSock
        if (!live) return
        await live.sendMessage(jid, content)
        remember(jid, { text: content.text, fromBot: true })
        logActivity('birthday', jid, content.text)
        await maybeSendSticker(live, jid, 'celebrate', { chance: 0.6 })
      },
    })
    return
  }

  const raw = await handleMessage({
    id: m.key.id,
    senderId,
    senderName,
    text,
    isGroup: true,
    fromMe,
    mentionedBot,
    repliedToBot,
    history,
  })

  if (raw) {
    // The AI may end its reply with [sticker: mood]: text first, then the sticker.
    const { text: reply, sticker } = splitStickerTag(raw)
    if (reply) {
      await sock.sendMessage(jid, { text: reply }, { quoted: m })
      remember(jid, { text: reply, fromBot: true })
      const kind = /^Here's what I found|^I couldn't find/.test(reply) ? 'search' : 'reply'
      logActivity(kind, jid, `${senderName || 'Member'}: "${text.slice(0, 80)}" → ${reply.slice(0, 120)}`)
    }
    if (sticker) await maybeSendSticker(sock, jid, sticker)
    return
  }

  if (fromMe) return
  const chime = await maybeChimeIn(jid)
  if (chime) {
    await sock.sendMessage(jid, { text: chime })
    remember(jid, { text: chime, fromBot: true })
    console.log(`[chime] Joined the discussion in ${jid}`)
    logActivity('chime', jid, chime)
    return
  }

  // Good news, testimonies, shared materials: sometimes just a heart; for
  // good news, now and then a celebration sticker instead.
  if (shouldReact(jid, { text, hasDocument })) {
    if (isGoodNews(text) && (await maybeSendSticker(sock, jid, 'celebrate', { chance: 0.5 }))) return
    await react()
  }
}

async function start() {
  setStatus('connecting')
  const auth = await loadAuth()
  const sock = makeWASocket({ auth: auth.state, logger: pino({ level: 'silent' }) })
  currentSock = null

  sock.ev.on('creds.update', auth.saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.log('\nScan this QR with the BOT number: WhatsApp > Linked devices > Link a device\n')
      console.log(await QRCode.toString(qr, { type: 'terminal', small: true }))
      // Terminal QR is hard to scan on small screens, so also save a big image.
      await QRCode.toFile(QR_FILE, qr, { width: 600, margin: 4 }).catch(() => {})
      console.log(`Too small? Open ${path.resolve(QR_FILE)} or the WhatsApp Bot page in the admin app`)
      setStatus('qr', { qrDataUrl: await QRCode.toDataURL(qr, { width: 400, margin: 2 }) })
    }

    if (connection === 'open') {
      fs.rmSync(QR_FILE, { force: true })
      currentSock = sock
      console.log(`Connected as ${sock.user?.id} (login saved in ${auth.where}). ${config.botName} is online.`)
      setStatus('online', { phone: bareId(sock.user?.id) })
      startPoster(() => currentSock)
      await refreshGroups()
      reportAllGroups(sock)
    }

    if (connection === 'close') {
      currentSock = null
      const code = lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        // Unlinked from the phone, or a superadmin asked for a new number.
        // Forget the old login and show a fresh QR (terminal + admin page).
        console.log('Logged out from WhatsApp. Clearing the saved login and showing a new QR...')
        await auth.clear()
        setTimeout(start, 2000)
        return
      }
      setStatus('connecting')
      const delay = code === DisconnectReason.restartRequired ? 0 : 5000
      console.log(`Connection closed (code ${code}). Reconnecting...`)
      setTimeout(start, delay)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const m of messages) {
      try {
        await onMessage(sock, m)
      } catch (err) {
        console.error('Message handling failed:', err.message)
      }
    }
  })

  // Someone added the bot to a new group.
  sock.ev.on('groups.upsert', (metas) => {
    for (const meta of metas) reportGroup(sock, meta.id, meta)
  })

  sock.ev.on('group-participants.update', ({ id, participants = [], action }) => {
    if (action !== 'add') return
    // Newer Baileys versions send objects instead of plain ids.
    const ids = participants.map((p) => (typeof p === 'string' ? p : p?.id)).filter(Boolean)
    const mine = botIds(sock)
    if (ids.some((j) => mine.includes(bareId(j)))) reportGroup(sock, id)
    const newcomers = ids.filter((j) => !mine.includes(bareId(j)))
    if (newcomers.length) queueWelcome(() => currentSock, id, newcomers)
  })
}

startHeartbeat(async () => {
  console.log('A superadmin asked to link a different number. Logging out...')
  try {
    await currentSock?.logout()
  } catch (err) {
    console.error('Logout failed:', err.message)
  }
})
setInterval(refreshGroups, GROUP_REFRESH_MS)

// Hosts like Render expect a web port. This also gives uptime monitors
// something to ping.
if (process.env.PORT) {
  http
    .createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, bot: config.botName, state: currentStatus() }))
    })
    .listen(process.env.PORT, () => console.log(`Health check on :${process.env.PORT}`))
}

process.on('unhandledRejection', (reason) => console.error('Unhandled promise rejection:', reason))

await initState()
await initStickers()
await startLiveSettings()
startActivityLog()
start()
