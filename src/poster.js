import { readdirSync } from 'node:fs'
import path from 'node:path'
import { config, isActiveHours } from './config.js'
import { getState, setState } from './state.js'
import { remember, lastHumanMessageAt } from './chatMemory.js'
import { botApi } from './backend.js'
import { allowedGroups, isAllowedGroup } from './groups.js'
import { askNewMonthWish } from './ai.js'
import { logActivity } from './activity.js'
import { quoteCard, HANDLE } from './quoteImage.js'
import { maybeSendSticker } from './stickers.js'

// Things the bot posts on its own: admin announcements (ticked "post to
// WhatsApp" in the admin app), "upload to the library" adverts, and
// welcomes for new members. getSock() always returns the live socket,
// since index.js makes a new one on every reconnect.

const PROMO_DIR = 'promo-images'
const PROMO_CHECK_MS = 10 * 60 * 1000
const WELCOME_BATCH_MS = 60 * 1000
const MAX_IMAGE_FAILURES = 3

async function send(sock, jid, content, logText) {
  await sock.sendMessage(jid, content)
  remember(jid, { text: logText, fromBot: true })
}

// ---------- Admin announcements ----------

const TYPE_HEADER = {
  announcement: '📢 *ANNOUNCEMENT*',
  news: '📰 *RCF LIBRARY NEWS*',
  advert: '✨ *SPONSORED*',
}

function announcementCaption(item) {
  const lines = [TYPE_HEADER[item.type] || '📢', '', `*${item.title}*`, '', item.message]
  if (item.link_url) lines.push('', `🔗 ${item.link_url}`)
  if (item.type !== 'advert') lines.push('', `More on the library app: ${config.siteUrl}/news/${item.id}`)
  return lines.join('\n').slice(0, 3500)
}

const imageFailures = new Map()

async function postAnnouncement(sock, item) {
  const caption = announcementCaption(item)
  const mime = item.attachment_mime || ''
  const useImage = item.attachment_url && mime.startsWith('image/') && (imageFailures.get(item.id) || 0) < MAX_IMAGE_FAILURES

  for (const jid of allowedGroups()) {
    if (useImage) {
      await send(sock, jid, { image: { url: item.attachment_url }, caption }, caption)
    } else if (item.attachment_url && mime === 'application/pdf') {
      await send(sock, jid, { text: caption }, caption)
      await sock.sendMessage(jid, {
        document: { url: item.attachment_url },
        mimetype: 'application/pdf',
        fileName: `${item.title.slice(0, 60)}.pdf`,
      })
    } else {
      await send(sock, jid, { text: caption }, caption)
    }
  }
}

let polling = false

async function pollAnnouncements(getSock) {
  const sock = getSock()
  if (polling || !sock || !isActiveHours() || allowedGroups().length === 0) return
  polling = true
  try {
    const { items = [] } = await botApi('/announcements/pending')
    for (const item of items) {
      try {
        await postAnnouncement(sock, item)
      } catch (err) {
        // Usually the image download (Drive / Render waking up). After a few
        // tries we post it as text so the announcement still goes out.
        imageFailures.set(item.id, (imageFailures.get(item.id) || 0) + 1)
        console.error(`Posting announcement ${item.id} failed:`, err.message)
        continue
      }
      await botApi(`/announcements/${item.id}/posted`, { method: 'POST', body: {} })
      imageFailures.delete(item.id)
      console.log(`[post] Announcement "${item.title}" posted to ${allowedGroups().length} group(s)`)
      logActivity('announcement', null, `Posted "${item.title}" to ${allowedGroups().length} group(s)`)
    }
  } catch (err) {
    console.error('Announcement check failed:', err.message)
  } finally {
    polling = false
  }
}

// ---------- "Upload to the library" adverts ----------

