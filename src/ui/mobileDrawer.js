/**
 * Mobile Shell control drawer (P2).
 *
 * The drawer is CSS-first by design: opening it just sets
 * `body.mobile-drawer-open`, and mobile-shell.css turns the two existing
 * panel stacks into one full-screen scroll sheet. No DOM re-parenting —
 * the rail engines, share-link panel state and position controls keep
 * owning their nodes (see ADR 0001 and CONTEXT.md "Control Drawer").
 *
 * This module owns only the chrome: the entry button on the map glass and
 * the drawer's header bar with its close control.
 */
const CLOSE_HTML = `
  <span class="mobile-drawer-title">CONTROL</span>
  <button id="mobile-drawer-close" class="mobile-drawer-close" type="button" aria-label="Close controls">
    <span class="material-symbols-outlined" aria-hidden="true">close</span>
  </button>
`;

export function installMobileDrawer({
  document: documentImpl = document,
  windowRef = globalThis.window,
} = {}) {
  if (!windowRef?.matchMedia) return { detach() {} };
  const body = documentImpl.body;

  const toggle = documentImpl.createElement('button');
  toggle.id = 'mobile-drawer-toggle';
  toggle.type = 'button';
  toggle.className = 'mobile-only';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'mobile-drawer-header');
  toggle.setAttribute('aria-label', 'Open controls');
  toggle.innerHTML =
    '<span class="material-symbols-outlined" aria-hidden="true">tune</span>';

  const header = documentImpl.createElement('header');
  header.id = 'mobile-drawer-header';
  header.innerHTML = CLOSE_HTML;

  const isOpen = () => body.classList.contains('mobile-drawer-open');
  const setOpen = (open) => {
    body.classList.toggle('mobile-drawer-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    if (open) header.querySelector('#mobile-drawer-close')?.focus();
  };

  toggle.addEventListener('click', () => setOpen(!isOpen()));
  header
    .querySelector('#mobile-drawer-close')
    ?.addEventListener('click', () => setOpen(false));
  const onKeyDown = (event) => {
    if (event.key === 'Escape' && isOpen()) setOpen(false);
  };
  windowRef.addEventListener('keydown', onKeyDown);

  body.append(toggle, header);

  return {
    detach() {
      windowRef.removeEventListener('keydown', onKeyDown);
      toggle.remove();
      header.remove();
      body.classList.remove('mobile-drawer-open');
    },
  };
}
