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

function header(response: Response, name: string): string | null {
    return response.headers.get(name);
}

export async function scanTarget(options: ScanOptions): Promise<ScanResult> {
    const failOn = options.failOn ?? "medium";
    const baseUrl = normalizeBaseUrl(options.targetUrl);
    const allowedHosts = options.allowedHosts?.length
        ? [...defaultAllowedHosts, ...options.allowedHosts]
        : defaultAllowedHosts;

    assertAllowedTarget(baseUrl, allowedHosts);

    const findings: Finding[] = [];
    const helloUrl = new URL("/hello", baseUrl);
    const swaggerUrl = new URL("/swagger-ui.html", baseUrl);
    const apiDocsUrl = new URL("/v3/api-docs", baseUrl);

    let hello: Response;
    try {
        hello = await get(helloUrl);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        findings.push({
            id: "TARGET-REACHABLE",
            severity: "high",
            passed: false,
            title: "Target service is reachable",
            detail: `GET ${helloUrl.href} failed: ${detail}.`,
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
        detail: `GET ${helloUrl.href} returned HTTP ${hello.status}.`,
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
