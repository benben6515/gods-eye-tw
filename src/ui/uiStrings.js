/**
 * UI string dictionary (中/EN) — user-facing chrome text outside the
 * recon-style English panel headings. The language follows the same switch
 * as the voice (`voiceLang.js`, localStorage `gev-voice-lang`), so the
 * dock's 中/EN button flips voice + UI + layer names in one tap. Modules
 * must not hardcode CJK literals; everything user-visible lives here (the
 * contract test enforces it).
 */

import { getVoiceLang } from './voiceLang.js';

const STRINGS = {
  zh: {
    // Dock states (mapEventToDock)
    listening: '聆聽中…再點一下送出',
    thinking: '思考中…',
    runningAction: (name) => `執行 ${name}…`,
    speakUnavailable: '（語音播報不可用）',
    voiceError: '語音系統錯誤',
    // Dock chrome
    helpRecord: '點一下開始錄音 · 再點一下送出',
    textPlaceholder: '或直接輸入指令…',
    quickPlaces: '快捷地點',
    expandVoice: '展開語音狀態',
    switched: '語言切換：中文',
    switchTo: 'EN',
    flyTo: (name) => `飛往 ${name}…`,
    // Recording outcomes
    noSpeech: '沒聽到聲音，再試一次。',
    micUnavailable: '麥克風不可用。',
    nothingHeard: '沒有聽到內容（語音語言：中文）。',
    // Player sheet
    sheetHandle: '拖動：下滑關閉，點一下全螢幕',
    // Session fallback
    fallbackReply: '這個指令太複雜了，請拆成幾個步驟再試。',
    // Site gate
    gateSub: '此站僅限授權人員 · clearance required',
    gateTooMany: '嘗試太多次，稍後再試。',
    gateNotSet: '閘門未設定（後端缺少 SITE_GATE_PASSWORD）。',
    gateWrong: '存取碼錯誤。',
    gateBadResponse: '後端回應異常。',
    gateUnreachable: '無法連線後端。',
  },
  en: {
    // Dock states (mapEventToDock)
    listening: 'Listening… tap again to submit',
    thinking: 'Thinking…',
    runningAction: (name) => `Running ${name}…`,
    speakUnavailable: '(voice playback unavailable)',
    voiceError: 'Voice system error',
    // Dock chrome
    helpRecord: 'Tap to record · tap again to submit',
    textPlaceholder: '…or type a command',
    quickPlaces: 'Quick places',
    expandVoice: 'Expand voice status',
    switched: 'Switched to English',
    switchTo: '中文',
    flyTo: (name) => `Flying to ${name}…`,
    // Recording outcomes
    noSpeech: 'No speech detected — try again.',
    micUnavailable: 'Microphone unavailable.',
    nothingHeard: 'Nothing heard (voice language: English).',
    // Player sheet
    sheetHandle: 'Drag down to dismiss · tap for fullscreen',
    // Session fallback
    fallbackReply:
      'That command is too complex — break it into steps and try again.',
    // Site gate
    gateSub: 'Authorized personnel only · clearance required',
    gateTooMany: 'Too many attempts — try again later.',
    gateNotSet: 'Gate not configured (missing SITE_GATE_PASSWORD on backend).',
    gateWrong: 'Access code incorrect.',
    gateBadResponse: 'Unexpected backend response.',
    gateUnreachable: 'Cannot reach the backend.',
  },
};

/** Look up a UI string in the active language (zh default). */
export function t(key, lang = getVoiceLang()) {
  const dict = STRINGS[lang] ?? STRINGS.zh;
  return dict[key] ?? STRINGS.zh[key];
}

export const UI_STRINGS = STRINGS;

/** Quick Places: preset fly-to chips in the expanded dock sheet. */
export const QUICK_PLACES = [
  {
    code: 'TPE 101',
    zh: '台北 101',
    en: 'Taipei 101',
    latitude: 25.033,
    longitude: 121.5654,
    rangeM: 1200,
  },
  {
    code: 'KHH PORT',
    zh: '高雄港',
    en: 'Kaohsiung Port',
    latitude: 22.605,
    longitude: 120.29,
    rangeM: 3500,
  },
  {
    code: 'MZG',
    zh: '澎湖',
    en: 'Penghu',
    latitude: 23.571,
    longitude: 119.57,
    rangeM: 30000,
  },
  {
    code: 'SML',
    zh: '日月潭',
    en: 'Sun Moon Lake',
    latitude: 23.865,
    longitude: 120.928,
    rangeM: 5000,
  },
  {
    code: 'CCK',
    zh: '清泉崗',
    en: 'Cingchuankang',
    latitude: 24.264,
    longitude: 120.621,
    rangeM: 4000,
  },
  {
    code: 'KTNT',
    zh: '墾丁',
    en: 'Kenting',
    latitude: 21.95,
    longitude: 120.79,
    rangeM: 12000,
  },
];

/** The chip/place name in the active language (code stays latin). */
export function placeName(place, lang = getVoiceLang()) {
  return lang === 'en' ? place.en : place.zh;
}
