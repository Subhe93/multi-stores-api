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
      throw new BadRequestException({ code: 'UPLOAD_NO_FILE', message: 'No file provided' });
    }

    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = [...RASTER_EXTS, ...PASSTHROUGH_EXTS];
    if (!allowedExts.includes(ext)) {
      throw new BadRequestException(`File type ${ext} not allowed`);
    }

    const maxSize = 50 * 1024 * 1024; // 50MB
    if (file.size > maxSize) {
      throw new BadRequestException({ code: 'UPLOAD_FILE_TOO_LARGE', message: 'File too large (max 50MB)' });
    }

    const safeFolder = this.sanitizeFolder(folder);
    const folderPath = path.join(this.uploadDir, safeFolder);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }

    // Raster images are resized + re-encoded to WebP to shrink payloads
    // (often 70–90% smaller). Other types are written through untouched.
    const isRaster = RASTER_EXTS.includes(ext);
    const outExt = isRaster ? '.webp' : ext;
    const filename = `${randomUUID()}${outExt}`;
    const filePath = path.join(folderPath, filename);

    let bytesWritten = file.size;
    if (isRaster) {
      const buffer = await this.processImage(file.buffer, ext);
      fs.writeFileSync(filePath, buffer);
      bytesWritten = buffer.length;
    } else {
      fs.writeFileSync(filePath, file.buffer);
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
  private async processImage(buffer: Buffer, ext: string): Promise<Buffer> {
    try {
      return await sharp(buffer, { animated: ext === '.webp' })
        .rotate() // honour EXIF orientation before stripping metadata
        .resize(MAX_DIMENSION, MAX_DIMENSION, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
    } catch {
      throw new BadRequestException({ code: 'UPLOAD_IMAGE_PROCESS_FAILED', message: 'Could not process image — file may be corrupt' });
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
  async deleteFile(fileUrl: string): Promise<void> {
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
  }
}
