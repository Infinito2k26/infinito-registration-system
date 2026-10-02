import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { StaffRequest } from '../auth/auth.types';
import { Response } from 'express';
import { StaffGuard } from '../auth/staff.guard';
import { PrismaService } from '../prisma/prisma.service';
import { WebExceptionFilter } from '../web/web-exception.filter';
import { DriveService } from './drive.service';

/**
 * Participant files. Photo and college ID card: any signed-in staff (volunteers check them at
 * the gate). Aadhaar card: admins only.
 */
@Controller('staff/files')
@UseGuards(StaffGuard)
@UseFilters(WebExceptionFilter)
export class DriveController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly drive: DriveService,
  ) {}

  @Get(':personId/:kind')
  async file(
    @Param('personId', ParseUUIDPipe) personId: string,
    @Param('kind') kind: string,
    @Req() req: StaffRequest,
    @Res() res: Response,
  ) {
    if (kind !== 'photo' && kind !== 'id' && kind !== 'aadhaar') throw new NotFoundException();
    // Aadhaar images: ADMIN only, checked on every request (a copied link doesn't help anyone else).
    if (kind === 'aadhaar' && req.staff!.role !== StaffRole.ADMIN) {
      throw new ForbiddenException('Aadhaar documents are only available to admins');
    }
    const person = await this.prisma.person.findUnique({
      where: { id: personId },
      select: { photoDriveId: true, idDocumentDriveId: true, aadhaarDriveId: true },
    });
    const fileId = { photo: person?.photoDriveId, id: person?.idDocumentDriveId, aadhaar: person?.aadhaarDriveId }[kind];
    const file = fileId ? await this.drive.fetchFile(fileId) : null;
    if (!file) throw new NotFoundException('File not available');
    res
      .set({
        'Content-Type': file.contentType,
        'Cache-Control': 'private, max-age=300',
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
        // Images opened directly can't run anything. (Not for PDFs: browsers won't render them sandboxed.)
        ...(file.contentType.startsWith('image/')
          ? { 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" }
          : {}),
      })
      .send(file.data);
  }
}
