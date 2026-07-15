import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createExportSettings,
  exportPanelPolicy,
  restoreExportSettings,
  snapshotExportSettings,
  textExportDescriptor,
} from '../js/export-settings.js';

test('export settings snapshot and restore includes every user choice', () => {
  const settings = createExportSettings();
  Object.assign(settings, {
    pngSize: 'source2x',
    gifSize: 'native',
    recordSeconds: '10',
    txtFormat: 'html',
    onCopyText: () => {},
  });
  const snapshot = snapshotExportSettings(settings);
  assert.deepEqual(snapshot, {
    pngSize: 'source2x',
    gifSize: 'native',
    recordSeconds: '10',
    txtFormat: 'html',
  });

  Object.assign(settings, createExportSettings());
  restoreExportSettings(settings, snapshot);
  assert.deepEqual(snapshotExportSettings(settings), snapshot);
  assert.equal(typeof settings.onCopyText, 'function', 'runtime callbacks survive restoration');
});

test('export panel exposes only settings that affect the current source', () => {
  assert.deepEqual(exportPanelPolicy({ sourceType: 'image', animationActive: false }), {
    showGifSize: false,
    durationLabel: null,
  });
  assert.deepEqual(exportPanelPolicy({ sourceType: 'video', animationActive: false }), {
    showGifSize: true,
    durationLabel: null,
  });
  assert.deepEqual(exportPanelPolicy({ sourceType: 'image', animationActive: true }), {
    showGifSize: true,
    durationLabel: 'Video length',
  });
  assert.deepEqual(exportPanelPolicy({ sourceType: 'gen', animationActive: true }), {
    showGifSize: true,
    durationLabel: 'Video length',
  });
  assert.deepEqual(exportPanelPolicy({ sourceType: 'webcam', animationActive: false }), {
    showGifSize: true,
    durationLabel: 'Capture length',
  });
  assert.deepEqual(exportPanelPolicy({ sourceType: 'animated-image', animationActive: false }), {
    showGifSize: true,
    durationLabel: 'Capture length',
  });
  assert.deepEqual(exportPanelPolicy({
    sourceType: 'image',
    animationActive: true,
    oneShotAnimation: true,
  }), {
    showGifSize: false,
    durationLabel: null,
  });
});

test('text export descriptor follows the selected file format', () => {
  assert.deepEqual(textExportDescriptor('plain'), {
    label: 'TXT',
    title: 'Download full-frame ASCII text',
  });
  assert.deepEqual(textExportDescriptor('ansi'), {
    label: 'ANSI',
    title: 'Download full-frame ANSI text',
  });
  assert.deepEqual(textExportDescriptor('html'), {
    label: 'HTML',
    title: 'Download full-frame HTML text',
  });
  assert.deepEqual(textExportDescriptor('interactive'), {
    label: 'WEB',
    title: 'Download click-triggered Gravity HTML',
  });
});
