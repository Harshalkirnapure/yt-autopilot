import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { paths } from '../config.js';
import { badRequest } from '../utils/errors.js';

const MAX_BYTES = 8 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface SavedThumbnail {
  filePath: string;
  bytes: number;
  mimeType: 'image/png' | 'image/jpeg';
}

/** Accepts the canvas data URL posted by the frontend designer. */
export async function saveThumbnail(videoId: string, image: string): Promise<SavedThumbnail> {
  const match = /^data:image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/=\s]+)$/i.exec(image.trim());
  if (!match) {
    throw badRequest('Thumbnail must be a PNG or JPEG data URL (data:image/png;base64,...).');
  }

  const kind = match[1]!.toLowerCase() === 'png' ? 'png' : 'jpeg';
  const buffer = Buffer.from(match[2]!.replace(/\s+/g, ''), 'base64');

  if (!buffer.length) throw badRequest('Thumbnail payload is empty.');
  if (buffer.length > MAX_BYTES) throw badRequest('Thumbnail is too large (max 8 MB).');

  const isPng = buffer.subarray(0, 8).equals(PNG_SIGNATURE);
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
  if (kind === 'png' && !isPng) throw badRequest('The uploaded file is not a valid PNG.');
  if (kind === 'jpeg' && !isJpeg) throw badRequest('The uploaded file is not a valid JPEG.');

  // YouTube only accepts PNG/JPEG under 2 MB; store lossless PNG for the site and
  // let the uploader reject oversized files with a clear message.
  const filePath = path.join(paths.thumbnails, `${videoId}.png`);
  if (kind === 'png' && isPng) {
    await fs.writeFile(filePath, buffer);
  } else {
    // Normalise JPEG input to a .jpg file so the extension always matches the bytes.
    const jpegPath = path.join(paths.thumbnails, `${videoId}.jpg`);
    await fs.writeFile(jpegPath, buffer);
    return { filePath: jpegPath, bytes: buffer.length, mimeType: 'image/jpeg' };
  }

  if (!fsSync.existsSync(filePath)) throw badRequest('Thumbnail could not be saved.');
  return { filePath, bytes: buffer.length, mimeType: 'image/png' };
}
