# Security MCP

This repo includes a scoped MCP server and CLI for defensive security smoke tests against this microservice.

## What It Checks

- `/hello` is reachable and returns the expected response
- Swagger UI is reachable
- `/v3/api-docs` returns an OpenAPI document
- `GET /hello` is documented in OpenAPI
- common information-disclosure headers are absent
- HTTPS is used for non-local targets

This is intentionally not an exploit framework. It is a build/deploy guardrail for this project.

## CI Usage

The deploy workflow runs the CLI after `pulumi up`:

```bash
TARGET_URL="$(pulumi stack output serviceBaseUrl --cwd infra)"
TARGET_HOST="$(node -e "console.log(new URL(process.argv[1]).hostname)" "$TARGET_URL")"
npm --prefix security run scan -- \
  --target-url "$TARGET_URL" \
  --allow-host "$TARGET_HOST" \
  --fail-on high
```

## Local CLI Usage

```bash
cd security
npm install
npm run build
npm run scan -- --target-url http://127.0.0.1:8080
```

For a deployed ECS task:

```bash
npm run scan -- \
  --target-url http://32.194.175.78:8080 \
  --allow-host 32.194.175.78 \
  --fail-on high
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
  "failOn": "medium"
}
```

For non-local targets, pass the exact host or IP in `allowedHosts`.
