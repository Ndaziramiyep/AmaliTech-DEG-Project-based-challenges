import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import IdempotencyRecord from '../models/IdempotencyRecord';
import redis from '../config/redis';

const POLL_INTERVAL_MS = parseInt(process.env.IN_FLIGHT_POLL_INTERVAL_MS ?? '200', 10);
const IN_FLIGHT_TIMEOUT_MS = parseInt(process.env.IN_FLIGHT_TIMEOUT_MS ?? '10000', 10);
const TTL_HOURS = parseInt(process.env.IDEMPOTENCY_KEY_TTL_HOURS ?? '24', 10);
const TTL_SECONDS = TTL_HOURS * 3600;

const REDIS_PREFIX = 'idempotency:';

interface CachedRecord {
  requestBodyHash: string;
  statusCode: number;
  responseBody: unknown;
}

function hashBody(body: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function expiresAt(): Date {
  return new Date(Date.now() + TTL_SECONDS * 1000);
}

async function getFromRedis(key: string): Promise<CachedRecord | null> {
  try {
    const raw = await redis.get(REDIS_PREFIX + key);
    return raw ? (JSON.parse(raw) as CachedRecord) : null;
  } catch {
    return null;
  }
}

async function setInRedis(key: string, data: CachedRecord): Promise<void> {
  try {
    await redis.setex(REDIS_PREFIX + key, TTL_SECONDS, JSON.stringify(data));
  } catch {
    // Non-fatal — MongoDB remains source of truth
  }
}

async function waitForResult(key: string): Promise<{ statusCode: number | null; responseBody: unknown } | null> {
  const deadline = Date.now() + IN_FLIGHT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));

    const cached = await getFromRedis(key);
    if (cached) {
      return { statusCode: cached.statusCode, responseBody: cached.responseBody };
    }

    const record = await IdempotencyRecord.findOne({ key }).lean();
    if (record?.status === 'completed') {
      return { statusCode: record.statusCode, responseBody: record.responseBody };
    }
  }
  return null;
}

export async function idempotencyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

  if (!idempotencyKey) {
    res.status(400).json({ error: 'Missing required header: Idempotency-Key' });
    return;
  }

  const bodyHash = hashBody(req.body);

  // Fast path — Redis cache hit bypasses MongoDB entirely
  const cached = await getFromRedis(idempotencyKey);
  if (cached) {
    if (cached.requestBodyHash !== bodyHash) {
      res.status(409).json({ error: 'Idempotency key already used for a different request body.' });
      return;
    }
    res.status(cached.statusCode).set('X-Cache-Hit', 'true').json(cached.responseBody);
    return;
  }

  let record;
  try {
    record = await IdempotencyRecord.findOneAndUpdate(
      { key: idempotencyKey },
      {
        $setOnInsert: {
          key: idempotencyKey,
          requestBodyHash: bodyHash,
          status: 'pending',
          expiresAt: expiresAt(),
        },
      },
      { upsert: true, new: false }
    );
  } catch (err: unknown) {
    const mongoErr = err as { code?: number };
    if (mongoErr.code === 11000) {
      record = await IdempotencyRecord.findOne({ key: idempotencyKey });
    } else {
      next(err);
      return;
    }
  }

  // Fresh insert — first request for this key
  if (!record) {
    const originalJson = res.json.bind(res) as (body: unknown) => Response;
    let capturedBody: unknown;
    res.json = function (body: unknown): Response {
      capturedBody = body;
      return originalJson(body);
    };

    res.on('finish', async () => {
      const update = { status: 'completed', statusCode: res.statusCode, responseBody: capturedBody };
      await Promise.all([
        IdempotencyRecord.findOneAndUpdate({ key: idempotencyKey }, update).catch(() => undefined),
        setInRedis(idempotencyKey, { requestBodyHash: bodyHash, statusCode: res.statusCode, responseBody: capturedBody }),
      ]);
    });

    next();
    return;
  }

  // Record already existed — validate body hash
  if (record.requestBodyHash !== bodyHash) {
    res.status(409).json({ error: 'Idempotency key already used for a different request body.' });
    return;
  }

  if (record.status === 'completed') {
    // Backfill Redis so future requests don't hit MongoDB
    void setInRedis(idempotencyKey, {
      requestBodyHash: record.requestBodyHash,
      statusCode: record.statusCode ?? 200,
      responseBody: record.responseBody,
    });
    res.status(record.statusCode ?? 200).set('X-Cache-Hit', 'true').json(record.responseBody);
    return;
  }

  // In-flight — poll Redis then MongoDB until completed or timeout
  const result = await waitForResult(idempotencyKey);
  if (!result) {
    res.status(503).json({
      error: 'A request with this key is already being processed. Please retry shortly.',
    });
    return;
  }
  res.status(result.statusCode ?? 200).set('X-Cache-Hit', 'true').json(result.responseBody);
}
