import { getConfig } from "../lib/config"
import { AppError } from "../lib/errors"
import { logger } from "../lib/logger"
import { fetchPublic } from "../lib/network"
import {
  BOARD_LABELS,
  locationMatches,
  readBoard,
  titleMatches,
  type BoardRef,
  type Fetcher,
} from "./job-sources/boards"
import {
  defaultJsonPost,
  JOOBLE_PAGE_SIZE,
  searchJooble,
  type JsonPost,
} from "./job-sources/jooble"
import type { JobListing } from "./job-sources/types"

/**
 * Searches for open jobs across Jooble and the company job boards the user
 * follows. Each source can fail or be switched off without failing the search;
 * `sources` says how each one went. Nothing is saved.
 */

export interface JobSearchParams {
  q: string
  location: string
  remote: boolean
  page: number
  boards: BoardRef[]
}

export interface JobSourceStatus {
  name: string
  /** "off": no API key is configured for it. */
  status: "ok" | "off" | "error"
  message?: string
}

export interface JobSearchResult {
  jobs: JobListing[]
  sources: JobSourceStatus[]
  hasMore: boolean
}

interface Dependencies {
  post: JsonPost
  fetcher: Fetcher
  apiKey: () => string | undefined
  now: () => number
}

// Results aren't user data, and API quotas are shared by every user.
const CACHE_TTL_MS = 10 * 60_000
const CACHE_MAX_ENTRIES = 50
const MAX_JOBS_PER_BOARD = 25

const messageOf = (error: unknown) =>
  error instanceof AppError ? error.message : "It couldn't be reached."

const dedupeKey = (job: JobListing) =>
  `${job.role}|${job.company}`.toLowerCase().replace(/[^a-z0-9|]+/g, "")

const newestFirst = (a: JobListing, b: JobListing) => b.postedAt.localeCompare(a.postedAt)

export function createJobSearch(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = {
    post: defaultJsonPost,
    fetcher: fetchPublic,
    apiKey: () => getConfig().joobleApiKey,
    now: Date.now,
    ...overrides,
  }
  const cache = new Map<string, { expires: number; value: unknown }>()

  async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key)
    if (hit && hit.expires > deps.now()) return hit.value as T
    const value = await load()
    cache.delete(key)
    if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value as string)
    cache.set(key, { expires: deps.now() + CACHE_TTL_MS, value })
    return value
  }

  async function fromJooble(params: JobSearchParams) {
    const name = "Jooble"
    const apiKey = deps.apiKey()
    if (!apiKey) {
      const status: JobSourceStatus = { name, status: "off" }
      return { jobs: [] as JobListing[], hasMore: false, status }
    }
    const { q, location, remote, page } = params
    const key = `jooble:${JSON.stringify([q.toLowerCase(), location.toLowerCase(), remote, page])}`
    try {
      const { jobs, total } = await cached(key, () =>
        searchJooble(deps.post, apiKey, { q, location, remote, page }),
      )
      const status: JobSourceStatus = { name, status: "ok" }
      return { jobs, hasMore: total > page * JOOBLE_PAGE_SIZE, status }
    } catch (error) {
      const message = messageOf(error)
      logger.warn("Jooble search failed", { message })
      const status: JobSourceStatus = { name, status: "error", message }
      return { jobs: [] as JobListing[], hasMore: false, status }
    }
  }

  async function fromBoard(board: BoardRef, params: JobSearchParams) {
    const name = `${BOARD_LABELS[board.type]}: ${board.slug}`
    try {
      const all = await cached(`board:${board.type}:${board.slug.toLowerCase()}`, () =>
        readBoard(deps.fetcher, board),
      )
      const jobs = all
        .filter((job) => titleMatches(job.role, params.q))
        .filter((job) =>
          params.remote ? job.workMode === "remote" : locationMatches(job, params.location),
        )
        .sort(newestFirst)
        .slice(0, MAX_JOBS_PER_BOARD)
      const status: JobSourceStatus = { name, status: "ok" }
      return { jobs, status }
    } catch (error) {
      const status: JobSourceStatus = { name, status: "error", message: messageOf(error) }
      return { jobs: [] as JobListing[], status }
    }
  }

  return {
    async search(params: JobSearchParams): Promise<JobSearchResult> {
      // Boards aren't paged: all of their matches come with the first page.
      const boardSearches = params.page === 1 ? params.boards : []
      const [jooble, boards] = await Promise.all([
        fromJooble(params),
        Promise.all(boardSearches.map((board) => fromBoard(board, params))),
      ])
      // A company's own board comes first so it wins over an aggregator's copy.
      const seen = new Set<string>()
      const jobs = [...boards.flatMap((board) => board.jobs), ...jooble.jobs].filter((job) => {
        const key = dedupeKey(job)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      return {
        jobs: jobs.sort(newestFirst),
        sources: [jooble.status, ...boards.map((board) => board.status)],
        hasMore: jooble.hasMore,
      }
    },
  }
}

export const jobSearchService = createJobSearch()
