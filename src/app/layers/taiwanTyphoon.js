import { createTaiwanTyphoonLayer } from '../../layers/taiwan/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire the typhoon track feed to the application overlay host. */
export function createApplicationTaiwanTyphoon(options) {
  return createTaiwanTyphoonLayer({ overlayHost, ...options });
}
