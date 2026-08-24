import { connectToDatabase, User, ApiSubscription } from '../../db.js';
import crypto from 'node:crypto';

// Verify stateless token signature
export function verifySessionToken(token) {
    if (!token || !token.includes('.')) return null;
    const [payloadB64, signature] = token.split('.');
    const key = process.env.API_KEY || 'AnihubTeraSecureKey2026_xYz';
    
    try {
        const payloadStr = Buffer.from(payloadB64, 'base64').toString('utf8');
        const expectedSignature = crypto.createHmac('sha256', key).update(payloadStr).digest('hex');
        
        if (expectedSignature !== signature) return null;
        return JSON.parse(payloadStr);
    } catch (e) {
        return null;
    }
}

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized. Missing token.' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = verifySessionToken(token);

    if (!decoded) {
        return res.status(401).json({ error: 'Unauthorized. Invalid token session.' });
    }

    try {
        await connectToDatabase();

        const user = await User.findOne({ email: decoded.email });
        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }

        // Fetch subscription
        let subscription = await ApiSubscription.findOne({ email: user.email, status: 'active' });

        // Admin override: Admin gets automatic unlimited premium access
        if (user.role === 'admin') {
            if (!subscription) {
                // Return a mock active admin subscription
                subscription = {
                    plan: 'yearly',
                    token: process.env.API_KEY || 'AnihubTeraSecureKey2026_xYz', // Admin can use the master key directly
                    status: 'active',
                    requestLimit: 1000000,
                    requestCount: 0,
                    expiresAt: new Date(Date.now() + 315360000000) // 10 years
                };
            } else {
                // Ensure admin limit is high
                subscription.requestLimit = 1000000;
            }
        }

        return res.status(200).json({
            success: true,
            user: {
                email: user.email,
                role: user.role,
                createdAt: user.createdAt
            },
            subscription: subscription ? {
                plan: subscription.plan,
                token: subscription.token,
                status: subscription.status,
                requestLimit: subscription.requestLimit,
                requestCount: subscription.requestCount,
                expiresAt: subscription.expiresAt
            } : null
        });

    } catch (err) {
        console.error('[Auth Me Error]:', err.message);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}
