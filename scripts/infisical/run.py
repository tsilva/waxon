"""Fetch development secrets in memory, then replace this process with the app."""

import os
import sys

from common import Infisical, ROOT, SecretError, application_environment

COMMANDS = {
    "dev": ["pnpm", "run", "dev:app", "--port", "auto"],
    "build": ["pnpm", "run", "build"],
    "start": ["pnpm", "run", "start", "--port", "auto"],
    "migrate": ["pnpm", "run", "db:migrate"],
    "check": ["node", "scripts/check-infisical-secrets.mjs"],
}


def selected_command(arguments):
    if not arguments or arguments[0] not in COMMANDS:
        raise SecretError("Usage: python3 scripts/infisical/run.py <dev|build|start|migrate|check>")
    if arguments[1:] and not (arguments[0] in ("dev", "start")
                              and arguments[1:] in (["--port", "auto"], ["--port=auto"])):
        raise SecretError("Only --port auto is supported for development/start; project and environment overrides are rejected.")
    return COMMANDS[arguments[0]]


def main():
    command = selected_command(sys.argv[1:])
    environment = application_environment(Infisical().read())
    environment.pop("VERCEL_ENV", None)
    environment.pop("WAXON_BACKFILL_SEMANTIC_TAGS", None)
    if sys.argv[1] == "dev":
        environment["NEXT_DEV_OUTPUT_DIR"] = f".next-dev-{os.getpid()}"
    os.chdir(ROOT)
    os.execvpe(command[0], command, environment)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
    except SecretError as error:
        print(error, file=sys.stderr)
        sys.exit(1)
    except Exception:
        print("Could not launch the application; credential details suppressed.", file=sys.stderr)
        sys.exit(1)
