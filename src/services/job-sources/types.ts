import type { WorkModeGuess } from "../../lib/job-page"

/** A job found by a search; nothing is saved until the user reviews it. */
export interface JobListing {
  /** Unique across sources: `<provider>:<the source's own id>`. */
  id: string
  role: string
  company: string
  location: string
  workMode: WorkModeGuess
  salary: string
  /** Plain text; some sources only return a snippet. */
  description: string
  url: string
  /** Where the job was found, for display ("Greenhouse", a Jooble publisher, …). */
  source: string
  /** ISO date ("" when the source doesn't say). */
  postedAt: string
}

export const str = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : ""

export function toIso(value: unknown): string {
  const raw = typeof value === "number" ? value : str(value)
  if (!raw) return ""
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? "" : date.toISOString()
}

/** Keeps long postings from inflating a page of results. */
export const capDescription = (text: string) => text.slice(0, 5000)
