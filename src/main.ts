import { NestFactory } from '@nestjs/core';
import * as express from 'express';
import { AppModule } from './app.module';

export const PORT = Number(process.env.PORT || 3000);

const normalizeOriginList = () =>
  (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  const configuredOrigins = normalizeOriginList();
  const allowAll =
    process.env.NODE_ENV === 'dev' || process.env.CORS_ALLOW_ALL === 'true';

  app.enableCors({
    origin: (origin, callback) => {
      // Server-to-server clients (curl/Cline/OpenAI SDK) often have no Origin.
      if (!origin) return callback(null, true);
      if (allowAll) return callback(null, true);
      if (origin.startsWith('chrome-extension://')) return callback(null, true);
      if (origin.startsWith('moz-extension://')) return callback(null, true);
      if (configuredOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS origin not allowed: ${origin}`), false);
    },
    credentials: true,
  });

  await app.listen(PORT, '0.0.0.0', () => {
    console.log('Server started on: ', PORT);
    console.log('API URL: ', `http://localhost:${PORT}/`);
  });
}

bootstrap();
