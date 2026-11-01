import { readFileSync } from 'node:fs'
import { config, isActiveHours } from './config.js'
import { searchLibrary } from './library.js'
import { askAi, askChimeIn } from './ai.js'
import { activity, recentChat } from './chatMemory.js'
import { liveFacts } from './liveSettings.js'
import { parseLevelRequest, levelLabel, findCoursesAtLevel, formatItems, courseMenu, rememberMenu, hasPendingMenu, answerMenu } from './levelSearch.js'

let knowledgeEntries = []
try {
  const raw = JSON.parse(readFileSync(new URL('./knowledge.json', import.meta.url), 'utf8'))
  knowledgeEntries = Array.isArray(raw.entries) ? raw.entries : []
} catch {
  knowledgeEntries = []
}

// knowledge.json plus the RCF facts saved in the admin app's Control Center.
const allKnowledge = () => [...knowledgeEntries, ...liveFacts()]

const MATERIAL_WORDS = /\b(past\s*questions?|p\.?q|textbooks?|books?|pdfs?|materials?|notes?|lectures?|handouts?|resources?|audio|sermons?|devotionals?|manuals?|slides?)\b/i
const REQUEST_WORDS = /\b(need|needs|want|looking\s+for|search(?:ing)?|where|anyone|anybody|send|share|help|please|pls|plz|kindly|do\s+we\s+have|is\s+there|can\s+i\s+get|does\s+anyone)\b/i
const COURSE_CODE = /\b([a-z]{3,5})\s?-?(\d{3})\b/gi

const STOPWORDS = new Set((
  'i me my we you a an the to for of on in is are am do does can could please pls plz kindly need needs want looking ' +
  'search searching where anyone anybody any one have has get send share help there with and or some find give show ' +
  'about here this that pdf pdfs book books textbook textbooks material materials note notes resource resources past ' +
  'question questions pq audio sermon sermons lecture lectures handout handouts devotional devotionals manual manuals ' +
  'slide slides dear guys everyone good morning afternoon evening bot assistant hi hello hey thanks thank it its'
).split(' '))

const CREATOR_QUESTION = /\b(who\s+(created|made|built|developed|designed|owns?|programmed)\s+(you|this|bro\s*paul)|your\s+(creator|developer|maker|owner)|who\s+is\s+your\s+(creator|developer|maker|owner)|contact\s+(info|information|details?|number)|(developer|admin|creator)\s+(contact|number|whatsapp)|how\s+(can|do)\s+i\s+(contact|reach)\s+(you|the\s+(developer|creator)))\b/i

function waLink() {
  const digits = config.creatorPhone.replace(/\D/g, '')
  return `https://wa.me/${digits.startsWith('0') ? `234${digits.slice(1)}` : digits}`
}

function creatorReply() {
  return `I'm *${config.botName}*, the RCF MOUAU Library Assistant 📚\n\nI was created by *${config.creatorName}* — ${config.creatorSkills}.\nFor contact or support, reach the developer on WhatsApp: ${config.creatorPhone}\n${waLink()}`
}

// A real business enquiry: a deal, partnership, advert, sponsorship or a job,
// aimed at the bot, its owner or the library. Both parts are needed, so
// "big deal" or "my business class" in normal chat doesn't trigger it.
const BUSINESS_WORDS = /\b((make|strike|close|discuss|do|have)\s+(a\s+)?deal|deal\s+with|business|partner(ship)?|collaborat\w*|sponsor\w*|advertis\w*|adverts?|promote\s+(my|our)|hire|work\s+with|invest\w*|proposal|contract|website|web\s*app|mobile\s+app|(a|my|our)\s+bot)\b/i
const BUSINESS_TARGET = /\b(you|your|owner|boss|developer|creator|admin|team|library|whoever|person\s+behind)\b/i
const CONTACT_OWNER = /\b(contact|reach|talk\s+to|speak\s+(to|with)|meet|number\s+of)\s+(the\s+|your\s+)?(owner|boss|developer|creator|admin|team|management|person\s+behind)\b/i

function isBusinessEnquiry(text) {
  const t = stripMentions(text) // the bot's own name doesn't count as the target
  return CONTACT_OWNER.test(t) || (BUSINESS_WORDS.test(t) && BUSINESS_TARGET.test(t))
}

