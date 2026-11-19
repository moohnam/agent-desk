import { feedUrl, fetchPublicBody } from './channels.ts';
import { HttpError } from './errors.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xd, 0xa, 0x1a, 0xa]);
const RIFF = Buffer.from('RIFF');
const WEBP = Buffer.from('WEBPVP');
export function rasterMediaType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(PNG)) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 4).equals(RIFF) && bytes.subarray(8, 14).equals(WEBP)) return 'image/webp';
}

/** Each request represents a click on one image. Send no client headers or credentials upstream. */
export async function loadMarkdownImage(input: unknown, signal: AbortSignal) {
  let url: URL;
  try { url = feedUrl(input); }
  catch { throw new HttpError(400,'공개 HTTP(S) 이미지 주소만 열 수 있습니다.'); }
  if (url.port) throw new HttpError(400,'표준 HTTP(S) 포트의 이미지 주소만 열 수 있습니다.');
  let result;
  try {
    result = await fetchPublicBody(url.href, { accept: 'image/png,image/jpeg,image/webp' },
      AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
      // Use a direct socket so the checked DNS address can't be resolved again by an ambient proxy.
      { maxBytes: 8 * 1024 * 1024, maxRedirects: 0, label: '이미지', agent: false });
  } catch {
    throw new HttpError(502,'이미지를 가져오지 못했습니다. 주소와 공개 접근 여부를 확인하세요.');
  }
  if (result.status !== 200) throw new HttpError(502,'이미지 서버에서 파일을 받지 못했습니다.');
  const type = rasterMediaType(result.body);
  if (!type) throw new HttpError(415,'외부 이미지는 PNG, JPEG, WebP만 표시할 수 있습니다.');
  return { type, bytes: result.body };
}
