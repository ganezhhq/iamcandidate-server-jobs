/**
 * Lightweight local backend — no Docker, no `sam build`:
 *
 *   npm run dev        # API on http://localhost:3001, restarts on code changes
 *   npm run dev:reset  # wipe local data (re-seeded on next start)
 *
 * One Node process runs:
 *   - the API: the same route tables, auth and validation as the Lambda
 *     functions, served over plain HTTP (no API Gateway/Lambda emulation);
 *   - dynalite: a DynamoDB-compatible database saved under `.local/dynamodb`;
 *   - a minimal S3 stand-in for presigned uploads/downloads under `.local/s3`.
 *
 * The first start creates the table and seeds the frontend's demo data plus
 * the admin login demo@example.com. Use `sam local` / AWS for a final check
 * of the real Lambda + API Gateway setup.
 */
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import http from "node:http"
import { dirname, join, resolve, sep } from "node:path"
import { pipeline } from "node:stream/promises"

import dynalite from "dynalite"

import { PUBLIC_PORTFOLIO_ROUTES, portfolioRoutes } from "../src/handlers/portfolio"
import { PUBLIC_PRICING_ROUTES, pricingRoutes } from "../src/handlers/pricing"
import { authRoutes, PUBLIC_ROUTES, userRoutes } from "../src/handlers/users"
import {
  applicationRoutes,
  companyRoutes,
  contactRoutes,
  interviewRoutes,
  jobRoutes,
  referralRoutes,
} from "../src/handlers/career"
import { emailRoutes, smtpRoutes, templateRoutes } from "../src/handlers/communication"
import { integrationRoutes } from "../src/handlers/integrations"
import { latexRoutes } from "../src/handlers/latex"
import { documentRoutes, resumeRoutes } from "../src/handlers/documents"
import { certificationRoutes, linkRoutes, skillRoutes } from "../src/handlers/knowledge"
import {
  activityRoutes,
  dashboardRoutes,
  notificationRoutes,
  settingsRoutes,
} from "../src/handlers/system"
import { boardRoutes, noteRoutes, projectRoutes, taskRoutes } from "../src/handlers/workspace"
import { getConfig } from "../src/lib/config"
import { createHandler } from "../src/lib/router"
import { usersRepository } from "../src/repositories/dynamodb"
import { loadLocalEnv } from "./env"
import { ensureLocalTable } from "./local-table"
import { seedAdminAccount, seedDemoData } from "./seed-data"

const DATA_DIR = resolve(process.env.DEV_DATA_DIR ?? ".local")
const API_PORT = Number(process.env.PORT ?? 3001)
const DB_PORT = Number(process.env.DEV_DB_PORT ?? 8010)
const S3_PORT = Number(process.env.DEV_S3_PORT ?? 9010)

/** Reuse the `sam local` secrets so sessions and saved SMTP passwords work in both setups. */
function localSecret(name: "AUTH_SECRET" | "DATA_ENCRYPTION_KEY"): string {
  try {
    const env = JSON.parse(readFileSync("env.local.json", "utf8")) as {
      Parameters?: Record<string, string | undefined>
    }
    const value = env.Parameters?.[name]
    if (value) return value
  } catch {
    // fall through
  }
  return `dev-only-${name}-dev-only-${name}`
}

// Config is read lazily, so setting the environment here (before any request
// or seed runs) is enough. Nothing here is used outside this process.
Object.assign(process.env, {
  STAGE: "dev",
  AWS_REGION: "ap-south-1",
  DYNAMODB_TABLE: "personal-os-local",
  DYNAMODB_ENDPOINT: `http://localhost:${DB_PORT}`,
  S3_BUCKET: "personal-os-documents-local",
  S3_ENDPOINT: `http://localhost:${S3_PORT}`,
  S3_PUBLIC_ENDPOINT: `http://localhost:${S3_PORT}`,
  // Portfolio images: served straight from the local S3 stand-in.
  PORTFOLIO_BUCKET: "personal-os-portfolio-local",
  PORTFOLIO_ASSETS_URL: `http://localhost:${S3_PORT}/personal-os-portfolio-local`,
  S3_ACCESS_KEY_ID: "local",
  S3_SECRET_ACCESS_KEY: "local",
  // 3002: the ganesh-portfolio site, run alongside the IamCandidate UI on 3000.
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ?? "http://localhost:3000,http://localhost:3002",
  DEFAULT_USER_ID: "usr_demo",
  AUTH_SECRET: process.env.AUTH_SECRET ?? localSecret("AUTH_SECRET"),
  DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY ?? localSecret("DATA_ENCRYPTION_KEY"),
  // Lets you test with a mail catcher on localhost (e.g. smtp4dev, MailHog).
  ALLOW_PRIVATE_SMTP_HOSTS: "true",
  LOG_LEVEL: process.env.LOG_LEVEL ?? "silent",
  GOOGLE_REDIRECT_URI:
    process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:3000/integrations/google-drive/callback",
})
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET come from the git-ignored .env (values set above win).
loadLocalEnv()

