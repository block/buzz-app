import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { createServer } from "./vite-server.mjs";

// These are browser codec contracts: Node/jsdom cannot prove orientation, colour or encoder output.
test("static photo preparation preserves appearance and uploads only cleaned bytes", async ({
  page,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/photo-preparation.html`,
    );
    const results = await page.evaluate(async () => {
      const { preparePhoto } = await import(
        "/src/features/relay/photo-preparation.ts"
      );
      const { attachmentMessage } = await import(
        "/src/features/relay/attachments.ts"
      );
      const { connectBrokerTransport } = await import(
        "/src/features/relay/transport.ts"
      );
      const { foldMessages } = await import("/src/features/relay/fold.ts");
      const encode = (canvas, type) =>
        new Promise((resolve) => canvas.toBlob(resolve, type, 1));
      const canvas = document.createElement("canvas");
      canvas.width = 32;
      canvas.height = 48;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#e02010";
      ctx.fillRect(0, 0, 16, 24);
      ctx.fillStyle = "#20d030";
      ctx.fillRect(16, 0, 16, 24);
      ctx.fillStyle = "#2030e0";
      ctx.fillRect(0, 24, 16, 24);
      // Bottom-right deliberately transparent.
      const sourceJpeg = new Uint8Array(
        await (await encode(canvas, "image/jpeg")).arrayBuffer(),
      );
      // A complete little-endian TIFF: orientation 6 + GPS IFD with latitude/longitude.
      const tiff = new Uint8Array(128);
      const tv = new DataView(tiff.buffer);
      tiff.set([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
      tv.setUint16(8, 2, true);
      tv.setUint16(10, 0x112, true);
      tv.setUint16(12, 3, true);
      tv.setUint32(14, 1, true);
      tv.setUint16(18, 6, true);
      tv.setUint16(22, 0x8825, true);
      tv.setUint16(24, 4, true);
      tv.setUint32(26, 1, true);
      tv.setUint32(30, 38, true);
      tv.setUint16(38, 4, true);
      for (const [at, tag, type, count, value] of [
        [40, 1, 2, 2, 78],
        [52, 2, 5, 3, 92],
        [64, 3, 2, 2, 87],
        [76, 4, 5, 3, 116],
      ]) {
        tv.setUint16(at, tag, true);
        tv.setUint16(at + 2, type, true);
        tv.setUint32(at + 4, count, true);
        tv.setUint32(at + 8, value, true);
      }
      // Grow for the final rationals; the GPS coordinate is 37N, 122W.
      const gps = new Uint8Array(140);
      gps.set(tiff);
      const gv = new DataView(gps.buffer);
      for (const [at, value] of [
        [92, 37],
        [100, 0],
        [108, 0],
        [116, 122],
        [124, 0],
        [132, 0],
      ]) {
        gv.setUint32(at, value, true);
        gv.setUint32(at + 4, 1, true);
      }
      const exif = new Uint8Array(6 + gps.length);
      exif.set([69, 120, 105, 102, 0, 0]);
      exif.set(gps, 6);
      const marker = (kind, payload) => {
        const result = new Uint8Array(payload.length + 4);
        result.set([
          255,
          kind,
          (payload.length + 2) >>> 8,
          (payload.length + 2) & 255,
        ]);
        result.set(payload, 4);
        return result;
      };
      const text = new TextEncoder();
      const oriented = new File(
        [
          sourceJpeg.slice(0, 2),
          marker(0xe1, exif),
          marker(
            0xe1,
            text.encode("http://ns.adobe.com/xap/1.0/\0GPS=private-location"),
          ),
          marker(0xfe, text.encode("private-location")),
          sourceJpeg.slice(2),
          text.encode("private-trailer"),
        ],
        "camera.jpg",
        { type: "application/octet-stream" },
      );
      const pngBlob = await encode(canvas, "image/png");
      const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
      const pngChunk = (kind, payload) => {
        const chunk = new Uint8Array(payload.length + 12);
        new DataView(chunk.buffer).setUint32(0, payload.length);
        chunk.set(text.encode(kind), 4);
        chunk.set(payload, 8);
        let crc = 0xffffffff;
        for (const byte of chunk.subarray(4, -4)) {
          crc ^= byte;
          for (let bit = 0; bit < 8; bit++)
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
        new DataView(chunk.buffer).setUint32(
          chunk.length - 4,
          (crc ^ 0xffffffff) >>> 0,
        );
        return chunk;
      };
      const sources = [oriented, new File([pngBlob], "alpha.png")];
      for (const keyword of ["buzz_agent_snapshot", "buzz_team_snapshot"]) {
        sources.push(
          new File(
            [
              pngBytes.slice(0, 33),
              pngChunk("tEXt", text.encode(`${keyword}\0manifest-payload`)),
              pngChunk("tEXt", text.encode("Comment\0private-location")),
              pngBytes.slice(33),
            ],
            `${keyword}.png`,
          ),
        );
      }
      for (const name of ["display-p3.png", "display-p3.jpg", "alpha.webp"])
        sources.push(
          new File(
            [await (await fetch(`/tests/fixtures/photos/${name}`)).blob()],
            name,
          ),
        );
      const pixels = async (blob) => {
        const image = await createImageBitmap(blob);
        const c = document.createElement("canvas");
        c.width = image.width;
        c.height = image.height;
        const context = c.getContext("2d", { colorSpace: "srgb" });
        context.drawImage(image, 0, 0);
        const samples = [
          [0.25, 0.25],
          [0.75, 0.25],
          [0.25, 0.75],
          [0.75, 0.75],
        ].flatMap(([x, y]) => [
          ...context.getImageData(
            Math.floor(c.width * x),
            Math.floor(c.height * y),
            1,
            1,
          ).data,
        ]);
        const result = { width: c.width, height: c.height, samples };
        image.close();
        return result;
      };
      const outputs = [];
      for (const file of sources) {
        let uploaded;
        const originalFetch = window.fetch;
        window.fetch = async (url, options) => {
          if (url.endsWith("/session"))
            return Response.json({
              viewer: "a".repeat(64),
              relayAuthor: "b".repeat(64),
              attachmentUploads: true,
              relayUrl: "https://relay.test",
            });
          if (!url.endsWith("/upload"))
            throw new Error(`Unexpected request ${url}`);
          uploaded = options.body;
          const bytes = await uploaded.arrayBuffer();
          const hash = [
            ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          ]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
          return Response.json({
            url: `https://relay.test/media/${hash}`,
            type:
              new Uint8Array(bytes)[0] === 255
                ? "image/jpeg"
                : new Uint8Array(bytes)[0] === 137
                  ? "image/png"
                  : "image/webp",
            size: uploaded.size,
            sha256: hash,
          });
        };
        try {
          const transport = await connectBrokerTransport();
          const result = await transport.uploadAttachment(
            file,
            new AbortController().signal,
          );
          const message = attachmentMessage(
            "hello",
            [result],
            "https://relay.test",
          );
          const [received] = foldMessages("c", "d".repeat(64), [
            {
              id: "b".repeat(64),
              pubkey: "c".repeat(64),
              created_at: 1,
              kind: 9,
              content: message.content,
              tags: [["h", "c"], ...message.tags],
            },
          ]);
          outputs.push({
            name: file.name,
            source: await pixels(file),
            output: await pixels(uploaded),
            bytes: [...new Uint8Array(await uploaded.arrayBuffer())],
            type: uploaded.type,
            received: {
              content: received.content,
              attachments: received.attachments,
            },
            result,
          });
        } finally {
          window.fetch = originalFetch;
        }
      }
      const broken = new File([new Uint8Array([255, 216, 255])], "broken.jpg");
      let rejected = false;
      try {
        await preparePhoto(broken, new AbortController().signal);
      } catch {
        rejected = true;
      }
      return {
        outputs,
        rejected,
        exif: [...exif],
        inputBytes: [...new Uint8Array(await oriented.arrayBuffer())],
      };
    });
    // Independent fixture preconditions, not an assertion against the sanitizer's parser.
    const exif = Buffer.from(results.exif);
    expect(exif.subarray(0, 6).toString()).toBe("Exif\0\0");
    expect(exif.readUInt16LE(6 + 18)).toBe(6);
    expect(exif.readUInt16LE(6 + 22)).toBe(0x8825);
    expect(exif.readUInt32LE(6 + 92)).toBe(37);
    expect(exif.readUInt32LE(6 + 116)).toBe(122);
    expect(
      Buffer.from(results.inputBytes).includes(Buffer.from("private-location")),
    ).toBe(true);
    expect(results.rejected).toBe(true);
    expect(results.outputs).toHaveLength(7);
    for (const result of results.outputs) {
      expect(result.output.width).toBe(result.source.width);
      expect(result.output.height).toBe(result.source.height);
      if (result.name === "camera.jpg")
        expect([result.output.width, result.output.height]).toEqual([48, 32]);
      for (let i = 0; i < result.source.samples.length; i++)
        expect(
          Math.abs(result.output.samples[i] - result.source.samples[i]),
          `${result.name} channel ${i}`,
        ).toBeLessThanOrEqual(result.type === "image/jpeg" ? 12 : 1);
      const bytes = Buffer.from(result.bytes);
      for (const forbidden of ["Exif", "private-location", "private-trailer"])
        expect(bytes.includes(Buffer.from(forbidden))).toBe(false);
      if (result.type === "image/png") {
        expect(bytes.subarray(0, 8)).toEqual(
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        );
        let offset = 8;
        while (offset < bytes.length) {
          const size = bytes.readUInt32BE(offset);
          const kind = bytes.subarray(offset + 4, offset + 8).toString();
          if (kind === "tEXt") {
            expect(result.name.startsWith("buzz_")).toBe(true);
            expect(
              bytes.subarray(offset + 8, offset + 8 + size).toString(),
            ).toBe(`${result.name.slice(0, -4)}\0manifest-payload`);
            expect(offset).toBe(33);
          } else
            expect([
              "IHDR",
              "PLTE",
              "IDAT",
              "IEND",
              "tRNS",
              "sRGB",
              "gAMA",
              "cHRM",
            ]).toContain(kind);
          offset += size + 12;
        }
        expect(offset).toBe(bytes.length);
        if (result.name.startsWith("buzz_"))
          expect(bytes.includes(Buffer.from("manifest-payload"))).toBe(true);
      } else {
        let offset = 2;
        while (bytes[offset + 1] !== 0xda) {
          const marker = bytes[offset + 1];
          expect(
            (marker >= 0xe1 && marker <= 0xed) ||
              marker === 0xef ||
              marker === 0xfe,
          ).toBe(false);
          offset += bytes.readUInt16BE(offset + 2) + 2;
        }
        expect([...bytes.subarray(-2)]).toEqual([255, 217]);
      }
      expect(result.received.content).toBe("hello");
      expect(result.received.attachments).toHaveLength(1);
      expect(result.received.attachments[0]).toMatchObject({
        kind: "image",
        url: result.result.url,
      });
      expect(result.result.size).toBe(bytes.length);
    }
  } finally {
    await server.close();
  }
});
