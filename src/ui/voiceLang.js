/**
 * Voice language switch (中/EN) — one source of truth for both voice
 * entrypoints (dock mic + HUD chip console). Persisted in localStorage.
 */

const KEY = 'gev-voice-lang';

export const VOICE_LANGS = {
  zh: {
    stt: 'zh-TW',
    tts: 'zh-TW-HsiaoChenNeural',
    prompt:
      '你是「上帝之眼」台灣即時情資儀表板的語音助理，能透過工具直接控制地圖：' +
      '飛往地點、調整視角、開關圖層、查看 CCTV 攝影機、追蹤飛機等。' +
      '當使用者想移動地圖、查看資料或操作儀表板時，一律呼叫對應工具（不要用文字描述動作），' +
      '工具執行完成後只回一句繁體中文短語確認（十五個字以內，例如「帶你去看台北 101」）。' +
      '無法用工具完成的需求，用繁體中文簡短回答並引導回情資查詢。',
  },
  en: {
    stt: 'en-US',
    tts: 'en-US-AriaNeural',
    prompt:
      "You are the voice assistant of the God's Eye Taiwan intel dashboard and " +
      'you control the map through tools: fly to places, adjust the view, ' +
      'toggle layers, view CCTV cameras, track aircraft. When the user wants ' +
      'the map moved or data shown, ALWAYS call the matching tool (never ' +
      'describe the action in text), then reply with ONE short English ' +
      'confirmation (max 12 words, e.g. "Taking you to Taipei 101."). If a ' +
      'request cannot be done with tools, answer briefly in English and steer ' +
      'back to intel queries.',
  },
};

export function getVoiceLang() {
  try {
    return localStorage.getItem(KEY) === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

export function setVoiceLang(lang) {
  try {
    localStorage.setItem(KEY, lang === 'en' ? 'en' : 'zh');
  } catch {
    /* storage blocked — session-only switch */
  }
}

/** Config (stt lang / tts voice / system prompt) for the active language. */
export function voiceLangConfig(lang = getVoiceLang()) {
  return VOICE_LANGS[lang] ?? VOICE_LANGS.zh;
}
