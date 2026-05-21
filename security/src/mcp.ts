import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatScanResult, scanTarget } from "./scanner.js";

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

const transport = new StdioServerTransport();
await server.connect(transport);
