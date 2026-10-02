import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
const read = (relative) =>
  fs.readFileSync(new URL(relative, import.meta.url), 'utf8');

const shell = read('./styles/mobile-shell.css');
const index = read('../../index.html');
const styleEntry = read('../../style.css');

// ── Entry points ─────────────────────────────────────────────────────────────

test('the viewport opts into device safe areas', () => {
  assert.match(
    index,
    /<meta name="viewport" content="[^"]*viewport-fit=cover[^"]*"\s*\/>/,
    'home-indicator insets need viewport-fit=cover',
  );
});

test('the Mobile Shell is the last word in the cascade and the old pass is gone', () => {
  const imports = [...styleEntry.matchAll(/@import\s+'([^']+)'/g)].map(
    (match) => match[1],
  );
  assert.ok(imports.length > 0, 'style.css lost its imports');
  assert.equal(
    imports.at(-1),
    './src/ui/styles/mobile-shell.css',
    'mobile-shell.css must be imported last — it wins cascade ties against cyber.css',
  );
  assert.ok(
    !imports.some((entry) => entry.includes('responsive.css')),
    'responsive.css import survived — ADR 0001 removed that pass',
  );
  assert.ok(
    !fs.existsSync(new URL('../src/ui/styles/responsive.css', import.meta.url)),
    'responsive.css still exists — ADR 0001 removed that pass',
  );
});

// ── Bottom Sheet Dock ────────────────────────────────────────────────────────

test('≤720px the dock collapses to a single voice row', () => {
  assert.match(
    shell,
    /@media \(max-width: 720px\)\s*\{[\s\S]*?#command-dock\s*\{[^}]*grid-template-areas:\s*'voice'/,
    'the dock must become a one-cell grid',
  );
  assert.match(
    shell,
    /#command-dock > #location-bar,\s*#command-dock > #control-panel\s*\{[^}]*display:\s*none;/,
    'LOCATION and VISUAL PRESETS trays must hide (Control Drawer re-homes them in P2)',
  );
});

test('the mobile mic and input are real touch targets', () => {
  assert.match(
    shell,
    /#command-dock #gev-voice-button\s*\{[^}]*height:\s*44px;/,
    'the mic button must be ≥44px tall',
  );
  assert.match(
    shell,
    /#command-dock #gev-voice-text-input\s*\{[^}]*font-size:\s*16px;/,
    '16px is the Input Zoom floor — iOS auto-zooms the page below it',
  );
  assert.match(
    shell,
    /#command-dock #gev-voice-text-input\s*\{[^}]*height:\s*44px;/,
  );
});

test('the expand affordance is mobile-only', () => {
  assert.match(
    shell,
    /\.gev-voice-expand\s*\{[^}]*display:\s*none;/,
    'desktop must not render the expand button',
  );
  assert.match(
    shell,
    /@media \(max-width: 720px\)\s*\{[\s\S]*?#command-dock \.gev-voice-expand\s*\{[^}]*display:\s*flex;/,
  );
});

test('the dock expand wiring exists end to end', () => {
  const control = read('../../src/voice/control.js');
  assert.match(control, /id="gev-voice-expand"/, 'the button must exist');
  assert.match(
    control,
    /expandButton:\s*root\.querySelector\('#gev-voice-expand'\)/,
    'the ui handle must expose it',
  );
  const dock = read('./voiceDock.js');
  assert.match(dock, /classList\.toggle\('dock-expanded'/);
  assert.match(dock, /collapseDock\(\);/, 'submitted commands collapse the sheet');
});

// ── Keyboard offset ──────────────────────────────────────────────────────────

test('keyboard offset translates the dock by the visual-viewport overlap', async () => {
  const listeners = new Map();
  const viewport = {
    height: 800,
    offsetTop: 0,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
  };
  const dock = {
    style: {
      transform: '',
      removeProperty(prop) {
        this[prop] = '';
      },
    },
  };
  const windowRef = {
    innerHeight: 800,
    document: { getElementById: (id) => (id === 'command-dock' ? dock : null) },
  };
  const { installKeyboardOffset } = await import('./keyboardOffset.js');
  const handle = installKeyboardOffset({ viewport, windowRef });

  assert.equal(dock.style.transform, '', 'no keyboard, no offset');

  viewport.height = 420; // keyboard opens
  listeners.get('resize')();
  assert.equal(dock.style.transform, 'translateY(-380px)');

  viewport.offsetTop = 80; // user scrolled the visual viewport
  listeners.get('scroll')();
  assert.equal(dock.style.transform, 'translateY(-300px)');

  viewport.height = 900; // keyboard closed, viewport taller than layout
  listeners.get('resize')();
  assert.equal(dock.style.transform, '', 'negative overlap clamps to no offset');

  handle.detach();
  assert.equal(listeners.size, 0, 'detach removes every listener');
});

test('keyboard offset is applied inline, never in the modelled stylesheet', () => {
  // The attribution cascade model (creditAttribution.test.mjs) guards
  // `transform` on #command-dock inside stylesheets. The keyboard offset is
  // deliberately an inline style — keep it that way.
  assert.doesNotMatch(
    shell,
    /#command-dock\s*\{[^}]*transform:\s*translate/,
    'shell must not translate the dock; keyboardOffset.js owns that inline',
  );
});

// ── Site gate ────────────────────────────────────────────────────────────────

test('the site-gate password input keeps the 16px Input Zoom floor', () => {
  const gate = read('./siteGate.js');
  assert.match(
    gate,
    /\.gev-gate-input\s*\{[^}]*font:\s*16px /,
    'a 13px gate input auto-zooms the whole page on focus',
  );
});
