export interface PaymentBody {
  amount: number;
  currency: string;
}

export interface PaymentResult {
  status: string;
  message: string;
  transactionId: string;
  amount: number;
  currency: string;
  processedAt: string;
}

export type IdempotencyStatus = 'pending' | 'completed';
