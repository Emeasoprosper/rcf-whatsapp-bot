import { readFileSync } from 'node:fs'
import { config, isActiveHours } from './config.js'
import { searchLibrary } from './library.js'
import { botApi } from './backend.js'
import { logActivity } from './activity.js'
import { askAi, askChimeIn, askPrayer, askRequestItems } from './ai.js'
import { getContact, updateContact, learnFromReply } from './contacts.js'
import { activity, recentChat, inPrayer } from './chatMemory.js'
import { liveFacts } from './liveSettings.js'
import { groupSettings, studyTipOn } from './groups.js'
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

// Questions about who made Bro Paul, and requests for that person's contact,
// including typos (carted), short forms (dev), filler words ("who REALLY
// designed you"), Pidgin ("who build you") and follow-ups ("his contact").
const MAKER = '(creator|developer|dev|maker|owner|programmer|builder|designer)'
const CONTACT = '(contact|contacts|number|phone|line|whatsapp|details?|info)'
const MADE = '(cr\\w*ted|cr\\w*ed|carted|create|made|make|built|build|buit|developed|develop|designed|design|owns?|programm?ed|program|coded|code|invented|trained)'
const YOU = '(you|u|bro\\s*paul|this\\s+(bot|ai|app|assistant|thing)|the\\s+(bot|ai|assistant))'
const WHO_MADE = new RegExp(
  [
    `who\\s+(\\w+\\s+){0,2}${MADE}\\s+${YOU}`, // who (really / actually) designed you
    `who\\s+(is|dey|be)\\s+(really\\s+)?behind\\s+${YOU}`,
    `(your|ur)\\s+${MAKER}`, // who is your creator
    `the\\s+${MAKER}\\s+of\\s+${YOU}`, // the developer of this bot (not "the owner of the hostel")
    `who\\s+(is|be)\\s+(your|ur)\\s+(boss|oga)`,
    `(were|was)\\s+you\\s+(\\w+\\s+)?${MADE}`, // were you made by...
    `names?\\s+(of\\s+)?(your|ur|the)\\s+${MAKER}`,
  ].join('|'),
  'i'
)
const CONTACT_ASK = new RegExp(
  [
    `${MAKER}'?s?\\s+${CONTACT}`,
    `${CONTACT}\\s+(of|for)\\s+(your|ur|the|this)\\s+${MAKER}`,
    `(his|her|their)\\s+${CONTACT}`,
    `contact\\s+(info|information|details?|number)`,
    `how\\s+(can|do)\\s+i\\s+(contact|reach)\\s+(you|u|him|her|them|the\\s+${MAKER})`,
    `(talk|speak|chat)\\s+(to|with)\\s+(the\\s+person|whoever|the\\s+one)\\s+who\\s+${MADE}`,
    `(send|give|share|drop)\\s+(me\\s+)?(the\\s+|your\\s+|his\\s+|her\\s+|their\\s+)?(contact|number|whatsapp)`,
  ].join('|'),
  'i'
)

// After "who made you", the same person can just say "yes" / "send it" /
// "send the contact" (no tag needed in groups) for the next 10 minutes.
const CONTACT_OFFER_MS = 10 * 60 * 1000
const contactOffered = new Map() // senderId -> time offered
const ACCEPT_OFFER = /^\W*(yes|yeah|yea|yep|ok(ay)?|sure|please|pls|plz|abeg|send(\s+it)?|share(\s+it)?|i\s+(want|need)\s+it|go\s+ahead)\b/i

function acceptedContactOffer(senderId, text) {
  const at = contactOffered.get(senderId)
  if (!at || Date.now() - at > CONTACT_OFFER_MS) return false
  const t = stripMentions(text)
  if (!(ACCEPT_OFFER.test(t) || CONTACT_ASK.test(t)) || t.length > 60) return false
  contactOffered.delete(senderId)
  return true
}

function waLink() {
  const digits = config.creatorPhone.replace(/\D/g, '')
  return `https://wa.me/${digits.startsWith('0') ? `234${digits.slice(1)}` : digits}`
}

const firstName = () => config.creatorName.split(' ').slice(-1)[0]

// "Web Developer · Data Analyst · Video Editor" -> "web developer, data analyst and video editor"
function skillsInWords() {
  const parts = config.creatorSkills.split('·').map((s) => s.trim().toLowerCase()).filter(Boolean)
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] || 'developer'
}