function promoTexts() {
  const site = config.siteUrl
  const upload = `${site}/contribute/submit`
  return [
    `📚 *Got past questions or notes on your phone?*\n\nThat PDF sitting in your gallery could save someone's semester! 🙌 Upload it to the RCF Library so every member can find it.\n\n📤 Upload here: ${upload}\n\n"Freely you have received, freely give." Matthew 10:8`,
    `🎓 *Help a fellow student today!*\n\nShare your lecture notes, handouts, textbooks or past questions on the RCF digital library. It takes less than a minute.\n\n📤 ${upload}\n🔎 Need something? Just ask me here, e.g. *Bro Paul, CHM 101 past questions*`,
    `✨ *The RCF Library grows because of YOU!*\n\nEvery upload helps a brother or sister study better. Courses, devotionals, sermons, project materials: everything counts.\n\n📤 Upload: ${upload}\n📝 Can't find something? Request it: ${site}/contribute/request`,
    `📖 *Exams are coming!* 🔥\n\nYour past questions can bless someone else's exam prep. Upload them to the RCF Library, and while you're there, check what others have shared.\n\n📤 ${upload}\n🌐 ${site}`,
  ]
}

function promoImages() {
  try {
    return readdirSync(PROMO_DIR)
      .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
      .sort()
      .map((f) => path.join(PROMO_DIR, f))
  } catch {
    return []
  }
}

async function maybePostPromo(getSock) {
  const sock = getSock()
  if (!sock || !config.promoEveryHours || !isActiveHours()) return

  const lastPromo = getState('lastPromoAt', {})
  const intervalMs = config.promoEveryHours * 60 * 60 * 1000
  const texts = promoTexts()
  const images = promoImages()
  let index = getState('promoIndex', 0)

  for (const jid of allowedGroups()) {
    const last = lastPromo[jid] || 0
    if (Date.now() - last < intervalMs) continue
    // Only advertise in a group that's been active since the last advert,
    // so the bot never talks to an empty room.
    if (last && lastHumanMessageAt(jid) < last) continue

    const text = texts[index % texts.length]
    const image = images.length ? images[index % images.length] : null
    try {
      await send(sock, jid, image ? { image: { url: image }, caption: text } : { text }, text)
      lastPromo[jid] = Date.now()
      console.log(`[promo] Upload advert posted in ${jid}${image ? ` with ${image}` : ''}`)
      logActivity('promo', jid, text.split('\n')[0])
    } catch (err) {
      console.error('Promo post failed:', err.message)
    }
    index += 1
  }
  setState('lastPromoAt', lastPromo)
  setState('promoIndex', index)
}

// ---------- Happy new month ----------

const NEW_MONTH_FROM_HOUR = 8

function lagosToday() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Lagos', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date())
  const get = (type) => parts.find((p) => p.type === type).value
  return { year: get('year'), monthName: get('month'), day: Number(get('day')), hour: Number(get('hour')) }
}

function newMonthFallback(monthName) {
  return `Happy new month, family! 🎉 Welcome to ${monthName}. May this month bring you clear focus for your studies, good health and answered prayers 🙏 Let's make it count 💪🏾`
}

// test = FORCE_NEW_MONTH=1 at startup: post right now, only to the groups in
// ALLOWED_GROUP_JID (your test group), and don't count it, so the real
// post on the 1st still happens.
async function maybeNewMonthWish(getSock, { test = false } = {}) {
  const sock = getSock()
  const { year, monthName, day, hour } = lagosToday()
  if (!sock) return
  if (!test && !config.newMonthWishes) return
  if (!test && (day !== 1 || hour < NEW_MONTH_FROM_HOUR || !isActiveHours())) return

  const key = `${year}-${monthName}`
  const done = getState('newMonthPosted', {})
  const due = test ? config.allowedGroups : allowedGroups().filter((jid) => done[jid] !== key)
  if (due.length === 0) {
    if (test) console.log('[new-month] Test skipped: put your test group in ALLOWED_GROUP_JID first.')
    return
  }

  // About one month in three gets a light "I'm a bot, but..." wink. Every
  // month would get old fast; never would feel a bit robotic.
  const selfAware = Math.random() < 0.34
  let text
  try {
    text = await askNewMonthWish({ monthName, selfAware })
  } catch (err) {
    console.error('New month AI failed, using a ready-made message:', err.message)
    text = newMonthFallback(monthName)
  }

  for (const jid of due) {
    try {
      await send(sock, jid, { text }, text)
      if (!test) done[jid] = key
      console.log(`[new-month] ${test ? 'TEST: ' : ''}Posted ${monthName} greeting in ${jid}${selfAware ? ' (with the bot wink)' : ''}`)
      logActivity('new-month', jid, text)
    } catch (err) {
      console.error('New month post failed:', err.message)
    }
  }
  if (!test) setState('newMonthPosted', done)
}

