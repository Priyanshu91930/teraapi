import createOrderHandler from './create-order.js';
import verifyPlayPurchaseHandler from './verify-play-purchase.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const url = req.url || '';
  const body = req.body || {};

  if (url.includes('verify-play-purchase') || body.purchaseToken || req.query?.action === 'verify') {
    return verifyPlayPurchaseHandler(req, res);
  }

  if (url.includes('create-order') || body.plan || req.query?.action === 'create-order') {
    return createOrderHandler(req, res);
  }

  return res.status(404).json({ error: 'Payment endpoint not found' });
}
