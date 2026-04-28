import mongoose, { Document, Schema } from 'mongoose';
import { IdempotencyStatus } from '../types';

export interface IIdempotencyRecord extends Document {
  key: string;
  requestBodyHash: string;
  status: IdempotencyStatus;
  statusCode: number | null;
  responseBody: unknown;
  createdAt: Date;
  expiresAt: Date;
}

const idempotencyRecordSchema = new Schema<IIdempotencyRecord>({
  key: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  requestBodyHash: {
    type: String,
    required: true,
  },
  status: {
    type: String,
    enum: ['pending', 'completed'],
    default: 'pending',
  },
  statusCode: {
    type: Number,
    default: null,
  },
  responseBody: {
    type: Schema.Types.Mixed,
    default: null,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
});

// MongoDB TTL index — automatically purges expired idempotency records
idempotencyRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model<IIdempotencyRecord>('IdempotencyRecord', idempotencyRecordSchema);
