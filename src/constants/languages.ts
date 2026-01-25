export const SUPPORTED_LANGUAGES: Record<string, string> = {
  "en": "English",
  "es": "Spanish",
  "fr": "French",
  "de": "German",
  "it": "Italian",
  "pt": "Portuguese",
  "nl": "Dutch",
  "ru": "Russian",
  "ja": "Japanese",
  "zh": "Chinese",
  "ko": "Korean",
  "ar": "Arabic",
  "hi": "Hindi",
  "tr": "Turkish",
  "pl": "Polish",
  "id": "Indonesian",
  "vi": "Vietnamese",
  "th": "Thai",
  "sv": "Swedish",
  "da": "Danish",
  "fi": "Finnish",
  "no": "Norwegian",
  "cs": "Czech",
  "el": "Greek",
  "he": "Hebrew",
  "ro": "Romanian",
  "hu": "Hungarian",
  "sk": "Slovak",
  "uk": "Ukrainian",
  "ca": "Catalan",
  "bg": "Bulgarian",
  "hr": "Croatian",
  "sr": "Serbian",
  "sl": "Slovenian",
  "et": "Estonian",
  "lv": "Latvian",
  "lt": "Lithuanian",
  "fa": "Persian",
  "ms": "Malay",
  "tl": "Tagalog",
  "sw": "Swahili",
  "ur": "Urdu",
  "bn": "Bengali",
  "ta": "Tamil",
  "te": "Telugu",
  "mr": "Marathi"
};

export const normalizeLanguageCode = (code: string): string => {
  return (code || "").trim().toLowerCase().replace(/_/g, "-");
};

export const getBaseLanguageCode = (code: string): string => {
  const normalized = normalizeLanguageCode(code);
  return normalized.split("-")[0] || normalized;
};

export const areLanguageCodesEquivalent = (left: string, right: string): boolean => {
  const leftNormalized = normalizeLanguageCode(left);
  const rightNormalized = normalizeLanguageCode(right);
  if (!leftNormalized || !rightNormalized) return false;
  if (leftNormalized === rightNormalized) return true;
  return getBaseLanguageCode(leftNormalized) === getBaseLanguageCode(rightNormalized);
};

export const getLanguageName = (code: string): string => {
  const raw = (code || "").trim();
  if (!raw) return raw;

  const normalized = normalizeLanguageCode(raw);
  const base = getBaseLanguageCode(normalized);

  return SUPPORTED_LANGUAGES[normalized] || SUPPORTED_LANGUAGES[base] || raw;
};
