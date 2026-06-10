#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";

const require = createRequire(import.meta.url);

async function randomAvailablePort() {
  const server = createServer();

  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        if (!address || typeof address === "string") {
          reject(new Error("Could not resolve random server port"));
          return;
        }

        resolve(address.port);
      });
    });
  });
}

async function resolveAutoPortArgs(args) {
  const nextArgs = [...args];

  for (let index = 0; index < nextArgs.length; index += 1) {
    const arg = nextArgs[index];

    if ((arg === "--port" || arg === "-p") && nextArgs[index + 1] === "auto") {
      const port = await randomAvailablePort();
      nextArgs[index + 1] = String(port);
      console.error(`Using random available port ${port}`);
      return nextArgs;
    }

    if (arg === "--port=auto") {
      const port = await randomAvailablePort();
      nextArgs[index] = `--port=${port}`;
      console.error(`Using random available port ${port}`);
      return nextArgs;
    }

    if (arg === "-p=auto") {
      const port = await randomAvailablePort();
      nextArgs[index] = `-p=${port}`;
      console.error(`Using random available port ${port}`);
      return nextArgs;
    }
  }

  return nextArgs;
}

async function main() {
  const [command, ...rawArgs] = process.argv.slice(2);

  if (!command) {
    console.error("Usage: node scripts/next-server.mjs <dev|start> [next args...]");
    process.exit(1);
  }

  const nextBin = require.resolve("next/dist/bin/next");
  const nextArgs = await resolveAutoPortArgs(rawArgs);
  const child = spawn(process.execPath, [nextBin, command, ...nextArgs], {
    env: process.env,
    stdio: "inherit",
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 1);
  });

  child.on("error", (error) => {
    console.error(error);
    process.exit(1);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
