/**
 * Published CLI bootstrap.
 *
 * Node will not type-strip TypeScript inside node_modules
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). npx installs this package
 * there, so the bin must be JavaScript: check Node 26+, register a loader
 * that strips our .ts sources, then dispatch into retemper.ts / install.ts /
 * uninstall.ts. Clone workflows keep running those files directly.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const REQUIRED_NODE_MAJOR = 26;

export function nodeMajor(version = process.versions.node) {
  const major = Number.parseInt(String(version), 10);
  return Number.isFinite(major) ? major : 0;
}

export function nodeVersionError(version = process.version) {
  return `retemper requires Node.js ${REQUIRED_NODE_MAJOR} or later; this runtime is ${version}. TypeScript sources run natively on Node ${REQUIRED_NODE_MAJOR}+ with no compile step.`;
}

export function assertSupportedNode(version = process.versions.node, display = process.version) {
  if (nodeMajor(version) < REQUIRED_NODE_MAJOR) {
    console.error(nodeVersionError(display));
    process.exit(1);
  }
}

function isTypeScriptFileUrl(url) {
  if (typeof url !== "string" || !url.startsWith("file:")) return false;
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(url).pathname);
  } catch {
    return false;
  }
  return pathname.endsWith(".ts") && !pathname.endsWith(".d.ts");
}

let hooksRegistered = false;

async function registerTypeScriptLoader() {
  if (hooksRegistered) return;
  const { registerHooks, stripTypeScriptTypes } = await import("node:module");
  registerHooks({
    load(url, context, nextLoad) {
      if (!isTypeScriptFileUrl(url)) {
        return nextLoad(url, context);
      }
      // Read and strip ourselves. Node refuses type stripping under node_modules,
      // which is where npx places this package.
      const source = readFileSync(fileURLToPath(url), "utf8");
      return {
        format: "module",
        shortCircuit: true,
        source: stripTypeScriptTypes(source, { mode: "strip", sourceUrl: url }),
      };
    },
  });
  hooksRegistered = true;
}

function fail(error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

export async function runCli(command) {
  assertSupportedNode();
  await registerTypeScriptLoader();
  try {
    if (command === "install") {
      const { main } = await import(new URL("../install.ts", import.meta.url).href);
      const code = main(process.argv);
      if (typeof code === "number" && code !== 0) process.exit(code);
      return;
    }
    if (command === "uninstall") {
      const { uninstallMain } = await import(new URL("../uninstall.ts", import.meta.url).href);
      const code = await uninstallMain(process.argv);
      if (typeof code === "number" && code !== 0) process.exit(code);
      return;
    }
    const { dispatch } = await import(new URL("../retemper.ts", import.meta.url).href);
    const code = await dispatch(process.argv);
    if (typeof code === "number" && code !== 0) process.exit(code);
  } catch (error) {
    fail(error);
  }
}
