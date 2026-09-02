import { connectToDatabase, User, ApiSubscription } from '../../db.js';
import { checkAndResetDailyTrials } from '../parse.js';
import crypto from 'node:crypto';

// Verify stateless token signature
export function verifySessionToken(token) {
    if (!token || !token.includes('.')) return null;
    const [payloadB64, signature] = token.split('.');
    const key = process.env.API_KEY;
    
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

    // Accept token from either Authorization: Bearer or x-api-key header
    // (header.php sends it via x-api-key for server-side fetches)
    const authHeader = req.headers['authorization'];
    const xApiKey = req.headers['x-api-key'];
    
    let token = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
    } else if (xApiKey) {
        token = xApiKey;
    }

    if (!token) {
        return res.status(401).json({ error: 'Unauthorized. Missing token.' });
    }

    const decoded = verifySessionToken(token);

    if (!decoded) {
        return res.status(401).json({ error: 'Unauthorized. Invalid token session.' });
    }

    try {
        await connectToDatabase();

        let user = await User.findOne({ email: decoded.email });
        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }

        user = await checkAndResetDailyTrials(user);

        // Build active subscription details directly from User document
        const isPremiumUser = user.premiumStatus === 'premium' || (user.plan && user.plan !== 'free') || user.role === 'admin';
        const isExpired = user.premiumExpiresAt && new Date(user.premiumExpiresAt) < new Date();

        const subscription = (isPremiumUser && !isExpired) ? {
            plan: user.plan || (user.role === 'admin' ? 'yearly' : 'premium'),
            status: 'active',
            expiresAt: user.premiumExpiresAt || (user.role === 'admin' ? new Date(Date.now() + 315360000000) : null)
        } : null;

        return res.status(200).json({
            success: true,
            user: {
                email: user.email,
                role: user.role,
                name: user.name || user.email.split('@')[0],
                avatar: user.avatar || '',
                plan: user.plan || 'free',
                freePremiumUsesRemaining: user.freePremiumUsesRemaining !== undefined ? user.freePremiumUsesRemaining : 3,
                premiumStatus: user.premiumStatus || 'free',
                premiumExpiresAt: user.premiumExpiresAt || null,
                createdAt: user.createdAt
            },
            subscription
        });

    } catch (err) {
        console.error('[Auth Me Error]:', err.message);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}
