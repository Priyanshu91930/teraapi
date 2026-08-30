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

        const payload = req.body.payload;
        if (!payload || !payload.subscription) {
            return res.status(200).json({ success: true, message: 'No subscription payload found' });
        }

        const subEntity = payload.subscription.entity;
        const subscriptionId = subEntity.id;
        const notes = subEntity.notes || {};
        const email = (notes.email || subEntity.email || 'unknown@example.com').toLowerCase().trim();
        const plan = notes.plan || 'monthly';

        // ── IDEMPOTENCY CHECK ──────────────────────────────────────────────────
        // Prevent duplicate premium activations from repeated webhook deliveries
        const paymentIdempotencyKey = `${subscriptionId}_${event}`;
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
        } else if (plan === 'yearly') {
            requestLimit = 100000;
        }

        // Calculate plan expiry date
        const expiresAt = new Date();
        if (plan === 'weekly') {
            expiresAt.setDate(expiresAt.getDate() + 7);
        } else if (plan === 'yearly') {
            expiresAt.setFullYear(expiresAt.getFullYear() + 1);
        } else {
            expiresAt.setMonth(expiresAt.getMonth() + 1); // Default: monthly
        }

        if (event === 'subscription.activated' || event === 'subscription.charged') {
            // Generate a secure API Access Token for developer use
            const token = 'tera_api_' + crypto.randomBytes(16).toString('hex');

            // Upsert developer ApiSubscription
            const subscription = await ApiSubscription.findOneAndUpdate(
                { subscriptionId },
                {
                    $setOnInsert: { token }, // Only set token on creation
                    $set: {
                        email,
                        plan,
                        status: 'active',
                        requestLimit,
                        expiresAt,
                        lastReset: new Date()
                    }
                },
                { upsert: true, returnDocument: 'after' }
            );

            // ── GOOGLE USER PREMIUM UPGRADE ────────────────────────────────────
            // If the email matches a Google Auth user, upgrade their premium status
            // in the User collection so website premium features unlock immediately.
            const googleUser = await User.findOne({ email });
            if (googleUser) {
                googleUser.plan = plan;
                googleUser.premiumStatus = 'premium';
                googleUser.premiumExpiresAt = expiresAt;
                googleUser.updatedAt = new Date();
                await googleUser.save();
                console.log(`[Webhook] Google user ${email} upgraded to premium(${plan}) until ${expiresAt.toISOString()}`);
            }
            // ──────────────────────────────────────────────────────────────────

            // Log processed event for idempotency
            await ProcessedPayment.create({
                paymentId: paymentIdempotencyKey,
                email,
                amount: 0,
                status: 'activated'
            });

            console.log(`[Webhook] Activated subscription ${subscriptionId} for ${email}. Token: ${subscription.token}`);
            return res.status(200).json({
                success: true,
                message: 'Subscription activated',
                token: subscription.token
            });

        } else if (event === 'subscription.cancelled' || event === 'subscription.halted') {
            // Disable developer API token
            await ApiSubscription.updateOne(
                { subscriptionId },
                { $set: { status: 'cancelled' } }
            );

            // Downgrade Google user premium status when subscription cancelled
            const googleUser = await User.findOne({ email });
            if (googleUser && googleUser.premiumStatus === 'premium') {
                googleUser.plan = 'free';
                googleUser.premiumStatus = 'free';
                googleUser.updatedAt = new Date();
                await googleUser.save();
                console.log(`[Webhook] Google user ${email} downgraded to free (subscription cancelled).`);
            }

            // Log processed event for idempotency
            await ProcessedPayment.create({
                paymentId: paymentIdempotencyKey,
                email,
                amount: 0,
                status: 'cancelled'
            });

            console.log(`[Webhook] Cancelled subscription ${subscriptionId} for ${email}`);
            return res.status(200).json({ success: true, message: 'Subscription cancelled' });
        }

        return res.status(200).json({ success: true, message: 'Unhandled event type' });

    } catch (err) {
        console.error('[Webhook] Error processing webhook event:', err.message);
        return res.status(500).json({ error: 'Internal Server Error: ' + err.message });
    }
}
