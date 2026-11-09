import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';

export class CsvOptionsDto {
  @ApiPropertyOptional({ enum: [',', ';', '|', 'tab'], default: ',' })
  @IsOptional()
  @IsString()
  @IsIn([',', ';', '|', 'tab', '\t'])
  delimiter?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  hasHeader?: boolean;
}

export class CreateJobDto {
  @ApiProperty({ enum: ['CSV_ANALYSIS'], example: 'CSV_ANALYSIS' })
  @IsIn(['CSV_ANALYSIS'])
  type!: 'CSV_ANALYSIS';

  @ApiProperty({ description: 'Id returned by POST /uploads' })
  @IsUUID()
  fileId!: string;

  @ApiPropertyOptional({ type: CsvOptionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CsvOptionsDto)
  options?: CsvOptionsDto;
}
