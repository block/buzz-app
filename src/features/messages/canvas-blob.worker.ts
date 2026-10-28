self.onmessage = async (
  event: MessageEvent<{ bitmap: ImageBitmap; type: string; quality: number }>,
) => {
  const { bitmap, type, quality } = event.data;
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No 2D context");
    context.drawImage(bitmap, 0, 0);
    self.postMessage(await canvas.convertToBlob({ type, quality }));
  } catch {
    self.postMessage(undefined);
  } finally {
    bitmap.close();
  }
};
