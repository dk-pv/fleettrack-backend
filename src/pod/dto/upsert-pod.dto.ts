import { IsDateString, IsOptional, IsString } from 'class-validator';

/**
 * Proof-of-delivery record upsert (POD-01 / POD-03). All fields optional — a partial
 * save never clears the others; setting `deliveredAt` confirms the delivery. Proof
 * media (photos/signature) is uploaded separately through the shared /uploads API.
 */
export class UpsertPodDto {
  @IsOptional()
  @IsString()
  recipientName?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsDateString()
  deliveredAt?: string;
}
