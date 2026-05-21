import { execFileSync } from "child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, relative, resolve } from "path";
import { Finding, ScanResult, Severity } from "./scanner.js";

export interface ToolOptions {
    failOn?: Severity;
}

const severityRank: Record<Severity, number> = {
    info: 0,
    low: 1,
    medium: 2,
    high: 3,
};

const excludedDirectories = new Set([
    ".git",
    ".gradle",
    ".idea",
    "build",
    "bin",
    "node_modules",
    "lib",
    "out",
]);

function isFailure(finding: Finding, failOn: Severity): boolean {
    return !finding.passed && severityRank[finding.severity] >= severityRank[failOn];
}

function result(name: string, findings: Finding[], failOn: Severity): ScanResult {
    return {
        targetUrl: name,
        checkedAt: new Date().toISOString(),
        failOn,
        passed: !findings.some((finding) => isFailure(finding, failOn)),
        findings,
    };
}

function commandExists(command: string): boolean {
    try {
        execFileSync("which", [command], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

function run(command: string, args: string[], cwd: string): { status: number; output: string } {
    try {
        const output = execFileSync(command, args, {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        return { status: 0, output };
    } catch (error: any) {
        const stdout = error.stdout ? error.stdout.toString() : "";
        const stderr = error.stderr ? error.stderr.toString() : "";
        return {
            status: error.status ?? 1,
            output: `${stdout}${stderr}`.trim(),
        };
    }
}

function listFiles(root: string): string[] {
    const files: string[] = [];

    function visit(directory: string): void {
        for (const entry of readdirSync(directory)) {
            const fullPath = join(directory, entry);
            const relativePath = relative(root, fullPath);
            const stats = statSync(fullPath);

            if (stats.isDirectory()) {
                if (!excludedDirectories.has(entry)) {
                    visit(fullPath);
                }
                continue;
            }

            if (stats.isFile()) {
                files.push(relativePath);
            }
        }
    }

    visit(root);
    return files;
}

export function scanSecrets(repoRoot: string, options: ToolOptions = {}): ScanResult {
    const failOn = options.failOn ?? "high";
    const root = resolve(repoRoot);
    const secretPatterns: Array<{ id: string; severity: Severity; title: string; pattern: RegExp }> = [
        { id: "AWS-ACCESS-KEY", severity: "high", title: "Potential AWS access key", pattern: /AKIA[0-9A-Z]{16}/ },
        { id: "AWS-SECRET-LIKE", severity: "high", title: "Potential AWS secret assignment", pattern: /aws_secret_access_key\s*=\s*['"]?[A-Za-z0-9/+=]{30,}/i },
        { id: "PRIVATE-KEY", severity: "high", title: "Private key material", pattern: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
        { id: "GITHUB-TOKEN", severity: "high", title: "Potential GitHub token", pattern: /gh[pousr]_[A-Za-z0-9_]{20,}/ },
        { id: "GENERIC-TOKEN", severity: "medium", title: "Potential hard-coded token", pattern: /(api[_-]?key|token|secret|password)\s*[:=]\s*['"][^'"]{12,}['"]/i },
    ];
    const findings: Finding[] = [];

    for (const file of listFiles(root)) {
        if (!/\.(gradle|groovy|java|json|md|properties|ts|yaml|yml|xml|txt|Dockerfile)$|(^|\/)Dockerfile$/.test(file)) {
            continue;
        }

        const content = readFileSync(join(root, file), "utf8");
        for (const secretPattern of secretPatterns) {
            if (secretPattern.pattern.test(content)) {
                findings.push({
                    id: secretPattern.id,
                    severity: secretPattern.severity,
                    passed: false,
                    title: secretPattern.title,
                    detail: `Pattern matched in ${file}.`,
                    recommendation: "Remove the secret from source control, rotate it if it was real, and use GitHub Actions secrets or a secrets manager.",
                });
            }
        }
    }

    if (findings.length === 0) {
        findings.push({
            id: "SECRETS-NOT-DETECTED",
            severity: "info",
            passed: true,
            title: "No obvious secrets detected",
            detail: "Built-in secret patterns did not match scanned source files.",
        });
    }

    return result("scan_secrets", findings, failOn);
}

export function scanContainerImage(image: string, options: ToolOptions = {}): ScanResult {
    const failOn = options.failOn ?? "high";
    const findings: Finding[] = [];

    if (!commandExists("docker")) {
        findings.push({
            id: "DOCKER-MISSING",
            severity: "high",
            passed: false,
            title: "Docker is available",
            detail: "The docker CLI is not installed or not on PATH.",
            recommendation: "Install Docker or run this check in an environment with Docker available.",
        });
        return result("scan_container_image", findings, failOn);
    }

    const inspect = run("docker", ["image", "inspect", image], process.cwd());
    findings.push({
        id: "IMAGE-INSPECT",
        severity: "high",
        passed: inspect.status === 0,
        title: "Container image exists locally",
        detail: inspect.status === 0 ? `Image ${image} is available for inspection.` : inspect.output,
        recommendation: "Build or pull the image before scanning it.",
    });

    if (inspect.status !== 0) {
        return result("scan_container_image", findings, failOn);
    }

    if (commandExists("trivy")) {
        const trivy = run("trivy", ["image", "--severity", "HIGH,CRITICAL", "--exit-code", "1", "--no-progress", image], process.cwd());
        findings.push({
            id: "TRIVY-HIGH-CRITICAL",
            severity: "high",
            passed: trivy.status === 0,
            title: "No high or critical vulnerabilities reported by Trivy",
            detail: trivy.output || "Trivy completed without high or critical findings.",
            recommendation: "Patch the base image or dependencies reported by Trivy.",
        });
    } else {
        findings.push({
            id: "TRIVY-MISSING",
            severity: "medium",
            passed: false,
            title: "Trivy is installed for image vulnerability scanning",
            detail: "Trivy is not installed, so image CVE scanning was skipped.",
            recommendation: "Install Trivy locally or add it to CI for vulnerability scanning.",
        });
    }

    return result("scan_container_image", findings, failOn);
}

export function scanIac(repoRoot: string, options: ToolOptions = {}): ScanResult {
    const failOn = options.failOn ?? "high";
    const root = resolve(repoRoot);
    const findings: Finding[] = [];
    const pulumiProgram = join(root, "infra", "index.ts");
    const pulumiContent = existsSync(pulumiProgram) ? readFileSync(pulumiProgram, "utf8") : "";

    findings.push({
        id: "ECR-SCAN-ON-PUSH",
        severity: "medium",
        passed: /scanOnPush:\s*true/.test(pulumiContent),
        title: "ECR scan on push is enabled",
        detail: "Pulumi ECR repository should enable image scan on push.",
        recommendation: "Set imageScanningConfiguration.scanOnPush to true on the ECR repository.",
    });

    findings.push({
        id: "LOG-RETENTION",
        severity: "low",
        passed: /retentionInDays:\s*[1-9]/.test(pulumiContent),
        title: "CloudWatch log retention is configured",
        detail: "CloudWatch log groups should have explicit retention to control cost and data exposure.",
        recommendation: "Set retentionInDays on CloudWatch log groups.",
    });

    findings.push({
        id: "PUBLIC-INGRESS",
        severity: "medium",
        passed: !/allowedCidrs[\s\S]*\["0\.0\.0\.0\/0"\]/.test(pulumiContent),
        title: "Default ingress is not open to the internet",
        detail: "The stack currently defaults allowedCidrs to 0.0.0.0/0 for low-friction testing.",
        recommendation: "Set allowedCidrs to trusted IP ranges or put the service behind an HTTPS load balancer/WAF before production.",
    });

    if (commandExists("checkov")) {
        const checkov = run("checkov", ["-d", join(root, "infra"), "--quiet"], root);
        findings.push({
            id: "CHECKOV",
            severity: "high",
            passed: checkov.status === 0,
            title: "Checkov IaC scan passes",
            detail: checkov.output || "Checkov completed without findings.",
            recommendation: "Review and remediate Checkov findings.",
        });
    } else {
        findings.push({
            id: "CHECKOV-MISSING",
            severity: "medium",
            passed: false,
            title: "Checkov is installed for IaC scanning",
            detail: "Checkov is not installed, so deep IaC scanning was skipped.",
            recommendation: "Install Checkov locally or add it to CI for IaC policy scanning.",
        });
    }

    return result("scan_iac", findings, failOn);
}

export function scanDependencies(repoRoot: string, options: ToolOptions = {}): ScanResult {
    const failOn = options.failOn ?? "high";
    const root = resolve(repoRoot);
    const findings: Finding[] = [];

    for (const workspace of ["infra", "security"]) {
        const audit = run("npm", ["audit", "--audit-level=high"], join(root, workspace));
        findings.push({
            id: `NPM-AUDIT-${workspace.toUpperCase()}`,
            severity: "high",
            passed: audit.status === 0,
            title: `${workspace} npm dependencies have no high or critical audit findings`,
            detail: audit.output || "npm audit completed without high or critical findings.",
            recommendation: "Update or replace vulnerable npm packages.",
        });
    }

    const gradle = run("./gradlew", ["dependencies", "--configuration", "runtimeClasspath"], root);
    findings.push({
        id: "GRADLE-DEPENDENCIES",
        severity: "medium",
        passed: gradle.status === 0,
        title: "Gradle dependency graph resolves",
        detail: gradle.status === 0 ? "Gradle runtimeClasspath dependency graph resolved." : gradle.output,
        recommendation: "Fix Gradle dependency resolution before deployment.",
    });

    return result("scan_dependencies", findings, failOn);
}

export async function zapBaselineScan(targetUrl: string, allowedHosts: string[], options: ToolOptions = {}): Promise<ScanResult> {
    const failOn = options.failOn ?? "high";
    const target = new URL(targetUrl);
    const allowed = new Set(["localhost", "127.0.0.1", "::1", ...allowedHosts]);
    const findings: Finding[] = [];

    if (!allowed.has(target.hostname)) {
        findings.push({
            id: "ZAP-TARGET-NOT-ALLOWED",
            severity: "high",
            passed: false,
            title: "ZAP target is explicitly allowlisted",
            detail: `${target.hostname} is not in the allowed host list.`,
            recommendation: "Pass the exact target host in allowedHosts.",
        });
        return result("zap_baseline_scan", findings, failOn);
    }

    if (!commandExists("docker")) {
        findings.push({
            id: "DOCKER-MISSING",
            severity: "high",
            passed: false,
            title: "Docker is available for ZAP baseline scan",
            detail: "The docker CLI is not installed or not on PATH.",
            recommendation: "Install Docker or run this check in CI with Docker available.",
        });
        return result("zap_baseline_scan", findings, failOn);
    }

    const zap = run("docker", [
        "run", "--rm",
        "ghcr.io/zaproxy/zaproxy:stable",
        "zap-baseline.py",
        "-t", target.href,
        "-I",
    ], process.cwd());

    findings.push({
        id: "ZAP-BASELINE",
        severity: "high",
        passed: zap.status === 0,
        title: "OWASP ZAP baseline scan passes",
        detail: zap.output || "ZAP baseline completed without failing findings.",
        recommendation: "Review ZAP baseline output and remediate reported passive scan findings.",
    });

    return result("zap_baseline_scan", findings, failOn);
}

export function evaluateReleaseGate(results: ScanResult[], failOn: Severity = "high"): ScanResult {
    const findings = results.flatMap((scanResult) => {
        return scanResult.findings
            .filter((finding) => !finding.passed)
            .map((finding) => ({
                ...finding,
                id: `${scanResult.targetUrl}:${finding.id}`,
                detail: `${scanResult.targetUrl}: ${finding.detail}`,
            }));
    });

    if (findings.length === 0) {
        findings.push({
            id: "RELEASE-GATE-PASSED",
            severity: "info",
            passed: true,
            title: "Release gate passed",
            detail: "No failed findings were provided to the release gate.",
        });
    }

    return result("evaluate_release_gate", findings, failOn);
}