// Answers "who made you" like a person would, and offers the contact.
const WHO_MADE_REPLIES = [
  (n, f, s) => `Ah, no secret at all 😄 I was built by *${n}*, a ${s} here in RCF MOUAU. ${f} put me together so you can find books, notes and past questions faster.\n\nWant to reach ${f}? Just ask for the contact and I'll send it.`,
  (n, f, s) => `That would be *${n}* 🙌 ${f} is a ${s} in the fellowship, and the brain behind me and the RCF digital library.\n\nIf you'd like to talk to ${f}, say "send the contact" and I'll share it.`,
  (n, f, s) => `My creator is *${n}* 😊 ${f} is a ${s}, and built me to help everyone in RCF MOUAU study smarter.\n\nNeed ${f}'s contact? Just ask.`,
]

function whoMadeReply() {
  const pick = WHO_MADE_REPLIES[Math.floor(Math.random() * WHO_MADE_REPLIES.length)]
  return pick(config.creatorName, firstName(), skillsInWords())
}

function contactReply() {
  return `Sure! Here's how to reach *${config.creatorName}* 👇\n\n📞 ${config.creatorPhone}\n💬 WhatsApp: ${waLink()}\n\nSend a short hello and say what it's about 🙏`
}

// "Who made you": the AI answers in its own words (matching the person's
// tone), as long as it names the creator and doesn't dodge. Otherwise, or
// when the AI is off or over its limit, one of the ready replies above.
async function whoMadeAnswer(text, { senderName, history = [], isPrivate = false }) {
  if (config.geminiApiKey && aiAllowed()) {
    aiCount += 1
    try {
      const result = await askAi({ question: stripMentions(text), senderName, history, knowledgeEntries: allKnowledge(), isPrivate })
      if (result.type === 'contact') return contactReply()
      const named = new RegExp(firstName(), 'i').test(result.text || '')
      const dodged = /confidential|classified|secret|can'?t (say|tell)|not allowed/i.test(result.text || '')
      if (result.type === 'reply' && named && !dodged) return result.text
    } catch (err) {
      console.error('Who-made AI reply failed, using a ready reply:', err.message)
    }
  }
  return whoMadeReply()
}

// "Send me the contact" -> the exact contact; "who made you" -> a human
// answer that offers the contact. Returns null when it's neither.
async function creatorAnswer(text, senderId, context) {
  const t = stripMentions(text)
  if (CONTACT_ASK.test(t)) {
    contactOffered.delete(senderId)
    return contactReply()
  }
  if (WHO_MADE.test(t)) {
    contactOffered.set(senderId, Date.now())
    if (contactOffered.size > 2000) contactOffered.delete(contactOffered.keys().next().value)
    return whoMadeAnswer(text, context)
  }
  return null
}

// A real business enquiry: a deal, partnership, advert, sponsorship or a job,
// aimed at the bot, its owner or the library. Both parts are needed, so
// "big deal" or "my business class" in normal chat doesn't trigger it.
const BUSINESS_WORDS = /\b((make|strike|close|discuss|do|have)\s+(a\s+)?deal|deal\s+with|business|partner(ship)?|collaborat\w*|sponsor\w*|advertis\w*|adverts?|promote\s+(my|our)|hire|work\s+with|invest\w*|proposal|contract|website|web\s*app|mobile\s+app|(build|make|create|develop|design|need|want)\s+(me\s+|us\s+)?(a|my|our)\s+(whatsapp\s+)?bot)\b/i
const BUSINESS_TARGET = /\b(you|your|owner|boss|developer|creator|admin|team|library|whoever|person\s+behind)\b/i
const CONTACT_OWNER = /\b(contact|reach|talk\s+to|speak\s+(to|with)|meet|number\s+of)\s+(the\s+|your\s+)?(owner|boss|developer|creator|admin|team|management|person\s+behind)\b/i

function isBusinessEnquiry(text) {
  const t = stripMentions(text) // the bot's own name doesn't count as the target
  return CONTACT_OWNER.test(t) || (BUSINESS_WORDS.test(t) && BUSINESS_TARGET.test(t))
}

