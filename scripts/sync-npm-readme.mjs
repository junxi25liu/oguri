#!/usr/bin/env node
/**
 * Write packages/cli/README.md, the page npm shows for `oguri`, from the root
 * README.
 *
 * npm renders a package README outside the repository, so every relative link
 * and image would break there. This rewrites them to absolute GitHub URLs and
 * keeps one source of truth: a test fails when the two drift apart.
 *
 *   node scripts/sync-npm-readme.mjs          write the file
 *   node scripts/sync-npm-readme.mjs --check  exit 1 when it is stale
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "https://github.com/junxi25liu/oguri";
const RAW = "https://raw.githubusercontent.com/junxi25liu/oguri/main";

export function npmReadme(source) {
  const absolute = (path, raw) => {
    if (/^(https?:|mailto:|#)/.test(path)) return path;
    const clean = path.replace(/^\.\//, "");
    if (raw) return `${RAW}/${clean}`;
    const isDir = clean.endsWith("/");
    return `${REPO}/${isDir ? "tree" : "blob"}/main/${clean}`;
  };
  const header =
    "<!-- Generated from the repository README by scripts/sync-npm-readme.mjs. Edit that file. -->\n\n";
  return (
    header +
    source
      .replace(/(<img\s[^>]*src=")([^"]+)(")/g, (_, a, path, b) => a + absolute(path, true) + b)
      .replace(/(<a\s[^>]*href=")([^"]+)(")/g, (_, a, path, b) => a + absolute(path, false) + b)
      .replace(/\]\(([^)\s]+)\)/g, (_, path) => `](${absolute(path, false)})`)
  );
}

const target = join(root, "packages", "cli", "README.md");
const expected = npmReadme(readFileSync(join(root, "README.md"), "utf8"));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    if (readFileSync(target, "utf8") !== expected) {
      process.stderr.write(
        "packages/cli/README.md is stale: run node scripts/sync-npm-readme.mjs\n",
      );
      process.exit(1);
    }
    process.stdout.write("packages/cli/README.md is in sync\n");
  } else {
    writeFileSync(target, expected);
    process.stdout.write("wrote packages/cli/README.md\n");
  }
}
