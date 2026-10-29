import makeWASocket, { DisconnectReason } from '@whiskeysockets/baileys'
import QRCode from 'qrcode'
import pino from 'pino'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { config } from './config.js'
import { handleMessage, maybeChimeIn } from './handler.js'
import { remember, recentChat } from './chatMemory.js'
import { startPoster, queueWelcome } from './poster.js'
import { loadAuth } from './authStore.js'
import { isAllowedGroup, refreshGroups, reportGroup, reportAllGroups } from './groups.js'
import { setStatus, startHeartbeat, currentStatus } from './status.js'
import { HEART, isThanksOnly, isBirthdayWish, shouldReact } from './reactions.js'
import { handleBirthdayWish } from './birthday.js'
import { initState } from './state.js'

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

async function onMessage(sock, m) {
  const jid = m.key?.remoteJid
  if (!jid || !jid.endsWith('@g.us')) return // groups only
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
  const react = () =>
    sock.sendMessage(jid, { react: { text: HEART, key: m.key } }).catch((err) => console.error('React failed:', err.message))

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
    await react() // "thanks Bro Paul" gets a heart, not a speech
    return
  }

  if (!fromMe && isBirthdayWish(text)) {
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
      },
    })
    return
  }

  const reply = await handleMessage({
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

  if (reply) {
    await sock.sendMessage(jid, { text: reply }, { quoted: m })
    remember(jid, { text: reply, fromBot: true })
    return
  }

  if (fromMe) return
  const chime = await maybeChimeIn(jid)
  if (chime) {
    await sock.sendMessage(jid, { text: chime })
    remember(jid, { text: chime, fromBot: true })
    console.log(`[chime] Joined the discussion in ${jid}`)
    return
  }

  // Good news, testimonies, shared materials: sometimes just a heart.
  if (shouldReact(jid, { text, hasDocument })) await react()
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
start()