function businessReply() {
  return (
    `Perfect, let's make it happen 🤝\n\nHere's the direct line to *${config.creatorName}* (${config.creatorSkills}) to agree the details:\n\n` +
    `📞 ${config.creatorPhone}\n💬 ${waLink()}\n\n` +
    `Send a short hello with what we discussed, and ${firstName()} will take it from there.`
  )
}

// Business never gets discussed in front of the whole group: invite them to
// the bot's DM, where the AI talks it through properly.
const DM_INVITES = [
  (link) => `Love that 🤝 Let's talk business properly in my DM so we can get into the details${link ? `: ${link}` : ' 😊'}`,
  (link) => `This one deserves a proper conversation 😄 Send me a DM and let's discuss${link ? ` 👉 ${link}` : ' 💼'}`,
  (link) => `Good one! Business talk is better in private 😉 DM me and tell me what you have in mind${link ? `: ${link}` : ''}`,
]

function dmInviteReply() {
  const link = config.botPhone ? `https://wa.me/${config.botPhone}` : ''
  return pickLine(DM_INVITES)(link)
}

const INTRO_WORDS = /\b(introduc(e|ing)|meet|welcome|who\s+are\s+you|what\s+(can\s+you\s+do|do\s+you\s+do)|new\s+(library\s+)?(dept|department)\s+member)\b/i
const BOT_NAME = /\bbro\s*paul\b/i
// The full introduction at most every 2 hours per group.
const INTRO_COOLDOWN_MS = 2 * 60 * 60 * 1000
const lastIntroAt = new Map()

// Bro Paul's introduction, written from the group's settings: who it's for
// (past questions only in campus groups), whether he presents himself as an
// AI, and only the posts switched on there. Used when someone asks "who are
// you" / "introduce yourself" and when a superadmin clicks Introduce in the
// admin app. It never brings up who made him. groupId null = private chat.
export function introFor(groupId) {
  const s = groupSettings(groupId)
  const inGroup = Boolean(groupId)
  const who = s.revealAi
    ? `I'm *${config.botName}*, the AI assistant of the RCF MOUAU Library Department`
    : `I'm *${config.botName}* from the RCF MOUAU Library Department`
  const ask = inGroup ? 'Just tag me and ask' : 'Just ask me here'
  const lines = [
    s.audience === 'campus'
      ? `📚 Find books, lecture notes, past questions and audio in our free digital library. ${ask}, e.g. *GST 101 past questions*`
      : s.audience === 'mixed'
        ? `📚 Find Christian books, devotionals, sermons and study materials in our free digital library. ${ask}, e.g. *any book on prayer?*`
        : `📚 Find Christian books, devotionals, sermons and resources for research in our free digital library. ${ask}, e.g. *any book on prayer?*`,
    inGroup ? '❓ Answer questions and chat when you tag me or reply to one of my messages' : '❓ Answer your questions and chat with you anytime',
  ]
  if (inGroup) {
    if (s.bookOfDay) lines.push('📖 Share a *Book of the day* at noon')
    if (s.morningPost) lines.push('☀️ Share a Bible verse of the day every morning')
    if (studyTipOn(groupId)) lines.push(s.audience === 'campus' ? '💡 Share a study tip of the day' : '💡 Share a helpful tip of the day')
    if (s.prayer === 'join') lines.push('🙏 Join you in prayer when the group prays')
    if (s.birthdays) lines.push('🎂 Celebrate birthdays with you')
    lines.push('📢 Share library updates now and then')
  }
  return `Hello${inGroup ? ' everyone' : ''}! 👋 ${who}. I work alongside our ${config.libraryHod}, and I'm happy to be here with you 😄\n\nHere's how I can help:\n${lines.join('\n')}\n\n🌐 Library: ${config.siteUrl}`
}

// Past questions, lecture notes and other course materials, as opposed to
// books, devotionals and sermons.
const ACADEMIC_WORDS = /\b(past\s*questions?|p\.?q|lecture\s*notes?|notes?|lectures?|handouts?|slides?|manuals?|syllabus|courses?)\b/i

function isAcademicRequest(text) {
  return ACADEMIC_WORDS.test(text) || new RegExp(COURSE_CODE.source, 'i').test(text) || Boolean(parseLevelRequest(text))
}

// A group that isn't for students: course materials are never offered by
// name, only as resources for research.
function researchReply() {
  return `For students who want to collect resources for research, the RCF digital library has books and materials you can access free 📚\n\n🌐 ${config.siteUrl}`
}

