import test from 'node:test';
import assert from 'node:assert/strict';

import { Viewport } from '../js/view.js';
import {
  MaskEditor,
  brushScreenSize,
  clipSegmentToUnitSquare,
  resolveStrokeOperation,
  touchGestureMetrics,
} from '../js/mask/tools.js';

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach((name) => this.values.add(name)); }
  remove(...names) { names.forEach((name) => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const next = force === undefined ? !this.values.has(name) : !!force;
    if (next) this.values.add(name);
    else this.values.delete(name);
    return next;
  }
}

class FakeElement {
  constructor() {
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.textContent = '';
    this.open = false;
    this.width = 0;
    this.height = 0;
    this.clientWidth = 800;
    this.clientHeight = 600;
    this.style = {};
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.attributes = new Map();
    this.captured = new Set();
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type, event = {}) {
    event.target ||= this;
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name); }
  closest() { return null; }
  getBoundingClientRect() { return { left: 10, top: 20, width: 800, height: 600 }; }
  setPointerCapture(id) { this.captured.add(id); }
  releasePointerCapture(id) { this.captured.delete(id); }
}

function makeElements() {
  const names = [
    'viewport', 'maskButton', 'splitButton', 'status', 'overlay', 'cursor',
    'cursorCore', 'bar', 'priming', 'brushOriginal', 'brushEffect', 'size', 'sizeValue',
    'feather', 'featherValue', 'actionsTrigger', 'actionsMenu', 'toggleGuide',
    'clearMask', 'originalEverywhere', 'done', 'hint',
  ];
  return Object.fromEntries(names.map((name) => [name, new FakeElement()]));
}

function makeView() {
  return {
    zoom: 2,
    output: { width: 400, height: 200 },
    router: null,
    splitSuppressed: false,
    panCalls: [],
    zoomCalls: [],
    setToolRouter(router) { this.router = router; },
    setSplitSuppressed(value) { this.splitSuppressed = value; },
    onTransform(listener) { this.transformListener = listener; return () => { this.transformListener = null; }; },
    panBy(dx, dy) { this.panCalls.push([dx, dy]); },
    zoomBy(factor, x, y) { this.zoomCalls.push([factor, x, y]); },
    clientToContent(clientX, clientY) {
      return { viewportX: clientX - 10, viewportY: clientY - 20, x: clientX, y: clientY };
    },
    clientToNormalized(clientX, clientY) {
      return {
        viewportX: clientX - 10,
        viewportY: clientY - 20,
        x: clientX,
        y: clientY,
        u: clientX / 100,
        v: clientY / 100,
        inside: clientX >= 0 && clientX <= 100 && clientY >= 0 && clientY <= 100,
      };
    },
  };
}

function pointer(overrides = {}) {
  return {
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    clientX: 20,
    clientY: 20,
    altKey: false,
    preventDefault() {},
    ...overrides,
  };
}

function key(code, overrides = {}) {
  return {
    code,
    repeat: false,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    target: null,
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
    ...overrides,
  };
}

test('unit-square clipping preserves the visible edge crossing', () => {
  const clipped = clipSegmentToUnitSquare({ u: -0.5, v: 0.25 }, { u: 0.5, v: 0.75 });
  assert.deepEqual(clipped, [{ u: 0, v: 0.5 }, { u: 0.5, v: 0.75 }]);
  assert.equal(clipSegmentToUnitSquare({ u: -2, v: -2 }, { u: -1, v: -1 }), null);
});

test('cursor geometry follows source-space roundness under stretched output', () => {
  const size = brushScreenSize({
    diameterShortNorm: 0.1,
    sourceWidth: 1000,
    sourceHeight: 500,
    outputWidth: 800,
    outputHeight: 500,
    zoom: 2,
  });
  assert.equal(size.width, 80);
  assert.equal(size.height, 100);
});

test('stroke operation maps direct visual targets onto internal placement', () => {
  assert.equal(resolveStrokeOperation(pointer(), 'original', 'outside', false), 'add');
  assert.equal(resolveStrokeOperation(pointer(), 'effect', 'outside', false), 'erase');
  assert.equal(resolveStrokeOperation(pointer(), 'original', 'inside', false), 'erase');
  assert.equal(resolveStrokeOperation(pointer(), 'effect', 'inside', false), 'add');
});

