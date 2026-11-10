/**
 * The text of a file a person picked, whatever program wrote it. Scale software writes what its
 * Windows writes: UTF-8 with or without a mark, UTF-16 from a spreadsheet's "Unicode text", or the
 * old Cyrillic code page. Reading Cyrillic headings as UTF-8 would turn them into question marks.
 */
export function decodeFileText(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Not UTF-8. In this region a one-byte file with letters above 127 is Windows-1251.
    return new TextDecoder('windows-1251').decode(bytes);
  }
}

/** A text file has no zero bytes; a spreadsheet saved as .xls or .xlsx is full of them. */
export function looksBinary(bytes: Uint8Array): boolean {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return false;
  return bytes.subarray(0, 4096).includes(0);
}