/** Tectonic downloaded into .tools (see docs/latex.md), else whatever is on PATH. */
const bundledTectonic = resolve(
  ".tools",
  "tectonic",
  process.platform === "win32" ? "tectonic.exe" : "tectonic",
)
process.env.TECTONIC_PATH ??= existsSync(bundledTectonic) ? bundledTectonic : "tectonic"
// A fixed package cache, independent of the terminal's environment (IDE terminals
// can hide the default one), and time for a first-run package download.
process.env.TECTONIC_CACHE_DIR ??= resolve(".tools", "tectonic-cache")
process.env.LATEX_TIMEOUT_MS ??= String(5 * 60_000)

/** Every route of every Lambda function, exactly as deployed. */
const api = createHandler(
  {
    ...applicationRoutes,
    ...jobRoutes,
    ...companyRoutes,
    ...contactRoutes,
    ...referralRoutes,
    ...interviewRoutes,
    ...documentRoutes,
    ...resumeRoutes,
    ...projectRoutes,
    ...taskRoutes,
    ...noteRoutes,
    ...boardRoutes,
    ...skillRoutes,
    ...certificationRoutes,
    ...linkRoutes,
    ...activityRoutes,
    ...notificationRoutes,
    ...settingsRoutes,
    ...dashboardRoutes,
    ...authRoutes,
    ...userRoutes,
    ...pricingRoutes,
    ...portfolioRoutes,
    ...emailRoutes,
    ...templateRoutes,
    ...smtpRoutes,
    ...integrationRoutes,
    // In AWS this route is an isolated Lambda behind an authorizer; here it is
    // a normal signed-in route that runs Tectonic on this machine.
    ...latexRoutes,
  },
  { publicRoutes: [...PUBLIC_ROUTES, ...PUBLIC_PRICING_ROUTES, ...PUBLIC_PORTFOLIO_ROUTES] },
)

function listen(server: http.Server, port: number, name: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "EADDRINUSE"
          ? new Error(
              `Port ${port} (${name}) is in use — stop the other process (e.g. sam local) or set ${name === "API" ? "PORT" : name === "database" ? "DEV_DB_PORT" : "DEV_S3_PORT"}.`,
            )
          : error,
      )
    })
    server.listen(port, () => resolvePromise())
  })
}

async function readBody(req: http.IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined
}

/* ------------------------------------------------------------------ */
/* API (API Gateway HTTP API v2 events → route handlers)               */
/* ------------------------------------------------------------------ */

function apiServer(): http.Server {
  return http.createServer(async (req, res) => {
    const started = Date.now()
    const url = new URL(req.url ?? "/", `http://localhost:${API_PORT}`)
    const method = (req.method ?? "GET").toUpperCase()
    try {
      const event = {
        version: "2.0",
        routeKey: "$default",
        rawPath: url.pathname,
        rawQueryString: url.search.slice(1),
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([key, value]) => [key, String(value)]),
        ),
        queryStringParameters: url.search ? Object.fromEntries(url.searchParams) : undefined,
        requestContext: {
          http: { method, path: url.pathname },
          requestId: "dev",
          stage: "$default",
        },
        body: await readBody(req),
        isBase64Encoded: false,
      }
      const result = await api(event as never)
      const headers = Object.fromEntries(
        Object.entries(result.headers ?? {}).map(([key, value]) => [key, String(value)]),
      )
      res.writeHead(result.statusCode ?? 200, headers)
      res.end(result.body ?? "")
      if (method !== "OPTIONS") {
        console.log(
          `${method} ${url.pathname}${url.search} → ${result.statusCode} (${Date.now() - started} ms)`,
        )
      }
    } catch (error) {
      console.error(error)
      res.writeHead(500, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          success: false,
          error: { code: "INTERNAL_ERROR", message: "Dev server error" },
        }),
      )
    }
  })
}

