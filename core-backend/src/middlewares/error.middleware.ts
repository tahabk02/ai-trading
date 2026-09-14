import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

export const errorMiddleware = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  logger.error('Unhandled Exception', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  // If the response headers were already committed (e.g. a streaming body was
  // mid-flight when the error surfaced) a second write would corrupt the
  // socket and produce the exact "empty response" the client must never see —
  // let the framework close the connection cleanly instead.
  if (res.headersSent) {
    return next(err);
  }

  const env = process.env.NODE_ENV;
  const status = Number((err as { status?: unknown }).status) >= 400
    ? Number((err as { status?: unknown }).status)
    : 500;

  res.status(status).json({
    error: status >= 500 ? 'Internal Server Error' : 'Request Error',
    message: env === 'production' ? 'An unexpected error occurred' : err.message,
  });
};
