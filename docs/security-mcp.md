# Security MCP And Deploy-Time Security Smoke Tests

This repo includes a scoped MCP server and CLI for defensive security smoke tests against this microservice. The goal is to make basic security validation part of the normal build/deploy process while keeping the checks bounded to systems we own.

This is intentionally not an exploit framework. It is a guardrail for this project: it validates that the deployed service is reachable, documented, and not exposing a few common response-level risks.

## Components

The implementation lives in `security/`:

- `security/src/scanner.ts`: shared scan engine used by both the CLI and MCP server
- `security/src/scan.ts`: command-line wrapper for CI and local runs
- `security/src/mcp.ts`: MCP server exposing the `security_smoke_test` tool
- `security/package.json`: scripts and dependencies

The deploy workflow runs the CLI after Pulumi deploys the service:

- `.github/workflows/deploy.yml`

The scanner target comes from Pulumi output:

```bash
pulumi stack output serviceBaseUrl --cwd infra
```

That means every deployment tests the actual URL that Pulumi believes is current.

## What It Checks

- `GET /hello` is reachable
- `GET /hello` returns the expected response body
- Swagger UI is reachable
- `/v3/api-docs` returns a valid OpenAPI document
- `GET /hello` is documented in OpenAPI
- common information-disclosure headers are absent:
  - `Server`
  - `X-Powered-By`
- HTTPS is used for non-local targets

Each check produces a finding with:

- `id`
- `severity`
- pass/fail result
- detail
- recommendation when applicable

Severity values are:

```text
info
low
medium
high
```

The current GitHub Actions gate uses:

```bash
--fail-on high
```

This keeps the low-cost ECS deployment from failing only because it uses direct HTTP to the task public IP. The scanner still reports that as a `medium` finding so it is visible.

## How It Works

The scanner accepts a base target URL and builds the specific paths it needs:

```text
<base-url>/hello
<base-url>/swagger-ui.html
<base-url>/v3/api-docs
```

It then performs simple HTTP requests and evaluates the response status, body, headers, and OpenAPI content.

For safety, non-local targets must be explicitly allowlisted. Localhost is allowed by default:

```text
localhost
127.0.0.1
::1
```

For a deployed ECS task or load balancer, the caller must pass:

```bash
--allow-host <host-or-ip>
```

The GitHub workflow does this automatically:

```bash
TARGET_URL="$(pulumi stack output serviceBaseUrl --cwd infra)"
TARGET_HOST="$(node -e "console.log(new URL(process.argv[1]).hostname)" "$TARGET_URL")"
```

Then it passes the extracted host to the scanner:

```bash
--allow-host "$TARGET_HOST"
```

## MCP Server

The MCP server wraps the same scanner logic in a tool named `security_smoke_test`. This lets an MCP-capable client run the scan interactively, inspect the text summary, and consume the JSON findings.

The MCP tool is useful when you want an assistant or local automation client to answer questions like:

- is the current deployed service reachable?
- is Swagger exposed?
- what security findings are currently failing?
- what would block CI at the current severity threshold?

The MCP server communicates over stdio, so it can be launched by any MCP client that supports local command-based servers.

## CI Usage

The deploy workflow runs the CLI after `pulumi up`:

```bash
TARGET_URL="$(pulumi stack output serviceBaseUrl --cwd infra)"
TARGET_HOST="$(node -e "console.log(new URL(process.argv[1]).hostname)" "$TARGET_URL")"
npm --prefix security run scan -- \
  --target-url "$TARGET_URL" \
  --allow-host "$TARGET_HOST" \
  --fail-on high \
  --readiness-retries 36 \
  --readiness-delay-ms 5000
```

The readiness settings make CI wait up to 3 minutes for `/hello` to return `HTTP 200`. This avoids a common ECS first-deploy race where the service has been created but the new task is not yet accepting traffic on its public IP.

The CI report appears in GitHub Actions:

1. Open the repository in GitHub.
2. Go to `Actions`.
3. Open the latest `Deploy` workflow run.
4. Open the `deploy` job.
5. Expand `Run security smoke test`.

The text report is printed directly in the logs.

## Local CLI Usage

```bash
cd security
npm install
npm run build
npm run scan -- --target-url http://127.0.0.1:8080
```

