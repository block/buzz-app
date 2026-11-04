import type { Host } from "../../features/host/service";
import type { Settings } from "./types.ts";

export type EmbeddingHost = Pick<Host, "request">;

export class EmbeddingHttpError extends Error {
  constructor(readonly status: number) {
    super("Embedding request failed");
  }
}

/** The setting is a server base URL, or the full OpenAI embeddings endpoint. */
export function endpoint(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        (url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname)))
    )
  )
    throw new Error(
      "Use HTTPS or a local HTTP server, without URL credentials, query or fragment.",
    );
  const path = url.pathname.replace(/\/$/, "");
  url.pathname = path.endsWith("/v1/embeddings")
    ? path
    : path + (path.endsWith("/v1") ? "/embeddings" : "/v1/embeddings");
  return url.href;
}

/** Normalize locally: OpenAI-compatible servers need not return unit vectors. */
export function vector(value: unknown, dimensions?: number): Float32Array {
  if (
    !Array.isArray(value) ||
    !value.length ||
    (dimensions !== undefined && value.length !== dimensions) ||
    !value.every((n) => typeof n === "number" && Number.isFinite(n))
  )
    throw new Error("Invalid embedding dimensions or values");
  // Scale first to avoid overflow/underflow for finite server values.
  const scale = value.reduce((max, n) => Math.max(max, Math.abs(n)), 0);
  if (!scale) throw new Error("Zero embedding");
  const norm = Math.sqrt(value.reduce((sum, n) => sum + (n / scale) ** 2, 0));
  return Float32Array.from(value, (n) => n / scale / norm);
}

export function createEmbeddingClient(
  host: EmbeddingHost,
  settings: () => Settings,
  onReset = () => {},
) {
  let config = "";
  let epoch = 0;
  let model: string | undefined;
  let dimensions: number | undefined;
  function sync() {
    const s = settings();
    const next = JSON.stringify([
      s.embeddingUrl ?? "",
      s.embeddingKey ?? "",
      s.queryPrefix ?? "",
      s.documentPrefix ?? "",
    ]);
    if (next !== config) {
      config = next;
      epoch++;
      model = undefined;
      dimensions = undefined;
      onReset();
    }
    return s;
  }
  async function embed(
    inputs: readonly string[],
    timeoutMs = 10_000,
  ): Promise<Float32Array[]> {
    const s = sync();
    if (!s.embeddingUrl) throw new Error("Embedding server is not configured");
    const current = epoch;
    const response = await bounded(
      host.request({
        url: endpoint(s.embeddingUrl),
        method: "POST",
        timeoutMs,
        headers: {
          "Content-Type": "application/json",
          ...(s.embeddingKey
            ? { Authorization: `Bearer ${s.embeddingKey}` }
            : {}),
        },
        body: JSON.stringify({
          input: inputs.map(boundedInput),
          encoding_format: "float",
        }),
      }),
      timeoutMs,
    );
    sync();
    if (current !== epoch) throw new Error("Embedding configuration changed");
    if (response.status !== 200) throw new EmbeddingHttpError(response.status);
    const data = JSON.parse(response.body);
    if (
      !data ||
      !Array.isArray(data.data) ||
      data.data.length !== inputs.length ||
      typeof data.model !== "string" ||
      !data.model
    )
      throw new Error("Invalid embedding response");
    if (model !== undefined && model !== data.model) {
      model = data.model;
      dimensions = undefined;
      epoch++;
      onReset();
      throw new Error("Embedding model changed; index cleared");
    }
    const ordered: Float32Array[] = new Array(inputs.length);
    let size = dimensions;
    for (const row of data.data) {
      if (
        !row ||
        !Number.isInteger(row.index) ||
        row.index < 0 ||
        row.index >= inputs.length ||
        ordered[row.index]
      )
        throw new Error("Invalid embedding order");
      const parsed = vector(row.embedding, size);
      size = parsed.length;
      ordered[row.index] = parsed;
    }
    model = data.model;
    dimensions = size;
    return ordered;
  }
  return {
    embed,
    configured: () => !!sync().embeddingUrl,
    // Model changes clear all banks; no vectors from two returned models coexist.
    identity: () => {
      sync();
      return config;
    },
    status: () => ({ model, dimensions }),
  };
}

async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Deadline exceeded")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Byte budget, not a tokenizer/context guarantee; preserve complete Unicode code points. */
const encoder = new TextEncoder();
export function boundedInput(text: string): string {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    bytes += encoder.encode(char).length;
    if (bytes > 4000) break;
    end += char.length;
  }
  return text.slice(0, end);
}
