/**
 * Runtime configuration, read from the environment. Locally the values come
 * from `env.local.json` (SAM) or `.env` (scripts); in AWS they are set by
 * template.yaml. Empty strings mean "use the AWS default".
 */
export interface Config {
  stage: string
  region: string
  tableName: string
  bucketName: string
  /** Public-read bucket for portfolio images (uploads are off when unset). */
  portfolioBucketName: string | undefined
  /** Base URL those images are served from, e.g. https://<bucket>.s3.<region>.amazonaws.com. */
  portfolioAssetsUrl: string | undefined
  dynamodbEndpoint: string | undefined
  s3Endpoint: string | undefined
  s3PublicEndpoint: string | undefined
  allowedOrigins: string[]
  defaultUserId: string
  /**
   * HMAC secret for session tokens. When unset (unit tests only) the API runs
   * in open mode as `defaultUserId`; template.yaml always sets it.
   */
  authSecret: string | undefined
  /** Key material for encrypting stored secrets (SMTP passwords). */
  dataEncryptionKey: string | undefined
  /** Lets SMTP hosts resolve to private/loopback addresses (local test servers only). */
  allowPrivateSmtpHosts: boolean
  /** Google OAuth client for the Drive integration (feature is off when unset). */
  google: { clientId: string; clientSecret: string; redirectUri: string } | undefined
  /** Jooble key for job search (that source is off when unset). */
  joobleApiKey: string | undefined
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

function required(name: string): string {
  const value = optional(name)
  if (!value) throw new Error(`Missing required environment variable ${name}`)
  return value
}

function googleConfig(): Config["google"] {
  const clientId = optional("GOOGLE_CLIENT_ID")
  const clientSecret = optional("GOOGLE_CLIENT_SECRET")
  const redirectUri = optional("GOOGLE_REDIRECT_URI")
  return clientId && clientSecret && redirectUri
    ? { clientId, clientSecret, redirectUri }
    : undefined
}

let cached: Config | undefined

export function getConfig(): Config {
  if (cached) return cached
  cached = {
    stage: optional("STAGE") ?? "local",
    region: optional("AWS_REGION") ?? "ap-south-1",
    tableName: required("DYNAMODB_TABLE"),
    bucketName: required("S3_BUCKET"),
    portfolioBucketName: optional("PORTFOLIO_BUCKET"),
    portfolioAssetsUrl: optional("PORTFOLIO_ASSETS_URL")?.replace(/\/+$/, ""),
    dynamodbEndpoint: optional("DYNAMODB_ENDPOINT"),
    s3Endpoint: optional("S3_ENDPOINT"),
    s3PublicEndpoint: optional("S3_PUBLIC_ENDPOINT") ?? optional("S3_ENDPOINT"),
    allowedOrigins: (optional("ALLOWED_ORIGINS") ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    defaultUserId: optional("DEFAULT_USER_ID") ?? "usr_demo",
    authSecret: optional("AUTH_SECRET"),
    dataEncryptionKey: optional("DATA_ENCRYPTION_KEY"),
    allowPrivateSmtpHosts: optional("ALLOW_PRIVATE_SMTP_HOSTS") === "true",
    google: googleConfig(),
    joobleApiKey: optional("JOOBLE_API_KEY"),
  }
  return cached
}

/** Test hook: forget cached config after changing process.env. */
export function resetConfig() {
  cached = undefined
}
