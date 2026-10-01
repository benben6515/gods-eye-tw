import { createTaiwanQuakeLayer } from '../../layers/taiwan/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire the Taiwan quake feed to the application overlay host. */
export function createApplicationTaiwanQuake(options) {
  return createTaiwanQuakeLayer({ overlayHost, ...options });
}
