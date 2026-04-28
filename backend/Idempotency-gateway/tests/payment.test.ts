import mongoose from 'mongoose';
import request from 'supertest';
import { app, start } from '../src/app';
import IdempotencyRecord from '../src/models/IdempotencyRecord';

const BASE_URL = '/api/process-payment';

beforeAll(async () => {
  process.env.MONGODB_URI = 'mongodb://localhost:27017/idempotency_gateway_test';
  process.env.IN_FLIGHT_POLL_INTERVAL_MS = '100';
  process.env.IN_FLIGHT_TIMEOUT_MS = '8000';
  await start();
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
});

beforeEach(async () => {
  await IdempotencyRecord.deleteMany({});
});

function uniqueKey(): string {
  return `key-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ── User Story 1: Happy Path ──────────────────────────────────────────────

describe('User Story 1 — First Transaction (Happy Path)', () => {
  it('returns 201 with a charged message on the first request', async () => {
    const res = await request(app)
      .post(BASE_URL)
      .set('Idempotency-Key', uniqueKey())
      .send({ amount: 100, currency: 'GHS' });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Charged 100 GHS');
    expect(res.body.transactionId).toBeDefined();
  });

  it('returns 400 when Idempotency-Key header is missing', async () => {
    const res = await request(app)
      .post(BASE_URL)
      .send({ amount: 100, currency: 'GHS' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Idempotency-Key/);
  });

  it('returns 400 for invalid amount', async () => {
    const res = await request(app)
      .post(BASE_URL)
      .set('Idempotency-Key', uniqueKey())
      .send({ amount: -50, currency: 'GHS' });

    expect(res.status).toBe(400);
  });

  it('returns 400 for unsupported currency', async () => {
    const res = await request(app)
      .post(BASE_URL)
      .set('Idempotency-Key', uniqueKey())
      .send({ amount: 100, currency: 'XYZ' });

    expect(res.status).toBe(400);
  });
});

// ── User Story 2: Idempotency (Duplicate Request) ────────────────────────

describe('User Story 2 — Duplicate Request (Idempotency)', () => {
  it('returns the cached response and X-Cache-Hit: true on retry', async () => {
    const key = uniqueKey();
    const payload = { amount: 200, currency: 'USD' };

    const first = await request(app)
      .post(BASE_URL)
      .set('Idempotency-Key', key)
      .send(payload);

    expect(first.status).toBe(201);

    const second = await request(app)
      .post(BASE_URL)
      .set('Idempotency-Key', key)
      .send(payload);

    expect(second.status).toBe(201);
    expect(second.headers['x-cache-hit']).toBe('true');
    expect(second.body).toEqual(first.body);
  });

  it('does not run the 2-second delay on a duplicate', async () => {
    const key = uniqueKey();
    const payload = { amount: 50, currency: 'EUR' };

    await request(app).post(BASE_URL).set('Idempotency-Key', key).send(payload);

    const startTime = Date.now();
    await request(app).post(BASE_URL).set('Idempotency-Key', key).send(payload);
    const elapsed = Date.now() - startTime;

    expect(elapsed).toBeLessThan(1000);
  });
});

// ── User Story 3: Different Body, Same Key ───────────────────────────────

describe('User Story 3 — Different Body Same Key (Conflict)', () => {
  it('returns 409 when the same key is used with a different body', async () => {
    const key = uniqueKey();

    await request(app)
      .post(BASE_URL)
      .set('Idempotency-Key', key)
      .send({ amount: 100, currency: 'GHS' });

    const conflict = await request(app)
      .post(BASE_URL)
      .set('Idempotency-Key', key)
      .send({ amount: 500, currency: 'GHS' });

    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatch(/different request body/i);
  });
});

// ── Bonus: In-Flight / Race Condition ────────────────────────────────────

describe('Bonus — In-Flight Race Condition', () => {
  it('waits for the first request and returns its result without double-processing', async () => {
    const key = uniqueKey();
    const payload = { amount: 75, currency: 'GBP' };

    const [first, second] = await Promise.all([
      request(app).post(BASE_URL).set('Idempotency-Key', key).send(payload),
      new Promise<request.Response>((resolve) =>
        setTimeout(
          () =>
            request(app)
              .post(BASE_URL)
              .set('Idempotency-Key', key)
              .send(payload)
              .then(resolve),
          300
        )
      ),
    ]);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['x-cache-hit']).toBe('true');
    expect(second.body).toEqual(first.body);
  });
});
