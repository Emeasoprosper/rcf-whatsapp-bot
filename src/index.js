import makeWASocket, { DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys'
import QRCode from 'qrcode'
import pino from 'pino'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { config } from './config.js'
import { handleMessage, handlePrivateMessage, maybeChimeIn, maybePrayAlong, REACT_MARKER, takeAiCall } from './handler.js'
import { logChat, startChatLog } from './chatLog.js'
import { speak, suitsVoice } from './voice.js'
import { transcribeVoice } from './ai.js'
import { remember, recentChat, inPrayer } from './chatMemory.js'
import { startPoster, queueWelcome, allowRepostToday } from './poster.js'
import { loadAuth } from './authStore.js'
import { isAllowedGroup, refreshGroups, reportGroup, reportAllGroups, groupSettings, whenNewGroup, whenSettingsChange, markLeft } from './groups.js'
import { rememberPost, introSignature, cleanUpGroup, recallLatestFeatured } from './cleanup.js'
import { setStatus, startHeartbeat, currentStatus } from './status.js'
import { HEART, isThanksOnly, isBirthdayWish, isGoodNews, shouldReact, isPrayerLike } from './reactions.js'
import { initStickers, learnSticker, forgetLastSticker, relabelLastSticker, stickerSummary, maybeSendSticker, splitStickerTag, MOODS } from './stickers.js'
import { handleBirthdayWish } from './birthday.js'
import { initState, getState, setState } from './state.js'
import { startLiveSettings } from './liveSettings.js'
import { startActivityLog, logActivity } from './activity.js'

const QR_FILE = 'qr.png'
const GROUP_REFRESH_MS = 60 * 1000

const announcedGroups = new Set()
// 🙏 on prayers during a session, at most this often per group, so it reads
// as joining in rather than a reaction on every line.
const PRAYER_REACT_GAP_MS = 30 * 1000
const lastPrayerReact = new Map()
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
    msg.stickerMessage?.contextInfo ||
    msg.audioMessage?.contextInfo ||
    {}
  )
}

const MAX_VOICE_SECONDS = 180

// A voice note turned into text, so it's handled like a typed message.
// Returns '' when it isn't a voice note, is too long, or couldn't be heard.
// source = the message holding the audio when it isn't m itself (a voice
// note m replies to); replies about it still quote m.
async function voiceText(sock, m, msg, jid, source = m) {
  const audio = msg?.audioMessage
  if (!audio) return ''
  if ((audio.seconds || 0) > MAX_VOICE_SECONDS) {
    await sock.sendMessage(jid, { text: 'That voice note is a bit long for me 😅 Can you send a shorter one (under 3 minutes) or type it?' }, { quoted: m }).catch(() => {})
    return ''
  }
  if (!takeAiCall()) return ''
  try {
    sock.sendPresenceUpdate('composing', jid).catch(() => {})
    const buffer = await downloadMediaMessage(source, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage })
    const text = await transcribeVoice(buffer, audio.mimetype || 'audio/ogg')
    if (text) console.log(`[voice] Heard ${audio.seconds || '?'}s voice note: "${text.slice(0, 80)}"`)
    else await sock.sendMessage(jid, { text: "I couldn't catch that voice note 🎧 Can you say it again or type it?" }, { quoted: m }).catch(() => {})
    return text
  } catch (err) {
    console.error('Voice note transcription failed:', err.message)
    await sock.sendMessage(jid, { text: 'Network dey do me small, I no fit play that voice note 😅 Try again in a minute or type it?' }, { quoted: m }).catch(() => {})
    return ''
  }
}