const FOR_MOUAU = 'For MOUAU students 🎓, you can access these on the RCF library:\n\n'

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

// Pray-along groups: Bro Paul adds his own short prayer during a session,
// at most every 12 minutes per group and only after a few people have
// prayed since he last did, so he joins in rather than leads.
const PRAYER_GAP_MS = 12 * 60 * 1000
const prayerState = new Map() // groupId -> { lastAt, since }

export async function maybePrayAlong(groupId) {
  const state = prayerState.get(groupId) || { lastAt: 0, since: 0 }
  state.since += 1
  prayerState.set(groupId, state)
  if (state.since < 4 || Date.now() - state.lastAt < PRAYER_GAP_MS) return null
  if (!takeAiCall()) return null
  state.lastAt = Date.now()
  state.since = 0
  try {
    return await askPrayer({ history: recentChat(groupId) })
  } catch (err) {
    console.error('Prayer reply failed:', err.message)
    return null
  }
}

// Listening to a voice note is an AI call too, so it counts toward today's limit.
export function takeAiCall() {
  if (!config.geminiApiKey || !aiAllowed()) return false
  aiCount += 1
  return true
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

// audience = the group's setting ('campus' in private chats). In a 'general'
// group course materials get the research line; in a 'mixed' one they're
// introduced as being for MOUAU students.
// who = { name, groupId } of the person asking, so a material the library
// doesn't have can be filed as a request for the admins in their name.
async function resourceReply(text, senderId = '', audience = 'campus', who = {}) {
  const academic = audience !== 'campus' && isAcademicRequest(stripMentions(text))
  if (academic && audience === 'general') return researchReply()
  const reply = await searchReply(text, senderId, who)
  if (!academic) return reply
  // "For MOUAU students, you can access these…" only makes sense with results.
  return /^(I couldn't find|I don't have|The library is slow)/.test(reply) ? `For MOUAU students 🎓: ${reply}` : FOR_MOUAU + reply
}

// Nothing found: file it for the admins (they get a push and see it under
// Requests); when they add it, Bro Paul DMs this person the link. Returns
// false if the backend couldn't take it, so the reply falls back to links.
// title = the material in the person's own words; who.asked = their whole
// message, attached so the admins see exactly what was asked.
async function fileRequest(title, senderId, who) {
  if (!config.botApiKey || !senderId || title.length < 2) return false
  try {
    await botApi('/requests', {
      method: 'POST',
      body: {
        title,
        courseCode: courseCodeOnly(title) || undefined,
        asked: who.asked ? stripMentions(who.asked).slice(0, 500) : undefined,
        whatsappId: senderId,
        whatsappName: who.name || undefined,
        groupJid: who.groupId || undefined,
      },
    })
    logActivity('request', who.groupId || senderId, `Filed a material request for "${title}"${who.name ? ` from ${who.name}` : ''}`)
    return true
  } catch (err) {
    console.error('Could not file the material request:', err.message)
    return false
  }
}

// Is this file really for that course? Its course code, or the code in its
// title ("MTH122", "Mth 122").
function isForCourse(item, code) {
  const [letters, digits] = code.split(' ')
  const inTitle = new RegExp(`\\b${letters}\\s?-?${digits}\\b`, 'i')
  return (item.courseCode || '').replace(/[\s-]+/g, ' ').toUpperCase() === code || inTitle.test(item.title || '')
}

// Looks one material up: with its type first, then without, then by the
// bare course code ("GST 101 use of english past questions" -> "GST 101").
// With a course code, only files for exactly that course count: the
// library's search also returns near misses (MTH 122 for "MTH 211"), and
// sending those as if they were the answer would be wrong. No exact match
// means not found, so it gets requested.
async function findMaterial(query, type) {
  const code = courseCodeOnly(query)
  const tries = new Map() // "words|type" -> [words, type], in order, no repeats
  for (const words of code && code !== query ? [query, code] : [query]) {
    for (const kind of type ? [type, null] : [null]) tries.set(`${words}|${kind}`, [words, kind])
  }
  for (const [words, kind] of tries.values()) {
    let items = await searchLibrary(words, kind ? { type: kind } : {})
    if (code) items = items.filter((it) => isForCourse(it, code))
    if (items.length) return items
  }
  return []
}

// The person's words for one material, without the asking around it.
// Only asking words: never anything that could start a real title ("The...").
const ASK_START = /^(ok|okay|alright|hi|hello|hey|please|pls|plz|abeg|biko|i need|i want|i'?m looking for|send me|give me|do you have|does anyone have|anyone has|anybody has|help me with|can i (get|have))\b[\s,:]*/i
const ASK_END = /[\s,]*\b(please|pls|plz|abeg|biko|thanks|thank you|o|sir|ma)\b[\s.!?]*$/i

function askedName(part) {
  let name = part.replace(/\s+/g, ' ').trim()
  for (let i = 0; i < 6 && ASK_START.test(name); i++) name = name.replace(ASK_START, '')
  for (let i = 0; i < 3 && ASK_END.test(name); i++) name = name.replace(ASK_END, '')
  return name.replace(/[?.!,;:\s]+$/, '').trim().slice(0, 120)
}

// Separators that may mean more than one material in a message.
const MAYBE_SEVERAL = /,|;|&|\+|\n|\band\b|\balso\b|\bplus\b/i

// The separate materials in a message, each in the person's exact words.
// The AI picks them out (checked word for word against the message); if it
// can't, or AI is unavailable, the message is split by course codes / list
// lines; one material -> null.
async function requestItems(message, fallbackText) {
  if (MAYBE_SEVERAL.test(message) && aiAllowed()) {
    aiCount += 1
    try {
      const items = await askRequestItems(message)
      if (items) return items.length > 1 ? items : null
    } catch (err) {
      console.error('Could not separate the requested materials:', err.message)
    }
  }
  return splitRequests(fallbackText)
}

// Words that look like course codes but aren't ("level 200", "year 300").
const NOT_A_CODE = /^(level|year|page|room|chapter|class|hall|block|lv|lvl)$/i
const MAX_ITEMS = 8

// Several materials asked for in one message, as separate searches:
// - the AI's "SEARCH: a | b | c",
// - two or more course codes, each with the words after it
//   ("MTH 211 calculus, CSC 224 data structures"),
// - a list with one material per line ("1. Atomic Habits\n2. ...").
// Returns the list, or null when it's really one request.
function splitRequests(text) {
  if (text.includes('|')) {
    const parts = text.split('|').map((p) => p.trim()).filter(Boolean)
    return parts.length > 1 ? parts.slice(0, MAX_ITEMS) : null
  }
  const codes = [...text.matchAll(new RegExp(COURSE_CODE.source, 'gi'))].filter((m) => !NOT_A_CODE.test(m[1]))
  const distinct = new Set(codes.map((m) => `${m[1].toUpperCase()} ${m[2]}`))
  if (distinct.size > 1) {
    const seen = new Set()
    const parts = []
    codes.forEach((m, i) => {
      const code = `${m[1].toUpperCase()} ${m[2]}`
      if (seen.has(code)) return
      seen.add(code)
      const end = i + 1 < codes.length ? codes[i + 1].index : text.length
      // The code plus its title, without joining words left at the end.
      const words = text.slice(m.index + m[0].length, end).replace(/(,|&|\band\b|\bplus\b|\balso\b|\n|\d+[.)])+\s*$/gi, '').trim()
      parts.push(`${code} ${words}`.trim())
    })
    return parts.slice(0, MAX_ITEMS)
  }
  const lines = text.split(/\n+/).map((l) => l.replace(/^\s*(\d+[.)]|[-•*])\s*/, '').trim()).filter((l) => l.length >= 3)
  const listed = text.split(/\n+/).filter((l) => /^\s*(\d+[.)]|[-•*])\s+\S/.test(l)).length
  return listed >= 2 && lines.length >= 2 ? lines.slice(0, MAX_ITEMS) : null
}

