# Buzz embedded Mesh runtime

Buzz supplies its own temporary Mesh configuration for consumer and serving
startup; it does not load the standalone Mesh configuration file.

## Disk prompt cache

The native KV disk tier stores reusable conversation prefixes with a **2 GiB
cap** (`2048 MiB`) and preserves **16 GiB of free filesystem space**. The latter
is a minimum-free threshold, not a disk allocation. The codec is `native`:
CacheGen is not enabled. Live KV and model memory budgets are unchanged.

The persistent directory is `buzz-kv-cache` beside the Mesh owner keystore,
separate from standalone Mesh's default cache and store lock. Mesh owns cache
identity, admission, eviction, integrity checks, and restore. A full or
unavailable cache falls back to normal prompt processing; low free space stops
new writes. These are disposable cache entries and may be removed while Buzz
is stopped. Model compatibility determines reuse after an upgrade.

Both startup roles receive the same policy because Mesh initializes its disk
cache manager once per process. Consumer mode does not perform local inference
or populate conversation prefixes. Mesh's explicit `MESH_LLM_KV_CACHE_*`
environment overrides retain their upstream precedence over this configuration.

No telemetry recording, export, or upload is added. The telemetry and blobstore
plugins remain disabled.
