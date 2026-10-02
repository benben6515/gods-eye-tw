import assert from 'node:assert/strict';
import test from 'node:test';

function makeNode(id) {
  const node = new EventTarget();
  Object.assign(node, {
    id,
    children: [],
    style: { setProperty(name, value) { node.style[name] = value; }, removeProperty(name) { delete node.style[name]; } },
    classList: {
      _set: new Set(),
      add(...names) { for (const n of names) node.classList._set.add(n); },
      remove(...names) { for (const n of names) node.classList._set.delete(n); },
      contains(name) { return node.classList._set.has(name); },
      toggle(name, force) {
        const next = force === undefined ? !node.classList._set.has(name) : force;
        if (next) node.classList._set.add(name);
        else node.classList._set.delete(name);
        return next;
      },
    },
    isConnected: true,
    remove() { node.isConnected = false; },
    setAttribute(name, value) {
      node[`attr-${name}`] = value;
    },
    prepend(child) { node.children.unshift(child); child.parentElement = node; },
    querySelector(selector) {
      const raw = selector.match(/data-(\w[\w-]*)/)?.[1];
      if (!raw) return null;
      const key = raw.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return node.children.find((c) => c.dataset?.[key] !== undefined) ?? null;
    },
  });
  return node;
}

function fakeEnv({ mobile = true } = {}) {
  const listeners = new Map();
  const panel = makeNode('cctv-panel');
  const collapseBtn = {
    dataset: { collapseTarget: 'cctv-panel' },
    clicks: 0,
    click() { this.clicks += 1; },
  };
  panel.children.push(collapseBtn);
  const doc = {
    getElementById: (id) => (id === 'cctv-panel' ? panel : null),
    createElement: (tag) => makeNode(tag),
  };
  const windowRef = {
    matchMedia: (query) => ({ matches: mobile && query === '(max-width: 720px)' }),
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
  };
  return { panel, collapseBtn, doc, windowRef, listeners };
}

const pointer = (y) =>
  Object.assign(new Event('pointerdown'), { clientY: y, pointerId: 1 });

test('drag down past the threshold closes through the app collapse button', async () => {
  const { installPlayerSheet } = await import('./playerSheet.js');
  const env = fakeEnv();
  const handle = installPlayerSheet({ document: env.doc, windowRef: env.windowRef });

  const grab = env.panel.children.find((n) => n.id === 'cctv-sheet-handle');
  assert.ok(grab, 'the handle must prepend itself to the panel');

  grab.dispatchEvent(pointer(0));
  env.listeners.get('pointermove')(pointer(0));
  env.listeners.get('pointermove')(pointer(60));
  env.listeners.get('pointermove')(pointer(130));
  assert.equal(env.panel.style['--player-drag'], '130px', 'the sheet tracks the finger');
  env.listeners.get('pointerup')();

  assert.equal(env.collapseBtn.clicks, 1, 'close rides the app own collapse path');
  assert.equal(env.panel.style['--player-drag'], undefined, 'drag offset resets');
  assert.equal(env.panel.classList.contains('player-dragging'), false);
  handle.detach();
});

test('drag up opens fullscreen; a plain tap toggles it', async () => {
  const { installPlayerSheet } = await import('./playerSheet.js');
  const env = fakeEnv();
  const handle = installPlayerSheet({ document: env.doc, windowRef: env.windowRef });
  const grab = env.panel.children.find((n) => n.id === 'cctv-sheet-handle');

  grab.dispatchEvent(pointer(0));
  env.listeners.get('pointermove')(pointer(-90));
  env.listeners.get('pointerup')();
  assert.equal(env.panel.classList.contains('player-fullscreen'), true, 'swipe up = fullscreen');

  grab.dispatchEvent(pointer(0));
  env.listeners.get('pointerup')();
  assert.equal(env.panel.classList.contains('player-fullscreen'), false, 'tap toggles back');

  assert.equal(env.collapseBtn.clicks, 0, 'neither gesture closes');
  handle.detach();
});

test('small drags spring back and do nothing', async () => {
  const { installPlayerSheet } = await import('./playerSheet.js');
  const env = fakeEnv();
  const handle = installPlayerSheet({ document: env.doc, windowRef: env.windowRef });
  const grab = env.panel.children.find((n) => n.id === 'cctv-sheet-handle');

  grab.dispatchEvent(pointer(0));
  env.listeners.get('pointermove')(pointer(40));
  env.listeners.get('pointerup')();

  assert.equal(env.collapseBtn.clicks, 0);
  assert.equal(env.panel.classList.contains('player-fullscreen'), false);
  handle.detach();
});

test('the gesture layer is inert on desktop', async () => {
  const { installPlayerSheet } = await import('./playerSheet.js');
  const env = fakeEnv({ mobile: false });
  const handle = installPlayerSheet({ document: env.doc, windowRef: env.windowRef });
  const grab = env.panel.children.find((n) => n.id === 'cctv-sheet-handle');

  grab.dispatchEvent(pointer(0));
  env.listeners.get('pointermove')(pointer(200));
  env.listeners.get('pointerup')();

  assert.equal(env.collapseBtn.clicks, 0, 'desktop drags are ignored');
  assert.equal(env.panel.style['--player-drag'], undefined);
  handle.detach();
});
