import { IsEnum, IsOptional, IsString } from 'class-validator';
import { FileCategory } from '@prisma/client';

/**
 * List query for a trip's files. `tripId` is required (files are always listed per
 * owning trip); `category` optionally narrows to one kind (e.g. only receipts).
 */
export class UploadQueryDto {
  @IsString()
  tripId: string;

  @IsOptional()
  @IsEnum(FileCategory)
  category?: FileCategory;
}
