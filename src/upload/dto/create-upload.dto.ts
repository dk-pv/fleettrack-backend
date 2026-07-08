import { IsEnum, IsString } from 'class-validator';
import { FileCategory } from '@prisma/client';

/**
 * Multipart text fields accompanying an upload. `category` is the generic
 * discriminator (RECEIPT / POD_*) the owning module supplies; `tripId` is the owner
 * link. The file part itself is validated by ParseFilePipe in the controller.
 */
export class CreateUploadDto {
  @IsEnum(FileCategory)
  category: FileCategory;

  @IsString()
  tripId: string;
}
