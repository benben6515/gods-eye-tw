import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { ensureSiteGate } from './ui/siteGate.js';
import { taiwanApiBase } from './layers/taiwan/client.js';

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  allowQaRegistration: import.meta.env.DEV,
});

// Boot behind the site gate: nothing expensive (Cesium tiles, ion quota,
// backend proxies) loads until the password clears. ensureSiteGate resolves
// immediately when a stored 7-day token is still usable.
ensureSiteGate({ apiBase: taiwanApiBase() })
  .then(() => application.start())
  .catch((error) => {
    console.error("God's Eye View initialization failed:", error);
    const loaderStatus = document.querySelector('#loading-screen .loader-status');
    loaderStatus.textContent = `Error: ${describeError(error)}`;
    loaderStatus.style.color = '#ff4444';
  });

export { application };
