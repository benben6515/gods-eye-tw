/**
 * Mobile Shell: keep bottom-fixed chrome above the on-screen keyboard.
 *
 * iOS WebKit does not resize the layout viewport when the keyboard opens —
 * position:fixed elements stay put and get covered. The visual viewport,
 * however, does shrink, so the shrink height is exactly the overlap. We
 * translate the dock up by that amount via an INLINE style: the attribution
 * cascade model (creditAttribution.test.mjs) parses stylesheets, not inline
 * styles, so this bypass is deliberate — see ADR 0001.
 *
 * Desktop is a no-op: the visual viewport never shrinks there.
 */
export function installKeyboardOffset({
  viewport = globalThis.visualViewport,
  windowRef = globalThis.window,
  target = () => windowRef?.document?.getElementById('command-dock') ?? null,
} = {}) {
  if (!viewport || !windowRef) return { detach() {} };

  const update = () => {
    const element = target();
    if (!element) return;
    const overlap = Math.max(
      0,
      Math.round(windowRef.innerHeight - viewport.height - viewport.offsetTop),
    );
    if (overlap > 0) {
      element.style.transform = `translateY(${-overlap}px)`;
    } else {
      element.style.removeProperty('transform');
    }
  };

  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  update();

  return {
    detach() {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      target()?.style.removeProperty('transform');
    },
  };
}
