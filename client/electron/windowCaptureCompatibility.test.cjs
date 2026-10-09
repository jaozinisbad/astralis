const test = require('node:test');
const assert = require('node:assert/strict');
const {
  WGC_WINDOW_FEATURE,
  addDisabledFeature,
  removeFeatureFromSwitchArgs,
  supportsWindows10WindowCaptureCompatibility,
} = require('./windowCaptureCompatibility.cjs');

test('offers legacy window capture only on Windows 10 builds where WGC is supported', () => {
  assert.equal(supportsWindows10WindowCaptureCompatibility('10.0.17763'), true);
  assert.equal(supportsWindows10WindowCaptureCompatibility('10.0.19045'), true);
  assert.equal(supportsWindows10WindowCaptureCompatibility('10.0.22000'), false);
  assert.equal(supportsWindows10WindowCaptureCompatibility('10.0.22631'), false);
  assert.equal(supportsWindows10WindowCaptureCompatibility('6.3.9600'), false);
  assert.equal(supportsWindows10WindowCaptureCompatibility(''), false);
});

test('adds only the window WGC feature while preserving existing disabled features', () => {
  assert.equal(
    addDisabledFeature('FeatureOne, FeatureTwo', WGC_WINDOW_FEATURE),
    'FeatureOne,FeatureTwo,AllowWgcWindowCapturer',
  );
  assert.equal(
    addDisabledFeature('FeatureOne,AllowWgcWindowCapturer', WGC_WINDOW_FEATURE),
    'FeatureOne,AllowWgcWindowCapturer',
  );
});

test('removes the window feature from relaunch arguments without dropping other features', () => {
  assert.deepEqual(
    removeFeatureFromSwitchArgs(
      ['.', '--disable-features=FeatureOne,AllowWgcWindowCapturer,FeatureTwo', '--lang=pt-BR'],
      'disable-features',
      WGC_WINDOW_FEATURE,
    ),
    ['.', '--disable-features=FeatureOne,FeatureTwo', '--lang=pt-BR'],
  );
  assert.deepEqual(
    removeFeatureFromSwitchArgs(
      ['--disable-features', 'AllowWgcWindowCapturer', '--foo'],
      'disable-features',
      WGC_WINDOW_FEATURE,
    ),
    ['--foo'],
  );
  assert.deepEqual(
    removeFeatureFromSwitchArgs(['--disable-features', '--foo'], 'disable-features', WGC_WINDOW_FEATURE),
    ['--disable-features', '--foo'],
  );
  assert.equal(
    addDisabledFeature('AllowWgcScreenCapturer', WGC_WINDOW_FEATURE),
    'AllowWgcScreenCapturer,AllowWgcWindowCapturer',
  );
});
