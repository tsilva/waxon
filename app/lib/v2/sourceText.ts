import { extractPdfText } from "./pdf.ts";

const PDF_SIGNATURE = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
const PDF_SIGNATURE_SCAN_BYTES = 1_024;

function hasPdfSignature(bytes: Uint8Array): boolean {
  const lastStart = Math.min(
    bytes.byteLength - PDF_SIGNATURE.byteLength,
    PDF_SIGNATURE_SCAN_BYTES - PDF_SIGNATURE.byteLength,
  );
  for (let start = 0; start <= lastStart; start += 1) {
    if (PDF_SIGNATURE.every((byte, index) => bytes[start + index] === byte)) {
      return true;
    }
  }
  return false;
}

export async function extractRemoteSourceText(input: {
  bytes: Uint8Array;
  contentType: string | null;
}): Promise<string> {
  const contentType = input.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  const isPdf =
    contentType === "application/pdf" ||
    contentType === "application/x-pdf" ||
    hasPdfSignature(input.bytes);

  return isPdf
    ? await extractPdfText(input.bytes)
    : new TextDecoder("utf-8", { fatal: false }).decode(input.bytes);
}
