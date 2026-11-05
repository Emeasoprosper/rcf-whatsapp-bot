import { readdirSync } from 'node:fs'
import path from 'node:path'
import { config, isActiveHours } from './config.js'
import { getState, setState } from './state.js'
import { remember, lastHumanMessageAt, inPrayer } from './chatMemory.js'
import { botApi } from './backend.js'
import { allowedGroups, allowedGroupsFor, groupSettings, isAllowedGroup, refreshGroups, studyTipOn } from './groups.js'
import { introFor } from './handler.js'
import { rememberPost, introSignature } from './cleanup.js'
import { askNewMonthWish, askFeaturedCaption } from './ai.js'
import { logActivity } from './activity.js'
import { quoteCard, coverCard, HANDLE } from './quoteImage.js'
import { featuredCandidates } from './library.js'
import { maybeSendSticker } from './stickers.js'

// Things the bot posts on its own: admin announcements (ticked "post to
// WhatsApp" in the admin app), "upload to the library" adverts, and
// welcomes for new members. getSock() always returns the live socket,
// since index.js makes a new one on every reconnect.

const PROMO_DIR = 'promo-images'
const PROMO_CHECK_MS = 10 * 60 * 1000
const WELCOME_BATCH_MS = 60 * 1000
const MAX_IMAGE_FAILURES = 3

// Safety net for scheduled posts: each one is tried at most MAX_TRIES times
// per group per period (period = today's date, or the advert round), at
// least RETRY_GAP_MS apart. A send can fail after WhatsApp already delivered
// it, so retrying without a limit could post the same thing over and over.
const MAX_TRIES = 2
const RETRY_GAP_MS = 20 * 60 * 1000

function mayTry(kind, jid, period) {
  const tries = getState('postTries', {})
  const id = `${kind}:${jid}`
  const t = tries[id]
  const same = t && t.period === period
  if (same && (t.n >= MAX_TRIES || Date.now() - t.at < RETRY_GAP_MS)) return false
  tries[id] = { period, n: same ? t.n + 1 : 1, at: Date.now() }
  setState('postTries', tries)
  return true
}

