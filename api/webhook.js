import { connectToDatabase, ApiSubscription, User, ProcessedPayment } from '../db.js';
import crypto from 'node:crypto';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers['x-razorpay-signature'];

    // Verify webhook signature if secret is defined
    if (secret && signature) {
        const bodyStr = JSON.stringify(req.body);
        const expectedSignature = crypto
            .createHmac('sha256', secret)
            .update(bodyStr)
            .digest('hex');

        if (expectedSignature !== signature) {
            console.warn('[Webhook] Signature verification failed');
            return res.status(400).json({ error: 'Invalid signature' });
        }
    }

    const event = req.body.event;
    console.log(`[Webhook] Received Razorpay event: ${event}`);

    try {
        await connectToDatabase();

        const payload = req.body.payload || {};
        const entity = (payload.payment && payload.payment.entity) 
            || (payload.order && payload.order.entity) 
            || (payload.subscription && payload.subscription.entity) 
            || {};

        const paymentId = entity.id || 'pay_' + Date.now();
        const notes = entity.notes || {};
        const email = (notes.email || entity.email || 'unknown@example.com').toLowerCase().trim();
        const plan = notes.plan || 'monthly';

        // ── IDEMPOTENCY CHECK ──────────────────────────────────────────────────
        // Prevent duplicate premium activations from repeated webhook deliveries
        const paymentIdempotencyKey = `${paymentId}_${event}`;
        const alreadyProcessed = await ProcessedPayment.findOne({ paymentId: paymentIdempotencyKey });
        if (alreadyProcessed) {
            console.log(`[Webhook] Idempotency: Event ${paymentIdempotencyKey} already processed. Skipping.`);
            return res.status(200).json({ success: true, message: 'Event already processed (idempotent)' });
        }
        // ──────────────────────────────────────────────────────────────────────

        // Determine daily request quota based on duration plan
        let requestLimit = 50000;
        if (plan === 'weekly') {
            requestLimit = 20000;
        } else if (plan === 'yearly' || plan === 'quarterly') {
            requestLimit = 100000;
        }

        // Calculate plan expiry date
        const expiresAt = new Date();
        if (plan === 'weekly') {
            expiresAt.setDate(expiresAt.getDate() + 7);
        } else if (plan === 'quarterly') {
            expiresAt.setDate(expiresAt.getDate() + 90);
        } else if (plan === 'yearly') {
            expiresAt.setFullYear(expiresAt.getFullYear() + 1);
        } else {
            expiresAt.setMonth(expiresAt.getMonth() + 1); // Default: monthly
        }

        if (event === 'subscription.activated' || event === 'subscription.charged' || event === 'payment.captured' || event === 'order.paid') {
            // ── USER PREMIUM UPGRADE ──────────────────────────────────────────
            const user = await User.findOne({ email });
            if (user) {
                user.plan = plan;
                user.premiumStatus = 'premium';
                user.premiumExpiresAt = expiresAt;
                user.updatedAt = new Date();
                await user.save();
                console.log(`[Webhook] User ${email} upgraded to premium(${plan}) until ${expiresAt.toISOString()}`);
            }
            // ──────────────────────────────────────────────────────────────────

            // Log processed event for idempotency
            await ProcessedPayment.create({
                paymentId: paymentIdempotencyKey,
                email,
                amount: entity.amount ? entity.amount / 100 : 0,
                status: 'activated'
            });

            console.log(`[Webhook] Activated ${plan} for ${email}`);
            return res.status(200).json({
                success: true,
                message: 'Payment processed and user upgraded successfully'
            });

        } else if (event === 'subscription.cancelled' || event === 'subscription.halted') {
            // Downgrade user premium status when subscription cancelled
            const user = await User.findOne({ email });
            if (user && user.premiumStatus === 'premium') {
                user.plan = 'free';
                user.premiumStatus = 'free';
                user.updatedAt = new Date();
                await user.save();
                console.log(`[Webhook] User ${email} downgraded to free.`);
            }

            // Log processed event for idempotency
            await ProcessedPayment.create({
                paymentId: paymentIdempotencyKey,
                email,
                amount: 0,
                status: 'cancelled'
            });

            console.log(`[Webhook] Cancelled payment/plan for ${email}`);
            return res.status(200).json({ success: true, message: 'Plan cancelled' });
        }

        return res.status(200).json({ success: true, message: 'Unhandled event type' });

    } catch (err) {
        console.error('[Webhook] Error processing webhook event:', err.message);
        return res.status(500).json({ error: 'Internal Server Error: ' + err.message });
    }
}
