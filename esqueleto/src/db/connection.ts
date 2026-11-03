// Conexões de infraestrutura (MongoDB, Redis, MinIO). Só adapters/server importam daqui; engine/ não.
import mongoose from 'mongoose';
import Redis from 'ioredis';
import * as Minio from 'minio';

export const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://localhost:27017/hub_ia';
export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
export const MINIO_BUCKET = process.env.MINIO_BUCKET ?? 'hub-ia';

export async function connectMongo(): Promise<void> {
  mongoose.set('strictQuery', true);
  await mongoose.connect(MONGO_URL, { serverSelectionTimeoutMS: 10_000 });
  console.log(`MongoDB conectado (${mongoose.connection.name})`);
}

export const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
redis.on('error', (e) => console.error('Redis:', e.message));

export async function connectRedis(): Promise<void> {
  await redis.connect();
  console.log('Redis conectado');
}

export const minio = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT ?? 'localhost',
  port: Number(process.env.MINIO_PORT ?? 9000),
  useSSL: process.env.MINIO_USE_SSL === '1',
  accessKey: process.env.MINIO_ACCESS_KEY ?? 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY ?? 'minioadmin',
});

export async function connectMinio(): Promise<void> {
  if (!(await minio.bucketExists(MINIO_BUCKET))) await minio.makeBucket(MINIO_BUCKET);
  console.log(`MinIO conectado (bucket ${MINIO_BUCKET})`);
}

export async function connectAll(): Promise<void> {
  await Promise.all([connectMongo(), connectRedis(), connectMinio()]);
}

export async function disconnectAll(): Promise<void> {
  await Promise.allSettled([mongoose.disconnect(), redis.quit()]);
}
