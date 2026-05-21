import { formatScanResult, scanTarget, Severity } from "./scanner.js";

interface CliOptions {
    targetUrl?: string;
    failOn?: Severity;
    allowedHosts: string[];
    readinessRetries?: number;
    readinessDelayMs?: number;
    json: boolean;
}

function parseArgs(args: string[]): CliOptions {
    const options: CliOptions = {
        allowedHosts: [],
        json: false,
    };

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        const next = args[index + 1];

        if (arg === "--target-url") {
            options.targetUrl = next;
            index += 1;
        } else if (arg === "--fail-on") {
            options.failOn = next as Severity;
            index += 1;
        } else if (arg === "--allow-host") {
            options.allowedHosts.push(next);
            index += 1;
        } else if (arg === "--readiness-retries") {
            options.readinessRetries = Number(next);
            index += 1;
        } else if (arg === "--readiness-delay-ms") {
            options.readinessDelayMs = Number(next);
            index += 1;
        } else if (arg === "--json") {
            options.json = true;
        } else if (arg === "--help" || arg === "-h") {
            printHelp();
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    return options;
}

function printHelp(): void {
    console.log(`Usage: member-app-pentest --target-url <url> [options]

Options:
  --target-url <url>     Base URL to test, for example http://127.0.0.1:8080
  --allow-host <host>    Additional allowed target host. Repeatable.
  --fail-on <severity>   info, low, medium, or high. Default: medium
  --readiness-retries <n> Number of /hello readiness attempts. Default: 30
  --readiness-delay-ms <n> Delay between readiness attempts. Default: 5000
  --json                 Print JSON instead of text
`);
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    const targetUrl = options.targetUrl ?? process.env.PENTEST_TARGET_URL;

    if (!targetUrl) {
        throw new Error("Missing target URL. Pass --target-url or set PENTEST_TARGET_URL.");
    }

    const result = await scanTarget({
        targetUrl,
        failOn: options.failOn,
        allowedHosts: options.allowedHosts,
        readinessRetries: options.readinessRetries,
        readinessDelayMs: options.readinessDelayMs,
    });

    if (options.json) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        console.log(formatScanResult(result));
    }

    if (!result.passed) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
