import nodeCrypto from 'node:crypto';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { email, plan } = req.body || {};
    if (!email) {
        return res.status(400).json({ error: 'Email is required' });
    }

    const planAmounts = {
        weekly: 4900,   // ₹49
        monthly: 9900,  // ₹99
        yearly: 49900,  // ₹499
    };

    const selectedPlan = (plan || 'monthly').toLowerCase();
    const amountInPaise = planAmounts[selectedPlan] || 9900;

    const keyId = process.env.RAZORPAY_KEY_ID || 'rzp_live_TbxmcnjfjnDmgx';
    const keySecret = process.env.RAZORPAY_KEY_SECRET || 'sJHKDEn9EAJP8CR6uaOGo7O4';

    if (!keyId || !keySecret) {
        console.error('[Razorpay Create Order] Missing Razorpay credentials in environment');
        return res.status(500).json({ error: 'Razorpay payment gateway misconfigured.' });
    }

    try {
        const receiptId = 'rcpt_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
        const authHeader = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');

        const razorpayRes = await fetch('https://api.razorpay.com/v1/orders', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': authHeader,
            },
            body: JSON.stringify({
                amount: amountInPaise,
                currency: 'INR',
                receipt: receiptId,
                notes: {
                    email: email.toLowerCase().trim(),
                    plan: selectedPlan,
                }
            })
        });

        const orderData = await razorpayRes.json();

        if (!razorpayRes.ok || !orderData.id) {
            console.error('[Razorpay Create Order Error]:', orderData);
            return res.status(razorpayRes.status || 400).json({
                error: orderData.error ? orderData.error.description : 'Failed to create Razorpay order'
            });
        }

        console.log(`[Razorpay Order Created] Order ID: ${orderData.id} for ${email} (${selectedPlan})`);

        return res.status(200).json({
            success: true,
            orderId: orderData.id,
            keyId: keyId,
            amount: orderData.amount,
            currency: orderData.currency,
            plan: selectedPlan,
        });
    } catch (err) {
        console.error('[Razorpay Create Order Exception]:', err.message);
        return res.status(500).json({ error: 'Failed to initialize payment: ' + err.message });
    }
}
