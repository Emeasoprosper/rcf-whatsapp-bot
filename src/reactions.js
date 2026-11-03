// When Bro Paul reacts with 🤍 instead of (or as well as) replying.
// Kept rare on purpose: a real person doesn't heart every message.
export const HEART = '🤍'

const REACT_COOLDOWN_MS = 3 * 60 * 1000
const lastReactAt = new Map()

// "thanks", "thank you bro paul", "ok noted 👍" — a reply would be awkward,
// a heart is what a person would do.
const THANKS_ONLY = /^\W*(thanks?( you)?( so much| very much| a lot)?|thank u|thx|tnx|tanx|ok(ay)?( thanks?)?|noted|alright|god bless( you)?|you'?re the best|nice one|great|perfect|wow|amen)\W*(bro\s*paul)?\W*$/i

const GOOD_NEWS = /\b(testimony|i passed|we passed|i made (an? )?[ab]\b|first class|2[:.]1|graduat(ed|ion)|congrat\w*|got (my )?admission|thank (you )?(god|jesus)|god did it|praise (the lord|god)|safe delivery|newborn|got engaged|wedding|got (the |a )?job|scholarship|answered prayer|breakthrough)\b/i

export const BIRTHDAY = /\b(happy\s*(birth\s*day|b'?day|bday|new\s*age)|hbd|many\s+happy\s+returns|happy\s+(earth\s*day|celebration))\b/i

// Prayer: the wording people use while praying together in the group.
const PRAYER = /\b(in\s+jesus'?\s*(mighty\s+|precious\s+)?name|in\s+the\s+name\s+of\s+jesus|ijn|amen+|father\s+(lord|god|we|i|in)|lord\s+(we|i)\s+(pray|thank|ask|come)|we\s+(pray|decree|declare|cover|plead)|i\s+(decree|declare)|let\s+us\s+pray|let'?s\s+pray|prayer\s+(points?|session|time|meeting)|by\s+the\s+blood\s+of\s+jesus|holy\s+spirit|abba\s+father|hallelujah|thank\s+you\s+(lord|jesus|father))\b/i

export function isPrayerLike(text) {
  return PRAYER.test(text)
}

export function isThanksOnly(text) {
  return text.length <= 60 && THANKS_ONLY.test(text.trim())
}

export function isGoodNews(text) {
  return GOOD_NEWS.test(text)
}

export function isBirthdayWish(text) {
  return BIRTHDAY.test(text)
}

// Rate-limited per group, so good news days don't turn into a heart storm.
// hasDocument = someone shared a file (likely materials) in the group.
export function shouldReact(groupId, { text, hasDocument = false, birthday = false }) {
  const now = Date.now()
  if (now - (lastReactAt.get(groupId) || 0) < REACT_COOLDOWN_MS) return false

  let chance = 0
  if (birthday) chance = 1
  else if (hasDocument) chance = 0.8
  else if (GOOD_NEWS.test(text)) chance = 0.7
  if (Math.random() >= chance) return false

  lastReactAt.set(groupId, now)
  return true
}