function businessReply() {
  return (
    `Happy to connect you! 🤝\n\nFor partnerships, adverts, sponsorship, projects or any business with the RCF MOUAU Library, please contact the developer directly:\n\n` +
    `*${config.creatorName}* — ${config.creatorSkills}\n📞 ${config.creatorPhone}\n💬 ${waLink()}\n\n` +
    `Send a short message saying who you are and what you have in mind.`
  )
}

const INTRO_WORDS = /\b(introduc(e|ing)|meet|welcome|who\s+are\s+you|what\s+(can\s+you\s+do|do\s+you\s+do)|new\s+(library\s+)?(dept|department)\s+member)\b/i
const BOT_NAME = /\bbro\s*paul\b/i
const INTRO_COOLDOWN_MS = 2 * 60 * 60 * 1000
let lastIntroAt = 0

function introReply() {
  return `Hello everyone! 👋 I'm *${config.botName}*, an AI assistant and the newest member of the RCF MOUAU Library Department. I work alongside our ${config.libraryHod}, and I'm so happy to serve the happiest people on campus! 😄\n\nHere's what I can do:\n📚 Find books, notes, past questions and audio in our digital library. Just ask, e.g. *anybody have GST 101 past questions?*\n❓ Answer study questions and chat when you tag me or reply to my message\n📢 Share library announcements and updates here\n📞 Tell you who built me and how to reach the developer\n\nOur library: ${config.siteUrl}\nGot materials? Upload them: ${config.siteUrl}/contribute/submit`
}

// Starts with the bot's name, or names it in a question: "Bro Paul, ..." / "... bro paul?"
function addressedByName(text) {
  return new RegExp(`^\\W*${BOT_NAME.source}`, 'i').test(text) || (BOT_NAME.test(text) && text.includes('?'))
}

const seenIds = new Set()
const senderLastReply = new Map()
const senderLastTagged = new Map()
let lastUntaggedReplyAt = 0
let aiDay = ''
let aiCount = 0

function alreadySeen(id) {
  if (seenIds.has(id)) return true
  seenIds.add(id)
  if (seenIds.size > 2000) seenIds.delete(seenIds.values().next().value)
  return false
}

function lagosDay() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' })
}

function aiAllowed() {
  const today = lagosDay()
  if (today !== aiDay) {
    aiDay = today
    aiCount = 0
  }
  return aiCount < config.dailyAiLimit
}

function stripMentions(text) {
  return text.replace(/@\S+/g, ' ').replace(BOT_NAME, ' ').replace(/\s+/g, ' ').trim()
}

function looksLikeResourceRequest(text) {
  const hasCode = new RegExp(COURSE_CODE.source, 'i').test(text)
  return REQUEST_WORDS.test(text) && (MATERIAL_WORDS.test(text) || hasCode)
}

// "maths 200lv", "200 level past questions": a level plus a subject or a
// kind of material. Untagged group messages also need a request word
// ("anyone has...") so normal chat about levels doesn't trigger a search.
function looksLikeLevelRequest(text, { tagged }) {
  const ask = parseLevelRequest(text)
  if (!ask || !(ask.subject || ask.prefix || MATERIAL_WORDS.test(text))) return false
  return tagged || REQUEST_WORDS.test(text)
}

function detectType(text) {
  if (/past\s*questions?|\bp\.?q\b/i.test(text)) return 'past_question'
  if (/\baudio\b|\bsermons?\b/i.test(text)) return 'audio'
  return null
}

function extractSearchQuery(text) {
  const withCodes = text.replace(COURSE_CODE, (_m, letters, digits) => `${letters.toUpperCase()} ${digits}`)
  const tokens = withCodes
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t))
  return tokens.join(' ').trim()
}

function formatResults(items) {
  const lines = items.map((item, i) => {
    const extra = [item.author, item.courseCode].filter(Boolean).join(' · ')
    return `${i + 1}. *${item.title}*${extra ? ` — ${extra}` : ''}\n${item.url}`
  })
  return `Here's what I found in the RCF library:\n\n${lines.join('\n\n')}\n\nSign in with your library account to open them.`
}

function courseCodeOnly(query) {
  const m = new RegExp(COURSE_CODE.source, 'i').exec(query)
  return m ? `${m[1].toUpperCase()} ${m[2]}` : null
}

