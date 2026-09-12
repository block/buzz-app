import { useTranslation } from "react-i18next";
import {
  appLocales,
  currentLocale,
  setAppLocale,
  type AppLocale,
} from "../features/localization/service";

export function LanguageSettings() {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="language-settings-title">
      <h2
        id="language-settings-title"
        className="mt-0 mb-3 text-lg font-medium"
      >
        {t("language.title")}
      </h2>
      <div className="ui-card p-5 sm:p-6">
        <label
          htmlFor="application-language"
          className="mb-2 block text-base font-medium"
        >
          {t("language.label")}
        </label>
        <p id="language-description" className="mt-0 mb-4 text-sm text-muted">
          {t("language.description")}
        </p>
        <select
          id="application-language"
          aria-describedby="language-description"
          value={currentLocale()}
          onChange={(event) =>
            void setAppLocale(event.currentTarget.value as AppLocale)
          }
          className="w-full max-w-sm rounded-xl border border-line bg-surface px-3 py-2 text-ink"
        >
          {appLocales.map((locale) => (
            <option key={locale} value={locale}>
              {locale === "pt-BR"
                ? t("language.portugueseBrazil")
                : t("language.english")}
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}
