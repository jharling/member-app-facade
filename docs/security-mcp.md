# Security MCP And Deploy-Time Security Smoke Tests

This repo includes a scoped MCP server and CLI for defensive security smoke tests against this microservice. The goal is to make basic security validation part of the normal build/deploy process while keeping the checks bounded to systems we own.

This is intentionally not an exploit framework. It is a guardrail for this project: it validates that the deployed service is reachable, documented, and not exposing a few common response-level risks.

## Components

The implementation lives in `security/`:

- `security/src/scanner.ts`: shared scan engine used by both the CLI and MCP server
- `security/src/toolkit.ts`: additional MCP-only security tools for secrets, dependencies, IaC, containers, ZAP, and release gates
- `security/src/scan.ts`: command-line wrapper for CI and local runs
- `security/src/mcp.ts`: MCP server exposing all security tools
- `security/package.json`: scripts and dependencies

The deploy workflow runs the CLI after Pulumi deploys the service:

- `.github/workflows/deploy.yml`

The scheduled security workflow runs recurring checks outside the deploy path:

- `.github/workflows/security-scheduled.yml`

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

The MCP server wraps the HTTP scanner and additional local security checks as tools. This lets an MCP-capable client run checks interactively, inspect the text summary, and consume JSON findings.

The MCP tool is useful when you want an assistant or local automation client to answer questions like:

- is the current deployed service reachable?
- is Swagger exposed?
- what security findings are currently failing?
- what would block CI at the current severity threshold?
- are there likely secrets, dependency risks, IaC risks, or image scanning gaps?

The MCP server communicates over stdio, so it can be launched by any MCP client that supports local command-based servers.

## MCP Tools

### `security_smoke_test`

Runs the HTTP smoke test against the deployed or local service.

Primary arguments:

- `targetUrl`
- `allowedHosts`
- `failOn`
- `readinessRetries`
- `readinessDelayMs`

### `scan_secrets`

Scans source files for common secret patterns such as AWS keys, private keys, GitHub tokens, and generic token/password assignments.

Primary arguments:

- `repoRoot`
- `failOn`

This is a lightweight built-in scanner. A future improvement should add a mature scanner such as `gitleaks` or `trufflehog`.

### `scan_container_image`

Checks that a local container image exists and, when `trivy` is installed, scans for high and critical vulnerabilities.

Primary arguments:

- `image`, for example `member-app-facade:local`
- `failOn`

Requirements:

- Docker for image inspection
- Optional: `trivy` for vulnerability scanning

If Trivy is missing, the tool returns a medium-severity finding that image CVE scanning was skipped.

### `scan_iac`

Checks the Pulumi infrastructure code for a small set of project-specific IaC controls:

- ECR scan on push is enabled
- CloudWatch log retention is configured
- default public ingress is highlighted
- optional Checkov scan when `checkov` is installed

Primary arguments:

- `repoRoot`
- `failOn`

If Checkov is missing, the tool returns a medium-severity finding that deep IaC scanning was skipped.

### `scan_dependencies`

Runs dependency checks for the repo:

- `npm audit --audit-level=high` in `infra`
- `npm audit --audit-level=high` in `security`
- Gradle dependency graph resolution for the app

Primary arguments:

- `repoRoot`
- `failOn`

### `zap_baseline_scan`

Runs OWASP ZAP baseline mode in a Docker container against an explicitly allowlisted target.

Primary arguments:

- `targetUrl`
- `allowedHosts`
- `failOn`

Requirements:

- Docker
- network access to pull `ghcr.io/zaproxy/zaproxy:stable`

This is intended for non-destructive passive scanning. The target host must be explicitly allowlisted.

### `evaluate_release_gate`

Combines one or more scan results and evaluates whether the release should pass at a given severity threshold.

Primary arguments:

- `scanResultsJson`: JSON array of `ScanResult` objects
- `failOn`

