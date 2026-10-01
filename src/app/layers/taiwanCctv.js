import { createTaiwanCctvLayer } from '../../layers/taiwan/index.js';
/** Wire the TDX roadside CCTV family to the running document. */
export function createApplicationTaiwanCctv(options) {
  return createTaiwanCctvLayer(options);
}
