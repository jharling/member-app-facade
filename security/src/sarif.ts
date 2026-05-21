import { Finding, ScanResult, Severity } from "./scanner.js";

interface SarifResult {
    ruleId: string;
    level: "note" | "warning" | "error";
    message: {
        text: string;
    };
    locations: Array<{
        physicalLocation: {
            artifactLocation: {
                uri: string;
            };
            region: {
                startLine: number;
            };
        };
    }>;
}

const sarifLevelBySeverity: Record<Severity, SarifResult["level"]> = {
    info: "note",
    low: "note",
    medium: "warning",
    high: "error",
};

function ruleHelp(finding: Finding): string {
    return finding.recommendation
        ? `${finding.detail}\n\nRecommendation: ${finding.recommendation}`
        : finding.detail;
}

export function formatSarif(result: ScanResult): object {
    const failedFindings = result.findings.filter((finding) => !finding.passed);

    return {
        version: "2.1.0",
        $schema: "https://json.schemastore.org/sarif-2.1.0.json",
        runs: [{
            tool: {
                driver: {
                    name: "member-app-facade-security",
                    informationUri: "https://github.com/jharling/member-app-facade",
                    rules: result.findings.map((finding) => ({
                        id: finding.id,
                        name: finding.title,
                        shortDescription: {
                            text: finding.title,
                        },
                        fullDescription: {
                            text: ruleHelp(finding),
                        },
                        help: {
                            text: ruleHelp(finding),
                        },
                        properties: {
                            severity: finding.severity,
                        },
                    })),
                },
            },
            invocations: [{
                executionSuccessful: result.passed,
                endTimeUtc: result.checkedAt,
                properties: {
                    targetUrl: result.targetUrl,
                    failOn: result.failOn,
                },
            }],
            results: failedFindings.map((finding) => ({
                ruleId: finding.id,
                level: sarifLevelBySeverity[finding.severity],
                message: {
                    text: [
                        finding.title,
                        finding.detail,
                        finding.recommendation ? `Recommendation: ${finding.recommendation}` : undefined,
                    ].filter(Boolean).join(" "),
                },
                locations: [{
                    physicalLocation: {
                        artifactLocation: {
                            uri: "security/src/scanner.ts",
                        },
                        region: {
                            startLine: 1,
                        },
                    },
                }],
                properties: {
                    targetUrl: result.targetUrl,
                    severity: finding.severity,
                },
            })),
        }],
    };
}
