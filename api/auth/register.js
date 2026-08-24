import { connectToDatabase, User } from '../../db.js';
import crypto from 'node:crypto';

// Secure pbkdf2 native hashing (zero dependency)
export function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return `${salt}:${hash}`;
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

    const { email, password, phone } = req.body;

    if (!email || !password || !email.includes('@') || password.length < 6) {
        return res.status(400).json({ error: 'Invalid input. Password must be at least 6 characters.' });
    }

    try {
        await connectToDatabase();

        // Check if user already exists
        const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
        if (existingUser) {
            return res.status(409).json({ error: 'Email is already registered. Please log in.' });
        }

        // Determine if first user should be admin, or special email handles
        let role = 'user';
        const lowerEmail = email.toLowerCase().trim();
        // Grant admin privileges if requested by admin email or if it matches user's request (role admin and premium)
        if (lowerEmail.startsWith('admin') || lowerEmail.includes('anihub')) {
            role = 'admin';
        }

        const hashedPassword = hashPassword(password);

        const newUser = await User.create({
            email: lowerEmail,
            password: hashedPassword,
            phone: phone || '',
            role
        });

        return res.status(201).json({
            success: true,
            message: 'Registration successful!',
            user: {
                email: newUser.email,
                role: newUser.role
            }
        });

    } catch (err) {
        console.error('[Register Auth Error]:', err.message);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}
