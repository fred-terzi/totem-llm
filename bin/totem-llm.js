#!/usr/bin/env node
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { setup } from "../lib/setup.js";
import { launch } from "../lib/launcher.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, "..");

const args = process.argv.slice(2);
const isHelp = args.includes("--help") || args.includes("-h");
const command = isHelp
  ? "help"
  : (args.find((a) => !a.startsWith("--")) ?? "start");
const noCollector = args.includes("--no-collector");
const portArg = args.find((a) => a.startsWith("--port="));
const port = portArg ? portArg.split("=")[1] : undefined;

async function main() {
  switch (command) {
    case "start":
      await setup({ packageRoot });
      await launch({ packageRoot, noCollector, port });
      break;

    case "setup":
      await setup({ packageRoot, force: args.includes("--force") });
      console.log(
        '\nSetup complete. Run "totem-llm start" to launch the server.'
      );
      break;

    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;

    default:
      console.error(`Unknown command: "${command}"`);
      printHelp();
      process.exit(1);
  }
}

function printHelp() {
  console.log(`
Totem LLM – Your Private AI

Usage:
  totem-llm [command] [options]

Commands:
  start         Start Totem LLM (default)
  setup         Run first-time setup without starting
  help          Show this help message

Options:
  --no-collector   Start without the document collector (skips Puppeteer/ffmpeg)
  --port=<port>    Override the server port (default: 3001)
  --force          (setup only) Regenerate configuration even if it already exists

Environment Variables:
  TOTEM_STORAGE_DIR    Override storage directory (default: ~/.totem-llm)
  SERVER_PORT          Override server port
  COLLECTOR_PORT       Override collector port (default: 8888)

Examples:
  totem-llm                        Start with defaults
  totem-llm --no-collector         Start without document ingestion
  totem-llm --port=8080            Start server on port 8080
  TOTEM_STORAGE_DIR=/data totem-llm start
`);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
