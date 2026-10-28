# Shared compute

Share this computer's compute with your community and run Mesh helper agents.

## Getting started

1. Open Settings → Shared compute and choose whether this computer shares compute with the current community.
2. Pick a model to serve, or use the community's shared models without serving one yourself.
3. Create a Mesh agent from Agents → New agent → Mesh to answer with the community's shared compute.

---

Contributor notes: [Mesh agent type](MESH_AGENT.md).

## Known limitations

- **Xet-backed models can't be downloaded for serving.** The pinned mesh-llm (the 0.78.1 bridge, `5d19ca69`) fails to read Hugging Face metadata for Xet-backed GGUF files (`missing X-Repo-Commit header`). Many current Hub repos are Xet-backed, including `unsloth/Qwen3.5-9B-GGUF`. When sharing picks such a model, the computer stays on "waking" and never serves it. Its own requests still work, but they go to another community computer that already serves the model. The fix is [Mesh-LLM/mesh-llm#2579](https://github.com/Mesh-LLM/mesh-llm/pull/2579), which is not in a release yet. Bump the pin once a release includes it.