// A typed message replying to a voice note ("Bro Paul, answer this"): listen
// to that voice note too, even one sent before the bot could hear them.
// A bare tag becomes just the voice note; anything longer keeps both.
async function withQuotedVoice(sock, m, jid, text, ctx) {
  const quoted = unwrap(ctx.quotedMessage)
  if (!quoted?.audioMessage) return text
  const source = { key: { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant }, message: ctx.quotedMessage }
  const heard = await voiceText(sock, m, quoted, jid, source)
  if (!heard) return text
  const typed = text.replace(/@\S+/g, ' ').replace(/\bbro\s*paul\b/i, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  return typed.length < 15 ? heard : `${text}\n(The voice note they replied to says: "${heard}")`
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

// The owner, typing on the bot's own phone, replies "answer" to a member's
// voice note (e.g. one sent before the bot could hear them): the "answer"
// is removed and the bot answers the voice note as if it had just arrived.
const ANSWER_CMD = /^\W*(bro\s*paul\W*)?(answer|reply)(\s+(am|this|it|him|her))?\W*$/i

async function answerOnBehalf(sock, m, jid) {
  const msg = unwrap(m.message)
  const text = msg ? readText(msg) : ''
  if (!text || !ANSWER_CMD.test(text)) return
  const ctx = readContext(msg)
  if (!unwrap(ctx.quotedMessage)?.audioMessage || !ctx.stanzaId) return
  sock.sendMessage(jid, { delete: m.key }).catch(() => {})
  console.log(`[voice] Owner asked to answer an earlier voice note in ${bareId(jid)}`)
  const voiceNote = { key: { remoteJid: jid, id: ctx.stanzaId, fromMe: false }, message: ctx.quotedMessage, pushName: '' }
  return onPrivateMessage(sock, voiceNote, jid)
}

// A voice note gets a voice note back when the reply suits being spoken (no
// links or lists) and today's AI limit allows; otherwise, or if the voice
// fails, the usual text. Voice notes are for private chats only (the free
// voice allowance is small); groups always get text. Returns { sent, spoken }.
async function sendReply(sock, jid, reply, { asVoice = false, quoted } = {}) {
  const opts = quoted ? { quoted } : undefined
  const privateChat = !jid.endsWith('@g.us')
  if (asVoice && privateChat && suitsVoice(reply) && takeAiCall()) {
    sock.sendPresenceUpdate('recording', jid).catch(() => {})
    const voice = await speak(reply)
    sock.sendPresenceUpdate('paused', jid).catch(() => {})
    if (voice) {
      const sent = await sock.sendMessage(jid, { audio: voice.audio, mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: voice.seconds }, opts)
      return { sent, spoken: true }
    }
  }
  return { sent: await sock.sendMessage(jid, { text: reply }, opts), spoken: false }
}

// Private chats are saved for the admin app's Chats tab (superadmins only),
// so each person is told once, under Bro Paul's first reply to them.
const PRIVACY_NOTICE = '\n\n_🔒 Heads-up: our chats are saved so the library team can improve me. Only the library admins can see them._'
const PRIVACY_NOTICE_MAX = 20000

function privacyNotice(jid) {
  if (!config.botApiKey || config.saveChats === false) return ''
  const told = getState('privacyNoticed', {})
  if (told[jid]) return ''
  told[jid] = Date.now()
  const ids = Object.keys(told)
  if (ids.length > PRIVACY_NOTICE_MAX) delete told[ids[0]]
  setState('privacyNoticed', told)
  return PRIVACY_NOTICE
}

async function onPrivateMessage(sock, m, jid) {
  if (!config.privateChats) return
  if (m.key.fromMe) return answerOnBehalf(sock, m, jid)
  const msg = unwrap(m.message)
  if (!msg) return

  // Stickers sent to the bot: the owner is teaching the pack. Others are ignored.
  if (msg.stickerMessage) {
    if (isStickerTeacher(m, jid)) return learnFromOwner(sock, m, jid)
    // Not a teacher: laugh along instead of ignoring it.
    console.log(`[stickers] Sticker from ${bareId(jid)} not learned (only teachers can add stickers; see STICKER_TEACHERS).`)
    await sock.sendMessage(jid, { react: { text: '😂', key: m.key } }).catch(() => {})
    return
  }

  const isVoice = Boolean(msg.audioMessage)
  if (isVoice) sock.readMessages([m.key]).catch(() => {})
  let text = isVoice ? await voiceText(sock, m, msg, jid) : readText(msg)
  if (!text) return
  if (!isVoice) text = await withQuotedVoice(sock, m, jid, text, readContext(msg))

  if (!isVoice && isStickerTeacher(m, jid)) {
    const answer = await stickerCommand(text)
    if (answer) return void sock.sendMessage(jid, { text: answer })
  }

  const senderName = m.pushName || ''
  const history = recentChat(jid)
  remember(jid, { name: senderName, text: isVoice ? `(voice note) ${text}` : text })
  logChat({ chatJid: jid, chatName: senderName, senderName, kind: isVoice ? 'voice' : 'text', text })

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

  // The AI couldn't answer a casual message: react like a person instead.
  const reaction = REACT_MARKER.exec(raw)
  if (reaction) return void sock.sendMessage(jid, { react: { text: reaction[1], key: m.key } }).catch(() => {})

  const { text: reply, sticker } = splitStickerTag(raw)
  if (reply) {
    const notice = privacyNotice(jid)
    const { spoken } = await sendReply(sock, jid, isVoice ? reply : reply + notice, { asVoice: isVoice })
    // A voice reply can't carry the written notice, so it follows as text.
    if (isVoice && notice) await sock.sendMessage(jid, { text: notice.trim() }).catch(() => {})
    remember(jid, { text: reply, fromBot: true, kind: spoken ? 'voice' : 'text' })
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

  // Voice notes can't @mention anyone, so in groups the bot only listens to
  // ones sent as a reply to its own message.
  const voiceCtx = msg.audioMessage ? readContext(msg) : null
  const voiceToBot = !fromMe && voiceCtx?.quotedMessage && botIds(sock).includes(bareId(voiceCtx.participant))
  const isVoice = Boolean(voiceToBot)
  let text = isVoice ? await voiceText(sock, m, msg, jid) : readText(msg)
  if (!text) {
    // Someone answered Bro Paul with a sticker, GIF or picture: laugh along
    // like a person would (a 😂 reaction, or now and then a funny sticker back).
    const visual = msg.stickerMessage || msg.imageMessage || msg.videoMessage
    const visualCtx = readContext(msg)
    const toBot = visual && visualCtx.quotedMessage && botIds(sock).includes(bareId(visualCtx.participant))
    if (!fromMe && toBot) {
      if (!(await maybeSendSticker(sock, jid, 'funny', { chance: 0.4 }))) {
        await sock.sendMessage(jid, { react: { text: '😂', key: m.key } }).catch(() => {})
      }
      return
    }
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
  // "@Bro Paul" as a reply to someone's voice note: listen to it and answer.
  if (!fromMe && !isVoice && (mentionedBot || /^\W*bro\s*paul\b/i.test(text))) text = await withQuotedVoice(sock, m, jid, text, ctx)

  // History is taken before this message is added, so the AI sees it once.
  const history = recentChat(jid)
  if (!fromMe) remember(jid, { name: senderName, text: isVoice ? `(voice note) ${text}` : text })

  // Prayer session: no banter. Depending on the group's setting, 🙏 the
  // prayers and now and then add a short prayer. Talking to Bro Paul
  // directly still gets an answer (a reverent one, see handler.js).
  if (!fromMe && !mentionedBot && !repliedToBot && inPrayer(jid) && isPrayerLike(text) && !isBirthdayWish(text)) {
    const mode = groupSettings(jid).prayer
    if (mode !== 'quiet' && config.reactions && Date.now() - (lastPrayerReact.get(jid) || 0) > PRAYER_REACT_GAP_MS) {
      lastPrayerReact.set(jid, Date.now())
      await sock.sendMessage(jid, { react: { text: '🙏', key: m.key } }).catch(() => {})
    }
    if (mode === 'join') {
      const prayer = await maybePrayAlong(jid)
      if (prayer && currentSock) {
        await currentSock.sendMessage(jid, { text: prayer })
        remember(jid, { text: prayer, fromBot: true })
        logActivity('prayer', jid, prayer)
      }
    }
    return
  }

  if (!fromMe && (mentionedBot || repliedToBot) && isThanksOnly(text)) {
    // "thanks Bro Paul" gets a heart (or now and then a thank-you sticker), not a speech.
    if (!(await maybeSendSticker(sock, jid, 'thanks', { chance: 0.35 }))) await react()
    return
  }

  if (!fromMe && config.birthdayWishes && groupSettings(jid).birthdays && isBirthdayWish(text)) {
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
    groupId: jid,
    senderId,
    senderName,
    text,
    isGroup: true,
    fromMe,
    mentionedBot,
    repliedToBot,
    history,
  })

  // A message Bro Paul answers goes to the chat log, just before his reply.
  if (raw && !fromMe) logChat({ chatJid: jid, senderName, kind: isVoice ? 'voice' : 'text', text })

  if (raw && REACT_MARKER.test(raw)) {
    // The AI couldn't answer a casual message: react like a person instead.
    const emoji = REACT_MARKER.exec(raw)[1]
    await sock.sendMessage(jid, { react: { text: emoji, key: m.key } }).catch(() => {})
    logActivity('react', jid, `${emoji} on ${senderName || 'a member'}'s message`)
    return
  }

  if (raw) {
    // The AI may end its reply with [sticker: mood]: text first, then the sticker.
    const { text: reply, sticker } = splitStickerTag(raw)
    if (reply) {
      const { sent, spoken } = await sendReply(sock, jid, reply, { asVoice: isVoice, quoted: m })
      // "Who are you?" gets the introduction: remember it so it can be
      // cleaned up if the group's settings change.
      if (reply.startsWith('Hello everyone! 👋')) rememberPost(jid, sent?.key, 'intro', { signature: introSignature(jid) })
      remember(jid, { text: reply, fromBot: true, kind: spoken ? 'voice' : 'text' })
      const kind = /^Here's what I found|^I couldn't find/.test(reply) ? 'search' : 'reply'
      logActivity(kind, jid, `${senderName || 'Member'}: "${text.slice(0, 80)}" → ${reply.slice(0, 120)}`)
    }
    if (sticker && !inPrayer(jid)) await maybeSendSticker(sock, jid, sticker)
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
      // For the "DM me" link when business comes up in a group.
      config.botPhone = bareId(sock.user?.id)
      console.log(`Connected as ${sock.user?.id} (login saved in ${auth.where}). ${config.botName} is online.`)
      setStatus('online', { phone: bareId(sock.user?.id) })
      setTimeout(async () => {
        await recallLatestFeatured(currentSock).catch((err) => console.error('Book of the day recall failed:', err.message))
        allowRepostToday()
      }, 15000)
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
    // Newer Baileys versions send objects instead of plain ids.
    const ids = participants.map((p) => (typeof p === 'string' ? p : p?.id)).filter(Boolean)
    const mine = botIds(sock)
    // Any form of his id (phone number or WhatsApp's @lid id) counts as him.
    const isMe = (p) =>
      [typeof p === 'string' ? p : p?.id, p?.lid, p?.phoneNumber].filter(Boolean).some((j) => mine.includes(bareId(j)))
    if ((action === 'remove' || action === 'leave') && participants.some(isMe)) {
      logActivity('left', id, 'Removed from the group: switched off there')
      markLeft(id)
      return
    }
    if (action !== 'add') return
    if (participants.some(isMe)) reportGroup(sock, id)
    const newcomers = ids.filter((j) => !mine.includes(bareId(j)))
    if (newcomers.length) queueWelcome(() => currentSock, id, newcomers)
  })
}

// A brand-new group waits silently under "New groups" in the admin app until
// a superadmin clicks Introduce or Start quietly (see poster.js sendOutbox).
whenNewGroup((jid) => console.log(`[groups] Waiting in ${jid} until a superadmin introduces or starts Bro Paul there.`))

// Settings changed in the admin app: delete his recent posts there that no
// longer fit (see cleanup.js).
// Not connected yet (e.g. just after a restart): try again shortly.
function cleanUpWhenConnected(jid, tries = 0) {
  if (!currentSock) {
    if (tries < 10) setTimeout(() => cleanUpWhenConnected(jid, tries + 1), 60 * 1000)
    return
  }
  cleanUpGroup(currentSock, jid).catch((err) => console.error('Cleanup failed:', err.message))
}
whenSettingsChange((jid) => cleanUpWhenConnected(jid))

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

// Render's free plan sleeps a service after ~15 minutes with no web visits,
// which drops WhatsApp. Visiting our own public address every 10 minutes
// keeps it awake (Render sets RENDER_EXTERNAL_URL). An outside monitor such
// as UptimeRobot is still needed to wake it if it ever does fall asleep.
const SELF_URL = process.env.KEEP_AWAKE_URL || process.env.RENDER_EXTERNAL_URL
if (SELF_URL && process.env.PORT) {
  setInterval(() => {
    fetch(SELF_URL, { signal: AbortSignal.timeout(30000) }).catch((err) => console.warn('Keep-awake ping failed:', err.message))
  }, 10 * 60 * 1000).unref()
}

process.on('unhandledRejection', (reason) => console.error('Unhandled promise rejection:', reason))

await initState()
await initStickers()
await startLiveSettings()
startActivityLog()
startChatLog()
start()
