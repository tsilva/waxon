import assert from "node:assert/strict";
import test from "node:test";
import { runBuild } from "../scripts/build.mjs";

type SpawnCall = {
  command: string;
  args: string[];
};

function recordingSpawn(statuses: number[] = []) {
  const calls: SpawnCall[] = [];
  return {
    calls,
    spawn(command: string, args: readonly string[]) {
      calls.push({ command, args: [...args] });
      return { status: statuses.shift() ?? 0 };
    },
  };
}

test("production builds migrate the database before compiling the app", () => {
  const runner = recordingSpawn();

  assert.equal(
    runBuild({ environment: { VERCEL_ENV: "production" }, spawn: runner.spawn }),
    0,
  );
  assert.deepEqual(runner.calls, [
    { command: "pnpm", args: ["db:migrate"] },
    { command: "next", args: ["build"] },
  ]);
});

test("preview and local builds do not mutate a database", () => {
  for (const environment of [{ VERCEL_ENV: "preview" }, {}]) {
    const runner = recordingSpawn();

    assert.equal(runBuild({ environment, spawn: runner.spawn }), 0);
    assert.deepEqual(runner.calls, [
      { command: "next", args: ["build"] },
    ]);
  }
});

test("a failed production migration prevents an incompatible app build", () => {
  const runner = recordingSpawn([1]);

  assert.equal(
    runBuild({ environment: { VERCEL_ENV: "production" }, spawn: runner.spawn }),
    1,
  );
  assert.deepEqual(runner.calls, [
    { command: "pnpm", args: ["db:migrate"] },
  ]);
});
