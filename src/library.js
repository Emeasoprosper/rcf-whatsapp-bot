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

const BOOKISH = /book|devotional|novel|magazine|biography|christian|inspiration/i
const PLAIN = /past|question|handout|note|slide|manual|syllabus|timetable/i

// Approved resources that have a cover, from both the most downloaded and the
// newest, best first, for the daily "book of the day" post. Books and
// devotionals with a real description beat past questions and handouts,
// whose covers are usually plain scans.
export async function featuredCandidates() {
  const lists = await Promise.all(
    ['popular', 'recent'].map((sort) =>
      fetchJson(`${config.backendUrl}/api/resources?sort=${sort}&pageSize=50`, config.searchTimeoutMs).catch(() => ({ items: [] }))
    )
  )
  const seen = new Set()
  return lists
    .flatMap((d) => d.items || [])
    .filter((r) => {
      if (seen.has(r.id) || !r.thumbnail_url || ['processing', 'failed'].includes(r.thumbnail_status)) return false
      seen.add(r.id)
      return true
    })
    .map((r) => {
      const kind = `${r.type || ''} ${r.type_label || ''} ${(r.categories || []).join(' ')}`
      const score =
        (BOOKISH.test(kind) ? 3 : 0) -
        (PLAIN.test(kind) ? 3 : 0) +
        ((r.description || '').trim().length > 40 ? 2 : 0) +
        (r.author ? 1 : 0) +
        Math.log10(1 + (r.download_count || 0) + (r.view_count || 0) / 5)
      return {
        id: r.id,
        title: r.title,
        author: r.author || null,
        description: (r.description || '').trim(),
        courseCode: r.course_code || null,
        typeLabel: r.type_label || null,
        categories: r.categories || [],
        coverUrl: r.thumbnail_url.startsWith('/') ? `${config.backendUrl}${r.thumbnail_url}` : r.thumbnail_url,
        url: `${config.siteUrl}/library/${r.id}`,
        score,
      }
    })
    .sort((a, b) => b.score - a.score)
}