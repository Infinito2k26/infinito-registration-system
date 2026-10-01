import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Res, UseFilters, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { StaffGuard } from '../auth/staff.guard';
import { PrismaService } from '../prisma/prisma.service';
import { WebExceptionFilter } from '../web/web-exception.filter';
import { DriveService } from './drive.service';

/** Participant photo / ID image, for any signed-in staff (volunteers need it at the gate). */
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
    @Res() res: Response,
  ) {
    if (kind !== 'photo' && kind !== 'id') throw new NotFoundException();
    const person = await this.prisma.person.findUnique({
      where: { id: personId },
      select: { photoDriveId: true, idDocumentDriveId: true },
    });
    const fileId = kind === 'photo' ? person?.photoDriveId : person?.idDocumentDriveId;
    const file = fileId ? await this.drive.fetchFile(fileId) : null;
    if (!file) throw new NotFoundException('File not available');
    res
      .set({
        'Content-Type': file.contentType,
        'Cache-Control': 'private, max-age=300',
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
      })
      .send(file.data);
  }
}
