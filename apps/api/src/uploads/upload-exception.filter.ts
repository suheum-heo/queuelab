import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

@Catch()
export class UploadExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status: (code: number) => { json: (body: unknown) => void };
    }>();

    if (error instanceof HttpException) {
      const body = error.getResponse();
      response.status(error.getStatus()).json(
        typeof body === 'string' ? { statusCode: error.getStatus(), message: body } : body,
      );
      return;
    }

    const code =
      error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code === 'LIMIT_FILE_SIZE') {
      response.status(HttpStatus.PAYLOAD_TOO_LARGE).json({
        statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
        message: 'CSV files must be 10 MB or smaller',
      });
      return;
    }
    if (code.startsWith('LIMIT_')) {
      response.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Upload was rejected',
      });
      return;
    }

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Upload failed',
    });
  }
}
