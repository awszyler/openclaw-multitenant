// ============================================================
// i18next Configuration
// Validates: Requirements 9.6
// ============================================================
// Default language: Chinese. Supports switching to English.

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zh from './zh.json';
import en from './en.json';

const LANGUAGE_KEY = 'openclaw_language';

function getSavedLanguage(): string {
  try {
    return localStorage.getItem(LANGUAGE_KEY) ?? 'zh';
  } catch {
    return 'zh';
  }
}

i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en },
  },
  lng: getSavedLanguage(),
  fallbackLng: 'zh',
  interpolation: {
    escapeValue: false, // React already escapes
  },
});

/** Switch language and persist the choice. */
export function changeLanguage(lang: 'zh' | 'en'): void {
  i18n.changeLanguage(lang);
  try {
    localStorage.setItem(LANGUAGE_KEY, lang);
  } catch {
    // Ignore storage errors
  }
}

export default i18n;
