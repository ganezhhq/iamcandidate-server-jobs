import { AppError } from "../../lib/errors"
import { clean, decodeEntities, htmlToText, titleCase, workModeFrom } from "../../lib/job-page"
import type { FetchedPage, FetchOptions } from "../../lib/network"
import { capDescription, str, toIso, type JobListing } from "./types"

export type BoardType = "greenhouse" | "lever" | "ashby"

/** One company's public job board, e.g. `{ type: "lever", slug: "acme" }`. */
export interface BoardRef {
  type: BoardType
  slug: string
}

export type Fetcher = (url: string, options?: FetchOptions) => Promise<FetchedPage>

type Json = Record<string, unknown>

const obj = (value: unknown): Json => (value && typeof value === "object" ? (value as Json) : {})

export const BOARD_LABELS: Record<BoardType, string> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
}

function greenhouse(json: unknown, slug: string): JobListing[] {
  const jobs = Array.isArray(obj(json).jobs) ? (obj(json).jobs as Json[]) : []
  return jobs.map((job) => {
    const role = clean(str(job.title))
    const location = clean(str(obj(job.location).name))
    return {
      id: `greenhouse:${slug}:${str(job.id)}`,
      role,
      company: clean(str(job.company_name)) || titleCase(slug),
      location,
      workMode: workModeFrom(`${role} ${location}`),
      salary: "",
      description: capDescription(htmlToText(decodeEntities(str(job.content)))),
      url: str(job.absolute_url),
      source: "Greenhouse",
      postedAt: toIso(job.first_published ?? job.updated_at),
    }
  })
}

function lever(json: unknown, slug: string): JobListing[] {
  const jobs = Array.isArray(json) ? (json as Json[]) : []
  return jobs.map((job) => {
    const role = clean(str(job.text))
    const location = clean(str(obj(job.categories).location))
    return {
      id: `lever:${slug}:${str(job.id)}`,
      role,
      company: titleCase(slug),
      location,
      workMode: workModeFrom(`${str(job.workplaceType)} ${role} ${location}`),
      salary: "",
      description: capDescription(clean(str(job.descriptionPlain))),
      url: str(job.hostedUrl),
      source: "Lever",
      postedAt: toIso(job.createdAt),
    }
  })
}

function ashby(json: unknown, slug: string): JobListing[] {
  const jobs = Array.isArray(obj(json).jobs) ? (obj(json).jobs as Json[]) : []
  return jobs
    .filter((job) => job.isListed !== false)
    .map((job) => {
      const role = clean(str(job.title))
      const location = clean(str(job.location))
      const mode = job.isRemote === true ? "remote" : str(job.workplaceType)
      return {
        id: `ashby:${slug}:${str(job.id)}`,
        role,
        company: titleCase(slug),
        location,
        workMode: workModeFrom(`${mode} ${role} ${location}`),
        salary: clean(str(obj(job.compensation).compensationTierSummary)),
        description: capDescription(clean(str(job.descriptionPlain))),
        url: str(job.jobUrl),
        source: "Ashby",
        postedAt: toIso(job.publishedAt),
      }
    })
}

const READERS: Record<BoardType, { url: (slug: string) => string; read: typeof greenhouse }> = {
  greenhouse: {
    url: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
    read: greenhouse,
  },
  lever: { url: (slug) => `https://api.lever.co/v0/postings/${slug}?mode=json`, read: lever },
  ashby: {
    url: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`,
    read: ashby,
  },
}

/** Every open job on one company's board. */
export async function readBoard(fetcher: Fetcher, board: BoardRef): Promise<JobListing[]> {
  const { url, read } = READERS[board.type]
  const page = await fetcher(url(encodeURIComponent(board.slug)), {
    accept: "application/json",
    timeoutMs: 6_000,
    // A big company's whole board, descriptions included, runs to many megabytes.
    maxBytes: 30 * 1024 * 1024,
  })
  if (page.status === 404) {
    throw new AppError(502, "INTEGRATION_ERROR", "That job board wasn't found.")
  }
  if (page.status !== 200) {
    throw new AppError(502, "INTEGRATION_ERROR", `The board answered with status ${page.status}.`)
  }
  let json: unknown
  try {
    json = JSON.parse(page.body)
  } catch {
    throw new AppError(502, "INTEGRATION_ERROR", "The board's answer couldn't be read.")
  }
  return read(json, board.slug).filter((job) => job.role && /^https?:\/\//i.test(job.url))
}

// Words every engineering title shares; they say nothing about the role asked for.
const GENERIC_TITLE_WORDS = new Set(["developer", "engineer", "programmer", "dev", "sde"])

const normalizeTitle = (text: string) =>
  text
    .toLowerCase()
    .replace(/[-/,()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()

/** Boards list all of a company's jobs, so they're filtered by the role searched for. */
export function titleMatches(title: string, query: string): boolean {
  const normalized = normalizeTitle(title)
  const words = normalizeTitle(query).split(" ").filter(Boolean)
  const specific = words.filter((word) => !GENERIC_TITLE_WORDS.has(word))
  if (!specific.length) {
    const titleWords = normalized.split(" ")
    return [...GENERIC_TITLE_WORDS].some((word) => titleWords.includes(word))
  }
  return specific.every((word) => normalized.includes(word))
}

/** Remote jobs always pass a location filter: they aren't tied to one city. */
export function locationMatches(job: JobListing, location: string): boolean {
  const wanted = location.split(",")[0]?.trim().toLowerCase()
  return !wanted || job.workMode === "remote" || job.location.toLowerCase().includes(wanted)
}
