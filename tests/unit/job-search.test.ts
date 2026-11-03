import { describe, expect, it } from "vitest"

import { handler } from "../../src/functions/career"
import type { FetchedPage } from "../../src/lib/network"
import { locationMatches, titleMatches } from "../../src/services/job-sources/boards"
import type { JobListing } from "../../src/services/job-sources/types"
import { createJobSearch, type JobSearchParams } from "../../src/services/job-search.service"
import { call } from "../support/http"

const params = (overrides: Partial<JobSearchParams> = {}): JobSearchParams => ({
  q: "React Developer",
  location: "Chennai",
  remote: false,
  page: 1,
  boards: [],
  ...overrides,
})

const joobleJob = {
  id: 123,
  title: "React Developer",
  company: "Acme",
  location: "Chennai, Tamil Nadu",
  snippet: "<b>React</b> &amp; Node.js",
  salary: "₹12 LPA",
  source: "board.example",
  link: "https://in.jooble.org/desc/123",
  updated: "2026-10-30T10:00:00.000",
}

function fakePost(status = 200, json: unknown = { totalCount: 45, jobs: [joobleJob] }) {
  const calls: Array<{ url: string; body: unknown }> = []
  return {
    calls,
    post: async (url: string, body: unknown) => {
      calls.push({ url, body })
      return { status, json }
    },
  }
}

function fakeFetch(routes: Record<string, unknown>) {
  const calls: string[] = []
  return {
    calls,
    fetcher: async (url: string): Promise<FetchedPage> => {
      calls.push(url)
      const json = routes[url]
      return {
        url,
        status: json === undefined ? 404 : 200,
        contentType: "application/json",
        body: JSON.stringify(json ?? {}),
      }
    },
  }
}

