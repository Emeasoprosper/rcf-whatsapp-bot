import { config } from './config.js'
import { searchLibrary } from './library.js'

// "Maths 200lv", "200 level past questions", "CSC 400l", "year 2 physics":
// the library has no level field filled in, so the level comes from the
// course code itself (MTH 221 -> 200 level). When several courses match,
// the bot lists them and remembers the list for a few minutes, so the
// member can answer "first 3", "2", "second one", "MTH 222", "222" or "all".

const LEVEL_RE = /\b([1-6])00\s*(?:l|lv|lvl|lvls|level|levels)\b|\blevel\s*([1-6])00\b|\b(?:year|yr)\s*([1-6])\b|\b([1-6])(?:st|nd|rd|th)\s+year\b/i

// Subject words members type -> course code prefixes used at MOUAU.
const SUBJECTS = [
  { name: 'Maths', re: /\b(maths?|mathematics|mth|mat)\b/i, prefixes: ['MTH', 'MAT'] },
  { name: 'Physics', re: /\b(physics|phy)\b/i, prefixes: ['PHY'] },
  { name: 'Chemistry', re: /\b(chemistry|chem|chm)\b/i, prefixes: ['CHM', 'CHE'] },
  { name: 'Biology', re: /\b(biology|bio|botany|zoology)\b/i, prefixes: ['BIO', 'BOT', 'ZOO'] },
  { name: 'Computer Science', re: /\b(computer(\s+science)?|csc|comp\s*sci)\b/i, prefixes: ['CSC', 'COS'] },
  { name: 'General Studies', re: /\b(gst|gss|general\s+studies)\b/i, prefixes: ['GST', 'GSS'] },
  { name: 'Engineering', re: /\b(engineering|eng)\b/i, prefixes: ['ENG'] },
  { name: 'Statistics', re: /\b(statistics|stats?|sta)\b/i, prefixes: ['STA', 'STS'] },
  { name: 'Economics', re: /\b(economics|eco)\b/i, prefixes: ['ECO'] },
  { name: 'Accounting', re: /\b(accounting|accountancy|acc)\b/i, prefixes: ['ACC'] },
  { name: 'Agricultural Economics', re: /\b(agric(ultural)?\s+economics|agb|aec)\b/i, prefixes: ['AGB', 'AEC'] },
]

const CODE_RE = /\b([a-z]{3})\s*[-_]?\s*(\d{3})\b/i

// "MTH221", "csc 314", "MTH_222" -> "MTH 221". From the course code field, else the title.
export function courseCodeOf(item) {
  const m = CODE_RE.exec(item.courseCode || '') || CODE_RE.exec(item.title || '')
  return m ? `${m[1].toUpperCase()} ${m[2]}` : null
}

// Returns { level, subject, prefix } or null when no level is mentioned.
export function parseLevelRequest(text) {
  const m = LEVEL_RE.exec(text)
  if (!m) return null
  const level = Number(m[1] || m[2] || m[3] || m[4])
  const subject = SUBJECTS.find((s) => s.re.test(text)) || null
  // An explicit prefix without numbers, e.g. "CSC 400 level".
  const prefixMatch = /\b([a-z]{3})\b/i.exec(text.replace(LEVEL_RE, ' '))
  const knownPrefix = prefixMatch && SUBJECTS.some((s) => s.prefixes.includes(prefixMatch[1].toUpperCase())) ? prefixMatch[1].toUpperCase() : null
  return { level, subject, prefix: knownPrefix }
}

// Library items at that level (and subject), grouped by course code, lowest code first.
export async function findCoursesAtLevel({ level, subject, prefix }, { type } = {}) {
  const prefixes = prefix ? [prefix] : subject ? subject.prefixes : null
  const searches = prefixes || ['']
  const lists = await Promise.all(
    searches.map((s) =>
      searchLibrary(s, { type, pageSize: 100 }).catch(() => [])
    )
  )
  const seen = new Set()
  const courses = new Map()
  for (const item of lists.flat()) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    const code = courseCodeOf(item)
    if (!code) continue
    const [pre, num] = code.split(' ')
    if (Number(num[0]) !== level) continue
    if (prefixes && !prefixes.includes(pre)) continue
    if (!courses.has(code)) courses.set(code, [])
    courses.get(code).push(item)
  }
  return [...courses.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, items]) => ({ code, items }))
}

