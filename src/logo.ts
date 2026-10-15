// Logo validation: allow-listed raster formats verified by magic bytes; SVG rejected
// (no sanitizer in the POC); logo URLs must be http(s).
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

export const MAX_LOGO_BYTES = 1024 * 1024;
const ALLOWED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export function sniffImage(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export function decodeLogo(dataUrl: unknown): { data: Buffer; mime: string } | null {
  if (typeof dataUrl !== 'string' || !dataUrl) return null;
  const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!m) throw new HttpError(415, 'Logo must be an uploaded PNG, JPEG, GIF or WebP image.');
  const declared = m[1].toLowerCase();
  if (declared === 'image/svg+xml') throw new HttpError(415, 'SVG logos are not accepted (they can carry scripts). Please upload PNG, JPEG, GIF or WebP.');
  if (!ALLOWED.includes(declared)) throw new HttpError(415, `Logo type ${declared} is not allowed. Use PNG, JPEG, GIF or WebP.`);
  const data = Buffer.from(m[2], 'base64');
  if (data.length > MAX_LOGO_BYTES) throw new HttpError(413, `Logo is ${(data.length / 1048576).toFixed(1)} MB; the limit is 1 MB.`);
  const real = sniffImage(data);
  if (!real) throw new HttpError(415, 'That file is not a valid PNG, JPEG, GIF or WebP image.');
  if (real !== declared) throw new HttpError(415, `File content is ${real} but was labeled ${declared}.`);
  return { data, mime: real };
}

/** Accept only absolute http(s) URLs (or empty). Rejects javascript:, data:, relative paths, etc. */
export function safeLogoUrl(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return null;
  let u: URL;
  try { u = new URL(s); } catch { throw new HttpError(400, `logo_url "${s.slice(0, 60)}" is not a valid http(s) URL`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, `logo_url must start with http:// or https:// (got ${u.protocol})`);
  return u.toString();
}
