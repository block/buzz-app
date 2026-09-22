# Browser

An external API-v1 plugin that opens HTTP(S) links in a Buzz-owned desktop browser window. The window provides an address field, Back, Forward and Reload. Website rendering is supplied by the host's public `browser` capability; the plugin imports no private host code.

## Install

First build and run Buzz from the Browser plugin branch in [PR #100](https://github.com/block/buzz-app/pull/100). Installing or reimporting this plugin alone cannot add the native `browser` capability to an older Buzz build. An older host rejects activation with `Browser plugin requires a Buzz build with the browser capability`.

In desktop Settings → Plugins, load this folder, install **Browser**, then enable it. The included `manifest.json` and `plugin.js` need no build tools.

In the web application the capability reports unavailable and this plugin leaves existing link handling unchanged. Earlier matching panels, including GitHub, retain precedence. Modifier-key and middle-click behavior is unchanged.

Disabling the plugin removes its link interception. A browser window already opened by the user stays open until closed. One window is reused; there are no tabs, bookmarks or saved browsing history. See the [host browser contract and limits](../../../docs/browser.md).

## Authoring example

The plugin checks that the host provides `browser`, binds its panel registration to `react`, `panels` and `browser`, and calls `ctx.browser.open(target)`. It displays opening, opened or failed status with the host's error message. Opening occurs once per target per panel mount, including React StrictMode. HTTP(S), credential and normalized URL-length validation happen before it claims a link; native validation still owns the final decision.

## Build from source

Pack the type-only SDK from the matching Buzz checkout:

```sh
bin/pnpm author:build
(cd dist-author && ../bin/pnpm pack --pack-destination ..)
```

Copy this example outside the host workspace, then run there:

```sh
pnpm install
pnpm add -D /absolute/path/to/buzz-author-0.0.0-preview.1.tgz
pnpm build
pnpm test
```

The SDK is a local development dependency, not a runtime import or a registry package. Copy the resulting `dist/plugin.js` back beside `manifest.json` when updating the example. Format the generated file using the host's Biome configuration. Do not commit an absolute SDK path into this example's `package.json`.

Tests cover URL acceptance, StrictMode opening, and visible native errors. The host separately tests native permissions and browser controls; native acceptance is required for website rendering and window layout.
