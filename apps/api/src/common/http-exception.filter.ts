import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const header = request.headers['x-trace-id'];
    const traceId = typeof header === 'string' ? header : undefined;

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    if (status >= 500) {
      this.logger.error({
        event: 'unhandled.exception',
        traceId,
        error: String(exception),
      });
    }

    const message =
      exception instanceof HttpException
        ? this.getHttpExceptionMessage(exception)
        : 'Internal server error';

    response.status(status).json({
      statusCode: status,
      traceId,
      message,
    });
  }

  private getHttpExceptionMessage(exception: HttpException): string {
    const res = exception.getResponse();
    if (typeof res === 'string') {
      return res;
    }
    if (typeof res === 'object' && res !== null && 'message' in res) {
      const msg = (res as { message: string | string[] }).message;
      return Array.isArray(msg) ? msg.join(', ') : msg;
    }
    return exception.message;
  }
}
