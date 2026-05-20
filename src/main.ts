import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import { AppModule } from './app.module';
import { getEnv } from './config/env';

async function bootstrap(): Promise<void> {
  const env = getEnv();
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    bodyParser: false
  });

  app.use('/payments/webhook/stripe', express.raw({ type: 'application/json' }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true
    })
  );

  app.enableCors({
    origin: [env.API_ORIGIN, env.WEB_ORIGIN].filter(Boolean) as string[],
    credentials: true
  });

  await app.listen(env.API_PORT);
  Logger.log(`UFit backend listening on port ${env.API_PORT}`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  Logger.error(error instanceof Error ? error.message : error, undefined, 'Bootstrap');
  process.exitCode = 1;
});