// Several materials: what's in the library comes back under each name, and
// every missing one is filed as its own request for the admins.
async function multiSearchReply(parts, type, senderId, who) {
  const found = []
  const missing = []
  try {
    for (const part of parts) {
      const query = extractSearchQuery(part)
      if (!query) continue
      const items = await findMaterial(query, detectType(part) || type)
      // Shown and filed in the person's own words, not the search words.
      const name = askedName(part) || query
      if (items.length) found.push({ label: name, items: items.slice(0, 3) })
      else missing.push(name)
    }
  } catch (err) {
    console.error('Library search failed:', err.message)
    return 'The library is slow to respond right now. Please try again in a minute.'
  }
  if (found.length === 0 && missing.length === 0) return 'Tell me the course codes or titles, e.g. *MTH 211 and CSC 224 past questions*.'

  const filed = []
  for (const query of missing) if (await fileRequest(query, senderId, who)) filed.push(query)

  const lines = []
  if (found.length) {
    lines.push("Here's what I found in the RCF library:")
    for (const { label, items } of found) {
      lines.push('', `📘 *${label}*`)
      items.forEach((item, i) => {
        const extra = [item.author, item.courseCode].filter(Boolean).join(' · ')
        lines.push(`${i + 1}. ${item.title}${extra ? ` — ${extra}` : ''}\n${item.url}`)
      })
    }
  }
  if (missing.length) {
    lines.push('', `😔 Not in the library yet: ${missing.map((q) => `*${q}*`).join(', ')}`)
    if (filed.length === missing.length) {
      const where = who.groupId ? "I'll send you a DM" : "I'll message you right here"
      lines.push(`📝 I've sent ${missing.length > 1 ? 'a separate request for each one' : 'a request'} to the library team. Once ${missing.length > 1 ? "they're" : "it's"} added, ${where} with the link.`)
    } else {
      lines.push(`📝 Request ${missing.length > 1 ? 'them' : 'it'}: ${config.siteUrl}/contribute/request`)
    }
    lines.push(`📤 Have any of them? Please upload so others can benefit: ${config.siteUrl}/contribute/submit`)
  }
  if (found.length) lines.push('', 'Sign in with your library account to open them.')
  return lines.join('\n')
}

