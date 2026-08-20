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
  if (environment.VERCEL_ENV === "production") {
    const migrationStatus = runCommand(
      spawn,
      environment,
      "pnpm",
      ["db:migrate"],
    );
    if (migrationStatus !== 0) return migrationStatus;
  }

  return runCommand(spawn, environment, "next", ["build"]);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = runBuild();
}
