# Deployment (AWS SAM)

Everything is created by `template.yaml` — nothing is set up by hand in the console.

| Resource                                            | Notes                                                                                                                                                          |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API Gateway HTTP API                                | 82 explicit routes, CORS for `AllowedOrigins`, throttling (25 rps / burst 50), JSON access logs                                                                |
| 6 Lambda functions                                  | Node.js 22, arm64, esbuild-bundled, one per domain (see README)                                                                                                |
| DynamoDB table `personal-os-<stage>`                | On-demand, PITR on, TTL on `ttl`, **retained** on stack delete                                                                                                 |
| S3 bucket `personal-os-documents-<account>-<stage>` | Private (all public access blocked, bucket-owner-enforced), SSE-S3, TLS-only policy, CORS for presigned PUT/GET, **retained** on stack delete                  |
| IAM roles                                           | One per function, least privilege: only the DynamoDB actions that function calls on this table; S3 Put/Get/Delete on `users/*` for the documents function only |
| CloudWatch log groups                               | One per function plus API access logs, `LogRetentionDays` (default 30)                                                                                         |

Region: **ap-south-1 (Mumbai)**, set in `samconfig.toml`.

## Prerequisites

- AWS account and credentials configured (`aws configure` or `AWS_PROFILE`). Never commit keys.
- SAM CLI and Node.js 22. Docker is **not** required to build: SAM bundles with esbuild.
  `npm run build` runs `sam build` with the project's esbuild on PATH; a bare `sam build`
  needs esbuild installed globally.

## First deploy

```bash
cd iamcandidate-server
npm install
npm run validate          # sam validate --lint
npm run build             # sam build
sam deploy --guided
```

Answer the prompts:

| Prompt                                                                 | Suggested                                                                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Stack name                                                             | `personal-os-dev`                                                                                                               |
| Region                                                                 | `ap-south-1`                                                                                                                    |
| Parameter `Stage`                                                      | `dev`                                                                                                                           |
| Parameter `AllowedOrigins`                                             | your frontend origin(s), comma-separated, e.g. `https://iamcandidate.example.com,http://localhost:3000`                                 |
| Parameter `AuthSecret`                                                 | 32+ random characters: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`                         |
| Parameter `EncryptionKey`                                              | Another 32+ random characters (encrypts users' SMTP passwords). Keep it safe: changing it makes saved SMTP passwords unreadable |
| Parameters `GoogleClientId`, `GoogleClientSecret`, `GoogleRedirectUri` | Optional, for Google Drive — see [google-drive.md](google-drive.md). Leave empty to disable                                     |
| Parameter `JoobleApiKey`                                               | Optional, for job search (request a key at https://jooble.org/api/about). Leave empty to search company job boards only        |
| Parameter `DefaultUserId`                                              | keep `usr_demo`                                                                                                                 |
| Confirm changes before deploy                                          | `y`                                                                                                                             |
| Allow SAM CLI IAM role creation                                        | `y`                                                                                                                             |
| Save arguments to samconfig.toml                                       | `y`                                                                                                                             |

The outputs include `ApiUrl`. Point the frontend at it:

```bash
# iamcandidate-ui/.env.local (or your hosting provider's env settings)
NEXT_PUBLIC_API_MODE=api
NEXT_PUBLIC_API_URL=https://<api-id>.execute-api.ap-south-1.amazonaws.com
```

`NEXT_PUBLIC_*` values are inlined at build time — rebuild the frontend after changing them.

Optionally load demo data into the deployed table (uses your AWS credentials):

```bash
DYNAMODB_TABLE=personal-os-dev DYNAMODB_ENDPOINT= S3_BUCKET=unused npm run seed
```

## LaTeX compiler image

`LatexFunction` is a container image, so `sam build` needs **Docker running** for it (the other
functions build without Docker). `sam deploy --guided` offers to create an ECR repository for
the image — answer yes. See [latex.md](latex.md).

## Create the first admin

A fresh table has no accounts. Create one with your AWS credentials:

```bash
DYNAMODB_TABLE=personal-os-dev DYNAMODB_ENDPOINT= S3_BUCKET=unused \
  npm run create-user -- --email you@example.com --name "Your Name" --role admin
```

(or run `npm run seed`, which creates `demo@example.com` / `demo123` — change that password
right after). Further users are added in the app under **System → Users**.

## Subsequent deploys

```bash
npm run build && sam deploy                  # dev (samconfig default)
npm run build && sam deploy --config-env prod
```

Set the real frontend origin in `[prod.deploy.parameters]` of `samconfig.toml` first. Never
use `*` for `AllowedOrigins` in production.

## CORS

The same `AllowedOrigins` list is applied to API Gateway (preflight + response headers)
and to the S3 bucket (browser PUT/GET on presigned URLs). API Gateway ignores CORS headers
returned by Lambda when CORS is configured, so the template is the single source of truth.

## Security notes

- Users' SMTP passwords are encrypted (AES-256-GCM) with `EncryptionKey` and never returned by
  the API. For stricter setups, swap `src/lib/secrets.ts` to AWS KMS.
- The communication function only connects to public SMTP hosts and has a 30 s timeout.
  Lambda blocks outbound port 25, so use 587 or 465.

- No AWS credentials exist in code or config; Lambda uses its execution role.
- The bucket is never public. Files are reached only through 5-minute presigned URLs issued
  for the caller's own `users/<userId>/` prefix.
- Errors returned to clients never include AWS error details; full errors go to CloudWatch.
- Authentication is built in: scrypt password hashes, rolling HS256 session tokens (365 days,
  refreshed daily by the clients) signed with `AuthSecret`, and an account check on every
  request. Keep `AuthSecret` out of git; non-guided
  `sam deploy` needs `--parameter-overrides AuthSecret=...` (or a local, untracked samconfig).
  Changing it signs everyone out.
- Login is rate-limited only by the API's global throttling; add AWS WAF rate rules if the API
  is public.

## Tear down

```bash
sam delete --stack-name personal-os-dev
```

The table and bucket are retained to protect data; delete them manually if you really want
them gone (empty the bucket first).

## Cost (rough, low traffic)

Everything is pay-per-use: Lambda and HTTP API requests, on-demand DynamoDB, S3 storage.
A personal workload typically stays within or near the free tier. There is no EC2, NAT
gateway or other always-on resource.
