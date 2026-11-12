# Accessibility

BladeVault should be usable by everyone who manages a collection, including people who use a
keyboard, a screen reader, zoom, or reduced motion. This statement describes where the project
stands today and how to report a barrier.

## Commitment

- Interactive controls are reachable and operable with the keyboard, keep a visible focus
  indicator, and have readable labels.
- New UI is built from the shared primitives in `components/ui` so focus, labelling, and dialogs
  behave consistently.
- Animations are designed to respect the operating system's **reduce motion** setting.
- Each visual style (see Settings → Appearance) aims for readable text contrast in the modes it
  supports.

Accessibility is reviewed as part of normal pull requests (see [CONTRIBUTING.md](CONTRIBUTING.md)),
but BladeVault has **not** had a formal audit against WCAG.

## Supported environments

- **Desktop app** on macOS, Windows, and Linux (Electron, Chromium-based).
- **Web UI** (self-hosted or the static web app) in current versions of Chrome, Edge, Firefox,
  and Safari.
- Screen readers: VoiceOver (macOS) and NVDA (Windows) with a current browser are the intended
  targets.

## Known limitations

- Several visual styles are offered; some have a lower-contrast or decorative look than others,
  and the Lumen and Espresso styles are light-only. If one is hard to read, the Classic and
  Modern styles with your system's light or dark mode are the most conventional choices.
- Product images imported from retailer pages often have no meaningful description, so their
  alternative text is the knife's brand and name.
- Charts on the Insights page are primarily visual; not every value is also
  presented as text.
- Pages opened from retailers (the interactive import browser) are outside BladeVault's control.

## Reporting a barrier

Open an issue with the [bug report form](https://github.com/dedkola/bladevault/issues/new/choose)
and choose **Settings / themes** or the affected area. Please include:

- what you were trying to do and where it failed;
- your assistive technology, browser or desktop app, and operating system, with versions;
- the visual style and light/dark mode you use.

Accessibility issues are treated as bugs.
