#!/usr/bin/env node

import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const forbiddenSpec = /^(?:file|git|git\+[^:]+|https?|link|workspace):/i;
const failures = [];

for (const field of dependencyFields) {
  for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
    if (typeof specifier === "string" && forbiddenSpec.test(specifier)) {
      failures.push(`${field}.${name} uses forbidden source ${specifier}`);
    }
  }
}

const lock = readFileSync("pnpm-lock.yaml", "utf8");

// Inspect only lockfile fields that can identify a package source. Arbitrary
// metadata such as deprecation messages may legitimately contain web links.
for (const pattern of [
  /^\s*(?:specifier|version):\s*(?:file|git|git\+[^:]+|https?|link|workspace):/gim,
  /^\s*tarball:/gim,
  /^\s*type:\s*git\s*$/gim,
]) {
  if (pattern.test(lock)) {
    failures.push(`pnpm-lock.yaml contains a forbidden non-registry source (${pattern})`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Dependency manifest and lock use registry-only sources.");
