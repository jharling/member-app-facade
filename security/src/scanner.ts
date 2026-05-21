export type Severity = "info" | "low" | "medium" | "high";

export interface Finding {
    id: string;
    severity: Severity;
    passed: boolean;
    title: string;
    detail: string;
    recommendation?: string;
}

export interface ScanOptions {
    targetUrl: string;
    failOn?: Severity;
    allowedHosts?: string[];
    readinessRetries?: number;
    readinessDelayMs?: number;
}

export interface ScanResult {
    targetUrl: string;
    checkedAt: string;
    passed: boolean;
    failOn: Severity;
    findings: Finding[];
}

const severityRank: Record<Severity, number> = {
    info: 0,
    low: 1,
    medium: 2,
    high: 3,
};

const defaultAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
];

const defaultReadinessRetries = 30;
const defaultReadinessDelayMs = 5000;

function normalizeBaseUrl(targetUrl: string): URL {
    const url = new URL(targetUrl);
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url;
}

function assertAllowedTarget(url: URL, allowedHosts: string[]): void {
    if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error(`Only http and https targets are allowed. Received: ${url.protocol}`);
    }

    if (!allowedHosts.includes(url.hostname)) {
        throw new Error([
            `Target host '${url.hostname}' is not in the allowed host list.`,
            `Allowed hosts: ${allowedHosts.join(", ")}`,
            "Pass --allow-host for deployed ECS task IPs or load balancer hosts.",
        ].join(" "));
    }
}

async function get(url: URL): Promise<Response> {
    return fetch(url, {
        method: "GET",
        redirect: "manual",
        headers: {
            "user-agent": "member-app-facade-security-smoke-test/0.1.0",
        },
    });
}

function sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function header(response: Response, name: string): string | null {
    return response.headers.get(name);
}

function operationEntries(apiDocs: any): Array<{ method: string; path: string; operation: any }> {
    const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
    const paths = apiDocs?.paths ?? {};

    return Object.entries(paths).flatMap(([path, pathItem]: [string, any]) => {
        return Object.entries(pathItem ?? {})
            .filter(([method]) => methods.has(method.toLowerCase()))
            .map(([method, operation]) => ({
                method: method.toUpperCase(),
                path,
                operation,
            }));
    });
}

function concretePath(openApiPath: string): string | undefined {
    if (openApiPath.includes("{")) {
        return undefined;
    }

    return openApiPath.startsWith("/") ? openApiPath : `/${openApiPath}`;
}

async function request(method: string, url: URL): Promise<Response> {
    return fetch(url, {
        method,
        redirect: "manual",
        headers: {
            "user-agent": "member-app-facade-security-smoke-test/0.1.0",
        },
    });
}

