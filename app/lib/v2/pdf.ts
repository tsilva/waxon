export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const canvas = await import("@napi-rs/canvas");
  Object.assign(globalThis, {
    ...(typeof globalThis.DOMMatrix === "undefined"
      ? { DOMMatrix: canvas.DOMMatrix }
      : {}),
    ...(typeof globalThis.Path2D === "undefined"
      ? { Path2D: canvas.Path2D }
      : {}),
    ...(typeof globalThis.ImageData === "undefined"
      ? { ImageData: canvas.ImageData }
      : {}),
  });

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    useSystemFonts: true,
  });
  const document = await loadingTask.promise;
  const pages: string[] = [];

  try {
    for (
      let pageNumber = 1;
      pageNumber <= document.numPages;
      pageNumber += 1
    ) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .map((item) =>
            "str" in item && typeof item.str === "string" ? item.str : "",
          )
          .join(" "),
      );
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }

  return pages.join("\n\n");
}
