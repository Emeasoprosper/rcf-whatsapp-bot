import 'dotenv/config'

const num = (value, fallback) => {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export const config = {
  backendUrl: (process.env.BACKEND_URL || 'https://rcf-library-backend.onrender.com').replace(/\/+$/, ''),
  siteUrl: (process.env.SITE_URL || 'https://rcf-mouau-library.vercel.app').replace(/\/+$/, ''),
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  // Same default your backend uses in rcf-library-backend/src/services/aiAnalysis.js.
  // Copy the GEMINI_MODEL value from your Render backend env to be safe.
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
  // 'tag_only' = answer only when tagged. 'tag_and_requests' = also answer
  // clear "I need X book / past question" messages without a tag.
  botMode: process.env.BOT_MODE === 'tag_only' ? 'tag_only' : 'tag_and_requests',
  // One or more group ids, comma separated. Empty = setup mode (never replies).
  allowedGroups: (process.env.ALLOWED_GROUP_JID || '').split(',').map((s) => s.trim()).filter(Boolean),
  dailyAiLimit: num(process.env.DAILY_AI_LIMIT, 150),
  senderCooldownMs: num(process.env.SENDER_COOLDOWN_SECONDS, 600) * 1000,
  groupCooldownMs: num(process.env.GROUP_COOLDOWN_SECONDS, 30) * 1000,
  // Render free backend can take a while to wake up, so be patient on search.
  searchTimeoutMs: 45000,
  aiTimeoutMs: 25000,
  maxResults: 5,
  // How many recent group messages the AI sees so it can follow the chat.
  chatMemorySize: 15,
  // Must match BOT_API_KEY on the Render backend. Empty = admin posts to
  // WhatsApp are switched off.
  botApiKey: process.env.BOT_API_KEY || '',
  announcementPollMs: 60 * 1000,
  // "Upload to the library" adverts. 0 turns them off.
  promoEveryHours: num(process.env.PROMO_EVERY_HOURS, 48),
  welcomeNewMembers: process.env.WELCOME_NEW_MEMBERS !== 'false',
  // These and most switches here can also be changed live from the admin
  // app (WhatsApp Bot page > Settings), see liveSettings.js.
  birthdayWishes: true,
  newMonthWishes: true,
  // Verse of the day + study tip in every group each morning from 7am.
  morningPost: process.env.MORNING_POST !== 'false',
  reactions: true,
  // Join a lively discussion without being tagged, when the AI thinks it can
  // genuinely help. At most once per cooldown per group.
  chimeIn: process.env.CHIME_IN !== 'false',
  chimeCooldownMs: num(process.env.CHIME_IN_COOLDOWN_MINUTES, 60) * 60 * 1000,
  // Answer people who message the bot number directly (one-to-one chats).
  // Each person gets this many AI answers a day there, so nobody can use up
  // the shared daily limit on their own.
  privateChats: process.env.PRIVATE_CHATS !== 'false',
  privateDailyLimit: num(process.env.PRIVATE_DAILY_LIMIT, 30),
  chimeMinMessages: 8,
  chimeMinPeople: 3,
  chimeWindowMs: 10 * 60 * 1000,
  // The bot never starts a post (adverts, announcements, welcomes) outside
  // these Lagos hours, so nobody gets pinged at night.
  activeFromHour: num(process.env.ACTIVE_FROM_HOUR, 7),
  activeToHour: num(process.env.ACTIVE_TO_HOUR, 21),
  libraryHod: process.env.LIBRARY_HOD || 'HOD for Library',
  botName: 'Bro Paul',
  creatorName: process.env.CREATOR_NAME || 'Emeaso Prosper',
  creatorPhone: process.env.CREATOR_PHONE || '08069305651',
  creatorSkills: 'Web Developer · Data Analyst · Graphic Designer · Video Editor',
}

export function lagosHour() {
  return Number(new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', hour12: false }))
}

export function isActiveHours() {
  const h = lagosHour()
  return h >= config.activeFromHour && h < config.activeToHour
}