/* ------------------------------------------------------------------ */
/* Minimal S3 stand-in (path-style PUT/HEAD/GET/DELETE)                */
/* ------------------------------------------------------------------ */

function s3Server(root: string): http.Server {
  return http.createServer(async (req, res) => {
    // Presigned URLs are not signature-checked locally; this only runs on localhost.
    res.setHeader("access-control-allow-origin", req.headers.origin ?? "*")
    res.setHeader("access-control-allow-methods", "GET,PUT,HEAD,DELETE,OPTIONS")
    res.setHeader("access-control-allow-headers", "content-type,cache-control")
    res.setHeader("access-control-expose-headers", "ETag")
    if (req.method === "OPTIONS") return void res.writeHead(204).end()

    const url = new URL(req.url ?? "/", `http://localhost:${S3_PORT}`)
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)
    if (segments.length < 2) return void res.writeHead(200).end() // bucket-level calls
    const file = resolve(root, ...segments)
    if (!file.startsWith(root + sep)) return void res.writeHead(400).end()
    const meta = `${file}.meta.json`

    try {
      if (req.method === "PUT") {
        await mkdir(dirname(file), { recursive: true })
        await pipeline(req, createWriteStream(file))
        await writeFile(meta, JSON.stringify({ contentType: req.headers["content-type"] ?? "" }))
        return void res.writeHead(200, { etag: `"${Date.now()}"` }).end()
      }
      if (req.method === "DELETE") {
        await rm(file, { force: true })
        await rm(meta, { force: true })
        return void res.writeHead(204).end()
      }
      if (!existsSync(file)) return void res.writeHead(404).end()
      const { size } = await stat(file)
      const { contentType } = JSON.parse(await readFile(meta, "utf8").catch(() => "{}")) as {
        contentType?: string
      }
      const headers: Record<string, string | number> = {
        "content-length": size,
        "content-type": contentType || "application/octet-stream",
      }
      const disposition = url.searchParams.get("response-content-disposition")
      if (disposition) headers["content-disposition"] = disposition
      res.writeHead(200, headers)
      if (req.method === "HEAD") return void res.end()
      await pipeline(createReadStream(file), res)
    } catch (error) {
      console.error("local S3 error", error)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    }
  })
}

/* ------------------------------------------------------------------ */

async function main() {
  await mkdir(join(DATA_DIR, "dynamodb"), { recursive: true })
  await mkdir(join(DATA_DIR, "s3"), { recursive: true })

  const db = dynalite({ path: join(DATA_DIR, "dynamodb"), createTableMs: 0 })
  await listen(db, DB_PORT, "database")

  const config = getConfig()
  if ((await ensureLocalTable(config)) === "created") {
    await seedDemoData(config.defaultUserId)
    console.log("✓ created the local database and loaded the demo data")
  }
  if ((await usersRepository.list()).length === 0) {
    const email = await seedAdminAccount(config.defaultUserId)
    console.log(`✓ created admin login ${email}`)
  }

  const s3 = s3Server(resolve(DATA_DIR, "s3"))
  await listen(s3, S3_PORT, "file storage")
  const server = apiServer()
  await listen(server, API_PORT, "API")

  console.log(`
  IamCandidate API (dev)          http://localhost:${API_PORT}
  Sign in                 demo@example.com / demo123  (admin)
  Data                    ${DATA_DIR}  (npm run dev:reset to start over)
  Frontend                NEXT_PUBLIC_API_MODE=api, NEXT_PUBLIC_API_URL=http://localhost:${API_PORT}
  Google Drive            ${getConfig().google ? "enabled" : "off — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env"}
  Job search (Jooble)     ${getConfig().joobleApiKey ? "enabled" : "off — set JOOBLE_API_KEY in .env"}
  LaTeX compiler          ${process.env.TECTONIC_PATH}
`)

  const shutdown = () => {
    server.close()
    s3.close()
    db.close()
    process.exit(0)
  }
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
