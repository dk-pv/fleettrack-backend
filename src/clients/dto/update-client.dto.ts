import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * Admin edit of a client. `vehicleIds`, when sent, is the client's complete vehicle set:
 * vehicles left out return to the unassigned pool (never deleted), new ones must be
 * unassigned. Omit it to leave assignments untouched.
 */
export class UpdateClientDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  // Format deliberately not re-checked (no @IsEmail): this route never validated it, so
  // an existing login stays editable.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  email?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  vehicleIds?: string[];
}
