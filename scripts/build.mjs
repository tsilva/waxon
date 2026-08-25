import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function runCommand(spawn, environment, command, args) {
  const result = spawn(command, args, {
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function runBuild({
  environment = process.env,
  spawn = spawnSync,
} = {}) {
  const shouldPrepareDatabase =
    environment.VERCEL_ENV === "preview" ||
    environment.VERCEL_ENV === "production";

  if (shouldPrepareDatabase) {
    const migrationStatus = runCommand(
      spawn,
      environment,
      "pnpm",
      ["db:migrate"],
    );
    if (migrationStatus !== 0) return migrationStatus;
    const backfillStatus = runCommand(
      spawn,
      environment,
      "pnpm",
      ["db:backfill-question-target-keys"],
    );
    if (backfillStatus !== 0) return backfillStatus;
  }

  return runCommand(spawn, environment, "next", ["build"]);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = runBuild();
}
