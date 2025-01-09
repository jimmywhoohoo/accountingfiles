import type { Request, Response, NextFunction } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ErrorLog {
  timestamp: string;
  level: 'error' | 'warn' | 'info';
  message: string;
  stack?: string;
  path?: string;
  method?: string;
  query?: any;
  body?: any;
  user?: any;
}

class ErrorLogger {
  private static instance: ErrorLogger;
  private logDir: string;
  private logFile: string;

  private constructor() {
    this.logDir = path.join(__dirname, '../logs');
    this.logFile = path.join(this.logDir, 'error.log');
    this.initializeLogDirectory();
  }

  public static getInstance(): ErrorLogger {
    if (!ErrorLogger.instance) {
      ErrorLogger.instance = new ErrorLogger();
    }
    return ErrorLogger.instance;
  }

  private async initializeLogDirectory() {
    try {
      await fs.mkdir(this.logDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create log directory:', error);
    }
  }

  public async log(error: Error | string, req?: Request, level: 'error' | 'warn' | 'info' = 'error') {
    const log: ErrorLog = {
      timestamp: new Date().toISOString(),
      level,
      message: error instanceof Error ? error.message : error,
      stack: error instanceof Error ? error.stack : undefined,
    };

    if (req) {
      log.path = req.path;
      log.method = req.method;
      log.query = req.query;
      log.body = req.body;
      log.user = req.user;
    }

    try {
      const logEntry = JSON.stringify(log) + '\n';
      await fs.appendFile(this.logFile, logEntry);
      
      // Also log to console in development
      if (process.env.NODE_ENV !== 'production') {
        console.error(`[${log.level.toUpperCase()}] ${log.message}`);
        if (log.stack) console.error(log.stack);
      }
    } catch (error) {
      console.error('Failed to write to error log:', error);
    }
  }
}

export const errorLogger = ErrorLogger.getInstance();

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  // Log the error
  errorLogger.log(err, req);

  // Send user-friendly response
  res.status(status).json({
    error: {
      message: status === 500 ? 'An unexpected error occurred' : message,
      code: status,
      id: Date.now().toString(36) + Math.random().toString(36).substr(2),
    },
  });
}

export function apiErrorLogger(req: Request, res: Response, next: NextFunction) {
  const originalSend = res.json;
  
  res.json = function(body) {
    if (res.statusCode >= 400) {
      errorLogger.log({
        message: `API Error: ${res.statusCode} ${body?.message || 'Unknown error'}`,
        stack: new Error().stack,
      } as Error, req, 'error');
    }
    return originalSend.call(this, body);
  };
  
  next();
}
