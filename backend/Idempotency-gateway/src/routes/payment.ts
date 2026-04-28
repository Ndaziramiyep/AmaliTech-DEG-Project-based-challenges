import { Router, Request, Response, NextFunction } from 'express';
import { idempotencyMiddleware } from '../middleware/idempotency';
import { validatePayment, processPayment } from '../services/paymentService';

const router = Router();

router.post(
  '/process-payment',
  idempotencyMiddleware,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { amount, currency } = req.body as { amount: unknown; currency: unknown };

      const validationError = validatePayment({
        amount: amount as number,
        currency: currency as string,
      });
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }

      const result = await processPayment({
        amount: amount as number,
        currency: currency as string,
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
