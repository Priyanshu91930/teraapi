import express from 'express';
import cors from 'cors';
import { TeraBoxApp } from './api.js';
import ytdl from '@distube/ytdl-core';
import { youtube, igdl, ttdl, fbdown } from 'btch-downloader';
import { connectToDatabase, Stat, incrementStat, recordPageView } from './db.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// API Key Verification Middleware for security (excludes /privacy)
const verifyApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  const expectedKey = process.env.API_KEY;
  if (apiKey !== expectedKey) {
    return res.status(403).json({ error: "Access denied. Invalid or missing API key." });
  }
  next();
};

app.use('/parse', verifyApiKey);
app.use('/stats', verifyApiKey);
app.use('/track', verifyApiKey);
app.use('/download', verifyApiKey);


function formatBytes(bytes, decimals = 2) {
  if (!bytes || isNaN(bytes)) return 'Unknown';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

app.get('/parse', async (req, res) => {
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
      console.log(`Resolving YouTube URL: ${cleanUrl}...`);

      // Swap priority: Try btch-downloader first for high-speed conversion proxy links (no IP throttle).
      // Fall back to ytdl-core only if btch-downloader fails.
      let yt = null;
      try {
        const fb = await youtube(cleanUrl);
        if (fb && fb.status && fb.mp4) {
          yt = { ...fb, mp4Size: 0, mp3Size: 0 };
        }
      } catch (e) {
        console.log(`btch-downloader youtube failed, trying ytdl-core:`, e.message);
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
          console.log(`ytdl-core fallback failed:`, err.message);
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
      console.log(`Resolving TikTok URL: ${cleanUrl}...`);
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
    if (!listData || listData.errno !== 0 || !hasDlink) {
      const ndusToken = process.env.TERABOX_NDUS || process.env.NDUS || process.env.ndus || process.env.NUDUS || process.env.nudus || "";
      if (ndusToken) {
        const app = new TeraBoxApp(ndusToken);
        app.params.ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        app.TERABOX_DOMAIN = anonApp.TERABOX_DOMAIN;
        app.params.whost = anonApp.params.whost;
        app.params.uhost = anonApp.params.uhost;

        try {
          const ndusData = await app.shortUrlList(strippedShortUrl);
          if (ndusData && ndusData.errno === 0) {
            listData = ndusData;
          }
        } catch (e) {
          // ignore
        }
      }
    }

    if (!listData || listData.errno !== 0) {
      const errCode = listData ? listData.errno : 'Unknown';
      return res.status(400).json({ error: `TeraBox API returned error code ${errCode}` });
    }

    const formattedList = (listData.list || []).map((file) => ({
      name: file.server_filename || 'video.mp4',
      size: file.size ? formatBytes(Number(file.size)) : 'Unknown',
      thumbnail: file.thumbs?.url3 || file.thumbs?.url1 || '',
      dlink: file.dlink || '',
    }));

    const ndusToken = process.env.TERABOX_NDUS || process.env.NDUS || process.env.ndus || process.env.NUDUS || process.env.nudus || "";

    return res.status(200).json({
      list: formattedList,
      downloadHeaders: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Cookie': ndusToken ? `ndus=${ndusToken}` : ''
      }
    });
  } catch (error) {
    console.error("Link resolution failed:", error);
    return res.status(500).json({
      error: error.message || "Failed to resolve link. Please try again.",
    });
  }
});

app.get('/download', async (req, res) => {
  const { url, filename } = req.query;

  if (!url) {
    return res.status(400).json({ error: "url query parameter is required" });
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return res.status(400).json({ error: "Invalid download URL" });
  }

  const ndusToken = process.env.TERABOX_NDUS || process.env.NDUS || process.env.ndus || process.env.NUDUS || process.env.nudus || "";
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Referer': 'https://www.terabox.com/',
  };
  if (ndusToken) headers['Cookie'] = `ndus=${ndusToken}`;

  const range = req.headers['range'];
  if (range) headers['Range'] = range;

  let upstream;
  try {
    upstream = await fetch(url, { headers, redirect: 'follow' });
  } catch (e) {
    return res.status(502).json({ error: 'Failed to reach upstream: ' + e.message });
  }
  if (!upstream.ok) {
    return res.status(upstream.status).json({ error: `Upstream returned HTTP ${upstream.status}` });
  }

  const copyHeader = (name, value) => {
    if (value) res.setHeader(name, value);
  };
  copyHeader('Content-Type', upstream.headers.get('content-type'));
  copyHeader('Content-Length', upstream.headers.get('content-length'));
  copyHeader('Content-Range', upstream.headers.get('content-range'));
  copyHeader('Accept-Ranges', upstream.headers.get('accept-ranges'));

  if (filename) {
    const safe = String(filename).replace(/[^\w\-. ]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
  }

  res.status(upstream.status);
  if (upstream.body) {
    const { Readable } = await import('stream');
    Readable.fromWeb(upstream.body).pipe(res);
    return;
  }
  return res.end();
});

