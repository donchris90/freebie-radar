import { BadRequestException, Controller, Get, Inject, NotFoundException, Param, Post, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { Matches } from 'class-validator';
import { CurrentUser, JwtAuthGuard } from '../auth/auth';
import type { UserRec } from '../domain/models';
import { ImageError, MAX_UPLOAD_BYTES, processImage } from './images';
import { photoKey } from './keys';
import { LocalDiskStorage, STORAGE, StorageDriver } from './storage';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export class PhotoParams {
  @Matches(new RegExp(`^${UUID}$`, 'i')) userId!: string;
  @Matches(new RegExp(`^${UUID}\\.jpg$`, 'i')) file!: string;
}

@Controller()
export class UploadsController {
  constructor(@Inject(STORAGE) private readonly storage: StorageDriver) {}

  /** Upload one photo (multipart field "file"). Returns the URL to put in a listing's imageUrls. */
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('uploads/images')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  async upload(@CurrentUser() user: UserRec, @UploadedFile() file: Express.Multer.File | undefined, @Req() req: Request) {
    if (!file?.buffer?.length) throw new BadRequestException('Attach a photo in the "file" field');
    let img;
    try {
      img = await processImage(file.buffer);
    } catch (e) {
      if (e instanceof ImageError) throw new BadRequestException(e.message);
      throw e;
    }
    const key = photoKey(user.id, randomUUID());
    await this.storage.put(key, img.body, img.contentType);
    const base = `${req.protocol}://${req.get('host')}`;
    return { url: this.storage.publicUrl(key, base), width: img.width, height: img.height, bytes: img.body.length };
  }

  /** Serves photos stored on local disk. With an object store, photos are served from its own URL instead. */
  @Get('uploads/u/:userId/:file')
  serve(@Param() p: PhotoParams, @Res() res: Response) {
    if (!(this.storage instanceof LocalDiskStorage)) throw new NotFoundException();
    const abs = this.storage.localPath(photoKey(p.userId.toLowerCase(), p.file.replace(/\.jpg$/i, '').toLowerCase()));
    if (!abs) throw new NotFoundException();
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable', 'Cross-Origin-Resource-Policy': 'cross-origin' });
    res.sendFile(abs, (err) => {
      if (err && !res.headersSent) res.status(404).json({ message: 'Not found', statusCode: 404 });
    });
  }
}
