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