// "Maths 200lv" and the like: list that level's courses (or show them
// straight away when there are only a few) and remember the list so the
// member can answer "first 3", "2" or "MTH 222".
async function levelReply(text, ask, senderId) {
  const type = detectType(text)
  const label = levelLabel(ask)
  try {
    let courses = await findCoursesAtLevel(ask, { type })
    if (courses.length === 0 && type) courses = await findCoursesAtLevel(ask)
    if (courses.length === 0) {
      return `I don't have ${label} materials in the library yet 😔\n\n📝 Request one: ${config.siteUrl}/contribute/request\n📤 Have some? Please upload them so others can benefit: ${config.siteUrl}/contribute/submit`
    }
    const total = courses.reduce((n, c) => n + c.items.length, 0)
    if (courses.length === 1 || total <= 3) {
      return formatItems(courses.flatMap((c) => c.items).slice(0, 8), `Here's what I have for ${label}:`)
    }
    rememberMenu(senderId, courses, label)
    return courseMenu(courses, label)
  } catch (err) {
    console.error('Level search failed:', err.message)
    return 'The library is slow to respond right now. Please try again in a minute.'
  }
}

async function resourceReply(text, senderId = '') {
  const ask = parseLevelRequest(stripMentions(text))
  if (ask) return levelReply(text, ask, senderId)
  const query = extractSearchQuery(stripMentions(text))
  if (!query) return 'Tell me the course code or the title, e.g. *GST 101 past questions*.'

  const type = detectType(text)
  try {
    let items = await searchLibrary(query, { type })
    if (items.length === 0 && type) items = await searchLibrary(query)
    // "GST 101 use of english past questions" -> try just "GST 101".
    const code = courseCodeOnly(query)
    if (items.length === 0 && code && code !== query) items = await searchLibrary(code)
    if (items.length === 0) {
      return `I couldn't find "${query}" in the library yet 😔\n\n📝 Request it: ${config.siteUrl}/contribute/request\n📤 Have it? Please upload it so others can benefit: ${config.siteUrl}/contribute/submit`
    }
    return formatResults(items)
  } catch (err) {
    console.error('Library search failed:', err.message)
    return 'The library is slow to respond right now. Please try again in a minute.'
  }
}

async function aiReply(text, { senderName, senderId = '', history, isPrivate = false }) {
  if (!aiAllowed()) return "I've reached my answer limit for today. Please try again tomorrow or ask an admin."
  aiCount += 1
  try {
    const result = await askAi({ question: stripMentions(text), senderName, history, knowledgeEntries: allKnowledge(), isPrivate })
    // The AI decided the member is asking for a material: look it up for real.
    if (result.type === 'search') return await resourceReply(result.query, senderId)
    // The AI recognised a business enquiry or a request for the owner's contact.
    if (result.type === 'contact') return businessReply()
    return result.text
  } catch (err) {
    console.error('AI reply failed:', err.message)
    return "I couldn't answer that right now. Please try again shortly."
  }
}

const lastChimeAt = new Map()
const chimeBusy = new Set()

// Called after every group message the bot didn't answer. Returns a message
// when the group is in a lively discussion and the AI decides it can add
// something useful, otherwise null.
export async function maybeChimeIn(groupId) {
  if (!config.chimeIn || !isActiveHours() || chimeBusy.has(groupId)) return null
  const now = Date.now()
  if (now - (lastChimeAt.get(groupId) || 0) < config.chimeCooldownMs) return null

  const stats = activity(groupId, config.chimeWindowMs)
  if (stats.messages < config.chimeMinMessages || stats.people < config.chimeMinPeople) return null
  // Don't butt in right after the bot already said something.
  if (now - stats.lastBotAt < 15 * 60 * 1000) return null
  if (!aiAllowed()) return null

  chimeBusy.add(groupId)
  // Set before asking, so a "SKIP" also waits a while before trying again.
  lastChimeAt.set(groupId, now)
  try {
    aiCount += 1
    const text = await askChimeIn({ history: recentChat(groupId), knowledgeEntries: allKnowledge() })
    return text ? text.slice(0, 1200) : null
  } catch (err) {
    console.error('Chime-in failed:', err.message)
    return null
  } finally {
    chimeBusy.delete(groupId)
  }
}

// AI answers each person has had in private chat today: senderId -> { day, n }.
const privateUse = new Map()

function privateLimitReached(senderId) {
  const today = lagosDay()
  const used = privateUse.get(senderId)
  const n = used?.day === today ? used.n : 0
  if (privateUse.size > 5000) privateUse.clear()
  privateUse.set(senderId, { day: today, n: n + 1 })
  return n >= config.privateDailyLimit ? n : false
}

