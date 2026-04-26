import { Injectable, BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

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
      throw new BadRequestException('No file provided');
    }

    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = ['.png', '.jpg', '.jpeg', '.svg', '.pdf', '.ai', '.webp'];
    if (!allowedExts.includes(ext)) {
      throw new BadRequestException(`File type ${ext} not allowed`);
    }

    const maxSize = 50 * 1024 * 1024; // 50MB
    if (file.size > maxSize) {
      throw new BadRequestException('File too large (max 50MB)');
    }

    const folderPath = path.join(this.uploadDir, folder);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }

    const filename = `${randomUUID()}${ext}`;
    const filePath = path.join(folderPath, filename);

    fs.writeFileSync(filePath, file.buffer);

    // In production, replace with S3/R2 URL
    const url = `/uploads/${folder}/${filename}`;

    return {
      url,
      file_type: ext.replace('.', ''),
      file_size: file.size,
    };
  }

  async deleteFile(fileUrl: string): Promise<void> {
    const filePath = path.join(process.cwd(), fileUrl);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}