// text = what to look for (the person's message, or the AI's SEARCH words);
// who.asked = the person's own message, which decides how many materials
// there are and the exact words each request is filed with.
async function searchReply(text, senderId, who = {}) {
  const clean = stripMentions(text)
  who = { ...who, asked: who.asked || text }
  const parts = await requestItems(stripMentions(who.asked), clean)
  if (parts) return multiSearchReply(parts, detectType(stripMentions(who.asked)), senderId, who)
  const ask = parseLevelRequest(clean)
  if (ask) return levelReply(text, ask, senderId)
  const query = extractSearchQuery(clean)
  if (!query) return 'Tell me the course code or the title, e.g. *GST 101 past questions*.'

  const type = detectType(text)
  try {
    const items = await findMaterial(query, type)
    if (items.length === 0) {
      // Their own words when it's their message; the AI's search words
      // otherwise (the full message is attached to the request either way).
      const name = askedName(clean) || query
      if (await fileRequest(name, senderId, who)) {
        const where = who.groupId ? "I'll send you a DM" : "I'll message you right here"
        return `I couldn't find "${name}" in the library yet 😔\n\n📝 I've sent a request to the library team for you. Once it's added, ${where} with the link.\n📤 Have it already? Please upload it so others can benefit: ${config.siteUrl}/contribute/submit`
      }
      return `I couldn't find "${name}" in the library yet 😔\n\n📝 Request it: ${config.siteUrl}/contribute/request\n📤 Have it? Please upload it so others can benefit: ${config.siteUrl}/contribute/submit`
    }
    return formatResults(items)
  } catch (err) {
    console.error('Library search failed:', err.message)
    return 'The library is slow to respond right now. Please try again in a minute.'
  }
}

// When the AI can't answer (busy after retries, or today's limit is used up),
// answer like a person instead of with an error message: casual one-liners
// ("better for you 😮‍💨", "lol", "ok o") just get an emoji reaction, real
// questions get a short, natural "give me a minute".
const BUSY_LINES = [
  'Network dey do me small 😅 Ask me again in a minute?',
  'Ah, my brain dey load small 🔄 Give me one minute, then ask me again.',
  'Hold on small, my connection dey shake 😅 Try me again shortly.',
  'Omo, I lost my train of thought there 😂 Say am again for me in a bit?',
]
const TIRED_LINES = [
  "I don talk tire for today 😅 Make we continue tomorrow. Meanwhile, the library is open: ",
  "My voice don finish for today 😂 Catch me tomorrow! You fit still search the library: ",
]
const pickLine = (lines) => lines[Math.floor(Math.random() * lines.length)]
// index.js reads this marker and reacts to the message instead of replying.
export const REACT_MARKER = /^\[\[react:(.{1,8})\]\]$/u
const reactWith = (emoji) => `[[react:${emoji}]]`

