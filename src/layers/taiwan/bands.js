/**
 * Taiwan AQI presentation bands (環境部 standard scale). The five bands named
 * in the Phase 2 contract plus the hazardous tail, each with the Traditional
 * Chinese label and the presentation color used by markers, labels, legend
 * and selection readouts.
 */

const BANDS = Object.freeze([
  Object.freeze({
    key: 'good',
    max: 50,
    label: '綠',
    name: '良好',
    color: '#00c853',
  }),
  Object.freeze({
    key: 'moderate',
    max: 100,
    label: '黃',
    name: '普通',
    color: '#fdd835',
  }),
  Object.freeze({
    key: 'sensitive',
    max: 150,
    label: '橘',
    name: '對敏感族群不健康',
    color: '#fb8c00',
  }),
  Object.freeze({
    key: 'unhealthy',
    max: 200,
    label: '紅',
    name: '不健康',
    color: '#e53935',
  }),
  Object.freeze({
    key: 'very-unhealthy',
    max: 300,
    label: '紫',
    name: '非常不健康',
    color: '#8e24aa',
  }),
  Object.freeze({
    key: 'hazardous',
    max: Infinity,
    label: '褐',
    name: '危害',
    color: '#795548',
  }),
]);

/** Classify one AQI reading; null readings fall back to the moderate band. */
export function aqiBand(aqi) {
  const value = Number.isFinite(aqi) ? Math.max(0, Math.round(aqi)) : 0;
  return BANDS.find((band) => value <= band.max) || BANDS[BANDS.length - 1];
}

export const AQI_BANDS = BANDS;
