import { getState, setState } from './state.js'
import { groupSettings, studyTipOn } from './groups.js'
import { logActivity } from './activity.js'

// Bro Paul remembers what he posted in each group (message id and what kind
// of post it was). When a superadmin changes that group's settings, recent
// posts that no longer fit are deleted for everyone: e.g. adverts after
// "Upload / library adverts" is switched off, student adverts after the group
// is set to "General", or an introduction that said "AI" after "Say he's an
// AI" is switched off. WhatsApp only lets the sender delete for everyone for
// about 2 days, so older posts are forgotten. A post someone already deleted
// is simply skipped.
const KEEP_MS = 2 * 24 * 60 * 60 * 1000
const MAX_PER_GROUP = 60
const STATE_KEY = 'postedByGroup'

// The settings an introduction describes; if any of them changes, the old
// introduction is out of date.
export function introSignature(jid) {
  const s = groupSettings(jid)
  return [s.audience, s.revealAi, s.bookOfDay, s.morningPost, studyTipOn(jid), s.prayer === 'join', s.birthdays].join('|')
}

// kind: promo | featured | morning | tip | newMonth | welcome | intro
// info: extra details needed to judge it later (audience, verse/tip, signature).
export function rememberPost(jid, key, kind, info = {}) {
  if (!key?.id || !jid?.endsWith('@g.us')) return
  const all = getState(STATE_KEY, {})
  const now = Date.now()
  const list = (all[jid] || []).filter((p) => now - p.at < KEEP_MS)
  list.push({ id: key.id, kind, at: now, ...info })
  all[jid] = list.slice(-MAX_PER_GROUP)
  setState(STATE_KEY, all)
}

// More student-specific content (campus) doesn't fit a less student group.
const STUDENT_LEVEL = { campus: 2, mixed: 1, general: 0 }

function noLongerFits(post, jid) {
  const s = groupSettings(jid)
  switch (post.kind) {
    case 'promo':
      return !s.promos || STUDENT_LEVEL[post.audience] > STUDENT_LEVEL[s.audience]
    case 'featured':
      return !s.bookOfDay
    case 'morning':
      // A message carrying the verse is only removed when the verse is
      // switched off (the separate tip card goes when the tip is), so a verse
      // that's still wanted is never lost.
      return post.verse ? !s.morningPost : post.tip && !studyTipOn(jid)
    case 'tip':
      return !studyTipOn(jid)
    case 'newMonth':
      return !s.newMonth
    case 'welcome':
      return !s.welcome || (post.audience === 'campus' && s.audience !== 'campus')
    case 'intro':
      return post.signature !== introSignature(jid)
    default:
      return false
  }
}

const running = new Set()

// Called when a group's settings change (and once per group after a restart).
export async function cleanUpGroup(sock, jid) {
  if (!sock || running.has(jid)) return
  const all = getState(STATE_KEY, {})
  const now = Date.now()
  const recent = (all[jid] || []).filter((p) => now - p.at < KEEP_MS)
  const stale = recent.filter((p) => noLongerFits(p, jid))
  if (stale.length === 0) return

  running.add(jid)
  try {
    for (const post of stale) {
      // Already deleted by an admin or too old for WhatsApp: nothing to do.
      await sock.sendMessage(jid, { delete: { remoteJid: jid, id: post.id, fromMe: true } }).catch(() => {})
    }
    const gone = new Set(stale.map((p) => p.id))
    all[jid] = recent.filter((p) => !gone.has(p.id))
    setState(STATE_KEY, all)
    const kinds = [...new Set(stale.map((p) => p.kind))].join(', ')
    console.log(`[cleanup] Deleted ${stale.length} post(s) in ${jid} that no longer fit its settings (${kinds})`)
    logActivity('cleanup', jid, `Deleted ${stale.length} earlier post(s) that no longer fit this group's settings (${kinds})`)
  } finally {
    running.delete(jid)
  }
}
