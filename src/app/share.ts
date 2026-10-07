// Shareable verification links: #/workspace?circuit=N&src=<base64url(utf8 source)>.
// The decoded text is only ever placed in the editor's value and passed to the compiler. Nothing here renders it as markup.

export const MAX_SHARED_SOURCE_CHARS = 4000;
// Four bytes of UTF-8 per character, four base64 characters per three bytes, plus slack. Anything longer is refused before decoding.
const MAX_ENCODED_LENGTH = Math.ceil((MAX_SHARED_SOURCE_CHARS * 4 * 4) / 3) + 8;

export function encodeSource(source: string): string {
  const bytes = new TextEncoder().encode(source);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type DecodedSource = { ok: true; source: string } | { ok: false; reason: string };

export function decodeSource(encoded: string): DecodedSource {
  if (encoded.length === 0) return { ok: false, reason: "empty" };
  if (encoded.length > MAX_ENCODED_LENGTH) return { ok: false, reason: "too long" };
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return { ok: false, reason: "not base64url" };
  try {
    const padded = encoded.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (encoded.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (source.length > MAX_SHARED_SOURCE_CHARS) return { ok: false, reason: "too long" };
    if (source.trim().length === 0) return { ok: false, reason: "empty" };
    return { ok: true, source };
  } catch {
    return { ok: false, reason: "not valid text" };
  }
}

/** `base` is the page address without a fragment. */
export function verificationLink(base: string, circuitId: string, source?: string): string {
  const params = [`circuit=${encodeURIComponent(circuitId)}`];
  if (source !== undefined) params.push(`src=${encodeSource(source)}`);
  return `${base}#/workspace?${params.join("&")}`;
}

/** A circuit id from a link: a plain positive integer, nothing else. */
export function parseCircuitParam(value: string | null): string | undefined {
  return value !== null && /^[1-9][0-9]{0,9}$/.test(value) ? value : undefined;
}
