import { ArrowUpRight, Settings2 } from "lucide-react";
import type { RegisteredPage } from "../../features/pages/service";
import { orderPages, pagePresentation } from "./presentation";
import { useTranslation } from "react-i18next";
import { localizedPageLabel } from "../../features/localization/service";

export function Home({
  pages,
  onSelect,
}: {
  pages: readonly RegisteredPage[];
  onSelect: (key: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="mx-auto max-w-2xl pt-8 sm:pt-16">
      <img
        src="/app-icon.png"
        alt="Buzz"
        className="mb-6 size-16 rounded-2xl"
      />
      <p className="mb-2 text-sm text-muted">{t("home.tagline")}</p>
      <h1 className="mb-8 text-4xl font-medium tracking-tight sm:text-5xl">
        {t("home.title")}
      </h1>
      <div className="overflow-hidden rounded-3xl border border-shell-edge/70 bg-surface/95 shadow-surface">
        {orderPages(pages).map((page) => {
          const { label, icon: Icon } = pagePresentation(page);
          return (
            <button
              key={page.key}
              type="button"
              onClick={() => onSelect(page.key)}
              className="flex w-full items-center gap-4 rounded-none border-0 border-b border-line bg-transparent p-6 text-left text-ink hover:bg-soft"
            >
              <span className="flex size-11 items-center justify-center rounded-2xl bg-shell">
                <Icon size={21} aria-hidden="true" />
              </span>
              <span className="flex-1 text-base font-medium">
                {localizedPageLabel(page.key, label, t)}
              </span>
              <ArrowUpRight
                size={18}
                className="text-muted"
                aria-hidden="true"
              />
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => onSelect("settings")}
          className="flex w-full items-center gap-4 rounded-none border-0 bg-transparent p-6 text-left text-ink hover:bg-soft"
        >
          <span className="flex size-11 items-center justify-center rounded-2xl bg-soft">
            <Settings2 size={21} aria-hidden="true" />
          </span>
          <span className="flex-1">
            <span className="block text-base font-medium">
              {t("home.customize")}
            </span>
            <span className="text-sm text-muted">{t("shell.settings")}</span>
          </span>
          <ArrowUpRight size={18} className="text-muted" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
