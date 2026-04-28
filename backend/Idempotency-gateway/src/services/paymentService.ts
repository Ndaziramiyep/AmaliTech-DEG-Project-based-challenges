import { PaymentBody, PaymentResult } from '../types';

const SUPPORTED_CURRENCIES = new Set(['GHS', 'USD', 'EUR', 'GBP', 'NGN']);

export function validatePayment({ amount, currency }: Partial<PaymentBody>): string | null {
  if (typeof amount !== 'number' || amount <= 0) {
    return 'amount must be a positive number';
  }
  if (!currency || !SUPPORTED_CURRENCIES.has(currency.toUpperCase())) {
    return `currency must be one of: ${[...SUPPORTED_CURRENCIES].join(', ')}`;
  }
  return null;
}

export async function processPayment({ amount, currency }: PaymentBody): Promise<PaymentResult> {
  await new Promise<void>((resolve) => setTimeout(resolve, 2000));

  return {
    status: 'success',
    message: `Charged ${amount} ${currency.toUpperCase()}`,
    transactionId: `TXN-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    amount,
    currency: currency.toUpperCase(),
    processedAt: new Date().toISOString(),
  };
}
