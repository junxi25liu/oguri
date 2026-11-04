#!/usr/bin/env node
/**
 * Build the npm package `oguri` as one self-contained bundle.
 *
 * The workspace has eight packages; seven are `@oguri/*`. npm keeps user and
 * organization names in one namespace, so the scope can be taken by someone
 * else. Publishing one bundle needs only the unscoped name `oguri`, installs
 * with no dependency resolution, and is the same code the single-file binary
 * runs.
 *
 *   pnpm build && node scripts/pack-npm.mjs   → dist-npm/oguri-<version>.tgz
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = JSON.parse(readFileSync(join(root, "packages", "cli", "package.json"), "utf8"));
const entry = join(root, "packages", "cli", "dist", "bin.js");
const out = join(root, "dist-npm");
const stage = join(out, "package");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(stage, "dist"), { recursive: true });

console.log("→ bundling the CLI to dist/oguri.cjs");
execFileSync(
  process.execPath,
  [
    join(root, "node_modules", "esbuild", "bin", "esbuild"),
    entry,
    "--bundle",
    "--platform=node",
    "--target=node24",
    "--format=cjs",
    "--external:node:*",
    `--outfile=${join(stage, "dist", "oguri.cjs")}`,
    "--log-level=warning",
  ],
  { stdio: "inherit" },
);

const manifest = {
  name: "oguri",
  version: cli.version,
  description: cli.description,
  keywords: cli.keywords,
  homepage: cli.homepage,
  repository: cli.repository,
  bugs: cli.bugs,
  license: cli.license,
  author: cli.author,
  type: "commonjs",
  bin: { oguri: "dist/oguri.cjs" },
  files: ["dist/oguri.cjs", "README.md", "LICENSE"],
  engines: cli.engines ?? { node: ">=24" },
  // The bundle carries everything; nothing is resolved at install time.
  dependencies: {},
};
writeFileSync(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
copyFileSync(join(root, "packages", "cli", "README.md"), join(stage, "README.md"));
copyFileSync(join(root, "LICENSE"), join(stage, "LICENSE"));

console.log("→ packing");
const packed = execFileSync("npm", ["pack", "--pack-destination", out], {
  cwd: stage,
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .pop();
console.log(`✓ ${join(out, packed)}`);
