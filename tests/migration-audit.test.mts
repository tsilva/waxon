import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('Production migration-audit client fails closed without application access', () => {
  const result = spawnSync('python3', ['-I', '-m', 'unittest', 'discover', '-s', 'scripts/infisical', '-p', 'test_migration_audit.py'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test' },
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
});