test('Option, right button, and pen eraser temporarily paint the opposite result', () => {
  assert.equal(resolveStrokeOperation(pointer({ altKey: true }), 'original', 'outside', false), 'erase');
  assert.equal(resolveStrokeOperation(pointer({ button: 2 }), 'original', 'outside', false), 'erase');
  assert.equal(resolveStrokeOperation(pointer({ pointerType: 'pen', button: 5 }), 'original', 'outside', false), 'erase');
  assert.equal(resolveStrokeOperation(pointer(), 'effect', 'inside', true), 'erase');
});

test('touch gesture metrics use centroid and stable nonzero distance', () => {
  assert.deepEqual(touchGestureMetrics([
    { clientX: 0, clientY: 10 },
    { clientX: 20, clientY: 10 },
  ]), { x: 10, y: 10, distance: 20 });
});

test('MaskEditor locks stroke operation and distinguishes commit from rollback', () => {
  const view = makeView();
  const elements = makeElements();
  const committed = [];
  let rolledBack = 0;
  const editor = new MaskEditor({
    view,
    root: null,
    elements,
    callbacks: {
      onStrokeCommitted: (stroke) => committed.push(stroke),
      onStrokeRolledBack: () => { rolledBack++; },
    },
  });
  editor.sync({ sourceWidth: 1000, sourceHeight: 500, outputWidth: 400, outputHeight: 200 });
  elements.splitButton.classList.add('active');
  elements.splitButton.setAttribute('aria-pressed', 'true');
  editor.open();
  assert.equal(view.splitSuppressed, true);
  assert.equal(elements.splitButton.disabled, true);
  assert.equal(elements.splitButton.classList.contains('active'), false, 'suppressed Split stops looking active');

  const down = pointer();
  assert.equal(editor.pointerDown(down, view.clientToNormalized(20, 20)), 'tool');
  editor.handleKeyDown(key('AltLeft'));
  editor.pointerUp(pointer({ clientX: 40, clientY: 40 }), view.clientToNormalized(40, 40), view);
  assert.equal(committed.length, 1);
  assert.equal(committed[0].operation, 'add', 'operation is captured at pointerdown');
  assert.ok(committed[0].points instanceof Float32Array);

  editor.pointerDown(pointer({ pointerId: 2 }), view.clientToNormalized(30, 30));
  editor.handleKeyDown(key('Escape'));
  assert.equal(rolledBack, 1);
  assert.equal(editor.editing, false);
  assert.equal(view.splitSuppressed, false);
  assert.equal(elements.splitButton.classList.contains('active'), true, 'Split appearance returns after Mask closes');
  editor.destroy();
});

test('MaskEditor commits on cancellation/export and rolls back on source replacement', () => {
  const view = makeView();
  const elements = makeElements();
  let commits = 0;
  let rollbacks = 0;
  const editor = new MaskEditor({
    view,
    root: null,
    elements,
    callbacks: {
      onStrokeCommitted: () => { commits++; },
      onStrokeRolledBack: () => { rollbacks++; },
    },
  });
  editor.sync({ sourceWidth: 100, sourceHeight: 100, outputWidth: 100, outputHeight: 100 });
  editor.open();
  editor.pointerDown(pointer(), view.clientToNormalized(20, 20));
  editor.pointerCancel(pointer());
  assert.equal(commits, 1);
  editor.pointerDown(pointer({ pointerId: 2 }), view.clientToNormalized(20, 20));
  editor.beforeSourceChange();
  assert.equal(rollbacks, 1);
  editor.pointerDown(pointer({ pointerId: 3 }), view.clientToNormalized(20, 20));
  assert.equal(editor.beforeExport(), true);
  assert.equal(commits, 2);
  editor.destroy();
});

test('MaskEditor cancelDraft rolls back the active draft and disarms its pointer', () => {
  const view = makeView();
  const elements = makeElements();
  let commits = 0;
  let rollbacks = 0;
  const editor = new MaskEditor({
    view,
    root: null,
    elements,
    callbacks: {
      onStrokeCommitted: () => { commits++; },
      onStrokeRolledBack: () => { rollbacks++; },
    },
  });
  editor.sync({ sourceWidth: 100, sourceHeight: 100, outputWidth: 100, outputHeight: 100 });
  editor.open();
  editor.pointerDown(pointer(), view.clientToNormalized(20, 20));

  assert.equal(editor.cancelDraft(), true);
  assert.equal(rollbacks, 1);
  assert.equal(editor.hasDraft, false);
  editor.pointerUp(pointer({ clientX: 40, clientY: 40 }), view.clientToNormalized(40, 40), view);
  assert.equal(commits, 0, 'a cancelled pointer cannot later commit');
  assert.equal(editor.cancelDraft(), false, 'cancelling with no draft is a no-op');
  assert.equal(rollbacks, 1);
  editor.destroy();
});