// Returns the sent message, whose key lets cleanup.js delete it later.
async function send(sock, jid, content, logText) {
  const sent = await sock.sendMessage(jid, content)
  remember(jid, { text: logText, fromBot: true, kind: 'post' })
  return sent
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

// audience = the group's setting: only 'campus' groups hear about past
// questions and lecture notes; 'mixed' groups mention students lightly;
// 'general' groups (not students) never hear about students, school or
// exams: the library is offered as books that bless and change lives.
function promoTexts(audience = 'campus') {
  const site = config.siteUrl
  const upload = `${site}/contribute/submit`
  if (audience === 'general') {
    return [
      `📚 *That book that blessed you can bless someone else too*\n\nA devotional that lifted you, a message that changed how you see God, a book that sorted your finances or your home: share it on the RCF digital library so others can find it 🙌\n\n📤 Share here: ${upload}\n\n"Freely you have received, freely give." Matthew 10:8`,
      `🕊️ *Help someone grow today*\n\nUpload a Christian book, devotional or sermon to the RCF digital library. It takes a minute, and it could be exactly what someone needs this season.\n\n📤 ${upload}\n🌐 Explore: ${site}`,
      `📖 *Looking for something good to read?*\n\nFree Christian books, devotionals and audio sermons on faith, prayer, marriage, money, purpose and more, all in one place on the RCF digital library.\n\n🌐 ${site}\n📤 Have a good book? Share it: ${upload}`,
      `✨ *Every upload helps change a life*\n\nSomewhere, someone is praying for direction, healing or peace. The book or sermon on your phone could be God's answer for them. Share it on the RCF digital library 🙏\n\n📤 ${upload}`,
    ]
  }
  if (audience === 'mixed') {
    return [
      `📚 *Got a good book on your phone?*\n\nThat PDF you loved could bless someone else! 🙌 Share it on the RCF digital library so others can read it too: Christian books, devotionals, sermons, self-development and research materials.\n\n📤 Share here: ${upload}\n\n"Freely you have received, freely give." Matthew 10:8`,
      `✨ *The RCF Library grows because of YOU!*\n\nBooks, devotionals, audio sermons and resources for students and anyone doing research. Every upload helps someone grow.\n\n📤 Upload: ${upload}\n🌐 Explore: ${site}`,
      `📖 *Looking for something good to read?*\n\nThe RCF digital library has free books and devotionals for faith, life, money, purpose and more. Students who want to collect resources for research will find plenty too.\n\n🌐 ${site}\n📤 Have a good book? Share it: ${upload}`,
    ]
  }
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
  const images = promoImages()
  let index = getState('promoIndex', 0)

  for (const jid of allowedGroupsFor('promos', inPrayer)) {
    const last = lastPromo[jid] || 0
    if (Date.now() - last < intervalMs) continue
    // Only advertise in a group that's been active since the last advert,
    // so the bot never talks to an empty room.
    if (last && lastHumanMessageAt(jid) < last) continue

    const texts = promoTexts(groupSettings(jid).audience)
    const text = texts[index % texts.length]
    const image = images.length ? images[index % images.length] : null
    if (!mayTry('promo', jid, String(last))) continue
    try {
      const sent = await send(sock, jid, image ? { image: { url: image }, caption: text } : { text }, text)
      lastPromo[jid] = Date.now()
      setState('lastPromoAt', lastPromo)
      rememberPost(jid, sent?.key, 'promo', { audience: groupSettings(jid).audience })
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
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Lagos', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date())
  const get = (type) => parts.find((p) => p.type === type).value
  return { year: get('year'), monthName: get('month'), day: Number(get('day')), hour: Number(get('hour')), minute: Number(get('minute')) }
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
  const due = test ? config.allowedGroups : allowedGroupsFor('newMonth', inPrayer).filter((jid) => done[jid] !== key)
  if (due.length === 0) {
    if (test) console.log('[new-month] Test skipped: put your test group in ALLOWED_GROUP_JID first.')
    return
  }

  // About one month in three gets a light "I'm a bot, but..." wink. Every
  // month would get old fast; never would feel a bit robotic.
  // Never in a group where he isn't presented as an AI.
  const selfAware = Math.random() < 0.34 && due.every((jid) => groupSettings(jid).revealAi)
  let text
  try {
    text = await askNewMonthWish({ monthName, selfAware })
  } catch (err) {
    console.error('New month AI failed, using a ready-made message:', err.message)
    text = newMonthFallback(monthName)
  }

  for (const jid of due) {
    if (!test && !mayTry('newMonth', jid, key)) continue
    try {
      const sent = await send(sock, jid, { text }, text)
      if (!test) {
        done[jid] = key
        setState('newMonthPosted', done)
      }
      rememberPost(jid, sent?.key, 'newMonth')
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

// The verse of the day (Scripture) and the study tip (practical advice) are
// separate switches per group; the message holds whichever are on.
function morningMessage({ verse, tip }, audience = 'campus', { withVerse = true, withTip = true } = {}) {
  const weekday = new Date().toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos', weekday: 'long' })
  const more = {
    campus: `More books, notes and past questions: ${config.siteUrl}`,
    mixed: `More books and study resources: ${config.siteUrl}`,
    general: `Free Christian books and devotionals: ${config.siteUrl}`,
  }[audience] || ''
  return [
    `☀️ *Good morning, family! Happy ${weekday}.*`,
    ...(withVerse ? ['', '📖 *Verse of the day*', `"${verse.text}"`, `— *${verse.ref}*`] : []),
    ...(withTip ? ['', '💡 *Study tip of the day*', tip.text] : []),
    '',
    `Have a blessed day 🙏 ${more}`,
  ].join('\n')
}

// test = FORCE_MORNING=1 at startup: post right now, only to the groups in
// ALLOWED_GROUP_JID (your test group), and don't count it.
export async function maybeMorningPost(getSock, { test = false } = {}) {
  const sock = getSock()
  if (!sock || !config.botApiKey) return
  if (!test && !config.morningPost) return
  const { year, monthName, day, hour } = lagosToday()
  if (!test && (hour < MORNING_FROM_HOUR || hour >= MORNING_UNTIL_HOUR)) return

  const key = `${year}-${monthName}-${day}`
  const done = getState('morningPosted', {})
  // Groups with the verse, the study tip or both switched on.
  const due = test
    ? config.allowedGroups
    : allowedGroups().filter((jid) => done[jid] !== key && !inPrayer(jid) && (groupSettings(jid).morningPost || studyTipOn(jid)))
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
    const { audience, morningPost } = groupSettings(jid)
    const withVerse = test || morningPost
    const withTip = test || studyTipOn(jid)
    const text = morningMessage(daily, audience, { withVerse, withTip })
    if (!test && !mayTry('morning', jid, key)) continue
    // Marked as done as soon as the first message is out, so a problem with
    // the second card (or anything after) never re-sends the morning post.
    const markDone = () => {
      if (test) return
      done[jid] = key
      setState('morningPosted', done)
    }
    try {
      if (cards) {
        // The first card carries the message; the tip card follows the verse card.
        const sent = await send(sock, jid, { image: withVerse ? cards[0] : cards[1], caption: text }, text)
        markDone()
        rememberPost(jid, sent?.key, 'morning', { verse: withVerse, tip: withTip })
        if (withVerse && withTip) {
          const tipCard = await sock.sendMessage(jid, { image: cards[1], caption: `💡 Study tip of the day · ${HANDLE}` })
          rememberPost(jid, tipCard?.key, 'tip')
        }
      } else {
        const sent = await send(sock, jid, { text }, text)
        markDone()
        rememberPost(jid, sent?.key, 'morning', { verse: withVerse, tip: withTip })
      }
      const what = [withVerse && 'verse', withTip && 'study tip'].filter(Boolean).join(' and ')
      console.log(`[morning] ${test ? 'TEST: ' : ''}Posted ${what} in ${jid}`)
      logActivity('morning', jid, withVerse ? `${daily.verse.ref}: ${daily.verse.text}` : `Study tip: ${daily.tip.text}`)
    } catch (err) {
      console.error('Morning post failed:', err.message)
    }
  }
}

// ---------- Book of the day ----------

// Books featured lately, so the same one doesn't come back for a long while.
const FEATURED_MEMORY = 60

const FEATURED_FALLBACKS = [
  (r) => `*This one could change how you see this season of your life* 👀\n\nI've been telling people about it all week. Short, practical and straight to the point, the kind of read you finish and immediately want to share 🔥\n\nOpen it today, thank me later 😄`,
  (r) => `*Looking for something worth your screen time today?* 📱\n\nSkip the endless scrolling for 20 minutes and give this a try. ${r.author ? `${r.author} has a way of saying things that just stick.` : 'It says things that just stick.'} 🙌\n\nIt's free on our library, go and see 👇`,
  (r) => `*Your future self will thank you for reading this* 🙏\n\nOne good book at the right time can reset your focus, your faith and your plans. This might be that book for you ✨\n\nTap the link and start the first page today.`,
]

async function fetchCover(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(45000) })
  if (!res.ok) throw new Error(`cover returned ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 2000) throw new Error('cover is too small')
  return buf
}

// Picks today's resource (one of the best few not featured lately, so it
// isn't always the same top book) and makes its picture and words.
async function prepareFeatured() {
  const history = getState('featuredHistory', [])
  // Only books uploaded to our own library (not ones added from the web
  // search), and only kinds everyone enjoys: Christian books, personal
  // growth, stories, business... never course material or past questions,
  // since the post goes to every kind of group.
  const all = (await featuredCandidates()).filter((r) => !r.fromWeb && !r.academic && r.forEveryone)
  if (all.length === 0) console.log('[featured] No library book fits Book of the day (needs a cover and a non-academic category).')
  const fresh = all.filter((r) => !history.includes(r.id))
  const pool = (fresh.length ? fresh : all).slice(0, 8)
  if (pool.length === 0) return null
  // Shuffle the best few, then take the first one whose cover downloads.
  pool.sort(() => Math.random() - 0.5)

  for (const resource of pool.slice(0, 4)) {
    let cover
    try {
      cover = await fetchCover(resource.coverUrl)
    } catch (err) {
      console.error(`[featured] Cover for "${resource.title}" failed:`, err.message)
      continue
    }
    let image = cover
    try {
      image = await coverCard({ cover })
    } catch (err) {
      console.error('[featured] Could not draw the card, sending the plain cover:', err.message)
    }
    return { resource, image, caption: await featuredCaption(resource) }
  }
  // No cover would download: still post today, as text with the link.
  console.error('[featured] No cover could be downloaded, posting as text.')
  return { resource: pool[0], image: null, caption: await featuredCaption(pool[0]) }
}

async function featuredCaption(resource) {
  let words
  try {
    words = await askFeaturedCaption(resource)
  } catch (err) {
    console.error('[featured] AI caption failed, using a ready one:', err.message)
    words = FEATURED_FALLBACKS[Math.floor(Math.random() * FEATURED_FALLBACKS.length)](resource)
  }
  return [
    '📚 *BOOK OF THE DAY*',
    '',
    words,
    '',
    `📖 *${resource.title}*${resource.author ? ` by ${resource.author}` : ''}`,
    ...(resource.licence ? [`🔓 ${/public domain/i.test(resource.licence) ? 'Public domain' : resource.licence.replace(/\s*\(.*\)\s*$/, '')} · free to read and share`] : []),
    `👉 Read it free: ${resource.url}`,
  ].join('\n')
}

// Posted once a day at featuredHour (12 noon Lagos: students check their
// phones between lectures, and the 7am slot already has the verse). It is
// prepared from 15 minutes before so it goes out right on the hour. If the
// bot was offline or asleep at noon, it posts as soon as it's back, until
// FEATURED_UNTIL_HOUR, so a day is never skipped but nobody is pinged at night.
const FEATURED_UNTIL_HOUR = 22
const FEATURED_PREP_MINUTES = 15
const FEATURED_CHECK_MS = 30 * 1000

// One-off, 5 Nov 2026 only: after the web-book post was deleted, let today's
// Book of the day go out again (now from the library). Does nothing on any
// other day, so it can never cause a double post later.
export function allowRepostToday() {
  const { year, monthName, day } = lagosToday()
  const key = `${year}-${monthName}-${day}`
  if (key !== '2026-November-5' || getState('featuredRepostDone', '') === key) return
  setState('featuredRepostDone', key)
  const done = getState('featuredPosted', {})
  const tries = getState('postTries', {})
  for (const jid of Object.keys(done)) {
    if (done[jid] !== key) continue
    delete done[jid]
    delete tries[`featured:${jid}`]
  }
  setState('featuredPosted', done)
  setState('postTries', tries)
  featuredReady = null
  console.log('[featured] Today\'s Book of the day will be posted again, from the library.')
}

let featuredReady = null // { key, post }: today's post, made once
let featuredBusy = false
let featuredWarned = ''

// test = FORCE_FEATURED=1 at startup: post right now, only to the groups in
// ALLOWED_GROUP_JID (your test group), and don't count it.
export async function maybeFeaturedPost(getSock, { test = false } = {}) {
  const sock = getSock()
  if (!sock || featuredBusy) return
  if (!test && !config.featuredPost) return
  const { year, monthName, day, hour, minute } = lagosToday()
  const key = `${year}-${monthName}-${day}`
  const minutesToGo = config.featuredHour * 60 - (hour * 60 + minute)
  if (!test && (hour >= FEATURED_UNTIL_HOUR || minutesToGo > FEATURED_PREP_MINUTES)) return

  const done = getState('featuredPosted', {})
  const due = test ? config.allowedGroups : allowedGroupsFor('bookOfDay', inPrayer).filter((jid) => done[jid] !== key)
  if (due.length === 0) {
    if (test) console.log('[featured] Test skipped: put your test group in ALLOWED_GROUP_JID first.')
    return
  }

  featuredBusy = true
  try {
    if (test || featuredReady?.key !== key) {
      const post = await prepareFeatured()
      if (!post) {
        if (featuredWarned !== key) console.log('[featured] Library not reachable or empty yet, retrying every 30 seconds.')
        featuredWarned = key
        return
      }
      featuredReady = { key, post }
      console.log(`[featured] Today's book is ready: "${post.resource.title}"`)
    }
    // Made early: wait for the hour itself.
    if (!test && minutesToGo > 0) return

    const { post } = featuredReady
    let postedCount = 0
    for (const jid of due) {
      if (!test && !mayTry('featured', jid, key)) continue
      let message
      try {
        message = await send(sock, jid, post.image ? { image: post.image, caption: post.caption } : { text: post.caption }, post.caption)
      } catch (err) {
        // Not marked as done: tried once more later (see mayTry), never more.
        console.error('Book of the day post failed:', err.message)
        continue
      }
      // Marked as done straight after WhatsApp accepted it, before anything
      // else, so nothing that goes wrong afterwards can make it post again.
      if (!test) {
        done[jid] = key
        setState('featuredPosted', done)
      }
      postedCount += 1
      rememberPost(jid, message?.key, 'featured')
      console.log(`[featured] ${test ? 'TEST: ' : ''}Posted "${post.resource.title}" in ${jid}`)
      logActivity('featured', jid, `Book of the day: ${post.resource.title}`)
    }
    if (!test && postedCount) {
      const history = getState('featuredHistory', [])
      setState('featuredHistory', [post.resource.id, ...history.filter((id) => id !== post.resource.id)].slice(0, FEATURED_MEMORY))
    }
  } finally {
    featuredBusy = false
  }
}

// ---------- Welcome new members ----------

const pendingWelcomes = new Map()

export function queueWelcome(getSock, groupId, memberIds) {
  if (!config.welcomeNewMembers || !isAllowedGroup(groupId) || !groupSettings(groupId).welcome) return
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
    const ask =
      groupSettings(groupId).audience === 'campus'
        ? 'Need a textbook, past question or notes? Just tag me or ask here, e.g. *Bro Paul, GST 101 past questions*.'
        : 'Looking for a good book or devotional? Just tag me or ask here, e.g. *Bro Paul, any book on prayer?*'
    const text = `Welcome to the family, ${tags}! 🎉🙏\n\nI'm *${config.botName}* from the RCF Library Department. ${ask}\n\n📚 Library: ${config.siteUrl}\n📤 Share your materials: ${config.siteUrl}/contribute/submit`
    try {
      const sent = await send(sock, groupId, { text, mentions: ids }, text)
      rememberPost(groupId, sent?.key, 'welcome', { audience: groupSettings(groupId).audience })
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
        if (item.kind === 'intro') {
          // "Introduce" in the admin app: fetch the group's latest settings
          // first (it may have just been started), then introduce himself.
          await refreshGroups()
          const intro = introFor(item.group_jid)
          const sent = await send(sock, item.group_jid, { text: intro }, intro)
          rememberPost(item.group_jid, sent?.key, 'intro', { signature: introSignature(item.group_jid) })
          await botApi(`/outbox/${item.id}`, { method: 'POST', body: { status: 'sent' } })
          logActivity('intro', item.group_jid, 'Introduced himself (from the admin app)')
          await maybeSendSticker(sock, item.group_jid, 'greeting', { chance: 0.5 })
          continue
        }
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

  // Every 30 seconds so it lands right at noon, plus once just after
  // connecting so a restart in the afternoon posts straight away.
  const featured = () => maybeFeaturedPost(getSock).catch((err) => console.error('Book of the day check failed:', err.message))
  setInterval(featured, FEATURED_CHECK_MS)
  setTimeout(featured, 20 * 1000)
  if (process.env.FORCE_FEATURED) {
    console.log('[featured] Test mode: posting a book of the day to your test group in 25 seconds...')
    setTimeout(() => maybeFeaturedPost(getSock, { test: true }).catch((err) => console.error('Book of the day test failed:', err.message)), 25 * 1000)
  }

  if (process.env.FORCE_NEW_MONTH) {
    console.log('[new-month] Test mode: posting a new-month wish to your test group in 20 seconds...')
    setTimeout(() => maybeNewMonthWish(getSock, { test: true }).catch((err) => console.error('New month test failed:', err.message)), 20 * 1000)
  }
}
