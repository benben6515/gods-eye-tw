/**
 * Resolve one `scene.pick()` result to a Taiwan-family entity id.
 *
 * Cesium entity picks surface the Entity OBJECT on `picked.id`, while
 * primitive picks carry the string on `picked.primitive.id`; both forms must
 * resolve to the same `${prefix}:${id}` identity (see data/pickRegistry.js for
 * the canonical unwrapping rules this mirrors).
 * @param {object|null|undefined} picked - `scene.pick()` result.
 * @param {string} prefix - Owning layer's entity-id prefix, e.g. 'taiwan-quake:'.
 * @returns {string|null} The id after the prefix, or null when not ours.
 */
export function pickEntityId(picked, prefix) {
  const candidates = [picked?.id, picked?.primitive?.id];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.startsWith(prefix)) {
      return candidate.slice(prefix.length);
    }
    if (
      candidate &&
      typeof candidate === 'object' &&
      typeof candidate.id === 'string' &&
      candidate.id.startsWith(prefix)
    ) {
      return candidate.id.slice(prefix.length);
    }
  }
  return null;
}