test('MaskEditor promotes a second touch to pan/pinch without an accidental dot', () => {
  const view = makeView();
  const elements = makeElements();
  let commits = 0;
  let rollbacks = 0;
  const editor = new MaskEditor({
    view,
    root: null,
    elements,
    callbacks: {
      onStrokeCommitted: () => { commits++; },
      onStrokeRolledBack: () => { rollbacks++; },
    },
  });
  editor.sync({ sourceWidth: 100, sourceHeight: 100, outputWidth: 100, outputHeight: 100 });
  editor.open();
  const first = pointer({ pointerId: 1, pointerType: 'touch', clientX: 20, clientY: 20 });
  const second = pointer({ pointerId: 2, pointerType: 'touch', clientX: 40, clientY: 20 });
  assert.equal(editor.pointerDown(first, view.clientToNormalized(20, 20)), 'tool');
  assert.equal(editor.pointerDown(second, view.clientToNormalized(40, 20)), 'tool');
  assert.equal(rollbacks, 1);
  editor.pointerMove(pointer({ pointerId: 2, pointerType: 'touch', clientX: 50, clientY: 20 }), null, view);
  assert.ok(view.panCalls.length > 0);
  assert.ok(view.zoomCalls.length > 0);
  editor.pointerUp(second, null, view);
  editor.pointerUp(first, null, view);
  assert.equal(commits, 0);
  editor.destroy();
});

test('MaskEditor keyboard routing uses physical bracket keys and repeat guards', () => {
  const view = makeView();
  const elements = makeElements();
  let compare = [];
  const editor = new MaskEditor({
    view,
    root: null,
    elements,
    callbacks: { onCompareRequested: (active) => compare.push(active) },
  });
  assert.equal(editor.handleKeyDown(key('KeyB', { metaKey: true })), false);
  assert.equal(editor.editing, false, 'modified B remains available to the host');
  assert.equal(editor.handleKeyDown(key('KeyB')), true);
  assert.equal(editor.editing, true);
  editor.handleKeyDown(key('KeyB', { repeat: true }));
  assert.equal(editor.editing, true, 'repeated B cannot oscillate editor state');
  const oldFeather = editor.feather;
  editor.handleKeyDown(key('BracketRight', { shiftKey: true, repeat: true }));
  assert.ok(editor.feather > oldFeather, 'range shortcuts may repeat');
  const featherAfterShortcut = editor.feather;
  assert.equal(editor.handleKeyDown(key('BracketRight', { ctrlKey: true })), false);
  assert.equal(editor.feather, featherAfterShortcut, 'modified brackets remain available to the host');
  const placementBeforeChord = editor.placement;
  const brushBeforeChord = editor.brushTarget;
  assert.equal(editor.handleKeyDown(key('KeyX', { altKey: true })), false);
  assert.equal(editor.placement, placementBeforeChord, 'Option-X cannot change mask placement');
  assert.equal(editor.brushTarget, brushBeforeChord, 'Option-X cannot change brush target');
  assert.equal(editor.handleKeyDown(key('AltLeft', { altKey: true })), true);
  assert.equal(editor.optionHeld, true, 'the bare Option key temporarily paints the opposite result');
  assert.equal(editor.handleKeyDown(key('KeyE', { altKey: true })), false);
  editor.handleKeyUp(key('AltLeft'));
  assert.equal(editor.optionHeld, false);
  editor.handleKeyDown(key('KeyX'));
  assert.notEqual(editor.brushTarget, brushBeforeChord, 'X swaps the direct brush target');
  editor.handleKeyDown(key('KeyC'));
  editor.handleKeyUp(key('KeyC'));
  assert.deepEqual(compare, [true, false]);
  const field = { closest: () => field };
  assert.equal(editor.handleKeyDown(key('KeyE', { target: field })), false);
  editor.destroy();
});

