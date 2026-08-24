import { TeraBoxApp } from '../api.js';
import ytdl from '@distube/ytdl-core';
import { youtube, igdl, ttdl, fbdown } from 'btch-downloader';
import { recordPageView, connectToDatabase, ApiSubscription } from '../db.js';

function formatBytes(bytes, decimals = 2) {
  if (!bytes || isNaN(bytes)) return 'Unknown';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Follow TeraBox dlink redirect to get actual CDN URL (faster download)
async function resolveCdnUrl(dlink, headers) {
  try {
    const response = await fetch(dlink, {
      method: 'GET',
      headers,
      redirect: 'manual', // Don't auto-follow, we want the Location header
    });
    // TeraBox returns 302 redirect to actual CDN URL
    if (response.status === 302 || response.status === 301) {
      const location = response.headers.get('location');
      if (location && location.startsWith('http')) {
        console.log('[CDN] Resolved redirect:', location.substring(0, 80) + '...');
        return location;
      }
    }
    // Already a direct URL or no redirect
    return dlink;
  } catch (e) {
    console.log('[CDN] Redirect resolve failed, using original dlink:', e.message);
    return dlink;
  }
}

export default async function handler(req, res) {
  // Handle CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Security Check: Validate API Key / Subscription Token
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  const expectedKey = process.env.API_KEY || 'AnihubTeraSecureKey2026_xYz';
  
  if (apiKey !== expectedKey) {
    if (!apiKey) {
      return res.status(403).json({ error: "Access denied. Missing API key." });
    }

    try {
      await connectToDatabase();
      const subscription = await ApiSubscription.findOne({ token: apiKey });

      if (!subscription || subscription.status !== 'active') {
        return res.status(403).json({ error: "Access denied. Invalid or inactive subscription token." });
      }

      // Check Expiry
      if (subscription.expiresAt && new Date(subscription.expiresAt) < new Date()) {
        subscription.status = 'expired';
        await subscription.save();
        return res.status(403).json({ error: "Access denied. Subscription token has expired." });
      }

      // Check and Reset daily quota
      const now = new Date();
      const lastReset = new Date(subscription.lastReset);
      const isNewDay = now.getUTCFullYear() !== lastReset.getUTCFullYear() ||
                        now.getUTCMonth() !== lastReset.getUTCMonth() ||
                        now.getUTCDate() !== lastReset.getUTCDate();

      if (isNewDay) {
        subscription.requestCount = 0;
        subscription.lastReset = now;
      }

      // Check daily limit
      if (subscription.requestCount >= subscription.requestLimit) {
        await subscription.save();
        return res.status(429).json({ error: "Daily request limit exceeded for this plan. Please upgrade." });
      }

      // Increment request count
      subscription.requestCount += 1;
      await subscription.save();

    } catch (dbErr) {
      console.error('[DB] Token verification failed:', dbErr.message);
      return res.status(500).json({ error: "Internal security validation error." });
    }
  }

  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "url query parameter is required" });
  }

  const cleanUrl = url.trim().replace(/[\s\r\n\t]/g, '');

  try {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    recordPageView(ip).catch(e => console.error('[DB] recordPageView error:', e));

    const lowerUrl = cleanUrl.toLowerCase();

    // 1. YouTube Downloader
    if (lowerUrl.includes('youtube.com') || lowerUrl.includes('youtu.be')) {
      // Swap priority: Try btch-downloader first for high-speed conversion proxy links (no IP throttle).
      // Fall back to ytdl-core only if btch-downloader fails.
      let yt = null;
      try {
        const fb = await youtube(cleanUrl);
        if (fb && fb.status && fb.mp4) {
          yt = { ...fb, mp4Size: 0, mp3Size: 0 };
        }
      } catch (e) {
        console.log(`[Parse] btch-downloader youtube failed, trying ytdl-core:`, e.message);
      }

      if (!yt || !yt.mp4) {
        try {
          const info = await ytdl.getInfo(cleanUrl, { requestOptions: { timeout: 20000 } });
          const video = ytdl.chooseFormat(info.formats, { quality: 'highest', filter: 'audioandvideo' });
          const audio = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
          if (video && video.url) {
            yt = {
              status: true,
              title: info.videoDetails.title,
              thumbnail: (info.videoDetails.thumbnails && info.videoDetails.thumbnails[info.videoDetails.thumbnails.length - 1]?.url) || '',
              mp4: video.url,
              mp4Size: video.contentLength,
              mp3: audio && audio.url ? audio.url : '',
              mp3Size: audio ? audio.contentLength : 0,
            };
          }
        } catch (err) {
          console.log(`[Parse] ytdl-core fallback failed:`, err.message);
        }
      }

      if (!yt || !yt.mp4) {
        throw new Error('YouTube resolution failed. Please verify the URL and try again.');
      }

      return res.status(200).json({
        list: [
          {
            name: `${yt.title || 'YouTube_Video'} (Video - MP4)`,
            size: yt.mp4Size ? formatBytes(Number(yt.mp4Size)) : 'Unknown',
            thumbnail: yt.thumbnail || '',
            dlink: yt.mp4 || '',
          },
          {
            name: `${yt.title || 'YouTube_Video'} (Audio - MP3)`,
            size: yt.mp3Size ? formatBytes(Number(yt.mp3Size)) : 'Unknown',
            thumbnail: yt.thumbnail || '',
            dlink: yt.mp3 || '',
          }
        ]
      });
    }

    // 2. Instagram Downloader
    if (lowerUrl.includes('instagram.com')) {
      console.log(`Resolving Instagram URL: ${cleanUrl}...`);
      let data;
      try {
        const apiRes = await fetch(`https://backend1.tioo.eu.org/igdl?url=${encodeURIComponent(cleanUrl)}`);
        data = await apiRes.json();
      } catch (err) {
        // Fallback to SDK
        const sdkRes = await igdl(cleanUrl);
        data = sdkRes.result || sdkRes;
      }
      
      const list = Array.isArray(data) ? data : (data.result || []);
      const first = list[0];
      if (!first) {
        throw new Error('No media files found in this Instagram post');
      }

      let caption = (data && data.caption) || (first && first.caption) || '';
      if (caption.length > 60) {
        caption = caption.substring(0, 60).trim() + '...';
      }
      const igTitle = caption ? `${caption} (Instagram).mp4` : `Instagram_Video_${Date.now().toString().slice(-4)}.mp4`;
      const igThumbnail = first.thumbnail || first.thumbnail_url || first.preview || '';

      return res.status(200).json({
        list: [{
          name: igTitle,
          size: 'Unknown',
          thumbnail: igThumbnail,
          dlink: first.url || first.dlink || '',
        }]
      });
    }

    // 3. TikTok Downloader
    if (lowerUrl.includes('tiktok.com')) {
      const tt = await ttdl(cleanUrl);
      if (!tt.status) {
        throw new Error(tt.message || 'TikTok resolution failed');
      }
      const videoUrl = Array.isArray(tt.video) ? tt.video[0] : tt.video;
      if (!videoUrl) {
        throw new Error('No video found in this TikTok');
      }
      return res.status(200).json({
        list: [{
          name: tt.title || 'TikTok_Video.mp4',
          size: 'Unknown',
          thumbnail: tt.thumbnail || '',
          dlink: videoUrl,
        }]
      });
    }

    // 4. Facebook Downloader
    if (lowerUrl.includes('facebook.com') || lowerUrl.includes('fb.watch') || lowerUrl.includes('fb.gg')) {
      console.log(`Resolving Facebook URL: ${cleanUrl}...`);
      let data;
      try {
        const apiRes = await fetch(`https://backend1.tioo.eu.org/fbdown?url=${encodeURIComponent(cleanUrl)}`);
        data = await apiRes.json();
      } catch (err) {
        data = await fbdown(cleanUrl);
      }

      const videoUrl = data.HD || data.Normal_video || data.url;
      if (!videoUrl) {
        throw new Error('No video found in this Facebook post');
      }

      let title = data.title || data.caption || 'Facebook_Video';
      if (title.length > 60) {
        title = title.substring(0, 60).trim() + '...';
      }
      const fbThumbnail = data.thumbnail || data.cover || data.image || data.thumb || '';

      return res.status(200).json({
        list: [{
          name: title.endsWith('.mp4') ? title : `${title}.mp4`,
          size: 'Unknown',
          thumbnail: fbThumbnail,
          dlink: videoUrl,
        }]
      });
    }

    // Default to TeraBox
    let shortUrl = "";
    const sMatch = cleanUrl.match(/\/s\/([A-Za-z0-9_-]+)/);
    const surlMatch = cleanUrl.match(/surl=([A-Za-z0-9_-]+)/);

    if (sMatch) {
      shortUrl = sMatch[1];
    } else if (surlMatch) {
      shortUrl = surlMatch[1];
    }

    if (!shortUrl) {
      return res.status(400).json({ error: "Invalid share link. Please paste a valid TeraBox, YouTube, Instagram, Facebook, or TikTok link." });
    }

    // Always strip the leading '1' from the shortUrl because the /share/list API expects the raw surl token
    const strippedShortUrl = shortUrl.replace(/^1/, '');

    // 1. Try resolving anonymously first to avoid regional cluster redirects (like dm.1024tera.com)
    const anonApp = new TeraBoxApp("");
    anonApp.params.ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    anonApp.TERABOX_DOMAIN = cleanUrl.includes('1024tera.com') || cleanUrl.includes('1024terabox.com') || cleanUrl.includes('terasharefile.com')
      ? '1024tera.com'
      : 'terabox.com';
    anonApp.params.whost = `https://www.${anonApp.TERABOX_DOMAIN}`;
    anonApp.params.uhost = `https://c-all.${anonApp.TERABOX_DOMAIN}`;

    let listData;
    try {
      listData = await anonApp.shortUrlList(strippedShortUrl);
    } catch (e) {
      // ignore
    }

    // 2. If anonymous fails, returns error, or lacks a dlink (direct download link), fallback to logged-in NDUS session
    const hasDlink = listData && listData.list && listData.list[0] && listData.list[0].dlink;
    let tokenExpiredDetected = false;

    if (!listData || listData.errno !== 0 || !hasDlink) {
      console.log(`[Parse] Anonymous resolution returned no dlink. Falling back to logged-in NDUS session...`);
      const ndusToken = process.env.TERABOX_NDUS || process.env.NDUS || process.env.ndus || process.env.NUDUS || process.env.nudus || "";
      if (ndusToken) {
        const app = new TeraBoxApp(ndusToken);
        app.params.ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        app.TERABOX_DOMAIN = anonApp.TERABOX_DOMAIN;
        app.params.whost = anonApp.params.whost;
        app.params.uhost = anonApp.params.uhost;

        try {
          const ndusData = await app.shortUrlList(strippedShortUrl);
          console.log(`[Parse] NDUS session response:`, JSON.stringify(ndusData));
          
          if (ndusData && ndusData.errno === 0) {
            listData = ndusData;
          } else if (ndusData && (ndusData.errno === 105 || ndusData.errno === -6 || ndusData.errno === 108)) {
            tokenExpiredDetected = true;
            console.warn(`[WARNING] TeraBox Premium Token (ndus) returned error code ${ndusData.errno}.`);
          }
        } catch (e) {
          console.error(`[Parse] NDUS session failed with error:`, e.message);
        }
      }
    }

    // Trigger Telegram notification if token expiry is detected
    if (tokenExpiredDetected) {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.CHAT_ID || "1892511025"; // Fallback to user ID from logs
      if (botToken && adminChatId) {
        console.log(`[Telegram Alert] Sending token expiry warning to admin chat: ${adminChatId}`);
        fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: adminChatId,
            text: `⚠️ <b>TeraBox Premium Token Expired!</b>\n\nThe premium cookie session (ndus) has expired or been blocked by TeraBox. The API is temporarily running in public/anonymous fallback mode.\n\nPlease update <b>TERABOX_NDUS</b> in Vercel settings and redeploy immediately.`,
            parse_mode: 'HTML'
          })
        }).catch(err => console.error('[Telegram Alert] Failed:', err.message));
      }
    }

    // Failsafe Fallback: If both failed, but anonymous returned a list (even without dlink), use it as fallback
    if ((!listData || listData.errno !== 0) && listData && listData.list) {
      listData.errno = 0; // Bypass error block to return whatever metadata we got
    }

    if (!listData || listData.errno !== 0) {
      const errCode = listData ? listData.errno : 'Unknown';
      return res.status(400).json({ error: `TeraBox API returned error code ${errCode}. Please verify the URL or try again later.` });
    }

    const ndusToken = process.env.TERABOX_NDUS || process.env.NDUS || process.env.ndus || process.env.NUDUS || process.env.nudus || "";

    const formattedList = await Promise.all((listData.list || []).map(async (file) => {
      const ext = file.server_filename?.split('.').pop()?.toLowerCase();
      const isVideo = ['mp4', 'webm', 'ogg', 'mkv', 'mov', 'avi', 'ts', 'wmv', '3gp', 'flv'].includes(ext);
      let streamUrl = '';

      if (isVideo && ndusToken) {
        try {
          const app = new TeraBoxApp(ndusToken);
          app.params.ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
          app.TERABOX_DOMAIN = anonApp.TERABOX_DOMAIN;
          app.params.whost = anonApp.params.whost;
          app.params.uhost = anonApp.params.uhost;

          let streamData;
          if (listData.share_id && listData.uk) {
            // Use the shared streaming endpoint which is optimized for shared links
            const streamEndpoint = `${app.params.whost}/share/streaming?path=${encodeURIComponent(file.path || '')}&uk=${listData.uk}&shareid=${listData.share_id}&type=M3U8_AUTO_480&vip=2`;
            const sRes = await fetch(streamEndpoint, {
              headers: {
                'User-Agent': app.params.ua,
                'Cookie': `ndus=${ndusToken}`,
                'Referer': `https://www.${app.TERABOX_DOMAIN}/`
              }
            });
            streamData = await sRes.json();
          } else {
            // Fallback to personal file stream endpoint
            streamData = await app.getStream(file.path || file.server_filename || '', 'M3U8_AUTO_480');
          }

          if (streamData && streamData.m3u8) {
            streamUrl = streamData.m3u8;
          } else if (streamData && streamData.result && streamData.result.m3u8) {
            streamUrl = streamData.result.m3u8;
          } else if (streamData && streamData.url) {
            streamUrl = streamData.url;
          }
        } catch (streamErr) {
          console.error('[Stream] Failed to resolve HLS stream:', streamErr.message);
        }
      }

      return {
        name: file.server_filename || 'video.mp4',
        size: file.size ? formatBytes(Number(file.size)) : 'Unknown',
        thumbnail: file.thumbs?.url3 || file.thumbs?.url1 || '',
        dlink: file.dlink || '',
        stream_url: streamUrl
      };
    }));

    return res.status(200).json({
      list: formattedList,
      downloadHeaders: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Cookie': ndusToken ? `ndus=${ndusToken}` : '',
        'Accept': '*/*',
        'Connection': 'keep-alive',
        'Referer': 'https://www.terabox.com/',
      }
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Failed to resolve link. Please verify the URL and try again.",
    });
  }
}
