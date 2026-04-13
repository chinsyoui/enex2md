import { createHash } from "crypto";

export function md5Buffer(bytes: Buffer | ArrayBuffer | Uint8Array): string {
  const hash = createHash("md5");
  if (bytes instanceof ArrayBuffer) {
    hash.update(Buffer.from(bytes));
  } else if (bytes instanceof Uint8Array) {
    hash.update(Buffer.from(bytes));
  } else {
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export function truncateMiddle(str: string, headLen = 100, tailLen = 100): string {
  if (!str) return "";
  if (str.length <= headLen + tailLen + 3) return str;
  return `${str.slice(0, headLen)}...${str.slice(str.length - tailLen)}`;
}

export function unwrapString(raw: string): string {
  return raw.trim();
}
