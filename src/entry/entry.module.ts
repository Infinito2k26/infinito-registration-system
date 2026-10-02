import { Module } from '@nestjs/common';
import { DriveModule } from '../drive/drive.module';
import { EntryService } from './entry.service';
import { ScanController } from './scan.controller';

@Module({
  imports: [DriveModule],
  controllers: [ScanController],
  providers: [EntryService],
})
export class EntryModule {}