function humanFallback(text, { tired = false } = {}) {
  const t = stripMentions(text)
  const casual = t.length <= 50 && !/\?/.test(t) && !looksLikeResourceRequest(t)
  if (casual) return reactWith(/😂|🤣|😆|😅|lol|lmao|haha/i.test(t) ? '😂' : /🙏|thank|amen/i.test(t) ? '🙏' : '🤍')
  return tired ? `${pickLine(TIRED_LINES)}${config.siteUrl}` : pickLine(BUSY_LINES)
}

// What he remembers about this person, for the AI. In a private chat the
// WhatsApp display name isn't used until they've told him their name
// themselves (like meeting someone), so the AI doesn't greet them by it.
function memberFor(senderId, extra = {}) {
  const c = getContact(senderId)
  return { name: c?.name || '', address: c?.address || '', title: c?.title || '', ...extra }
}

async function aiReply(text, { senderName, senderId = '', groupId = null, history, isPrivate = false, audience = 'campus', praying = false, revealAi = true, member = null }) {
  if (!aiAllowed()) return humanFallback(text, { tired: true })
  aiCount += 1
  try {
    const known = member || memberFor(senderId)
    const result = await askAi({
      question: stripMentions(text),
      senderName: isPrivate ? known.name || 'them' : known.name || senderName,
      history,
      knowledgeEntries: allKnowledge(),
      isPrivate,
      audience,
      praying,
      revealAi,
      member: known,
    })
    // Whatever they told him about themselves (name, Sir/Ma, title).
    learnFromReply(senderId, result.member)
    // The AI decided the member is asking for a material: look it up for real.
    if (result.type === 'search') return await resourceReply(result.query, senderId, audience, { name: senderName, groupId, asked: text })
    // Business or a request for the owner: the direct contact in DM (the AI
    // has talked it through first), an invite to the DM in a group.
    if (result.type === 'contact') return isPrivate ? businessReply() : dmInviteReply()
    return result.text
  } catch (err) {
    console.error('AI reply failed after retries:', err.message)
    return humanFallback(text)
  }
}

const lastChimeAt = new Map()
const chimeBusy = new Set()

// Called after every group message the bot didn't answer. Returns a message
// when the group is in a lively discussion and the AI decides it can add
// something useful, otherwise null.
export async function maybeChimeIn(groupId) {
  if (!config.chimeIn || !isActiveHours() || chimeBusy.has(groupId) || !groupSettings(groupId).chimeIn || inPrayer(groupId)) return null
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
    const text = await askChimeIn({ history: recentChat(groupId), knowledgeEntries: allKnowledge(), audience: groupSettings(groupId).audience, revealAi: groupSettings(groupId).revealAi })
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

  // Business enquiries go to the AI below, which talks them through and
  // hands over the contact when it's time.
  if (acceptedContactOffer(msg.senderId, text)) return contactReply()
  const aboutCreator = await creatorAnswer(text, msg.senderId, { senderName: msg.senderName, history: msg.history || [], isPrivate: true })
  if (aboutCreator) return aboutCreator.slice(0, 1800)
  // "What can you do" gets the introduction; "who are you" goes to the AI,
  // which answers about itself a little at a time like a person would.
  if (/what\s+(can\s+you\s+do|do\s+you\s+do)/i.test(text)) return introFor(null)

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

  // Getting to know them: the first time, he asks their name like a person
  // would; their next message is read as the answer (and he never asks
  // again, even if they skip it).
  const contact = getContact(msg.senderId)
  const askName = !contact
  const justAskedName = Boolean(contact && contact.askedAt && !contact.name && !contact.nameTurnDone)
  if (askName) updateContact(msg.senderId, { askedAt: Date.now() })
  else if (justAskedName) updateContact(msg.senderId, { nameTurnDone: true })

  let reply
  if (looksLikeResourceRequest(text) || looksLikeLevelRequest(text, { tagged: true })) {
    reply = await resourceReply(text, msg.senderId, 'campus', { name: contact?.name || msg.senderName })
    // Straight to business on the first message: help first, then ask.
    if (askName && reply) reply += `\n\n${pickLine(NAME_ASKS)}`
  } else {
    reply = await aiReply(text, {
      senderName: msg.senderName,
      senderId: msg.senderId,
      history: msg.history || [],
      isPrivate: true,
      member: memberFor(msg.senderId, { askName, justAskedName }),
    })
    // Backup for a plain answer like "Emeka" or "I'm Tolu": kept only when
    // Bro Paul's own reply greeted them by that same name.
    if (justAskedName && reply && !getContact(msg.senderId)?.name) {
      const name = nameAnswer(text)
      if (name && reply.toLowerCase().includes(name.toLowerCase())) updateContact(msg.senderId, { name })
    }
  }
  return reply ? reply.slice(0, 1800) : null
}

