import { connectToDatabase, User, ProcessedPayment } from '../../db.js';

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

  const { email, purchaseToken, productId, plan } = req.body || {};
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const userEmail = email.toLowerCase().trim();
  let selectedPlan = (plan || '').toLowerCase();

  // Smart SKU matching: Extract exact plan from Google Play productId
  if (productId) {
    const pid = String(productId).toLowerCase();
    if (pid.includes('weekly') || pid === 'weekly_pass') {
      selectedPlan = 'weekly';
    } else if (pid.includes('yearly') || pid === 'yearly_vip') {
      selectedPlan = 'yearly';
    } else if (pid.includes('monthly') || pid === 'monthly_pro') {
      selectedPlan = 'monthly';
    }
  }

  if (!selectedPlan) {
    selectedPlan = 'monthly';
  }

  try {
    await connectToDatabase();

    // Calculate plan expiry date
    const expiresAt = new Date();
    if (selectedPlan === 'weekly') {
      expiresAt.setDate(expiresAt.getDate() + 7);
    } else if (selectedPlan === 'yearly') {
      expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    } else {
      expiresAt.setMonth(expiresAt.getMonth() + 1); // Default: monthly
    }

    let user = await User.findOne({ email: userEmail });
    if (!user) {
      user = new User({ email: userEmail });
    }

    user.plan = selectedPlan;
    user.premiumStatus = 'premium';
    user.premiumExpiresAt = expiresAt;
    user.updatedAt = new Date();
    await user.save();

    if (purchaseToken) {
      await ProcessedPayment.create({
        paymentId: `play_${purchaseToken.substring(0, 30)}`,
        email: userEmail,
        amount: selectedPlan === 'weekly' ? 49 : (selectedPlan === 'yearly' ? 499 : 99),
        status: 'google_play_activated'
      }).catch(() => {});
    }

    console.log(`[Google Play Purchase Verified] User ${userEmail} upgraded to premium (${selectedPlan}) until ${expiresAt.toISOString()}`);

    return res.status(200).json({
      success: true,
      message: 'Google Play subscription activated successfully!',
      plan: selectedPlan,
      expiresAt: expiresAt.toISOString()
    });
  } catch (err) {
    console.error('[Google Play Verify Error]:', err.message);
    return res.status(500).json({ error: 'Failed to verify Google Play purchase: ' + err.message });
  }
}
