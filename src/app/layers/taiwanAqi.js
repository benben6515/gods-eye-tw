import { createTaiwanAqiLayer } from '../../layers/taiwan/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire the air-quality feed to the application overlay host. */
export function createApplicationTaiwanAqi(options) {
  return createTaiwanAqiLayer({ overlayHost, ...options });
}
