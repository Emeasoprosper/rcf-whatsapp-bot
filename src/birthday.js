import { askBirthdayWish, askFlyerCelebrant } from './ai.js'
import { recentChat } from './chatMemory.js'
import { isBirthdayWish } from './reactions.js'

// When the group starts wishing someone happy birthday, Bro Paul joins in
// once per celebrant per day, after a short human-like pause.
const DAY_MS = 24 * 60 * 60 * 1000
const wished = new Map() // `${groupId}|${celebrantKey}` -> time
const pending = new Set()

const NAME_AFTER_WISH =
  /(?:happy\s*(?:birth\s*day|b'?day|bday|new\s*age)|hbd|many\s+happy\s+returns)[\s,!.-]*(?:to\s+)?(?:our\s+|my\s+|dear\s+|dearest\s+|sis\s+|bro\s+|brother\s+|sister\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/

const bare = (jid) => String(jid || '').split('@')[0].split(':')[0]

function fallbackWish() {
  const wishes = [
    'Happy birthday NAME! 🎉 May this new year bring you joy, good health and plenty of answered prayers. Enjoy your day 🤍',
    'HBD NAME! 🥳 Wishing you a year full of grace, laughter and success in everything you do 🎂',
    'Happy birthday NAME 🎂 God keep you, bless your studies and make this your best year yet 🤍',
  ]
  return wishes[Math.floor(Math.random() * wishes.length)]
}

// "It's my birthday today", "I'm a year older", "thanks for the birthday
// wishes": the person is talking about their own birthday.
const OWN_BIRTHDAY =
  /\b(my|me)\b[^.!?\n]{0,30}\b(birth\s*day|b'?day|bday|new\s*age)\b|\bi'?m\s+(a|one|another)\s+year\s+older|\bi\s+am\s+(a|one|another)\s+year\s+older|\b(thank(s| you)|appreciate)\b[^.!?\n]{0,40}\b(wish|wishes|birthday|b'?day|bday)\b/i
const NOT_A_NAME = /^(Bro|Paul|Everyone|All|You|Him|Her|Sir|Ma|Dear|Our|The|To|My)$/i

const nameIn = (t) => {
  const n = NAME_AFTER_WISH.exec(t || '')?.[1] || null
  return n && !NOT_A_NAME.test(n.split(' ')[0]) ? n : null
}

const flyerNames = new Map() // message id -> name read from the flyer ('' = none)

async function readFlyer(id, readImage, caption) {
  if (flyerNames.has(id)) return flyerNames.get(id)
  let name = ''
  try {
    const img = await readImage()
    if (img) name = await askFlyerCelebrant(img.buffer, img.mimetype, caption)
    // Flyers are often in capitals: "A. HOUSTON" -> "A. Houston".
    if (name && name === name.toUpperCase()) name = name.toLowerCase().replace(/(^|[\s.'-])(\p{L})/gu, (m, p, c) => p + c.toUpperCase())
  } catch (err) {
    console.error('Could not read the birthday flyer:', err.message)
  }
  flyerNames.set(id, name)
  if (flyerNames.size > 200) flyerNames.delete(flyerNames.keys().next().value)
  return name
}

// Works out whose birthday it is, reading the situation like a person:
// 1. Someone tagged in the wish is the celebrant.
// 2. A reply to a post: if that post is itself a birthday wish or flyer
//    (someone celebrating someone else), its poster is NOT the celebrant:
//    look for who is tagged or named in it, or the name written on the
//    flyer. Only when the post is the person's own news ("it's my birthday")
//    or an ordinary message of theirs is its author the celebrant.
// 3. A new wish or flyer: a name in it, or on the flyer picture.
// Otherwise unknown: nobody is guessed.
// Returns { ids, name, key } (ids = people to tag).
async function findCelebrant({ text, mentioned, senderId, quoted, ownImage, messageId }) {
  const ids = mentioned.filter((j) => j !== senderId)
  if (ids.length) return { ids, name: null, key: ids.map(bare).sort().join(',') }

  if (quoted?.author && quoted.author !== senderId) {
    const qText = quoted.text || ''
    const celebratingSomeone = isBirthdayWish(qText) && !OWN_BIRTHDAY.test(qText)
    const flyer = quoted.hasImage && !OWN_BIRTHDAY.test(qText)
    if (celebratingSomeone || flyer) {
      const tagged = (quoted.mentions || []).filter((j) => j !== quoted.author)
      if (tagged.length) return { ids: tagged, name: null, key: tagged.map(bare).sort().join(',') }
      let name = nameIn(qText) || nameIn(text)
      if (!name && quoted.readImage) name = await readFlyer(quoted.id, quoted.readImage, qText)
      return name ? { ids: [], name, key: name.toLowerCase() } : { ids: [], name: null, key: `post:${quoted.id}` }
    }
    // Their own birthday news, or an ordinary message of theirs.
    return { ids: [quoted.author], name: null, key: bare(quoted.author) }
  }

  let name = nameIn(text)
  if (!name && ownImage) name = await readFlyer(messageId, ownImage, text)
  if (name) return { ids: [], name, key: name.toLowerCase() }
  // "Happy birthday to me" / "it's my birthday": the sender.
  if (OWN_BIRTHDAY.test(text)) return { ids: [senderId], name: null, key: bare(senderId) }
  return { ids: [], name: null, key: messageId ? `post:${messageId}` : 'someone' }
}

// mentioned = people tagged in the wish (not the bot); quoted = the post it
// replies to { id, author, text, mentions, hasImage, readImage() };
// ownImage = reads this message's own picture (a flyer posted with the
// wish). Returns nothing; calls send() later.
export function handleBirthdayWish({ groupId, text, mentioned = [], quoted = null, ownImage = null, messageId = '', senderId, send }) {
  // One wish per post at a time while we work out who it's for.
  const early = `${groupId}|msg:${quoted?.id || messageId}`
  if (pending.has(early)) return
  pending.add(early)

  // 20s to 2 min, like someone who just noticed the wishes.
  const delay = 20000 + Math.floor(Math.random() * 100000)
  setTimeout(async () => {
    let dedupe = null
    try {
      const { ids: celebrantIds, name, key } = await findCelebrant({ text, mentioned, senderId, quoted, ownImage, messageId })
      dedupe = `${groupId}|${key}`
      // Several replies to the same flyer, or a celebrant already wished today.
      const sameFlyer = quoted?.id ? `${groupId}|post:${quoted.id}` : null
      if (pending.has(dedupe) || Date.now() - (wished.get(dedupe) || 0) < DAY_MS || (sameFlyer && Date.now() - (wished.get(sameFlyer) || 0) < DAY_MS)) {
        dedupe = null // someone else's job: don't clear their "in progress" mark
        return
      }
      pending.add(dedupe)
      const known = Boolean(celebrantIds.length || name)
      let wish
      try {
        wish = await askBirthdayWish({ celebrant: name, history: recentChat(groupId), known })
      } catch (err) {
        console.error('Birthday wish AI failed, using a ready-made one:', err.message)
        wish = fallbackWish()
      }
      const label = celebrantIds.length ? celebrantIds.map((j) => `@${bare(j)}`).join(' ') : name || 'our celebrant'
      if (!known) wish = wish.replace(/(happy\s+(?:birth\s*day|b'?day|bday))\s+NAME/gi, '$1 to NAME')
      // No NAME in the wish: put the tag in front so they're notified; a
      // plain name or "our celebrant" isn't glued on (it would read oddly).
      if (!/\bNAME\b/.test(wish) && celebrantIds.length) wish = `${label} ${wish}`
      await send({ text: wish.replace(/\bNAME\b/g, label), mentions: celebrantIds })
      wished.set(dedupe, Date.now())
      if (sameFlyer) wished.set(sameFlyer, Date.now())
      console.log(`[birthday] Wished ${label} in ${groupId}`)
    } catch (err) {
      console.error('Birthday wish failed:', err.message)
    } finally {
      pending.delete(early)
      if (dedupe) pending.delete(dedupe)
    }
  }, delay)
}
