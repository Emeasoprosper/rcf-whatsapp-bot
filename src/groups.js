import { config } from './config.js'
import { botApi } from './backend.js'

// Which groups the bot talks in:
// - With BOT_API_KEY: the groups switched on in the admin app's WhatsApp Bot
//   page. A group the bot is added to is reported to the backend, which turns
//   it on automatically and notifies the superadmins. ALLOWED_GROUP_JID is
//   only used until the first list arrives from the backend.
// - Without it: only ALLOWED_GROUP_JID from .env.
const backendOn = () => Boolean(config.botApiKey)
let groups = new Set(config.allowedGroups)
let settingsByGroup = {}
const reported = new Set()

// Set per group on the admin app's WhatsApp Bot page.
// audience: 'campus' (MOUAU students), 'mixed' or 'general' (not students).
// prayer: during a prayer session, 'quiet' (say nothing), 'amen' (🙏 the
// prayers) or 'join' (also add a short prayer now and then).
const DEFAULT_GROUP_SETTINGS = {
  audience: 'campus',
  prayer: 'amen',
  bookOfDay: true,
  morningPost: true,
  promos: true,
  welcome: true,
  chimeIn: true,
  newMonth: true,
  birthdays: true,
}

export function groupSettings(jid) {
  return { ...DEFAULT_GROUP_SETTINGS, ...(settingsByGroup[jid] || {}) }
}

// The study tip is its own switch, separate from the verse of the day
// (morningPost). Not set yet: on for student groups, off for 'general' ones.
export function studyTipOn(jid) {
  const s = groupSettings(jid)
  return typeof s.studyTip === 'boolean' ? s.studyTip : s.audience !== 'general'
}

// The groups where a kind of post is switched on, e.g. allowedGroupsFor('bookOfDay').
// notNow = groups to hold the post back from for the moment (e.g. praying);
// the poster tries them again on its next check.
export function allowedGroupsFor(key, notNow = () => false) {
  return allowedGroups().filter((jid) => groupSettings(jid)[key] !== false && !notNow(jid))
}

export function isAllowedGroup(jid) {
  return groups.has(jid)
}

// A WhatsApp Community's parent is a container, not a chat: nothing can be
// posted there. Its announcement group and linked groups are normal groups.
const communityParents = new Set()

export function allowedGroups() {
  return [...groups].filter((jid) => !communityParents.has(jid))
}

export async function refreshGroups() {
  if (!backendOn()) return
  try {
    const { jids = [], settings = {} } = await botApi('/groups')
    // Groups whose settings changed (or that are seen for the first time
    // since a restart), so posts that no longer fit can be cleaned up.
    const changed = jids.filter((jid) => JSON.stringify(settings[jid]) !== JSON.stringify(settingsByGroup[jid]))
    groups = new Set(jids)
    settingsByGroup = settings
    if (settingsChangeHandler) changed.forEach((jid) => settingsChangeHandler(jid))
  } catch (err) {
    console.error('Could not refresh group list:', err.message)
  }
}

// Called with a group id whenever that group's settings change. Set from index.js.
let settingsChangeHandler = null
export function whenSettingsChange(fn) {
  settingsChangeHandler = fn
}

// Called once for a group the bot has never been in before (so it can
// introduce itself). Set from index.js.
let newGroupHandler = null
export function whenNewGroup(fn) {
  newGroupHandler = fn
}

// sock is used to look up the group's name. Safe to call often: each group
// is only reported once per run.
export async function reportGroup(sock, jid, meta = null) {
  if (!backendOn() || !jid?.endsWith('@g.us') || reported.has(jid)) return
  reported.add(jid)
  try {
    const info = meta || (await sock.groupMetadata(jid).catch(() => null))
    if (info?.isCommunity) {
      communityParents.add(jid)
      console.log(`[groups] "${info.subject || jid}" is a Community (parent), not a chat: skipped. Its groups are handled on their own.`)
      return
    }
    const { enabled, isNew, rejoined } = await botApi('/groups', {
      method: 'POST',
      body: { jid, name: info?.subject || null, memberCount: info?.participants?.length ?? null },
    })
    if (enabled) groups.add(jid)
    else groups.delete(jid)
    if (isNew || rejoined) {
      console.log(`[groups] ${rejoined ? 'Added back to' : 'New group'} "${info?.subject || jid}": waiting silently until a superadmin starts him there.`)
      if (newGroupHandler) newGroupHandler(jid)
    }
  } catch (err) {
    // Try again in 10 minutes, not on every message (backend may be asleep).
    setTimeout(() => reported.delete(jid), 10 * 60 * 1000)
    console.error(`Could not report group ${jid}:`, err.message)
  }
}

// He was removed from a group (or left it): stop talking there at once and
// tell the backend, which switches it off and lists it under "Removed from".
// If he's added back, the group is reported again and waits as a new group.
export async function markLeft(jid) {
  groups.delete(jid)
  reported.delete(jid)
  if (!backendOn()) return
  try {
    await botApi('/groups/left', { method: 'POST', body: { jid } })
    console.log(`[groups] Removed from ${jid}: switched off there.`)
  } catch (err) {
    console.error(`Could not report leaving ${jid}:`, err.message)
  }
}

export async function reportAllGroups(sock) {
  if (!backendOn()) return
  try {
    const all = await sock.groupFetchAllParticipating()
    for (const [jid, meta] of Object.entries(all)) await reportGroup(sock, jid, meta)
    // Groups he was removed from while offline get marked too.
    const current = Object.keys(all).filter((jid) => !communityParents.has(jid))
    if (current.length) {
      const { marked = 0 } = await botApi('/groups/sync', { method: 'POST', body: { jids: current } })
      if (marked) {
        console.log(`[groups] ${marked} group(s) he was removed from while offline are now switched off.`)
        await refreshGroups()
      }
    }
  } catch (err) {
    console.error('Could not list groups:', err.message)
  }
}
