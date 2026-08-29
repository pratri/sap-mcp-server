/**
 * Prints, or writes, the MCP client config block for this machine with the
 * absolute paths filled in. Hand-editing those paths is the step most easily
 * got wrong on a new machine.
 *
 *   npm run mcp-config              print the block and its destination
 *   npm run mcp-config -- --write   merge it into ~/.lmstudio/mcp.json
 *
 * --write keeps any other servers already configured, leaves a .bak, and
 * refuses to touch a config file it cannot parse.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = join(projectRoot, "server.ts").replace(/\\/g, "/");
const tsxPath = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs").replace(/\\/g, "/");
const nodePath = process.execPath.replace(/\\/g, "/");
const lmStudioConfig = join(homedir(), ".lmstudio", "mcp.json");

const SERVER_NAME = "s4hana-sandbox";

// The absolute form is the default because it depends on nothing being
// resolvable on PATH from inside the host application's spawn environment,
// which is the usual reason "npx" fails there.
const block = {
  command: nodePath,
  args: [tsxPath, serverPath],
};

const npxBlock = {
  command: "npx",
  args: ["tsx", serverPath],
};

const problems = [];
if (!existsSync(join(projectRoot, "node_modules"))) {
  problems.push('node_modules/ is missing — run "npm install" first.');
}
if (!existsSync(join(projectRoot, ".env"))) {
  problems.push('.env is missing — copy .env.example to .env and fill it in.');
}

const write = process.argv.includes("--write");

console.log(`\nProject:      ${projectRoot}`);
console.log(`Config file:  ${lmStudioConfig}`);
console.log(`              (other MCP clients keep their own config file;`);
console.log(`               the block below is the same.)\n`);

if (problems.length) {
  console.log("Before this will work:");
  for (const p of problems) console.log(`  - ${p}`);
  console.log("");
}

console.log("Recommended block (absolute paths, nothing to resolve on PATH):\n");
console.log(JSON.stringify({ mcpServers: { [SERVER_NAME]: block } }, null, 2));
console.log("\nAlternative, if you would rather it follow your PATH:\n");
console.log(JSON.stringify({ mcpServers: { [SERVER_NAME]: npxBlock } }, null, 2));

if (!write) {
  console.log(`\nTo merge the recommended block into ${lmStudioConfig}:\n`);
  console.log("  npm run mcp-config -- --write\n");
  console.log("Then fully quit and restart LM Studio — it reads mcp.json only at startup.\n");
  process.exit(0);
}

// --- merge -----------------------------------------------------------

let existing = {};
if (existsSync(lmStudioConfig)) {
  const raw = readFileSync(lmStudioConfig, "utf8").trim();
  if (raw) {
    try {
      existing = JSON.parse(raw);
    } catch (err) {
      console.error(
        `\nRefusing to write: ${lmStudioConfig} is not valid JSON ` +
          `(${err.message}).\nFix or move that file, then run this again.\n`
      );
      process.exit(1);
    }
  }
  copyFileSync(lmStudioConfig, `${lmStudioConfig}.bak`);
  console.log(`\nBacked up existing config to ${lmStudioConfig}.bak`);
} else {
  mkdirSync(dirname(lmStudioConfig), { recursive: true });
  console.log(`\nCreating ${lmStudioConfig}`);
}

if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
  console.error("\nRefusing to write: the config file's top level is not an object.\n");
  process.exit(1);
}

const others = Object.keys(existing.mcpServers ?? {}).filter((k) => k !== SERVER_NAME);
existing.mcpServers = { ...(existing.mcpServers ?? {}), [SERVER_NAME]: block };
writeFileSync(lmStudioConfig, JSON.stringify(existing, null, 2) + "\n");

console.log(`Wrote "${SERVER_NAME}".`);
console.log(
  others.length
    ? `Left ${others.length} other server(s) untouched: ${others.join(", ")}`
    : "No other servers were configured."
);
console.log("\nNow fully quit and restart LM Studio, then check Integrations.\n");
