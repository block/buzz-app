export function supportsImageCopy(): boolean {
  return (
    typeof ClipboardItem !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.write === "function"
  );
}

function encodeImageAsPng(image: HTMLImageElement): Promise<Blob> {
  if (!image.complete || image.naturalWidth === 0 || image.naturalHeight === 0)
    return Promise.reject(new Error("Image is not loaded"));

  return new Promise<Blob>((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      reject(new Error("Could not encode image"));
      return;
    }
    context.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight);
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not encode image"));
    }, "image/png");
  });
}

export function copyImageToClipboard(image: HTMLImageElement): Promise<void> {
  const png = encodeImageAsPng(image);
  const item = new ClipboardItem({ "image/png": png });
  // WebKit requires clipboard.write to happen inside the user gesture; awaiting
  // canvas encoding first breaks that gesture even though Chromium/jsdom pass.
  const write = navigator.clipboard.write([item]);
  return Promise.all([write, png]).then(() => undefined);
}
