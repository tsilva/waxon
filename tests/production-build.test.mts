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

test("Vercel preview and production builds prepare the database before compiling", () => {
  for (const vercelEnvironment of ["preview", "production"]) {
    const runner = recordingSpawn();

    assert.equal(
      runBuild({
        environment: { VERCEL_ENV: vercelEnvironment },
        spawn: runner.spawn,
      }),
      0,
    );
    assert.deepEqual(runner.calls, [
      { command: "pnpm", args: ["db:migrate"] },
      { command: "next", args: ["build"] },
    ]);
  }
});

test("local builds do not mutate a database", () => {
  const runner = recordingSpawn();

  assert.equal(runBuild({ environment: {}, spawn: runner.spawn }), 0);
  assert.deepEqual(runner.calls, [{ command: "next", args: ["build"] }]);
});

test("a requested production build prepares the enriched semantic Tag space", () => {
  const runner = recordingSpawn();

  assert.equal(
    runBuild({
      environment: {
        VERCEL_ENV: "production",
        WAXON_BACKFILL_SEMANTIC_TAGS: "1",
      },
      spawn: runner.spawn,
    }),
    0,
  );
  assert.deepEqual(runner.calls, [
    { command: "pnpm", args: ["db:migrate"] },
    { command: "pnpm", args: ["semantic-tags:backfill"] },
    { command: "next", args: ["build"] },
  ]);
});

test("a failed semantic Tag backfill prevents activation of that space", () => {
  const runner = recordingSpawn([0, 1]);

  assert.equal(
    runBuild({
      environment: {
        VERCEL_ENV: "production",
        WAXON_BACKFILL_SEMANTIC_TAGS: "1",
      },
      spawn: runner.spawn,
    }),
    1,
  );
  assert.deepEqual(runner.calls, [
    { command: "pnpm", args: ["db:migrate"] },
    { command: "pnpm", args: ["semantic-tags:backfill"] },
  ]);
});

test("a requested production build calibrates the active semantic Tag space", () => {
  const runner = recordingSpawn();

  assert.equal(
    runBuild({
      environment: {
        VERCEL_ENV: "production",
        WAXON_CALIBRATE_SEMANTIC_TAGS: "1",
      },
      spawn: runner.spawn,
    }),
    0,
  );
  assert.deepEqual(runner.calls, [
    { command: "pnpm", args: ["db:migrate"] },
    { command: "pnpm", args: ["semantic-tags:calibrate"] },
    { command: "next", args: ["build"] },
  ]);
});

test("a failed Vercel migration prevents an incompatible app build", () => {
  for (const vercelEnvironment of ["preview", "production"]) {
    const runner = recordingSpawn([1]);

    assert.equal(
      runBuild({
        environment: { VERCEL_ENV: vercelEnvironment },
        spawn: runner.spawn,
      }),
      1,
    );
    assert.deepEqual(runner.calls, [
      { command: "pnpm", args: ["db:migrate"] },
    ]);
  }
});
