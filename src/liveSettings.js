import { config } from './config.js'
import { botApi } from './backend.js'

// Pulls the Control Center switches and RCF facts from the admin app every
// minute and applies them on top of .env, so changes need no redeploy.
// If the backend can't be reached, the last known values (or .env) stay.
const REFRESH_MS = 60 * 1000

let facts = []

export function liveFacts() {
  return facts
}

function apply(settings = {}) {
  const set = (key, value) => {
    if (value !== undefined && value !== null) config[key] = value
  }
  set('chimeIn', settings.chimeIn)
  set('welcomeNewMembers', settings.welcomeNewMembers)
  set('birthdayWishes', settings.birthdayWishes)
  set('newMonthWishes', settings.newMonthWishes)
  set('reactions', settings.reactions)
  set('privateChats', settings.privateChats)
  set('morningPost', settings.morningPost)
  set('promoEveryHours', settings.promoEveryHours)
  set('activeFromHour', settings.activeFromHour)
  set('activeToHour', settings.activeToHour)
  set('dailyAiLimit', settings.dailyAiLimit)
  if (typeof settings.answerUntagged === 'boolean') config.botMode = settings.answerUntagged ? 'tag_and_requests' : 'tag_only'
}

async function refresh() {
  try {
    const data = await botApi('/config')
    apply(data.settings)
    facts = Array.isArray(data.facts) ? data.facts : []
  } catch (err) {
    if (!refresh.warned) console.error('Could not load Control Center settings (using .env):', err.message)
    refresh.warned = true
  }
}

let started = false

export async function startLiveSettings() {
  if (started || !config.botApiKey) return
  started = true
  await refresh()
  setInterval(refresh, REFRESH_MS)
}
