import { connectToDatabase, User, ApiSubscription } from '../../db.js';
import { verifySessionToken } from './me.js';
import { generateSessionToken } from './login.js';
import crypto from 'node:crypto';

export default async function handler(req, res) {
    // CORS setup
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Get path from URL to route requests: /api/auth/google, /api/auth/google-callback, /api/auth/me
    const url = req.url || '';
    
    // Route 1: Google Auth Initiation
    if (url.includes('/google') && !url.includes('/google-callback')) {
        const client_id = process.env.GOOGLE_CLIENT_ID;
        if (!client_id) {
            console.error('[Google OAuth] GOOGLE_CLIENT_ID is missing.');
            return res.status(500).json({ error: 'OAuth misconfiguration: Client ID is missing.' });
        }

        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers.host;
        const redirect_uri = `${protocol}://${host}/auth/google-callback`;

        const returnState = req.query.state || '/';
        const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        authUrl.search = new URLSearchParams({
            client_id,
            redirect_uri,
            response_type: 'code',
            scope: 'openid email profile',
            access_type: 'offline',
            prompt: 'select_account',
            state: Buffer.from(returnState).toString('base64')
        });

        return res.redirect(authUrl.toString());
    }

    // Route 2: Google Auth Callback
    if (url.includes('/google-callback')) {
        const { code, state } = req.query;
        if (!code) {
            return res.status(400).json({ error: 'Missing authorization code from Google.' });
        }

        const client_id = process.env.GOOGLE_CLIENT_ID;
        const client_secret = process.env.GOOGLE_CLIENT_SECRET;
        const site_domain = process.env.SITE_DOMAIN || 'teraboxdownloader.co.in';

        if (!client_id || !client_secret) {
            return res.status(500).json({ error: 'OAuth Callback misconfiguration.' });
        }

        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers.host;
        const redirect_uri = `${protocol}://${host}/auth/google-callback`;

        try {
            const tokenUrl = 'https://oauth2.googleapis.com/token';
            const tokenRes = await fetch(tokenUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    code, client_id, client_secret, redirect_uri,
                    grant_type: 'authorization_code'
                })
            });

            const tokenData = await tokenRes.json();
            if (tokenData.error) {
                return res.status(400).json({ error: tokenData.error_description || 'Failed to exchange authorization code.' });
            }

            const profileUrl = 'https://www.googleapis.com/oauth2/v2/userinfo';
            const profileRes = await fetch(profileUrl, {
                headers: { Authorization: `Bearer ${tokenData.access_token}` }
            });
            const profile = await profileRes.json();

            if (!profile.email) {
                return res.status(400).json({ error: 'Google did not return email identifier.' });
            }

            const email = profile.email.toLowerCase().trim();
            const name = profile.name || email.split('@')[0];
            const avatar = profile.picture || '';
            const googleId = profile.id;

            await connectToDatabase();
            let user = await User.findOne({ $or: [{ googleId }, { email }] });

            if (!user) {
                user = new User({
                    email, googleId, name, avatar,
                    plan: 'free', premiumStatus: 'free', freePremiumUsesRemaining: 3
                });
                await user.save();
            } else {
                user.googleId = googleId;
                user.name = name;
                user.avatar = avatar;
                user.updatedAt = new Date();
                await user.save();
            }

            const sessionToken = generateSessionToken(user.email, user.role);

            let returnUrl = '/';
            if (state) {
                try {
                    returnUrl = Buffer.from(state, 'base64').toString('utf8');
                } catch (err) {}
            }

            const cleanReturnUrl = returnUrl.startsWith('http') 
                ? returnUrl 
                : `https://${site_domain}${returnUrl}`;

            const redirectTarget = new URL(`https://${site_domain}/auth/callback.php`);
            redirectTarget.searchParams.set('token', sessionToken);
            redirectTarget.searchParams.set('state', cleanReturnUrl);

            return res.redirect(redirectTarget.toString());
        } catch (err) {
            return res.status(500).json({ error: 'Auth callback error: ' + err.message });
        }
    }

    // Route 3: Auth Me Profile Fetch
    if (url.includes('/me')) {
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
            const user = await User.findOne({ email: decoded.email });
            if (!user) {
                return res.status(404).json({ error: 'User not found.' });
            }

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
            return res.status(500).json({ error: 'Internal Server Error' });
        }
    }

    return res.status(404).json({ error: 'Endpoint not found.' });
}
