import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';

const packageConfig = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('Windows package edits executable resources to embed the Astralis taskbar icon', () => {
  assert.equal(packageConfig.build.win.icon, 'build/icon.ico');
  assert.equal(packageConfig.build.win.signAndEditExecutable, true);
  assert.ok(statSync(new URL('../build/icon.ico', import.meta.url)).size > 0);
});