// ---------- Morning verse and study tip ----------

// Posted from 7am (Lagos). If the bot was offline at 7, it still posts when
// it's back, but not after noon: a "good morning" at 4pm would look odd.
const MORNING_FROM_HOUR = 7
const MORNING_UNTIL_HOUR = 12

function morningMessage({ verse, tip }) {
  const weekday = new Date().toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos', weekday: 'long' })
  return [
    `☀️ *Good morning, family! Happy ${weekday}.*`,
    '',
    '📖 *Verse of the day*',
    `"${verse.text}"`,
    `— *${verse.ref}*`,
    '',
    '💡 *Study tip*',
    tip.text,
    '',
    `Have a blessed day 🙏 More books, notes and past questions: ${config.siteUrl}`,
  ].join('\n')
}

// test = FORCE_MORNING=1 at startup: post right now, only to the groups in
// ALLOWED_GROUP_JID (your test group), and don't count it.
async function maybeMorningPost(getSock, { test = false } = {}) {
  const sock = getSock()
  if (!sock || !config.botApiKey) return
  if (!test && !config.morningPost) return
  const { year, monthName, day, hour } = lagosToday()
  if (!test && (hour < MORNING_FROM_HOUR || hour >= MORNING_UNTIL_HOUR)) return

  const key = `${year}-${monthName}-${day}`
  const done = getState('morningPosted', {})
  const due = test ? config.allowedGroups : allowedGroups().filter((jid) => done[jid] !== key)
  if (due.length === 0) {
    if (test) console.log('[morning] Test skipped: put your test group in ALLOWED_GROUP_JID first.')
    return
  }

  // Same verse and tip as the app and the 7am phone push. Backend asleep:
  // try again on the next check.
  let daily
  try {
    daily = await botApi('/daily')
  } catch (err) {
    console.error('Morning post: could not get today\'s verse yet:', err.message)
    return
  }
  const text = morningMessage(daily)

  // The verse and the tip as square cards, like the app shows them. Drawn
  // once in memory for all groups and never saved. If drawing fails, the
  // plain text message still goes out.
  let cards = null
  try {
    cards = await Promise.all([
      quoteCard({ kind: 'verse', label: 'Verse of the day', quote: daily.verse.text, by: daily.verse.ref }),
      quoteCard({ kind: 'tip', label: 'Study tip of the day', quote: daily.tip.text, by: 'RCF Library' }),
    ])
  } catch (err) {
    console.error('Morning cards could not be drawn, sending text only:', err.message)
  }

  for (const jid of due) {
    try {
      if (cards) {
        await send(sock, jid, { image: cards[0], caption: text }, text)
        await sock.sendMessage(jid, { image: cards[1], caption: `💡 Study tip of the day · ${HANDLE}` })
      } else {
        await send(sock, jid, { text }, text)
      }
      if (!test) {
        done[jid] = key
        setState('morningPosted', done)
      }
      console.log(`[morning] ${test ? 'TEST: ' : ''}Posted verse and tip in ${jid}`)
      logActivity('morning', jid, text.split('\n').slice(3, 5).join(' '))
    } catch (err) {
      console.error('Morning post failed:', err.message)
    }
  }
}

// ---------- Welcome new members ----------

const pendingWelcomes = new Map()

