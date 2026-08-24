import { connectToDatabase, User } from '../../db.js';
import crypto from 'node:crypto';

// Verify pbkdf2 hash
export function verifyPassword(password, storedPassword) {
    if (!storedPassword || !storedPassword.includes(':')) return false;
    const [salt, originalHash] = storedPassword.split(':');
    const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return hash === originalHash;
}

// Generate secure stateless signature token
export function generateSessionToken(email, role) {
    const key = process.env.API_KEY;
    const payload = JSON.stringify({ email: email.toLowerCase().trim(), role });
    const signature = crypto.createHmac('sha256', key).update(payload).digest('hex');
    return Buffer.from(payload).toString('base64') + '.' + signature;
}

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Please enter email and password.' });
    }

    try {
        await connectToDatabase();

        const user = await User.findOne({ email: email.toLowerCase().trim() });
        if (!user) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        const isMatch = verifyPassword(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        // Generate session token
        const token = generateSessionToken(user.email, user.role);

        return res.status(200).json({
            success: true,
            message: 'Login successful!',
            token,
            user: {
                email: user.email,
                role: user.role
            }
        });

    } catch (err) {
        console.error('[Login Auth Error]:', err.message);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}
