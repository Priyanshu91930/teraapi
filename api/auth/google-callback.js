import { connectToDatabase, User } from '../../db.js';
import { generateSessionToken } from './login.js';

export default async function handler(req, res) {
  const { code, state } = req.query;

  if (!code) {
    return res.status(400).json({ error: 'Missing authorization code from Google.' });
  }

  const client_id = process.env.GOOGLE_CLIENT_ID;
  const client_secret = process.env.GOOGLE_CLIENT_SECRET;
  const site_domain = process.env.SITE_DOMAIN || 'teraboxdownloader.co.in';

  if (!client_id || !client_secret) {
    console.error('[Google Callback] Google API OAuth credentials missing.');
    return res.status(500).json({ error: 'OAuth Callback misconfiguration.' });
  }

  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;
  const redirect_uri = `${protocol}://${host}/api/auth/google-callback`;

  try {
    // 1. Exchange Auth Code for Tokens
    const tokenUrl = 'https://oauth2.googleapis.com/token';
    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id,
        client_secret,
        redirect_uri,
        grant_type: 'authorization_code'
      })
    });

    const tokenData = await tokenRes.json();
    if (tokenData.error) {
      console.error('[Google OAuth] Token exchange failed:', tokenData);
      return res.status(400).json({ error: tokenData.error_description || 'Failed to exchange authorization code.' });
    }

    // 2. Fetch User Profile Details from Google
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

    // 3. Connect to Database and Upsert User Profile
    await connectToDatabase();
    
    // Find user by Google ID or by email
    let user = await User.findOne({ $or: [{ googleId }, { email }] });

    if (!user) {
      // Create new user (gets 3 free premium uses by default via schema defaults)
      user = new User({
        email,
        googleId,
        name,
        avatar,
        plan: 'free',
        premiumStatus: 'free',
        freePremiumUsesRemaining: 3
      });
      await user.save();
      console.log(`[Google OAuth] Created new user: ${email} with 3 trials.`);
    } else {
      // Update Google details on existing account
      user.googleId = googleId;
      user.name = name;
      user.avatar = avatar;
      user.updatedAt = new Date();
      await user.save();
      console.log(`[Google OAuth] Authenticated existing user: ${email}`);
    }

    // 4. Generate a secure stateless signature session token
    const sessionToken = generateSessionToken(user.email, user.role);

    // 5. Decode original landing path URL from base64 state parameter
    let returnUrl = '/';
    if (state) {
      try {
        returnUrl = Buffer.from(state, 'base64').toString('utf8');
      } catch (err) {
        console.error('[Google OAuth] Failed to decode state parameter:', err.message);
      }
    }

    // Ensure the landing page points back to the main website domain PHP callback handler
    // Example: https://teraboxdownloader.co.in/auth/callback.php?token=XYZ&state=ABC
    const cleanReturnUrl = returnUrl.startsWith('http') 
      ? returnUrl 
      : `https://${site_domain}${returnUrl}`;

    const redirectTarget = new URL(`https://${site_domain}/auth/callback.php`);
    redirectTarget.searchParams.set('token', sessionToken);
    redirectTarget.searchParams.set('state', cleanReturnUrl);

    console.log(`[Google OAuth] Redirecting authenticated user to PHP Callback: ${redirectTarget.toString()}`);
    return res.redirect(redirectTarget.toString());

  } catch (err) {
    console.error('[Google OAuth Callback Error]:', err.message);
    return res.status(500).json({ error: 'Internal Authentication callback error: ' + err.message });
  }
}