export function queueWelcome(getSock, groupId, memberIds) {
  if (!config.welcomeNewMembers || !isAllowedGroup(groupId)) return
  const entry = pendingWelcomes.get(groupId) || { ids: new Set(), timer: null }
  memberIds.forEach((id) => entry.ids.add(id))
  pendingWelcomes.set(groupId, entry)
  if (entry.timer) return

  // Wait a minute so several people added together get one message.
  entry.timer = setTimeout(async () => {
    pendingWelcomes.delete(groupId)
    const sock = getSock()
    const ids = [...entry.ids].slice(0, 20)
    if (!sock || ids.length === 0 || !isActiveHours()) return
    const tags = ids.map((id) => `@${id.split('@')[0].split(':')[0]}`).join(' ')
    const text = `Welcome to the family, ${tags}! 🎉🙏\n\nI'm *${config.botName}* from the RCF Library Department. Need a textbook, past question or notes? Just tag me or ask here, e.g. *Bro Paul, GST 101 past questions*.\n\n📚 Library: ${config.siteUrl}\n📤 Share your materials: ${config.siteUrl}/contribute/submit`
    try {
      await send(sock, groupId, { text, mentions: ids }, text)
      logActivity('welcome', groupId, `Welcomed ${ids.length} new member${ids.length === 1 ? '' : 's'}`)
      await maybeSendSticker(sock, groupId, 'greeting', { chance: 0.5 })
    } catch (err) {
      console.error('Welcome message failed:', err.message)
    }
  }, WELCOME_BATCH_MS)
}

// ---------- Send as Bro Paul (Control Center) ----------

const OUTBOX_POLL_MS = 20 * 1000
let sendingOutbox = false

// A superadmin typed a message in the admin app. Sent any time of day,
// since a person chose to send it now.
async function sendOutbox(getSock) {
  const sock = getSock()
  if (sendingOutbox || !sock) return
  sendingOutbox = true
  try {
    const { items = [] } = await botApi('/outbox')
    for (const item of items) {
      try {
        await send(sock, item.group_jid, { text: item.text }, item.text)
        await botApi(`/outbox/${item.id}`, { method: 'POST', body: { status: 'sent' } })
        logActivity('send', item.group_jid, `Admin message: ${item.text}`)
      } catch (err) {
        await botApi(`/outbox/${item.id}`, { method: 'POST', body: { status: 'failed', error: err.message } }).catch(() => {})
        console.error('Outbox send failed:', err.message)
      }
    }
  } catch {
    // Backend asleep: try again next round.
  } finally {
    sendingOutbox = false
  }
}

// ---------- Start ----------

let started = false

export function startPoster(getSock) {
  if (started) return
  started = true

  if (config.botApiKey) {
    setInterval(() => pollAnnouncements(getSock), config.announcementPollMs)
    setTimeout(() => pollAnnouncements(getSock), 15 * 1000)
  } else {
    console.log('[setup] BOT_API_KEY not set, so admin announcements will not be posted to WhatsApp.')
  }

  // Always scheduled: the advert interval can be switched on later from the
  // admin app, and maybePostPromo checks it each time.
  setInterval(() => maybePostPromo(getSock), PROMO_CHECK_MS)

  if (config.botApiKey) {
    setInterval(() => sendOutbox(getSock), OUTBOX_POLL_MS)
  }

  setInterval(() => maybeNewMonthWish(getSock).catch((err) => console.error('New month check failed:', err.message)), PROMO_CHECK_MS)

  // Every 10 minutes, plus once shortly after connecting, so a restart
  // during the morning still gets today's post out promptly.
  const morning = () => maybeMorningPost(getSock).catch((err) => console.error('Morning check failed:', err.message))
  setInterval(morning, PROMO_CHECK_MS)
  setTimeout(morning, 30 * 1000)
  if (process.env.FORCE_MORNING) {
    console.log('[morning] Test mode: posting the morning verse to your test group in 20 seconds...')
    setTimeout(() => maybeMorningPost(getSock, { test: true }).catch((err) => console.error('Morning test failed:', err.message)), 20 * 1000)
  }

  if (process.env.FORCE_NEW_MONTH) {
    console.log('[new-month] Test mode: posting a new-month wish to your test group in 20 seconds...')
    setTimeout(() => maybeNewMonthWish(getSock, { test: true }).catch((err) => console.error('New month test failed:', err.message)), 20 * 1000)
  }
}