app.get('/stats', async (req, res) => {
  try {
    await connectToDatabase();
    const statsList = await Stat.find({});
    const baseStats = {
      downloads: 0,
      views: 0,
      streams: 0,
      users: 0
    };
    statsList.forEach(stat => {
      if (baseStats[stat.key] !== undefined) {
        baseStats[stat.key] += stat.value;
      }
    });
    return res.status(200).json(baseStats);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to fetch statistics' });
  }
});

app.post('/track', async (req, res) => {
  const { type } = req.query;
  if (type === 'download' || type === 'downloads') {
    await incrementStat('downloads', 1);
    return res.status(200).json({ success: true, message: 'Download tracked' });
  }
  if (type === 'stream' || type === 'streams') {
    await incrementStat('streams', 1);
    return res.status(200).json({ success: true, message: 'Stream tracked' });
  }
  return res.status(400).json({ error: 'Invalid tracking type' });
});

app.get('/privacy', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Privacy Policy - Tera Downloader</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f9f9f9;
        }
        h1 {
            color: #2563EB;
            border-bottom: 2px solid #E2E8F0;
            padding-bottom: 10px;
        }
        h2 {
            color: #1E3A8A;
            margin-top: 30px;
        }
        p, li {
            font-size: 15px;
            color: #4A5568;
        }
        ul {
            padding-left: 20px;
        }
        a {
            color: #2563EB;
            text-decoration: none;
        }
        a:hover {
            text-decoration: underline;
        }
        .container {
            background-color: #ffffff;
            padding: 30px;
            border-radius: 12px;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
        }
        .footer {
            margin-top: 40px;
            text-align: center;
            font-size: 12px;
            color: #94A3B8;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Privacy Policy</h1>
        <p>Last updated: August 02, 2026</p>
        <p><strong>Tera Downloader</strong> ("us", "we", or "our") operates the mobile application (the "Service"). This page informs you of our policies regarding the collection, use, and disclosure of personal data when you use our Service and the choices you have associated with that data.</p>
        
        <h2>1. Information Collection and Use</h2>
        <p>We do not collect or store any personal identification information (PII) from our users. The app is a utility tool designed to help you resolve cloud links and download files directly to your device storage.</p>

        <h2>2. Permissions Requested</h2>
        <p>To provide its core features, our app requests the following device permissions:</p>
        <ul>
            <li><strong>Storage/Photos/Media Files Permission:</strong> Used solely to save the downloaded videos, images, or audio files directly to your device's downloads folder. We do not access, view, or read any other files on your device.</li>
            <li><strong>Network/Internet Access:</strong> Required to parse links from supported sources and fetch files for downloading.</li>
            <li><strong>Notifications Permission:</strong> Used to display ongoing file download progress bars, speed, and download completion alerts in the Android notification drawer.</li>
        </ul>

        <h2>3. Third-Party Service Providers</h2>
        <p>Our app utilizes third-party services that may collect information used to identify you. Below are the links to the privacy policies of the third-party service providers used by our application:</p>
        <ul>
            <li><a href="https://www.google.com/policies/privacy/" target="_blank" rel="noopener noreferrer">Google Play Services</a></li>
            <li><a href="https://support.google.com/admob/answer/6128543?hl=en" target="_blank" rel="noopener noreferrer">Google AdMob (Advertising)</a></li>
        </ul>

        <h2>4. Data Storage and Transfers</h2>
        <p>All downloaded files and parsed media streams are saved directly onto your device. Our servers do not host, store, or cache any user files. All link resolution processing happens temporarily in memory on serverless nodes and is immediately discarded.</p>

        <h2>5. Children's Privacy</h2>
        <p>Our Service does not address anyone under the age of 13. We do not knowingly collect personally identifiable information from children under 13.</p>

        <h2>6. Changes to This Privacy Policy</h2>
        <p>We may update our Privacy Policy from time to time. You are advised to review this page periodically for any changes. Changes to this Privacy Policy are effective when they are posted on this page.</p>

        <h2>7. Contact Us</h2>
        <p>If you have any questions or suggestions about our Privacy Policy, do not hesitate to contact us at <strong>solankipriyanshu94@gmail.com</strong>.</p>
    </div>
    <div class="footer">
        &copy; 2026 Tera Downloader. All rights reserved.
    </div>
</body>
</html>
  `);
});

app.listen(PORT, () => {
  console.log(`Local parse server running on port ${PORT}`);
});
