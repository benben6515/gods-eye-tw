/**
 * Mobile Shell CCTV player sheet (P2).
 *
 * At ≤720px mobile-shell.css turns #cctv-panel into a bottom sheet (~60dvh).
 * position:fixed cannot escape a display:none ancestor, and the panel lives
 * inside a hidden panel stack on mobile — so this module also OWNS the
 * panel's placement: re-parented to <body> while mobile (an observer moves
 * it back if the app's stack logic re-appends it), restored to its original
 * stack slot on desktop. Detach undoes everything.
 *
 * The gesture layer rides a grab handle: drag down past the threshold closes
 * the panel through the app's OWN collapse button (the same path a desktop
 * click takes, so persistence and auto-expand logic stay in sync); drag up —
 * or a plain tap — toggles fullscreen.
 */
const MOBILE_QUERY = '(max-width: 720px)';

export function installPlayerSheet({
  document: documentImpl = document,
  windowRef = globalThis.window,
  panelId = 'cctv-panel',
  closeThresholdPx = 110,
  fullscreenThresholdPx = 70,
} = {}) {
  if (!windowRef?.matchMedia) return { detach() {} };
  const doc = documentImpl;
  let handle = null;
  let drag = null;
  let originalSlot = null; // { parent, next } — desktop restore target

  const panel = () => doc.getElementById(panelId);
  const isMobile = () => windowRef.matchMedia(MOBILE_QUERY).matches;
  const inStack = (node) =>
    node?.parentElement?.id === 'left-panel-stack' ||
    node?.parentElement?.id === 'right-context-rail';

  /** Mobile: the sheet lives on <body>, outside the hidden stacks. */
  const ensurePlacement = () => {
    const owner = panel();
    if (!owner) return;
    if (isMobile()) {
      if (owner.parentElement !== doc.body) {
        if (!originalSlot && owner.parentElement) {
          originalSlot = { parent: owner.parentElement, next: owner.nextElementSibling };
        }
        doc.body.appendChild(owner);
      }
    } else if (originalSlot?.parent?.isConnected) {
      originalSlot.parent.insertBefore(owner, originalSlot.next);
      originalSlot = null;
    }
  };

  // The app moves the panel between stacks at runtime; if it re-appends it
  // into a (hidden) stack while mobile, take it back out.
  const observer =
    typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => {
          if (isMobile() && inStack(panel())) ensurePlacement();
        })
      : null;
  for (const stackId of ['left-panel-stack', 'right-context-rail']) {
    const stack = doc.getElementById(stackId);
    if (stack) observer?.observe(stack, { childList: true });
  }
  const mql = windowRef.matchMedia(MOBILE_QUERY);
  mql.addEventListener?.('change', ensurePlacement);
  ensurePlacement();

  const ensureHandle = () => {
    const owner = panel();
    if (!owner) return null;
    if (!handle || !handle.isConnected) {
      handle = doc.createElement('button');
      handle.id = 'cctv-sheet-handle';
      handle.type = 'button';
      handle.className = 'cctv-sheet-handle';
      handle.setAttribute('aria-label', '拖動：下滑關閉，點一下全螢幕');
      owner.prepend(handle);
    }
    return handle;
  };

  const onPointerDown = (event) => {
    if (!isMobile()) return;
    drag = { startY: event.clientY, dy: 0, moved: false };
    panel()?.classList.add('player-dragging');
    handle?.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event) => {
    if (!drag) return;
    drag.dy = event.clientY - drag.startY;
    if (Math.abs(drag.dy) > 6) drag.moved = true;
    panel()?.style.setProperty(
      '--player-drag',
      `${Math.max(-160, drag.dy)}px`,
    );
  };

  const onPointerUp = () => {
    if (!drag) return;
    const owner = panel();
    owner?.classList.remove('player-dragging');
    owner?.style.removeProperty('--player-drag');
    if (drag.dy > closeThresholdPx) {
      owner?.querySelector('[data-collapse-target]')?.click();
    } else if (drag.dy < -fullscreenThresholdPx) {
      owner?.classList.add('player-fullscreen');
    } else if (!drag.moved) {
      owner?.classList.toggle('player-fullscreen');
    }
    drag = null;
  };

  const start = ensureHandle();
  start?.addEventListener('pointerdown', onPointerDown);
  windowRef.addEventListener('pointermove', onPointerMove);
  windowRef.addEventListener('pointerup', onPointerUp);
  windowRef.addEventListener('pointercancel', onPointerUp);

  return {
    detach() {
      handle?.remove();
      handle = null;
      observer?.disconnect();
      mql.removeEventListener?.('change', ensurePlacement);
      windowRef.removeEventListener('pointermove', onPointerMove);
      windowRef.removeEventListener('pointerup', onPointerUp);
      windowRef.removeEventListener('pointercancel', onPointerUp);
      if (originalSlot?.parent?.isConnected && panel()?.parentElement === doc.body) {
        originalSlot.parent.insertBefore(panel(), originalSlot.next);
      }
      originalSlot = null;
    },
  };
}
