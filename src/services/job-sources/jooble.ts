import { AppError } from "../../lib/errors"
import { clean, htmlToText, workModeFrom } from "../../lib/job-page"
import { capDescription, str, toIso, type JobListing } from "./types"

/** Sends a JSON POST and returns the status and parsed body. */
export type JsonPost = (url: string, body: unknown) => Promise<{ status: number; json: unknown }>

export const defaultJsonPost: JsonPost = async (url, body) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(6_000),
  })
  return { status: response.status, json: await response.json().catch(() => undefined) }
}

export const JOOBLE_PAGE_SIZE = 20

/** The India host, as the app's users search Indian job markets first. */
const JOOBLE_API = "https://in.jooble.org/api/"

type Json = Record<string, unknown>

function toListing(raw: Json): JobListing | undefined {
  const url = str(raw.link)
  const role = clean(str(raw.title))
  if (!role || !/^https?:\/\//i.test(url)) return undefined
  const location = clean(str(raw.location))
  return {
    id: `jooble:${str(raw.id) || url}`,
    role,
    company: clean(str(raw.company)),
    location,
    workMode: workModeFrom(`${role} ${location}`),
    salary: clean(str(raw.salary)),
    description: capDescription(htmlToText(str(raw.snippet))),
    url,
    source: clean(str(raw.source)) || "Jooble",
    postedAt: toIso(raw.updated),
  }
}

export async function searchJooble(
  post: JsonPost,
  apiKey: string,
  params: { q: string; location: string; remote: boolean; page: number },
): Promise<{ jobs: JobListing[]; total: number }> {
  // The key is part of the URL, so errors below never repeat the URL.
  const { status, json } = await post(`${JOOBLE_API}${encodeURIComponent(apiKey)}`, {
    keywords: params.remote ? `${params.q} remote` : params.q,
    location: params.remote ? "" : params.location,
    page: String(params.page),
    ResultOnPage: String(JOOBLE_PAGE_SIZE),
  })
  if (status === 401 || status === 403) {
    throw new AppError(502, "INTEGRATION_ERROR", "Jooble rejected the API key.")
  }
  if (status === 429) {
    throw new AppError(429, "RATE_LIMITED", "Jooble's usage limit was reached. Try again later.")
  }
  if (status !== 200 || !json || typeof json !== "object") {
    throw new AppError(502, "INTEGRATION_ERROR", `Jooble answered with status ${status}.`)
  }
  const body = json as Json
  const raw = Array.isArray(body.jobs) ? (body.jobs as Json[]) : []
  return {
    jobs: raw.map(toListing).filter((job): job is JobListing => Boolean(job)),
    total: Number(body.totalCount) || 0,
  }
}
