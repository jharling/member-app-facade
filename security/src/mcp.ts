import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatScanResult, scanTarget } from "./scanner.js";
import {
    evaluateReleaseGate,
    scanContainerImage,
    scanDependencies,
    scanIac,
    scanSecrets,
    zapBaselineScan,
} from "./toolkit.js";

const server = new McpServer({
    name: "member-app-facade-pentest",
    version: "0.1.0",
});

server.tool(
    "security_smoke_test",
    {
        targetUrl: z.string().url().describe("Base URL to test, for example http://127.0.0.1:8080"),
        allowedHosts: z.array(z.string()).default([]).describe("Additional allowed target hostnames or IPs"),
        failOn: z.enum(["info", "low", "medium", "high"]).default("medium"),
        readinessRetries: z.number().int().positive().default(30),
        readinessDelayMs: z.number().int().positive().default(5000),
    },
    async ({ targetUrl, allowedHosts, failOn, readinessRetries, readinessDelayMs }) => {
        const result = await scanTarget({
            targetUrl,
            allowedHosts,
            failOn,
            readinessRetries,
            readinessDelayMs,
        });

        return {
            content: [{
                type: "text",
                text: formatScanResult(result),
            }, {
                type: "text",
                text: JSON.stringify(result, null, 2),
            }],
            isError: !result.passed,
        };
    },
);

server.tool(
    "scan_secrets",
    {
        repoRoot: z.string().default("."),
        failOn: z.enum(["info", "low", "medium", "high"]).default("high"),
    },
    async ({ repoRoot, failOn }) => {
        const result = scanSecrets(repoRoot, { failOn });
        return {
            content: [{
                type: "text",
                text: formatScanResult(result),
            }, {
                type: "text",
                text: JSON.stringify(result, null, 2),
            }],
            isError: !result.passed,
        };
    },
);

server.tool(
    "scan_container_image",
    {
        image: z.string().describe("Local container image reference, for example member-app-facade:local"),
        failOn: z.enum(["info", "low", "medium", "high"]).default("high"),
    },
    async ({ image, failOn }) => {
        const result = scanContainerImage(image, { failOn });
        return {
            content: [{
                type: "text",
                text: formatScanResult(result),
            }, {
                type: "text",
                text: JSON.stringify(result, null, 2),
            }],
            isError: !result.passed,
        };
    },
);

server.tool(
    "scan_iac",
    {
        repoRoot: z.string().default("."),
        failOn: z.enum(["info", "low", "medium", "high"]).default("high"),
    },
    async ({ repoRoot, failOn }) => {
        const result = scanIac(repoRoot, { failOn });
        return {
            content: [{
                type: "text",
                text: formatScanResult(result),
            }, {
                type: "text",
                text: JSON.stringify(result, null, 2),
            }],
            isError: !result.passed,
        };
    },
);

server.tool(
    "scan_dependencies",
    {
        repoRoot: z.string().default("."),
        failOn: z.enum(["info", "low", "medium", "high"]).default("high"),
    },
    async ({ repoRoot, failOn }) => {
        const result = scanDependencies(repoRoot, { failOn });
        return {
            content: [{
                type: "text",
                text: formatScanResult(result),
            }, {
                type: "text",
                text: JSON.stringify(result, null, 2),
            }],
            isError: !result.passed,
        };
    },
);

server.tool(
    "zap_baseline_scan",
    {
        targetUrl: z.string().url(),
        allowedHosts: z.array(z.string()).default([]),
        failOn: z.enum(["info", "low", "medium", "high"]).default("high"),
    },
    async ({ targetUrl, allowedHosts, failOn }) => {
        const result = await zapBaselineScan(targetUrl, allowedHosts, { failOn });
        return {
            content: [{
                type: "text",
                text: formatScanResult(result),
            }, {
                type: "text",
                text: JSON.stringify(result, null, 2),
            }],
            isError: !result.passed,
        };
    },
);

server.tool(
    "evaluate_release_gate",
    {
        scanResultsJson: z.string().describe("JSON array of ScanResult objects"),
        failOn: z.enum(["info", "low", "medium", "high"]).default("high"),
    },
    async ({ scanResultsJson, failOn }) => {
        const scanResults = JSON.parse(scanResultsJson);
        const result = evaluateReleaseGate(scanResults, failOn);
        return {
            content: [{
                type: "text",
                text: formatScanResult(result),
            }, {
                type: "text",
                text: JSON.stringify(result, null, 2),
            }],
            isError: !result.passed,
        };
    },
);

const transport = new StdioServerTransport();
await server.connect(transport);
