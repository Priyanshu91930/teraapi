export default async function handler(req, res) {
  // CORS setup
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const client_id = process.env.GOOGLE_CLIENT_ID;
  if (!client_id) {
    console.error('[Google OAuth] GOOGLE_CLIENT_ID is missing in environment variables.');
    return res.status(500).json({ error: 'OAuth misconfiguration: Client ID is missing.' });
  }

  // Determine redirect callback target on Vercel dynamically to support local dev vs staging/prod
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;
  const redirect_uri = `${protocol}://${host}/api/auth/google-callback`;

  // The 'state' query param contains the destination URL on the website (e.g. /download?url=...)
  // We keep it so user is returned to the exact file context after successful OAuth.
  const returnState = req.query.state || '/';

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.search = new URLSearchParams({
    client_id: client_id,
    redirect_uri: redirect_uri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'select_account',
    state: Buffer.from(returnState).toString('base64') // Base64 safe encoding
  });

  return res.redirect(authUrl.toString());
}
