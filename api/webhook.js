import { connectToDatabase, ApiSubscription } from '../db.js';
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
        const email = notes.email || subEntity.email || 'unknown@example.com';
        const plan = notes.plan || 'monthly';

        // Determine daily request quota based on duration plan
        let requestLimit = 50000;
        if (plan === 'weekly') {
            requestLimit = 20000;
        } else if (plan === 'yearly') {
            requestLimit = 100000;
        }

        if (event === 'subscription.activated' || event === 'subscription.charged') {
            // Generate a secure API Access Token
            const token = 'tera_api_' + crypto.randomBytes(16).toString('hex');
            
            // Calculate expiry (1 month from now)
            const expiresAt = new Date();
            expiresAt.setMonth(expiresAt.getMonth() + 1);

            // Upsert subscription into MongoDB
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
                { upsert: true, new: true }
            );

            console.log(`[Webhook] Activated subscription ${subscriptionId} for ${email}. Token: ${subscription.token}`);

            return res.status(200).json({
                success: true,
                message: 'Subscription activated',
                token: subscription.token
            });

        } else if (event === 'subscription.cancelled' || event === 'subscription.halted') {
            // Disable token in MongoDB
            await ApiSubscription.updateOne(
                { subscriptionId },
                { $set: { status: 'cancelled' } }
            );

            console.log(`[Webhook] Cancelled subscription ${subscriptionId} for ${email}`);
            return res.status(200).json({ success: true, message: 'Subscription cancelled' });
        }

        return res.status(200).json({ success: true, message: 'Unhandled event type' });

    } catch (err) {
        console.error('[Webhook] Error processing webhook event:', err.message);
        return res.status(500).json({ error: 'Internal Server Error: ' + err.message });
    }
}
