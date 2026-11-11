# Read-only Production migration audit

Run `pnpm db:check-migrations` before deployment work that needs independent
Production migration-history verification. This command does not apply migrations,
read learner records, load application credentials or alter the deployment pipeline.
The existing Production migration job remains a separate operation that can apply
pending migrations; it is not a substitute for this read-only client.

The audit compares `drizzle.__drizzle_migrations` with the ordered timestamps and
SHA-256 hashes in `drizzle-v2/meta/_journal.json` and its SQL files. Success requires
an exact history match, the expected database and auditor identity, and read-only
transaction mode. It rejects application-table or column access, ledger writes,
elevated roles or memberships, database/schema creation and executable non-system
security-definer functions. It reports only success and the migration count.

## Trusted setup

The existing Agent Vault bundle is `local-waxon-migration-audit`. Its only service,
`waxon-neon-ledger`, permits `POST /sql` on the reviewed endpoint and attaches its
stored connection URL using `Neon-Connection-String` without a prefix. The database
role is `waxon_migration_auditor`; it needs only database `CONNECT`, schema `drizzle`
`USAGE` and migration-ledger `SELECT`, with `default_transaction_read_only=on`.
Do not create it using a provider-console default role with broader privileges.

On an explicitly authorized trusted Mac, run:

```sh
python3 -I scripts/infisical/provision_migration_audit.py --inspect
python3 -I scripts/infisical/provision_migration_audit.py --fake-test
python3 -I scripts/infisical/provision_migration_audit.py --install
pnpm db:check-migrations
```

Inspection reads configuration metadata. The synthetic test temporarily creates
an isolated fake-credential bundle and loopback server, verifies real proxy
substitution, method/path restrictions and sandbox denials, then removes them.
It does not contact the Production database.

Installation validates the existing service without replacing its credential or
changing grants. It compares its endpoint with the fixed `DATABASE_URL_UNPOOLED`
binding in Production project `ad93d013-8087-4bcb-bf12-63ef33e13282`, environment
`prod`, path `/`. This explicitly trusted step inspects that URL only in memory;
it never connects as the application role, prints it, exports it or writes it to
the audit profile. A mismatched or missing existing service stops setup rather
than silently creating a broader route.

The installed owner-only profile under
`~/.config/infisical/neon-migration-checks/waxon.json` contains endpoint and database
metadata, source provenance, a CLI digest and the pinned public proxy CA. It contains
no database credential. Existing profiles are never overwritten automatically;
rotation and changed bindings require a separate trusted review.

## Isolation and failures

The ordinary launcher creates a ten-minute Agent Vault session with a clean
environment, pinned HTTPS instance and CA, no persistent CA trust changes and no
cloud-skill installation. It checks the expected placeholder before running curl
in the macOS sandbox. The SQL client can reach only the local proxy, and cannot
read other home-directory files. This protects the SQL subprocess, not the
full-access launcher or other same-user processes on the host.

An absent profile, expired login, rejected credential, permission drift, history
mismatch or changed CLI must be repaired through its documented administrative
route. Do not export a DSN, change scopes, bypass the sandbox, disable TLS checks
or run migrations as a fallback. Source tests use synthetic credentials:

```sh
python3 -I -m unittest discover -s scripts/infisical -p test_migration_audit.py
```