export async function scanTarget(options: ScanOptions): Promise<ScanResult> {
    const failOn = options.failOn ?? "medium";
    const readinessRetries = options.readinessRetries ?? defaultReadinessRetries;
    const readinessDelayMs = options.readinessDelayMs ?? defaultReadinessDelayMs;
    const baseUrl = normalizeBaseUrl(options.targetUrl);
    const allowedHosts = options.allowedHosts?.length
        ? [...defaultAllowedHosts, ...options.allowedHosts]
        : defaultAllowedHosts;

    assertAllowedTarget(baseUrl, allowedHosts);

    const findings: Finding[] = [];
    const helloUrl = new URL("/hello", baseUrl);
    const swaggerUrl = new URL("/swagger-ui.html", baseUrl);
    const apiDocsUrl = new URL("/v3/api-docs", baseUrl);

    let hello: Response | undefined;
    let lastReadinessDetail = "not attempted";

    for (let attempt = 1; attempt <= readinessRetries; attempt += 1) {
        try {
            const response = await get(helloUrl);
            lastReadinessDetail = `attempt ${attempt}/${readinessRetries} returned HTTP ${response.status}`;

            if (response.status === 200) {
                hello = response;
                break;
            }
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            lastReadinessDetail = `attempt ${attempt}/${readinessRetries} failed: ${detail}`;
        }

        if (attempt < readinessRetries) {
            await sleep(readinessDelayMs);
        }
    }

    if (!hello) {
        findings.push({
            id: "TARGET-REACHABLE",
            severity: "high",
            passed: false,
            title: "Target service is reachable",
            detail: `GET ${helloUrl.href} did not become ready after ${readinessRetries} attempts with ${readinessDelayMs}ms delay. Last result: ${lastReadinessDetail}.`,
            recommendation: "Confirm the ECS task is running, the public IP is current, security group ingress allows port 8080, and the service is listening.",
        });

        return {
            targetUrl: baseUrl.href.replace(/\/$/, ""),
            checkedAt: new Date().toISOString(),
            passed: false,
            failOn,
            findings,
        };
    }

    const helloBody = await hello.text();

    findings.push({
        id: "HELLO-STATUS",
        severity: "high",
        passed: hello.status === 200,
        title: "Hello endpoint is reachable",
        detail: `GET ${helloUrl.href} returned HTTP ${hello.status} after readiness wait. Last readiness result: ${lastReadinessDetail}.`,
        recommendation: "Confirm the ECS service is running, the task security group allows the expected source, and the container listens on port 8080.",
    });

    findings.push({
        id: "HELLO-BODY",
        severity: "medium",
        passed: helloBody.trim() === "Hello, World!",
        title: "Hello endpoint returns expected body",
        detail: `GET ${helloUrl.href} returned ${JSON.stringify(helloBody.trim())}.`,
        recommendation: "Confirm the deployed image contains the expected application version.",
    });

    const swagger = await get(swaggerUrl);
    findings.push({
        id: "SWAGGER-REACHABLE",
        severity: "medium",
        passed: swagger.status === 200 || swagger.status === 302,
        title: "Swagger UI is reachable",
        detail: `GET ${swaggerUrl.href} returned HTTP ${swagger.status}.`,
        recommendation: "Confirm springdoc is enabled for the deployed environment if Swagger should be available.",
    });

    const apiDocs = await get(apiDocsUrl);
    let apiDocsJson: any;
    try {
        apiDocsJson = await apiDocs.json();
    } catch {
        apiDocsJson = undefined;
    }

    findings.push({
        id: "OPENAPI-REACHABLE",
        severity: "medium",
        passed: apiDocs.status === 200 && apiDocsJson?.openapi,
        title: "OpenAPI document is reachable",
        detail: `GET ${apiDocsUrl.href} returned HTTP ${apiDocs.status}.`,
        recommendation: "Confirm /v3/api-docs is enabled and returns a valid OpenAPI document.",
    });

    findings.push({
        id: "OPENAPI-HELLO-DOCUMENTED",
        severity: "low",
        passed: Boolean(apiDocsJson?.paths?.["/hello"]?.get),
        title: "Hello endpoint is documented in OpenAPI",
        detail: "The OpenAPI document should include GET /hello.",
        recommendation: "Add or fix OpenAPI annotations if the endpoint is missing from the generated spec.",
    });

    if (apiDocsJson?.paths) {
        const operations = operationEntries(apiDocsJson);

        findings.push({
            id: "OPENAPI-OPERATIONS-DISCOVERED",
            severity: "info",
            passed: operations.length > 0,
            title: "OpenAPI declares at least one operation",
            detail: `Discovered ${operations.length} documented operation(s).`,
            recommendation: "Document all externally reachable endpoints in OpenAPI.",
        });

        for (const { method, path, operation } of operations) {
            const operationId = `OPENAPI-${method}-${path.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toUpperCase()}`;
            const summary = operation?.summary ?? operation?.description;
            const responses = operation?.responses ?? {};
            const hasSuccessResponse = Object.keys(responses).some((status) => /^2\d\d$/.test(status));
            const hasErrorResponse = Object.keys(responses).some((status) => /^[45]\d\d$/.test(status));

            findings.push({
                id: `${operationId}-SUMMARY`,
                severity: "low",
                passed: Boolean(summary),
                title: `${method} ${path} has summary or description`,
                detail: summary ? `Summary/description is present for ${method} ${path}.` : `Summary/description is missing for ${method} ${path}.`,
                recommendation: "Add a short summary or description for each OpenAPI operation.",
            });

            findings.push({
                id: `${operationId}-RESPONSES`,
                severity: "low",
                passed: hasSuccessResponse && hasErrorResponse,
                title: `${method} ${path} documents success and error responses`,
                detail: `Documented response statuses for ${method} ${path}: ${Object.keys(responses).join(", ") || "none"}.`,
                recommendation: "Document at least one 2xx response and one 4xx/5xx response for each operation.",
            });

            const runnablePath = concretePath(path);
            if (method === "GET" && runnablePath) {
                try {
                    const response = await request("GET", new URL(runnablePath, baseUrl));
                    const body = await response.text();
                    findings.push({
                        id: `${operationId}-GET-RUNTIME`,
                        severity: "medium",
                        passed: response.status < 500,
                        title: `${method} ${path} does not return a server error`,
                        detail: `GET ${runnablePath} returned HTTP ${response.status}.`,
                        recommendation: "Fix unexpected 5xx responses for documented GET endpoints.",
                    });
                    findings.push({
                        id: `${operationId}-NO-STACKTRACE`,
                        severity: "medium",
                        passed: !/(Exception|Traceback|stack trace|at\s+[\w.$]+\()/i.test(body),
                        title: `${method} ${path} does not expose stack traces`,
                        detail: `GET ${runnablePath} response body length was ${body.length} bytes.`,
                        recommendation: "Return sanitized error responses and keep stack traces in server logs only.",
                    });
                } catch (error) {
                    const detail = error instanceof Error ? error.message : String(error);
                    findings.push({
                        id: `${operationId}-GET-RUNTIME`,
                        severity: "medium",
                        passed: false,
                        title: `${method} ${path} is reachable for safe GET test`,
                        detail: `GET ${runnablePath} failed: ${detail}.`,
                        recommendation: "Confirm documented GET endpoints are reachable or remove stale OpenAPI operations.",
                    });
                }
            } else {
                findings.push({
                    id: `${operationId}-RUNTIME-SKIPPED`,
                    severity: "info",
                    passed: true,
                    title: `${method} ${path} runtime test skipped`,
                    detail: runnablePath
                        ? `Runtime test skipped for ${method} because only GET operations are exercised automatically.`
                        : `Runtime test skipped because ${path} contains path parameters and no test values are configured.`,
                    recommendation: "Add configured test examples before automatically exercising parameterized or state-changing operations.",
                });
            }
        }
    }

    findings.push({
        id: "NO-SERVER-HEADER",
        severity: "low",
        passed: !header(hello, "server"),
        title: "Server header is not exposed",
        detail: `Server header: ${header(hello, "server") ?? "not present"}.`,
        recommendation: "Avoid exposing server implementation details in HTTP headers.",
    });

    findings.push({
        id: "NO-X-POWERED-BY",
        severity: "low",
        passed: !header(hello, "x-powered-by"),
        title: "X-Powered-By header is not exposed",
        detail: `X-Powered-By header: ${header(hello, "x-powered-by") ?? "not present"}.`,
        recommendation: "Remove framework-identifying headers from production responses.",
    });

    if (baseUrl.protocol === "http:") {
        findings.push({
            id: "HTTPS",
            severity: "medium",
            passed: baseUrl.hostname === "localhost" || baseUrl.hostname === "127.0.0.1",
            title: "HTTPS is used outside local development",
            detail: `Target uses ${baseUrl.protocol}.`,
            recommendation: "Use HTTPS through an application load balancer, API Gateway, CloudFront, or another TLS termination layer for internet-facing environments.",
        });
    }

    if (baseUrl.protocol === "https:") {
        findings.push({
            id: "HSTS",
            severity: "low",
            passed: Boolean(header(hello, "strict-transport-security")),
            title: "HSTS header is present for HTTPS target",
            detail: `Strict-Transport-Security header: ${header(hello, "strict-transport-security") ?? "not present"}.`,
            recommendation: "Add Strict-Transport-Security for HTTPS production endpoints.",
        });
    }

    const passed = findings.every((finding) => {
        return finding.passed || severityRank[finding.severity] < severityRank[failOn];
    });

    return {
        targetUrl: baseUrl.href.replace(/\/$/, ""),
        checkedAt: new Date().toISOString(),
        passed,
        failOn,
        findings,
    };
}

export function formatScanResult(result: ScanResult): string {
    const lines = [
        `Security smoke test for ${result.targetUrl}`,
        `Checked at: ${result.checkedAt}`,
        `Fail threshold: ${result.failOn}`,
        `Result: ${result.passed ? "PASS" : "FAIL"}`,
        "",
    ];

    for (const finding of result.findings) {
        lines.push(`${finding.passed ? "PASS" : "FAIL"} [${finding.severity}] ${finding.id}: ${finding.title}`);
        lines.push(`  ${finding.detail}`);
        if (!finding.passed && finding.recommendation) {
            lines.push(`  Recommendation: ${finding.recommendation}`);
        }
    }

    return lines.join("\n");
}