// A one-to-one chat with the bot number. Every message is for the bot, so no
// tag is needed. Returns a reply string, or null to stay silent.
export async function handlePrivateMessage(msg) {
  if (!msg || msg.fromMe || !msg.text || !msg.id) return null
  if (alreadySeen(msg.id)) return null
  const text = msg.text.trim()
  if (!text) return null

  if (isBusinessEnquiry(text)) return businessReply()
  if (CREATOR_QUESTION.test(text)) return creatorReply()
  if (INTRO_WORDS.test(text) && /who\s+are\s+you|what\s+(can\s+you\s+do|do\s+you\s+do)/i.test(text)) return introReply()

  // Answer to a course list Bro Paul just sent ("first 3", "2", "MTH 222").
  const picked = answerMenu(msg.senderId, text)
  if (picked) return picked

  const over = privateLimitReached(msg.senderId)
  if (over !== false) {
    // Say it once, then stay quiet until tomorrow.
    return over === config.privateDailyLimit
      ? `We've talked a lot today 😄 I've reached my limit for private chats. Let's continue tomorrow! Meanwhile, search the library yourself: ${config.siteUrl}`
      : null
  }

  const reply = looksLikeResourceRequest(text) || looksLikeLevelRequest(text, { tagged: true })
    ? await resourceReply(text, msg.senderId)
    : await aiReply(text, { senderName: msg.senderName, senderId: msg.senderId, history: msg.history || [], isPrivate: true })
  return reply ? reply.slice(0, 1800) : null
}

// msg = { id, senderId, senderName, text, isGroup, fromMe, mentionedBot, repliedToBot, history }
// history = recent group messages (oldest first), not including this one.
// Returns a reply string, or null when the bot should stay silent.
export async function handleMessage(msg) {
  if (!msg || msg.fromMe || !msg.text || !msg.id) return null
  if (alreadySeen(msg.id)) return null

  const text = msg.text.trim()
  if (!text) return null

  // "Tagged" = the member is talking to the bot: @mention, a reply to one of
  // its messages, or starting the message with its name.
  const tagged =
    Boolean(msg.mentionedBot) ||
    Boolean(msg.repliedToBot) ||
    (config.botMode !== 'tag_only' && addressedByName(text))

  // Answer to a course list Bro Paul just sent this person ("first 3", "2",
  // "MTH 222"). Taken when they tag/reply, or when it's a short message.
  if (hasPendingMenu(msg.senderId) && (tagged || text.length <= 40)) {
    const picked = answerMenu(msg.senderId, text)
    if (picked) {
      senderLastTagged.set(msg.senderId, Date.now())
      return picked.slice(0, 1800)
    }
  }

  const introWords = INTRO_WORDS.test(text)
  const nameIntro = config.botMode !== 'tag_only' && introWords && BOT_NAME.test(text)
  if ((tagged && introWords) || nameIntro) {
    const introNow = Date.now()
    if (introNow - lastIntroAt >= INTRO_COOLDOWN_MS) {
      lastIntroAt = introNow
      return introReply()
    }
    if (!tagged) return null
  }
  const isRequest = looksLikeResourceRequest(text) || looksLikeLevelRequest(text, { tagged })
  const now = Date.now()

  if (tagged) {
    if (now - (senderLastTagged.get(msg.senderId) || 0) < 10000) return null
  } else {
    if (config.botMode === 'tag_only' || !isRequest || text.length > 300) return null
    if (now - lastUntaggedReplyAt < config.groupCooldownMs) return null
    if (now - (senderLastReply.get(msg.senderId) || 0) < config.senderCooldownMs) return null
  }

  const reply =
    tagged && isBusinessEnquiry(text)
      ? businessReply()
      : tagged && CREATOR_QUESTION.test(text)
        ? creatorReply()
        : isRequest
        ? await resourceReply(text, msg.senderId)
        : tagged
          ? await aiReply(text, { senderName: msg.senderName, senderId: msg.senderId, history: msg.history || [] })
          : null
  if (!reply) return null

  if (tagged) senderLastTagged.set(msg.senderId, now)
  else {
    lastUntaggedReplyAt = now
    senderLastReply.set(msg.senderId, now)
  }
  return reply.slice(0, 1800)
}