import { Injectable, BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import sharp from 'sharp';

// Raster formats we re-encode to WebP. Vector/document types are stored as-is.
const RASTER_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];
const PASSTHROUGH_EXTS = ['.svg', '.pdf', '.ai'];

// Downscale anything larger than this on the longest edge — storefront images
// never need more, and next/image generates smaller responsive variants on top.
const MAX_DIMENSION = 2000;
const WEBP_QUALITY = 80;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class UploadsService {
  private readonly uploadDir = path.join(process.cwd(), 'uploads');

  constructor() {
    // Ensure uploads directory exists
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }
  }

  async uploadFile(
    file: Express.Multer.File,
    folder: string = 'general',
  ): Promise<{ url: string; file_type: string; file_size: number }> {
    if (!file) {
      throw new BadRequestException({
        code: 'UPLOAD_NO_FILE',
        message: 'No file provided',
      });
    }

    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = [...RASTER_EXTS, ...PASSTHROUGH_EXTS];
    if (!allowedExts.includes(ext)) {
      throw new BadRequestException(`File type ${ext} not allowed`);
    }

    const maxSize = 50 * 1024 * 1024; // 50MB
    if (file.size > maxSize) {
      throw new BadRequestException({
        code: 'UPLOAD_FILE_TOO_LARGE',
        message: 'File too large (max 50MB)',
      });
    }

    return this.storeBuffer(file.buffer, ext, folder);
  }

  /**
   * Writes a buffer under `uploads/<folder>/` exactly like `uploadFile` does
   * (M4.5 C21): raster input (`.png/.jpg/.jpeg/.webp`) is resized and
   * re-encoded to WebP, anything else is written through untouched. The
   * caller has already validated the type and size. `opts.id` fixes the file
   * name (`<id><ext>`) instead of a random uuid; it must be a uuid.
   * `opts.animated` / `opts.limitInputPixels` override the decoder options of
   * the raster path (customer uploads: first frame only, explicit pixel cap);
   * without them the output is exactly what `uploadFile` always produced.
   */
  async storeBuffer(
    buffer: Buffer,
    ext: string,
    folder: string = 'general',
    opts: { id?: string; animated?: boolean; limitInputPixels?: number } = {},
  ): Promise<{ url: string; file_type: string; file_size: number }> {
    const inExt = (ext.startsWith('.') ? ext : `.${ext}`).toLowerCase();
    const id = opts.id ?? randomUUID();
    if (!UUID_RE.test(id)) {
      throw new BadRequestException({
        code: 'UPLOAD_INVALID_PATH',
        message: 'Invalid file name',
      });
    }

    const safeFolder = this.sanitizeFolder(folder);
    const folderPath = path.join(this.uploadDir, safeFolder);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }

    // Raster images are resized + re-encoded to WebP to shrink payloads
    // (often 70–90% smaller). Other types are written through untouched.
    const isRaster = RASTER_EXTS.includes(inExt);
    const outExt = isRaster ? '.webp' : inExt;
    const filename = `${id}${outExt}`;
    const filePath = path.join(folderPath, filename);

    let bytesWritten = buffer.length;
    if (isRaster) {
      const out = await this.processImage(buffer, inExt, opts);
      fs.writeFileSync(filePath, out);
      bytesWritten = out.length;
    } else {
      fs.writeFileSync(filePath, buffer);
    }

    // In production, replace with S3/R2 URL
    const url = `/uploads/${safeFolder}/${filename}`;

    return {
      url,
      file_type: outExt.replace('.', ''),
      file_size: bytesWritten,
    };
  }

  /**
   * Resize (without enlarging) to fit within MAX_DIMENSION and encode as WebP.
   * Animated WebP frames are preserved. Rejects undecodable input rather than
   * storing it under a mismatched .webp name.
   */
  private async processImage(
    buffer: Buffer,
    ext: string,
    decode: { animated?: boolean; limitInputPixels?: number } = {},
  ): Promise<Buffer> {
    const input: sharp.SharpOptions = {
      animated: decode.animated ?? ext === '.webp',
    };
    if (decode.limitInputPixels !== undefined) {
      input.limitInputPixels = decode.limitInputPixels;
    }
    try {
      return await sharp(buffer, input)
        .rotate() // honour EXIF orientation before stripping metadata
        .resize(MAX_DIMENSION, MAX_DIMENSION, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
    } catch {
      throw new BadRequestException({
        code: 'UPLOAD_IMAGE_PROCESS_FAILED',
        message: 'Could not process image — file may be corrupt',
      });
    }
  }

  /**
   * Reduce a caller-supplied folder to a single safe path segment. Without this
   * a `folder` of `../../etc` wrote files outside the uploads tree entirely.
   */
  private sanitizeFolder(folder: string): string {
    const segment = (folder || '').trim().replace(/[^a-zA-Z0-9._-]/g, '');
    // Reject empties and anything that is only dots (`.`, `..`).
    if (!segment || /^\.+$/.test(segment)) return 'general';
    return segment;
  }

  /**
   * Delete an uploaded file. The url arrives from the client, so the resolved
   * path is checked to still be inside the uploads directory — previously
   * `../../` in the url escaped it and could unlink any file the process owns.
   */
  deleteFile(fileUrl: string): Promise<void> {
    const filePath = path.resolve(process.cwd(), '.' + path.sep + fileUrl);
    const root = path.resolve(this.uploadDir);
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      throw new BadRequestException({
        code: 'UPLOAD_INVALID_PATH',
        message: 'Invalid file path',
      });
    }
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return Promise.resolve();
  }
}
