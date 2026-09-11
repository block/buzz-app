import type { ShortcutsService } from "../features/shortcuts/service";
import type { Appearance } from "../shared/theme/service";

/** Host actions use the same binding/dispatch rules as plugins, without fake plugin ownership. */
export function registerAppShortcuts(
  shortcuts: ShortcutsService,
  appearance: Appearance,
  openSettings: () => void,
  ready: boolean,
) {
  const remove = [
    shortcuts.registerHost({
      id: "settings",
      title: "Open Settings",
      binding: { key: ",", mod: true },
      allowInEditable: true,
      when: () => ready,
      run: openSettings,
    }),
    ...(
      [
        [
          "font-increase",
          "Increase text size",
          [
            { key: "=", mod: true },
            { key: "=", mod: true, shift: true },
            { key: "+", mod: true },
            { key: "+", mod: true, shift: true },
          ],
          () => appearance.setFontScale(appearance.snapshot().fontScale + 0.1),
        ],
        [
          "font-decrease",
          "Decrease text size",
          { key: "-", mod: true },
          () => appearance.setFontScale(appearance.snapshot().fontScale - 0.1),
        ],
        [
          "font-reset",
          "Reset text size",
          { key: "0", mod: true },
          () => appearance.setFontScale(1),
        ],
      ] as const
    ).map(([id, title, binding, run]) =>
      shortcuts.registerHost({
        id,
        title,
        binding,
        run,
        allowInEditable: true,
        allowInModal: true,
        repeat: true,
      }),
    ),
  ];
  return () => {
    for (const dispose of remove) dispose();
  };
}

export function registerNavigationShortcuts(
  shortcuts: ShortcutsService,
  navigation: import("../features/navigation/controller").Navigation,
) {
  const remove = [
    shortcuts.registerHost({
      id: "navigation-back",
      title: "Go back",
      binding: [
        { key: "[", mod: true },
        { key: "ArrowLeft", alt: true },
      ],
      allowInEditable: true,
      when: () => navigation.snapshot().canGoBack,
      run: navigation.back,
    }),
    shortcuts.registerHost({
      id: "navigation-forward",
      title: "Go forward",
      binding: [
        { key: "]", mod: true },
        { key: "ArrowRight", alt: true },
      ],
      allowInEditable: true,
      when: () => navigation.snapshot().canGoForward,
      run: navigation.forward,
    }),
  ];
  return () => {
    for (const dispose of remove) dispose();
  };
}
