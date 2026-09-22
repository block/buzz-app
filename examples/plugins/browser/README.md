# Browser

An external API-v1 plugin that opens HTTP(S) links in the existing Buzz side panel. The host provides the address field, Back, Forward, Reload, and native website content through its public `browser` capability. The plugin imports no private host code.

## Install

First build and run Buzz from the Browser plugin branch in [PR #100](https://github.com/block/buzz-app/pull/100). Installing or reimporting this plugin alone cannot add the native `browser` capability to an older Buzz build. An older host rejects activation with `Browser plugin requires a Buzz build with the embedded browser capability`.

In desktop Settings → Plugins, load this folder, install **Browser**, then enable it. The included `manifest.json` and `plugin.js` need no build tools.

The embedded browser is currently available in the macOS desktop application. Web, Linux, and Windows builds report it unavailable, so this plugin leaves existing link handling unchanged. Earlier matching panels, including GitHub, retain precedence. Modifier-key and middle-click behavior is unchanged.

Disabling the plugin removes its link interception and detaches the native website content. Closing the panel, changing community, or changing its target also detaches that panel's native browser session. There are no tabs, bookmarks, or saved browsing history. See the [host browser contract and limits](../../../docs/browser.md).

## Authoring example

The plugin checks that the host provides the embedded `browser.View`, binds its panel registration to `react`, `panels` and `browser`, and renders `ctx.browser.View` with the target URL. The host owns navigation, status, geometry, overlay visibility, and session cleanup. HTTP(S), credential, and normalized URL-length validation happen before the plugin claims a link; native validation still owns the final decision.

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

Tests cover URL acceptance, rejection of older window-only hosts, and delegation to the public host View. The host separately tests native permissions, controls, geometry, and session cleanup.