test('releasing Option immediately clears the temporary opposite cursor', () => {
  const view = makeView();
  const elements = makeElements();
  const editor = new MaskEditor({ view, root: null, elements });
  editor.sync({ sourceWidth: 100, sourceHeight: 100, outputWidth: 100, outputHeight: 100 });
  editor.open();
  editor.pointerHover(pointer({ altKey: true }), view.clientToNormalized(20, 20));
  assert.equal(elements.cursor.classList.contains('opposite'), true);
  editor.handleKeyUp(key('AltLeft'));
  assert.equal(elements.cursor.classList.contains('opposite'), false);
  editor.destroy();
});

test('Escape in the actions menu dismisses only the menu', () => {
  const view = makeView();
  const elements = makeElements();
  const editor = new MaskEditor({ view, root: null, elements });
  editor.open();
  elements.actionsTrigger.dispatch('click');
  assert.equal(elements.actionsMenu.hidden, false);

  const event = key('', { key: 'Escape' });
  elements.actionsMenu.dispatch('keydown', event);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true, 'the app-level Escape handler must not also see this key');
  assert.equal(elements.actionsMenu.hidden, true);
  assert.equal(editor.editing, true, 'dismissing More keeps the Mask editor open');
  editor.destroy();
});

test('Viewport preserves legacy pan when inactive and routes claimed pointers once', () => {
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  const fakeWindow = new FakeElement();
  const fakeDocument = new FakeElement();
  fakeDocument.visibilityState = 'visible';
  globalThis.window = fakeWindow;
  globalThis.document = fakeDocument;
  try {
    const viewportEl = new FakeElement();
    const stack = new FakeElement();
    const output = new FakeElement();
    output.width = 400;
    output.height = 200;
    const divider = new FakeElement();
    const comparison = new FakeElement();
    comparison.hidden = true;
    const view = new Viewport({ viewport: viewportEl, stack, output, divider, comparison });
    view.setReferenceSize(800, 400);
    view.zoom = 2;
    assert.equal(view.displayZoom(), 1, 'zoom readout is relative to source pixels, not work-canvas pixels');

    view.setSplit(true);
    assert.equal(divider.hidden, false);
    assert.equal(comparison.hidden, false);
    assert.equal(divider.getAttribute('aria-valuenow'), '50');
    let splitChanges = 0;
    view.onSplitDrag = () => { splitChanges++; };
    divider.dispatch('keydown', key('', { key: 'ArrowRight' }));
    assert.equal(view.splitFrac, 0.52);
    assert.equal(divider.getAttribute('aria-valuenow'), '52');
    divider.dispatch('keydown', key('', { key: 'ArrowLeft', shiftKey: true }));
    assert.ok(Math.abs(view.splitFrac - 0.42) < 1e-9);
    divider.dispatch('keydown', key('', { key: 'Home' }));
    assert.equal(view.splitFrac, 0);
    divider.dispatch('keydown', key('', { key: 'End' }));
    assert.equal(view.splitFrac, 1);
    assert.equal(splitChanges, 4);
    view.setSplitSuppressed(true);
    assert.equal(divider.hidden, true);
    assert.equal(comparison.hidden, true, 'suppression hides the comparison image as well as its divider');
    view.setSplitSuppressed(false);
    assert.equal(divider.hidden, false);
    assert.equal(comparison.hidden, false, 'ending suppression restores an enabled split');
    view.setSplit(false);
    assert.equal(divider.hidden, true);
    assert.equal(comparison.hidden, true);

    const event = pointer({ clientX: 30, clientY: 40, target: viewportEl });
    viewportEl.dispatch('pointerdown', event);
    viewportEl.dispatch('pointermove', pointer({ clientX: 50, clientY: 70, target: viewportEl }));
    viewportEl.dispatch('pointerup', pointer({ clientX: 50, clientY: 70, target: viewportEl }));
    assert.equal(view.tx, 20);
    assert.equal(view.ty, 30);

    const routed = [];
    view.setToolRouter({
      pointerDown: () => 'tool',
      pointerMove: () => routed.push('move'),
      pointerUp: () => routed.push('up'),
    });
    const before = [view.tx, view.ty];
    viewportEl.dispatch('pointerdown', pointer({ pointerId: 4, target: viewportEl }));
    viewportEl.dispatch('pointermove', pointer({ pointerId: 4, clientX: 80, target: viewportEl }));
    viewportEl.dispatch('pointerup', pointer({ pointerId: 4, clientX: 80, target: viewportEl }));
    assert.deepEqual(routed, ['move', 'up']);
    assert.deepEqual([view.tx, view.ty], before, 'claimed tool drag does not also pan');
  } finally {
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  }
});
