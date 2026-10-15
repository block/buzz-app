# Link rendering security

## Code-scanning alert 9

[Alert 9](https://github.com/block/buzz-app/security/code-scanning/9)
reports `js/xss-through-dom` from the Link Lab input to the `InlineLink`
anchor's `href`. The proposed disposition is **false positive**.

The alert's latest instance, refreshed on 2026-10-15, analyzes
`c481835ff2708a3a9804b0954d63d091196265c9`. The relevant guard is present
in that snapshot and unchanged at the checked main revision,
`31cdec9f41a1a9a2688306e8f5bc498826c414e8`.

The data path is:

1. [Link Lab](../src/bundled/link-lab/index.tsx) reads `event.target.value`
   into state and passes that string to `InlineLink`.
2. [InlineLink](../src/bundled/links/InlineLink.tsx) calls `linkKind` before
   rendering an anchor. `linkKind` parses with `new URL`, accepts HTTP and
   HTTPS, and delegates Buzz URLs to
   [`buzzLinkKind` / `parseBuzzLink`](../src/features/navigation/buzz-links.ts).
   Invalid URLs and all other schemes return `null`.
3. A rejected destination returns a React text child, without an anchor.
   Accepted destinations are assigned through React's `href` attribute;
   labels remain React text children. No HTML parsing API consumes the input.
   Quotes and markup in a destination or label remain literal attribute/text
   content. Executable URL schemes cannot reach this anchor.

The reference client uses the same separation of URL policy and anchor rendering:
[`buzzDeepLinkUrlTransform`](https://github.com/block/buzz/blob/7b11c6147df099cd28729f340ea032630bab38cc/desktop/src/shared/ui/markdown/utils.ts#L170-L189)
preserves supported Buzz links and delegates other destinations to
`react-markdown`'s default URL transform;
[`ExternalLinkAnchor`](https://github.com/block/buzz/blob/7b11c6147df099cd28729f340ea032630bab38cc/desktop/src/shared/ui/markdown/ExternalLinkAnchor.tsx)
renders a React anchor. Its broader URL policy is not substituted for the Link
Lab's existing HTTP, HTTPS, and supported Buzz policy.

[`InlineLink.security.test.tsx`](../src/bundled/links/InlineLink.security.test.tsx)
mounts the real components to check rejected schemes (including case and control
character variants), literal markup labels, attribute injection attempts, and
the Link Lab input-to-preview path with recovery to a supported URL. Existing
[`InlineLink.test.tsx`](../src/bundled/links/InlineLink.test.tsx) retains semantic
Buzz label, URL shortening, rich label, and service-host boundary coverage.
These DOM checks establish rendering behavior, not native navigation or browser
script execution. No production code, URL policy, or UI copy changes are needed.

The alert remains open pending review and an authorized false-positive dismissal.
This evidence does not claim that a new scan has cleared it.
