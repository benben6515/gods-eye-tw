# Gods-Eye-TW

The Taiwan "god's eye" 3D recon map: Cesium globe + live data layers + voice control. One codebase, two layout worlds split by the 720px breakpoint.

## Language

### Layout

**Desktop Chrome**:
The full tactical overlay set — title bar, globe actions, left panel stack, right context rail, intel-HUD decorations, command dock.
_Avoid_: desktop layout, full UI

**Mobile Shell**:
The map-first phone layout that replaces Desktop Chrome at ≤720px: one collapsed dock row, one control-drawer entry point, everything else is map.
_Avoid_: responsive layout, mobile view

**Command Dock**:
The bottom command surface on desktop (LOCATION tray + voice + VISUAL PRESETS tray).
_Avoid_: toolbar, bottom bar

**Bottom Sheet Dock**:
The mobile dock: a single row [mic][text input][expand] that expands upward for status, language toggle, and Quick Places.
_Avoid_: voice dock (that is the inner voice control), command dock (desktop)

**Control Drawer**:
The full-screen mobile sheet holding every Desktop Chrome control that is not the dock. Nothing stays strewn over the map.
_Avoid_: settings modal, panel stack

**Player Sheet**:
The mobile CCTV player: slides up to ~60% height; swipe up for fullscreen, swipe down to close.
_Avoid_: video panel (desktop left-stack panel)

**Quick Places**:
Preset fly-to chips shown in the expanded Bottom Sheet Dock.
_Avoid_: bookmarks, favorites

**Intel HUD**:
The decorative corner/bars overlay around the map edges. Not interactive.

**Cockpit**:
The full-screen flight-instrument mode. A separate world with its own layout rules; intentionally not part of the Mobile Shell work.

### Voice

**Audio Unlock**:
Playing a silent sound on the user's first mic tap so later TTS replies pass iOS autoplay policy; failure degrades to text reply plus a replay button.
_Avoid_: autoplay hack, sound unlock

**Input Zoom**:
iOS auto-zooms the whole page when an input with font-size < 16px gets focus, and does not reliably zoom back out. All mobile inputs keep ≥16px to prevent it.
_Avoid_: keyboard bug, zoom glitch