export function levelLabel({ level, subject, prefix }) {
  return `${level}00 level${prefix ? ` ${prefix}` : subject ? ` ${subject.name}` : ''}`
}

export function formatItems(items, heading) {
  const lines = items.map((item, i) => {
    const code = courseCodeOf(item)
    const extra = [item.author, code].filter(Boolean).join(' · ')
    return `${i + 1}. *${item.title}*${extra ? ` — ${extra}` : ''}\n${item.url}`
  })
  return `${heading}\n\n${lines.join('\n\n')}\n\nSign in with your library account to open them.`
}

export function courseMenu(courses, label) {
  const lines = courses.map((c, i) => `${i + 1}. *${c.code}* (${c.items.length} item${c.items.length === 1 ? '' : 's'})`)
  return (
    `Here are the ${label} courses I have 📚\n\n${lines.join('\n')}\n\n` +
    `Which one do you need? Reply with the number or the course code (e.g. *${courses[0].code}*), ` +
    `or say *first 3* and I'll show you the first three.`
  )
}

// ---------- Remembering the list for the follow-up answer ----------

const PICK_TTL_MS = 10 * 60 * 1000
const pending = new Map() // senderId -> { courses, label, at }

export function rememberMenu(senderId, courses, label) {
  pending.set(senderId, { courses, label, at: Date.now() })
  if (pending.size > 2000) pending.delete(pending.keys().next().value)
}

export function hasPendingMenu(senderId) {
  const p = pending.get(senderId)
  if (p && Date.now() - p.at > PICK_TTL_MS) pending.delete(senderId)
  return pending.has(senderId)
}

const WORD_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
const ORDINALS = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5, last: -1 }
const MAX_SHOW = 8

// Turns "first 3" / "2" / "second one" / "MTH 222" / "222" / "all" into a
// reply, or returns null when the message isn't an answer to the list.
export function answerMenu(senderId, text) {
  if (!hasPendingMenu(senderId)) return null
  const { courses, label } = pending.get(senderId)
  const t = text.toLowerCase().replace(/@\S+/g, ' ').replace(/\bbro\s*paul\b/g, ' ').trim()
  const allItems = courses.flatMap((c) => c.items)
  const done = (reply) => {
    pending.delete(senderId)
    return reply
  }

  // "first 3", "top three", "show me the first 2"
  const firstN = /\b(?:first|top)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b/.exec(t)
  if (firstN) {
    const n = Math.min(MAX_SHOW, Number(firstN[1]) || WORD_NUMBERS[firstN[1]] || 3)
    return done(formatItems(allItems.slice(0, n), `Here are the first ${Math.min(n, allItems.length)} for ${label}:`))
  }
  if (/\b(all|everything|all of them)\b/.test(t)) {
    const shown = allItems.slice(0, MAX_SHOW)
    const more = allItems.length > shown.length ? `\n\n…and ${allItems.length - shown.length} more on ${config.siteUrl}` : ''
    return done(formatItems(shown, `Everything I have for ${label}:`) + more)
  }

  // A course code ("MTH 222") or just its number ("222").
  const codeHit = courses.find((c) => {
    const [pre, num] = c.code.split(' ')
    return new RegExp(`\\b${pre}\\s*${num}\\b`, 'i').test(t) || new RegExp(`(^|\\D)${num}(\\D|$)`).test(t)
  })
  if (codeHit) return done(formatItems(codeHit.items.slice(0, MAX_SHOW), `Here's what I have for *${codeHit.code}*:`))

  // "2", "number 2", "second", "the 3rd one", "last"
  const ord = Object.keys(ORDINALS).find((w) => new RegExp(`\\b${w}\\b`).test(t))
  const num = /^\D{0,12}(\d{1,2})\D{0,8}$/.exec(t)
  const index = ord ? ORDINALS[ord] : num ? Number(num[1]) : null
  if (index) {
    const course = index === -1 ? courses[courses.length - 1] : courses[index - 1]
    if (course) return done(formatItems(course.items.slice(0, MAX_SHOW), `Here's what I have for *${course.code}*:`))
  }
  return null
}