For JSON output:

```bash
npm run scan -- \
  --target-url http://127.0.0.1:8080 \
  --json
```

For a deployed ECS task:

```bash
npm run scan -- \
  --target-url http://32.194.175.78:8080 \
  --allow-host 32.194.175.78 \
  --fail-on high \
  --readiness-retries 36 \
  --readiness-delay-ms 5000
```

## MCP Usage

Start the MCP server:

```bash
cd security
npm run build
npm run mcp
```

MCP tool:

```text
security_smoke_test
```

Tool arguments:

```json
{
  "targetUrl": "http://127.0.0.1:8080",
  "allowedHosts": [],
  "failOn": "medium",
  "readinessRetries": 30,
  "readinessDelayMs": 5000
}
```

For non-local targets, pass the exact host or IP in `allowedHosts`.

## Current Limitations

The current scanner is intentionally shallow. It is a security smoke test, not a full penetration test.

Current limitations:

- It only checks a few known URLs.
- It does not crawl the application.
- It does not authenticate.
- It does not perform destructive tests.
- It does not fuzz request parameters.
- It does not validate AWS-side controls such as security group rules, IAM policies, or ECS task role permissions.
- It does not currently produce a persisted artifact in GitHub Actions.
- With `enableLoadBalancer=false`, the ECS task public IP can change when the task is replaced. Pulumi outputs are updated during deploy, but a direct task URL is still not a stable production endpoint.
- The deploy workflow currently waits up to 3 minutes for `/hello` to become ready. Very slow image pulls, networking delays, or ECS replacement events can still exceed that window.

## Improvement Ideas

### Persist Reports In CI

Write JSON and text reports to files and upload them as GitHub Actions artifacts:

```bash
npm --prefix security run scan -- \
  --target-url "$TARGET_URL" \
  --allow-host "$TARGET_HOST" \
  --fail-on high \
  --readiness-retries 36 \
  --readiness-delay-ms 5000 \
  --json > security-report.json
```

Then use `actions/upload-artifact` to retain reports per workflow run.

### Add SARIF Output

Add a SARIF formatter so findings appear in GitHub's `Security` tab as code scanning alerts. This would make failed checks easier to track over time.

### Add OpenAPI-Driven Tests

Use `/v3/api-docs` to discover every documented endpoint and check:

- every operation responds with an expected status
- every operation has a summary/description
- error responses are documented
- endpoints do not return stack traces or framework errors

### Add Security Header Policy

Create a configurable policy for headers such as:

- `Content-Security-Policy`
- `X-Content-Type-Options`
- `Referrer-Policy`
- `Cache-Control`
- `Strict-Transport-Security` for HTTPS targets

Some of these are more relevant once the service is behind a load balancer or serving browser-facing content.

### Add AWS Configuration Checks

Add a separate AWS posture check that uses AWS APIs to validate:

- ECS service desired count
- task public IP exposure
- security group ingress scope
- CloudWatch log retention
- ECR image scanning
- IAM role permissions
- whether an ALB is enabled for stable HTTPS

These checks should be separate from HTTP scanning because they evaluate infrastructure, not the running web service.

### Add Dependency And Container Scanning

Integrate tools such as:

- Gradle dependency vulnerability checks
- npm audit for the `infra` and `security` packages
- container image scanning before push
- ECR scan result checks after image push

### Add ZAP Baseline Scanning

For a broader dynamic scan, add OWASP ZAP baseline mode against the deployed URL. Keep it non-destructive and scoped to the project URL. ZAP would complement this MCP by providing broader passive checks.

### Add Environments And Thresholds

Use different gates by environment:

```text
dev:     fail on high
stage:   fail on medium
prod:    fail on medium or selected lows
```

This lets early development stay flexible while production becomes stricter.

### Add Authentication Support

If the microservice later requires auth, add support for:

- bearer tokens
- API keys
- signed headers
- test users from GitHub secrets

Secrets should be injected by CI and never committed.

## Safe-Use Rules

- Only run against systems you own or have explicit permission to test.
- Keep the allowlist narrow.
- Avoid destructive checks in the deploy pipeline.
- Fail builds on clear, actionable findings.
- Report lower-severity risks without blocking early development unless the team intentionally raises the threshold.
