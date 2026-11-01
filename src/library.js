import { config } from './config.js'

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`Library API returned ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

// Calls your existing public route: GET /api/resources (rcf-library-backend/src/routes/resources.js).
// Only approved resources come back. Links are built here from real ids, never by the AI.
export async function searchLibrary(searchText, { type, pageSize = config.maxResults } = {}) {
  const params = new URLSearchParams({
    search: searchText,
    pageSize: String(pageSize),
  })
  if (type) params.set('type', type)
  const url = `${config.backendUrl}/api/resources?${params.toString()}`

  let data
  try {
    data = await fetchJson(url, config.searchTimeoutMs)
  } catch (firstError) {
    // One retry — covers the backend waking up from sleep.
    data = await fetchJson(url, config.searchTimeoutMs)
  }

  return (data.items || []).map((r) => ({
    id: r.id,
    title: r.title,
    author: r.author || null,
    courseCode: r.course_code || null,
    typeLabel: r.type_label || null,
    url: `${config.siteUrl}/library/${r.id}`,
  }))
}