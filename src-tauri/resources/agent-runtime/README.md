# Agent runtime resources

Run `bin/node scripts/build-agent-runtime.mjs` before building a runnable agent
manager. It builds the immutable source in `runtime/agent-runtime.json` using
pinned Cargo and the upstream lockfile. Generated tools and `manifest.json` are
ignored, not committed. No runtime download or old-app binary lookup exists.
An unstaged app still opens its editor but reports runtime unavailable.
