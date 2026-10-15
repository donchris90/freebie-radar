import sharp from 'sharp';

export class ImageError extends Error {}

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_EDGE = 1600;
const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp']);

export interface ProcessedImage {
  body: Buffer;
  contentType: 'image/jpeg';
  width: number;
  height: number;
}

/**
 * Decodes the upload as a real image and re-encodes it. This is deliberate:
 * - the content is verified by decoding it (a renamed file or a script is rejected),
 * - EXIF metadata, including the GPS position phones embed, is dropped, so a photo can never reveal
 *   the exact location the listing promises not to share,
 * - orientation is applied and the size is capped, which keeps feeds fast.
 */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  try {
    const meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).metadata();
    if (!meta.format || !ALLOWED_FORMATS.has(meta.format)) throw new ImageError('Use a JPEG, PNG or WebP photo');
    const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { body: data, contentType: 'image/jpeg', width: info.width, height: info.height };
  } catch (e) {
    if (e instanceof ImageError) throw e;
    throw new ImageError('That file is not a readable image');
  }
}
