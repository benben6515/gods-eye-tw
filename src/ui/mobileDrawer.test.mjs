import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (relative) =>
  fs.readFileSync(new URL(relative, import.meta.url), 'utf8');

function makeNode(tag = 'div') {
  const node = new EventTarget();
  Object.assign(node, {
    tagName: tag.toUpperCase(),
    children: [],
    dataset: {},
    style: {},
    hidden: false,
    textContent: '',
    className: '',
    isConnected: true,
    classList: {
      _set: new Set(),
      add(...names) {
        for (const name of names) node.classList._set.add(name);
      },
      remove(...names) {
        for (const name of names) node.classList._set.delete(name);
      },
      contains(name) {
        return node.classList._set.has(name);
      },
      toggle(name, force) {
        const next = force === undefined ? !node.classList._set.has(name) : force;
        if (next) node.classList._set.add(name);
        else node.classList._set.delete(name);
        return next;
      },
    },
    appendChild(child) {
      node.children.push(child);
      child.parentElement = node;
      return child;
    },
    append(...kids) {
      for (const kid of kids) node.appendChild(kid);
    },
    remove() {
      node.isConnected = false;
      node.parentElement?.children.splice(
        node.parentElement.children.indexOf(node),
        1,
      );
    },
    setAttribute(name, value) {
      node[`attr-${name}`] = value;
    },
    getAttribute(name) {
      return node[`attr-${name}`] ?? null;
    },
    focus() {
      node.focused = true;
    },
    closest(selector) {
      const id = selector.match(/^#([\w-]+)/)?.[1];
      if (!id || node.id === id) return node;
      return node.parentElement?.closest(selector) ?? null;
    },
    querySelector(selector) {
      const id = selector.match(/^#([\w-]+)$/)?.[1];
      const find = (list) => {
        for (const child of list) {
          if (id && child.id === id) return child;
          const deep = find(child.children ?? []);
          if (deep) return deep;
        }
        return null;
      };
      return find(node.children);
    },
  });
  Object.defineProperty(node, 'innerHTML', {
    set(html) {
      // Same convention as voiceDock.test: resolve id="..." into children.
      for (const match of html.matchAll(/id="([^"]+)"/g)) {
        const child = makeNode('div');
        child.id = match[1];
        node.appendChild(child);
      }
    },
  });
  return node;
}

function fakeDocument() {
  const body = makeNode('body');
  return {
    body,
    createElement: (tag) => makeNode(tag),
    getElementById: (id) => (id === 'gev-voice-control' ? null : null),
  };
}

function fakeWindow() {
  const listeners = new Map();
  return {
    listeners,
    matchMedia: () => ({ matches: true }),
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
  };
}

const settle = async (turns = 3) => {
  for (let i = 0; i < turns; i += 1) await new Promise((r) => setImmediate(r));
};

test('the drawer chrome mounts, opens, and closes through every path', async () => {
  const { installMobileDrawer } = await import('./mobileDrawer.js');
  const doc = fakeDocument();
  const windowRef = fakeWindow();
  const handle = installMobileDrawer({ document: doc, windowRef });

  const toggle = doc.body.children.find((n) => n.id === 'mobile-drawer-toggle');
  const header = doc.body.children.find((n) => n.id === 'mobile-drawer-header');
  assert.ok(toggle && header, 'toggle and header must mount into body');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');

  toggle.dispatchEvent(new Event('click'));
  assert.ok(doc.body.classList.contains('mobile-drawer-open'), 'toggle opens');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(header.querySelector('#mobile-drawer-close').focused, true,
    'focus moves to the close control');

  header.querySelector('#mobile-drawer-close').dispatchEvent(new Event('click', { bubbles: true }));
  assert.equal(doc.body.classList.contains('mobile-drawer-open'), false, 'close button closes');

  toggle.dispatchEvent(new Event('click'));
  windowRef.listeners.get('keydown')({ key: 'Escape' });
  assert.equal(doc.body.classList.contains('mobile-drawer-open'), false, 'Escape closes');

  handle.detach();
  assert.equal(doc.body.children.includes(toggle), false, 'detach unmounts');
  assert.equal(doc.body.classList.contains('mobile-drawer-open'), false);
  await settle();
});

test('the drawer is CSS-first and mobile-only (contract)', () => {
  const shell = read('./styles/mobile-shell.css');
  assert.match(shell, /#mobile-drawer-toggle,\s*#mobile-drawer-header\s*\{[^}]*display:\s*none;/,
    'desktop must not render drawer chrome');
  assert.match(shell, /@media \(max-width: 720px\)\s*\{[\s\S]*?body\.mobile-drawer-open\s*\{[^}]*overflow-y:\s*auto;/,
    'the body becomes the scroll sheet');
  assert.match(shell, /body\.mobile-drawer-open #left-panel-stack,\s*body\.mobile-drawer-open #right-context-rail\s*\{[^}]*position:\s*static;/,
    'the stacks flow, no re-parenting');
  assert.match(shell, /body\.mobile-drawer-open #right-context-rail > \[data-panel-id\]\.collapsed\s*\{[^}]*display:\s*block;/,
    'exclusive pass must not hide collapsed panels inside the drawer');
});
