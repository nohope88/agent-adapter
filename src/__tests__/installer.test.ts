import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-inst-'));
process.env.HOME = home;
process.env.USERPROFILE = home; // Windows: os.homedir() reads USERPROFILE, not HOME
process.env.AGENT_ADAPTER_SKIP_DAEMON = '1';

test('installer: detect, wire claude+cursor hooks, credentials, uninstall', async () => {
  const claudeDir = path.join(home, '.claude');
  const cursorDir = path.join(home, '.cursor');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(cursorDir, { recursive: true });

  const inst = await import('../hooks/installer');
  const report = inst.detectReport();
  assert.ok(report.some((r) => r.kind === 'claude-code' && r.installed));

  const wired = inst.installHooks();
  assert.ok(wired.length >= 1, `expected hooks wired, got: ${wired.join(',')}`);
  const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
  assert.ok(settings.hooks && Object.keys(settings.hooks as object).length > 0);

  assert.equal(inst.loadCredential(), undefined); // no credential file yet → undefined
  inst.saveCredential('secret');
  assert.equal(inst.loadCredential()?.token, 'secret');

  inst.uninstallHooks();
  const after = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
  assert.ok(!JSON.stringify(after.hooks || {}).includes(' # agent-adapter'));
});

test('registerDaemon respects skip env', async () => {
  process.env.AGENT_ADAPTER_SKIP_DAEMON = '1';
  const inst = await import('../hooks/installer');
  inst.registerDaemon();
  delete process.env.AGENT_ADAPTER_SKIP_DAEMON;
});

test('installer wires cursor hooks with neutral replies', async () => {
  const cursorDir = path.join(home, '.cursor');
  fs.mkdirSync(cursorDir, { recursive: true });
  const inst = await import('../hooks/installer');
  inst.installHooks();
  const hooks = JSON.parse(fs.readFileSync(path.join(cursorDir, 'hooks.json'), 'utf8'));
  assert.ok(JSON.stringify(hooks).includes('beforeSubmitPrompt'));
});

test('installer: a per-adapter wiring failure is caught, not fatal', async () => {
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const settings = path.join(claudeDir, 'settings.json');
  // Turn the target into a directory → writeJson's writeFileSync throws (EISDIR),
  // exercising installHooks' per-adapter try/catch without aborting the rest.
  fs.rmSync(settings, { force: true });
  fs.mkdirSync(settings, { recursive: true });
  try {
    const inst = await import('../hooks/installer');
    const wired = inst.installHooks();
    assert.ok(Array.isArray(wired));
    assert.ok(!wired.includes('claude-code'), 'claude wiring failed and was caught');
  } finally {
    fs.rmSync(settings, { recursive: true, force: true });
  }
});

test('installer: reconcileHooks wires present agents, strips absent ones, catches failures', async () => {
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.rmSync(path.join(home, '.cursor'), { recursive: true, force: true }); // ensure cursor is absent → strip path
  const inst = await import('../hooks/installer');

  // claude present → wired; cursor absent → stripHooks no-ops on a missing config.
  const wired = inst.reconcileHooks();
  assert.ok(wired.includes('claude-code'), `expected claude wired, got: ${wired.join(',')}`);
  assert.ok(!wired.includes('cursor'));
  const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
  assert.ok(settings.hooks && Object.keys(settings.hooks as object).length > 0);

  // Make claude's config un-writable (dir in place of file) → mergeHooks throws → caught.
  const sPath = path.join(claudeDir, 'settings.json');
  fs.rmSync(sPath, { force: true });
  fs.mkdirSync(sPath, { recursive: true });
  try {
    const again = inst.reconcileHooks();
    assert.ok(!again.includes('claude-code'), 'wiring failure was caught');
  } finally {
    fs.rmSync(sPath, { recursive: true, force: true });
  }
});

test('installer: clearCredential removes the credential, false when none', async () => {
  const inst = await import('../hooks/installer');
  inst.saveCredential('tok');
  assert.equal(inst.loadCredential()?.token, 'tok');
  assert.equal(inst.clearCredential(), true);
  assert.equal(inst.loadCredential(), undefined);
  assert.equal(inst.clearCredential(), false); // already gone
});
