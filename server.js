import express from 'express';
import cors from 'cors';
import { TeraBoxApp } from './api.js';
import ytdl from '@distube/ytdl-core';
import { youtube, igdl, ttdl, fbdown } from 'btch-downloader';
import { getDb, getKeysCollection, addApiKey, listApiKeys, toggleApiKey, deleteApiKey } from './db.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me';

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
    const lowerUrl = cleanUrl.toLowerCase();

    // 1. YouTube Downloader
    if (lowerUrl.includes('youtube.com') || lowerUrl.includes('youtu.be')) {
      console.log(`Resolving YouTube URL: ${cleanUrl}...`);

      // Prefer direct googlevideo.com links (faster, no third-party proxy throttling).
      // ytdl-core sometimes gets bot-blocked on datacenter IPs, so fall back to btch-downloader.
      let yt = null;
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
      } catch (e) {
        console.log(`ytdl-core failed (${e.message || e}), falling back to btch-downloader...`);
      }

      if (!yt || !yt.mp4) {
        const fb = await youtube(cleanUrl);
        if (!fb.status) {
          throw new Error(fb.message || 'YouTube resolution failed');
        }
        yt = { ...fb, mp4Size: 0, mp3Size: 0 };
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
      const ig = await igdl(cleanUrl);
      if (!ig.status) {
        throw new Error(ig.message || 'Instagram resolution failed');
      }
      const first = ig.result && ig.result[0];
      if (!first) {
        throw new Error('No media files found in this Instagram post');
      }
      return res.status(200).json({
        list: [{
          name: 'Instagram_Video.mp4',
          size: 'Unknown',
          thumbnail: first.thumbnail || '',
          dlink: first.url || '',
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
      const fb = await fbdown(cleanUrl);
      if (!fb.status) {
        throw new Error(fb.message || 'Facebook resolution failed');
      }
      const videoUrl = fb.HD || fb.Normal_video;
      if (!videoUrl) {
        throw new Error('No video found in this Facebook post');
      }
      return res.status(200).json({
        list: [{
          name: fb.title || 'Facebook_Video.mp4',
          size: 'Unknown',
          thumbnail: '',
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

    // 0. Primary: teraboxdl.site API (premium ndus → full download speed) with multi-key rotation
    try {
      const { resolveTeraboxdl } = await import('./rotation.js');
      await getDb();
      const tdl = await resolveTeraboxdl({ url: cleanUrl });
      if (tdl.ok && tdl.result && tdl.result.list && tdl.result.list.length > 0) {
        console.log(`[Parse] Resolved via teraboxdl API: ${tdl.result.list.length} file(s)`);
        return res.status(200).json(tdl.result);
      }
      console.log(`[Parse] teraboxdl API unavailable (${tdl.error}), falling back to own API...`);
    } catch (e) {
      console.log(`[Parse] teraboxdl API error (${e.message}), falling back to own API...`);
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

// ─── Admin endpoints for managing teraboxdl API keys ───
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized. Invalid admin token.' });
  }
  next();
}

app.get('/admin/keys', requireAdmin, async (req, res) => {
  try {
    await getDb();
    const keys = await listApiKeys();
    res.status(200).json({ keys });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/keys', requireAdmin, async (req, res) => {
  const { apiKey, apiSecret, label, note } = req.body || {};
  if (!apiKey || !apiSecret) {
    return res.status(400).json({ error: 'apiKey and apiSecret are required' });
  }
  try {
    await getDb();
    const id = await addApiKey({ apiKey, apiSecret, label, note });
    res.status(201).json({ id, message: 'API key added' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/admin/keys/:id', requireAdmin, async (req, res) => {
  const { enabled } = req.body || {};
  try {
    await getDb();
    await toggleApiKey(req.params.id, !!enabled);
    res.status(200).json({ message: 'Updated' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/admin/keys/:id', requireAdmin, async (req, res) => {
  try {
    await getDb();
    await deleteApiKey(req.params.id);
    res.status(200).json({ message: 'Deleted' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Local parse server running on port ${PORT}`);
});