This is useful when an MCP client runs several tools and wants one final pass/fail decision.

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
  --readiness-delay-ms 5000 \
  --sarif security-report.sarif \
  --json-output security-report.json
```

The readiness settings make CI wait up to 3 minutes for `/hello` to return `HTTP 200`. This avoids a common ECS first-deploy race where the service has been created but the new task is not yet accepting traffic on its public IP.

The text report appears in GitHub Actions:

1. Open the repository in GitHub.
2. Go to `Actions`.
3. Open the latest `Deploy` workflow run.
4. Open the `deploy` job.
5. Expand `Run security smoke test`.

The workflow also uploads `security-report.json` and `security-report.sarif` as a GitHub Actions artifact named `security-smoke-test-report`. This artifact contains every finding from the scan, including passing checks.

SARIF is also uploaded using `github/codeql-action/upload-sarif`. The SARIF file includes every finding with SARIF `kind` set to either `pass` or `fail`. Failed findings appear as code scanning alerts in:

1. Open the repository in GitHub.
2. Go to `Security`.
3. Open `Code scanning`.
4. Filter by the `member-app-facade-security-smoke-test` category.

## Scheduled Security Workflow

The scheduled workflow runs daily at `08:00 UTC` and can also be started manually from GitHub Actions.

It runs:

- deployed service smoke scan
- npm audit for `infra`
- npm audit for `security`
- Gradle runtime dependency resolution
- JSON/SARIF report upload as the `scheduled-security-report` artifact
- SARIF upload to GitHub Code Scanning

GitHub path:

```text
Actions -> Scheduled Security Scan
```

Code scanning category:

```text
scheduled-security-smoke-test
```

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

For a JSON report file:

```bash
npm run scan -- \
  --target-url http://127.0.0.1:8080 \
  --json-output security-report.json
```

For SARIF output:

```bash
npm run scan -- \
  --target-url http://127.0.0.1:8080 \
  --sarif security-report.sarif
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
- IaC and dependency checks are intentionally lightweight unless optional tools such as Checkov, Trivy, or ZAP are installed.
- GitHub Code Scanning primarily displays failed SARIF results as alerts. Passing checks are still preserved in the uploaded workflow artifact.
- With `enableLoadBalancer=false`, the ECS task public IP can change when the task is replaced. Pulumi outputs are updated during deploy, but a direct task URL is still not a stable production endpoint.
- The deploy workflow currently waits up to 3 minutes for `/hello` to become ready. Very slow image pulls, networking delays, or ECS replacement events can still exceed that window.

## Improvement Ideas

### Improve Report Persistence

The workflow uploads JSON and SARIF reports as artifacts. Future improvements could also upload a human-readable Markdown summary:

```bash
npm --prefix security run scan -- \
  --target-url "$TARGET_URL" \
  --allow-host "$TARGET_HOST" \
  --fail-on high \
  --readiness-retries 36 \
  --readiness-delay-ms 5000 \
  --json-output security-report.json \
  --sarif security-report.sarif
```

Then generate `security-report.md` from the JSON and upload all three files.

### Improve SARIF Locations

The current SARIF file anchors findings to `security/src/scanner.ts`, because the findings are runtime deployment checks rather than source-code line findings. A future improvement could map each finding to a more useful file, such as:

- `infra/index.ts` for AWS exposure or HTTP findings
- `src/main/resources/application.properties` for server configuration findings
- controller source files for route-specific findings

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

### Deepen Dependency And Container Scanning

The MCP now has lightweight dependency and container-image tools. Future improvements could make them deeper by adding:

- Gradle dependency vulnerability checks
- mandatory Trivy scanning in CI
- ECR scan result checks after image push
- SBOM generation and retention

### Automate ZAP Baseline Scanning In CI

The MCP includes `zap_baseline_scan`, but the deploy workflow does not run it by default because it pulls and runs the ZAP container and can add time to every deployment. A future improvement could run it on a schedule, before release tags, or only for staging/prod environments.

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