// "Emeka", "I'm Tolu", "my name is Ada Obi", "na Seun": the name, or null.
const NOT_NAMES = /^(hi|hello|hey|ok|okay|yes|no|nope|why|what|who|thanks|thank you|fine|good|cool|sure|lol|hmm|morning|evening|afternoon|nothing|me|guess)$/i
function nameAnswer(text) {
  const m = text.trim().match(/^(?:(?:i'?m|i am|my name is|my name'?s|it'?s|na|call me|this is)\s+)?([\p{L}][\p{L}'-]{1,20}(?:\s[\p{L}][\p{L}'-]{1,20})?)\s*[.!😊🙂😄]*$/iu)
  if (!m || NOT_NAMES.test(m[1])) return null
  return m[1].replace(/\b\p{L}/gu, (c) => c.toUpperCase())
}

const NAME_ASKS = ['By the way, who I dey talk with? 😊', "Btw what's your name? 😊", 'Who am I chatting with sef? 😄']

// msg = { id, groupId, senderId, senderName, text, isGroup, fromMe, mentionedBot, repliedToBot, history }
// history = recent group messages (oldest first), not including this one.
// Returns a reply string, or null when the bot should stay silent.
export async function handleMessage(msg) {
  if (!msg || msg.fromMe || !msg.text || !msg.id) return null
  if (alreadySeen(msg.id)) return null

  const text = msg.text.trim()
  if (!text) return null
  const { audience, revealAi } = groupSettings(msg.groupId)
  // While the group prays, Bro Paul only speaks when someone talks to him.
  const praying = inPrayer(msg.groupId)

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

  // "Yes, send it" right after Bro Paul offered his creator's contact.
  if (acceptedContactOffer(msg.senderId, text)) {
    senderLastTagged.set(msg.senderId, Date.now())
    return contactReply()
  }

  const introWords = INTRO_WORDS.test(text)
  const nameIntro = config.botMode !== 'tag_only' && introWords && BOT_NAME.test(text)
  if ((tagged && introWords) || nameIntro) {
    const introNow = Date.now()
    if (introNow - (lastIntroAt.get(msg.groupId) || 0) >= INTRO_COOLDOWN_MS) {
      lastIntroAt.set(msg.groupId, introNow)
      return introFor(msg.groupId)
    }
    if (!tagged) return null
  }
  const isRequest = looksLikeResourceRequest(text) || looksLikeLevelRequest(text, { tagged })
  const now = Date.now()

  if (tagged) {
    if (now - (senderLastTagged.get(msg.senderId) || 0) < 10000) return null
  } else {
    if (praying || config.botMode === 'tag_only' || !isRequest || text.length > 300) return null
    if (now - lastUntaggedReplyAt < config.groupCooldownMs) return null
    if (now - (senderLastReply.get(msg.senderId) || 0) < config.senderCooldownMs) return null
  }

  const aboutCreator =
    tagged && !isBusinessEnquiry(text)
      ? await creatorAnswer(text, msg.senderId, { senderName: msg.senderName, history: msg.history || [] })
      : null
  const reply =
    tagged && isBusinessEnquiry(text)
      ? dmInviteReply()
      : aboutCreator
        ? aboutCreator
        : isRequest
          ? await resourceReply(text, msg.senderId, audience, { name: msg.senderName, groupId: msg.groupId })
          : tagged
            ? await aiReply(text, { senderName: msg.senderName, senderId: msg.senderId, groupId: msg.groupId, history: msg.history || [], audience, praying, revealAi })
            : null
  if (!reply) return null

  if (tagged) senderLastTagged.set(msg.senderId, now)
  else {
    lastUntaggedReplyAt = now
    senderLastReply.set(msg.senderId, now)
  }
  return reply.slice(0, 1800)
}