describe("job search", () => {
  it("maps Jooble results and reports more pages", async () => {
    const { post, calls } = fakePost()
    const result = await createJobSearch({ post, apiKey: () => "key" }).search(params())
    expect(calls[0]?.url).toBe("https://in.jooble.org/api/key")
    expect(calls[0]?.body).toMatchObject({
      keywords: "React Developer",
      location: "Chennai",
      page: "1",
    })
    expect(result.hasMore).toBe(true)
    expect(result.sources).toEqual([{ name: "Jooble", status: "ok" }])
    expect(result.jobs[0]).toMatchObject({
      id: "jooble:123",
      role: "React Developer",
      company: "Acme",
      salary: "₹12 LPA",
      description: "React & Node.js",
      url: "https://in.jooble.org/desc/123",
      source: "board.example",
    })
  })

  it("marks Jooble off without a key and makes no call", async () => {
    const { post, calls } = fakePost()
    const result = await createJobSearch({ post, apiKey: () => undefined }).search(params())
    expect(calls).toHaveLength(0)
    expect(result).toEqual({
      jobs: [],
      sources: [{ name: "Jooble", status: "off" }],
      hasMore: false,
    })
  })

  it("reports a rejected key without exposing it or failing the search", async () => {
    const { post } = fakePost(403, {})
    const result = await createJobSearch({ post, apiKey: () => "secret-key" }).search(params())
    expect(result.jobs).toEqual([])
    expect(result.sources[0]).toMatchObject({
      status: "error",
      message: "Jooble rejected the API key.",
    })
    expect(JSON.stringify(result)).not.toContain("secret-key")
  })

  it("reads each board type and filters by role and location", async () => {
    const { fetcher, calls } = fakeFetch({
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": {
        jobs: [
          {
            id: 1,
            title: "Senior React Engineer",
            location: { name: "Chennai" },
            absolute_url: "https://job-boards.greenhouse.io/acme/jobs/1",
            content: "&lt;p&gt;Ship React&lt;/p&gt;",
            updated_at: "2026-10-20T00:00:00Z",
          },
          {
            id: 2,
            title: "Sales Manager",
            location: { name: "Chennai" },
            absolute_url: "https://x.example/2",
          },
          {
            id: 3,
            title: "React Engineer",
            location: { name: "Berlin" },
            absolute_url: "https://x.example/3",
          },
        ],
      },
      "https://api.lever.co/v0/postings/globex?mode=json": [
        {
          id: "a",
          text: "React Native Developer",
          categories: { location: "Remote" },
          hostedUrl: "https://jobs.lever.co/globex/a",
          descriptionPlain: "Mobile",
          createdAt: 1793000000000,
        },
      ],
      "https://api.ashbyhq.com/posting-api/job-board/initech?includeCompensation=true": {
        jobs: [
          {
            id: "z",
            title: "React Developer",
            location: "Chennai",
            jobUrl: "https://jobs.ashbyhq.com/initech/z",
            compensation: { compensationTierSummary: "₹20L" },
            publishedAt: "2026-10-25T00:00:00Z",
          },
          {
            id: "hidden",
            title: "React Developer II",
            location: "Chennai",
            isListed: false,
            jobUrl: "https://x.example/h",
          },
        ],
      },
    })
    const result = await createJobSearch({ fetcher, apiKey: () => undefined }).search(
      params({
        boards: [
          { type: "greenhouse", slug: "acme" },
          { type: "lever", slug: "globex" },
          { type: "ashby", slug: "initech" },
        ],
      }),
    )
    expect(calls).toHaveLength(3)
    expect(result.jobs.map((job) => job.id).sort()).toEqual([
      "ashby:initech:z",
      "greenhouse:acme:1",
      "lever:globex:a",
    ])
    expect(result.jobs.find((job) => job.id === "greenhouse:acme:1")).toMatchObject({
      company: "Acme",
      description: "Ship React",
      source: "Greenhouse",
    })
    expect(result.jobs.find((job) => job.id === "ashby:initech:z")?.salary).toBe("₹20L")
    expect(result.jobs.find((job) => job.id === "lever:globex:a")?.workMode).toBe("remote")
  })

  it("keeps other results when one board fails", async () => {
    const { post } = fakePost()
    const { fetcher } = fakeFetch({})
    const result = await createJobSearch({ post, fetcher, apiKey: () => "key" }).search(
      params({ boards: [{ type: "lever", slug: "gone" }] }),
    )
    expect(result.jobs).toHaveLength(1)
    expect(result.sources[1]).toEqual({
      name: "Lever: gone",
      status: "error",
      message: "That job board wasn't found.",
    })
  })

  it("prefers a company's own posting over an aggregator's copy", async () => {
    const { post } = fakePost()
    const { fetcher } = fakeFetch({
      "https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true": {
        jobs: [
          {
            id: "z",
            title: "React Developer",
            location: "Chennai",
            jobUrl: "https://jobs.ashbyhq.com/acme/z",
          },
        ],
      },
    })
    const result = await createJobSearch({ post, fetcher, apiKey: () => "key" }).search(
      params({ boards: [{ type: "ashby", slug: "acme" }] }),
    )
    expect(result.jobs.map((job) => job.source)).toEqual(["Ashby"])
  })

  it("reads boards only for the first page", async () => {
    const { post } = fakePost()
    const { fetcher, calls } = fakeFetch({})
    await createJobSearch({ post, fetcher, apiKey: () => "key" }).search(
      params({ page: 2, boards: [{ type: "lever", slug: "acme" }] }),
    )
    expect(calls).toHaveLength(0)
  })

  it("caches results for ten minutes, but not failures", async () => {
    let now = 0
    const { post, calls } = fakePost()
    const search = createJobSearch({ post, apiKey: () => "key", now: () => now })
    await search.search(params())
    await search.search(params({ q: "react developer" }))
    expect(calls).toHaveLength(1)
    now = 10 * 60_000 + 1
    await search.search(params())
    expect(calls).toHaveLength(2)

    const failing = fakePost(500, {})
    const retry = createJobSearch({ post: failing.post, apiKey: () => "key" })
    await retry.search(params())
    await retry.search(params())
    expect(failing.calls).toHaveLength(2)
  })

  it("matches titles and locations sensibly", () => {
    expect(titleMatches("Full-Stack Engineer", "Full Stack Developer")).toBe(true)
    expect(titleMatches("Sales Developer", "React Developer")).toBe(false)
    expect(titleMatches("Backend Engineer", "Developer")).toBe(true)
    expect(titleMatches("Account Manager", "Developer")).toBe(false)
    const job = { location: "Chennai, India", workMode: "" } as JobListing
    expect(locationMatches(job, "Chennai, Tamil Nadu")).toBe(true)
    expect(locationMatches(job, "Pune")).toBe(false)
    expect(locationMatches({ ...job, workMode: "remote" }, "Pune")).toBe(true)
    expect(locationMatches(job, "")).toBe(true)
  })
})

describe("GET /jobs/search", () => {
  it("requires a role and validates boards", async () => {
    const missing = await call(handler, "GET", "/jobs/search", { query: { q: "" } })
    expect(missing.status).toBe(400)
    const badBoard = await call(handler, "GET", "/jobs/search", {
      query: { q: "React", boards: "evil.example:../../x" },
    })
    expect(badBoard.status).toBe(400)
  })

  it("answers with the source status when Jooble is off", async () => {
    const response = await call(handler, "GET", "/jobs/search", { query: { q: "React" } })
    expect(response.status).toBe(200)
    expect(response.body.data).toEqual({
      jobs: [],
      sources: [{ name: "Jooble", status: "off" }],
      hasMore: false,
    })
  })
})
