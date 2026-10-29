import { askBirthdayWish } from './ai.js'
import { recentChat } from './chatMemory.js'

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

// mentioned = people tagged in the wish (not the bot); quotedParticipant =
// whose message the wish replied to. Returns nothing; calls send() later.
export function handleBirthdayWish({ groupId, text, mentioned = [], quotedParticipant = null, senderId, send }) {
  let celebrantIds = mentioned.filter((j) => j !== senderId)
  if (celebrantIds.length === 0 && quotedParticipant && quotedParticipant !== senderId) celebrantIds = [quotedParticipant]
  const name = celebrantIds.length ? null : NAME_AFTER_WISH.exec(text)?.[1] || null
  if (/^(Bro|Paul|Everyone|All|You|Him|Her)$/i.test(name || '')) return

  const key = celebrantIds.length ? celebrantIds.map(bare).sort().join(',') : (name || 'someone').toLowerCase()
  const dedupe = `${groupId}|${key}`
  if (pending.has(dedupe) || Date.now() - (wished.get(dedupe) || 0) < DAY_MS) return
  pending.add(dedupe)

  // 20s to 2 min, like someone who just noticed the wishes.
  const delay = 20000 + Math.floor(Math.random() * 100000)
  setTimeout(async () => {
    try {
      let wish
      try {
        wish = await askBirthdayWish({ celebrant: name, history: recentChat(groupId) })
      } catch (err) {
        console.error('Birthday wish AI failed, using a ready-made one:', err.message)
        wish = fallbackWish()
      }
      const label = celebrantIds.length ? celebrantIds.map((j) => `@${bare(j)}`).join(' ') : name || 'dear'
      if (!/\bNAME\b/.test(wish)) wish = `${label} ${wish}`
      await send({ text: wish.replace(/\bNAME\b/g, label), mentions: celebrantIds })
      wished.set(dedupe, Date.now())
      console.log(`[birthday] Wished ${label} in ${groupId}`)
    } catch (err) {
      console.error('Birthday wish failed:', err.message)
    } finally {
      pending.delete(dedupe)
    }
  }, delay)
}
