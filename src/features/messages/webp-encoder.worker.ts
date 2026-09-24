import encode, { init } from "@jsquash/webp/encode.js";
import wasm from "@jsquash/webp/codec/enc/webp_enc.wasm?url";
import simdWasm from "@jsquash/webp/codec/enc/webp_enc_simd.wasm?url";

self.onmessage = async (event: MessageEvent<ImageData>) => {
  try {
    await init({
      locateFile: (name: string) => (name.includes("simd") ? simdWasm : wasm),
    });
    const bytes = await encode(event.data, { lossless: 1, exact: 1 });
    self.postMessage({ bytes }, { transfer: [bytes] });
  } catch {
    self.postMessage({ error: "WebP preparation failed." });
  }
};
