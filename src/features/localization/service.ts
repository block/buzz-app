import i18next, { type TFunction } from "i18next";
import { initReactI18next } from "react-i18next";

export const appLocales = ["en-US", "pt-BR"] as const;
export type AppLocale = (typeof appLocales)[number];

const storageKey = "buzz.language";

export const translationResources = {
  "en-US": {
    translation: {
      "shell.skipToContent": "Skip to content",
      "shell.pages": "Pages",
      "shell.home": "Home",
      "shell.messages": "Messages",
      "shell.projects": "Projects",
      "shell.findPage": "Find a page",
      "shell.findPagePlaceholder": "Find a page…",
      "shell.closeSearch": "Close search",
      "shell.noMatchingPages": "No matching pages.",
      "shell.yourProfile": "Your profile",
      "shell.yourAccount": "Your account",
      "shell.settings": "Settings",
      "home.tagline": "A little space for everything.",
      "home.title": "Make yourself at home.",
      "home.customize": "Make it yours",
      "settings.title": "Settings",
      "settings.sections": "Settings sections",
      "settings.profile": "Profile",
      "settings.plugins": "Plugins",
      "settings.appearance": "Appearance",
      "settings.language": "Language",
      "language.title": "Language",
      "language.label": "Application language",
      "language.description":
        "Choose the language used by Buzz on this device. Your choice is saved automatically.",
      "language.english": "English (United States)",
      "language.portugueseBrazil": "Português (Brasil)",
    },
  },
  "pt-BR": {
    translation: {
      "shell.skipToContent": "Pular para o conteúdo",
      "shell.pages": "Páginas",
      "shell.home": "Início",
      "shell.messages": "Mensagens",
      "shell.projects": "Projetos",
      "shell.findPage": "Buscar uma página",
      "shell.findPagePlaceholder": "Buscar uma página…",
      "shell.closeSearch": "Fechar busca",
      "shell.noMatchingPages": "Nenhuma página encontrada.",
      "shell.yourProfile": "Seu perfil",
      "shell.yourAccount": "Sua conta",
      "shell.settings": "Configurações",
      "home.tagline": "Um espaço para tudo.",
      "home.title": "Sinta-se em casa.",
      "home.customize": "Deixe do seu jeito",
      "settings.title": "Configurações",
      "settings.sections": "Seções das configurações",
      "settings.profile": "Perfil",
      "settings.plugins": "Plugins",
      "settings.appearance": "Aparência",
      "settings.language": "Idioma",
      "language.title": "Idioma",
      "language.label": "Idioma do aplicativo",
      "language.description":
        "Escolha o idioma usado pelo Buzz neste dispositivo. Sua escolha é salva automaticamente.",
      "language.english": "English (United States)",
      "language.portugueseBrazil": "Português (Brasil)",
    },
  },
} as const;

export function normalizeLocale(value: unknown): AppLocale | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replaceAll("_", "-").toLowerCase();
  if (normalized === "pt" || normalized === "pt-br") return "pt-BR";
  if (normalized === "en" || normalized.startsWith("en-")) return "en-US";
  return undefined;
}

export function resolveInitialLocale(
  saved: unknown,
  preferred: readonly string[],
): AppLocale {
  const stored = normalizeLocale(saved);
  if (stored) return stored;
  for (const candidate of preferred) {
    const locale = normalizeLocale(candidate);
    if (locale) return locale;
  }
  return "en-US";
}

function readStoredLocale() {
  try {
    return globalThis.localStorage?.getItem(storageKey);
  } catch {
    return undefined;
  }
}

function preferredLocales() {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length
    ? navigator.languages
    : navigator.language
      ? [navigator.language]
      : [];
}

function updateDocumentLanguage(locale: string) {
  if (typeof document !== "undefined") document.documentElement.lang = locale;
}

export const appI18n = i18next.createInstance();
void appI18n.use(initReactI18next).init({
  resources: translationResources,
  lng: resolveInitialLocale(readStoredLocale(), preferredLocales()),
  fallbackLng: "en-US",
  supportedLngs: appLocales,
  load: "currentOnly",
  keySeparator: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});
updateDocumentLanguage(appI18n.resolvedLanguage ?? appI18n.language);
appI18n.on("languageChanged", updateDocumentLanguage);

export function currentLocale(): AppLocale {
  return (
    normalizeLocale(appI18n.resolvedLanguage ?? appI18n.language) ?? "en-US"
  );
}

export async function setAppLocale(locale: AppLocale) {
  try {
    globalThis.localStorage?.setItem(storageKey, locale);
  } catch {
    // Language changes still apply to this session when storage is unavailable.
  }
  await appI18n.changeLanguage(locale);
}

export function localizedPageLabel(
  key: string,
  fallback: string,
  t: TFunction,
) {
  if (key === "buzz.channels/channels") return t("shell.messages");
  if (key === "buzz.projects/projects") return t("shell.projects");
  return fallback;
}
