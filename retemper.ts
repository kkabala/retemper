#!/usr/bin/env node
/**
 * Retemper single entry point — one command with install / uninstall / update verbs.
 *
 *   node retemper.ts install [installer flags]
 *   node retemper.ts uninstall [uninstaller flags]
 *   node retemper.ts update [--dry-run] [--skip-deps] [--standards]
 *   node retemper.ts help
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { main as installMain } from "./install.ts";
import { uninstallMain } from "./uninstall.ts";

export function usageText(): string {
  return [
    "retemper — plan → accept → build → harden → review → QA → PR cycle",
    "",
    "Usage:",
    "  node retemper.ts install [flags]     same flags as install.ts",
    "  node retemper.ts uninstall [flags]   remove installs; --all is the default filter",
    "  node retemper.ts update [flags]      refresh every recorded install",
    "  node retemper.ts help                show this text",
    "",
    "Per-verb flags:",
    "  node retemper.ts install --help",
    "  node retemper.ts uninstall --help",
  ].join("\n");
}

async function dispatch(argv: string[]): Promise<number> {
  const [, , verb, ...rest] = argv;
  if (!verb || verb === "-h" || verb === "--help" || verb === "help") {
    console.log(usageText());
    return 0;
  }
  if (verb === "install") return installMain(["node", "retemper", ...rest]);
  if (verb === "uninstall") return uninstallMain(["node", "retemper", ...rest]);
  if (verb === "update") return installMain(["node", "retemper", "--update", ...rest]);
  console.error(`Unknown command: ${verb}. Try "install", "uninstall", "update", or "help".`);
  return 1;
}

function invokedAsThisModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}

if (invokedAsThisModule(import.meta.url)) {
  try {
    const code = await dispatch(process.argv);
    if (typeof code === "number" && code !== 0) process.exit(code);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
