import express from 'express';
import cors from 'cors';
import { TeraBoxApp } from './api.js';
import { youtube, igdl, ttdl, fbdown } from 'btch-downloader';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

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
      const yt = await youtube(cleanUrl);
      if (!yt.status) {
        throw new Error(yt.message || 'YouTube resolution failed');
      }
      return res.status(200).json({
        list: [
          {
            name: `${yt.title || 'YouTube_Video'} (Video - MP4)`,
            size: 'Unknown',
            thumbnail: yt.thumbnail || '',
            dlink: yt.mp4 || '',
          },
          {
            name: `${yt.title || 'YouTube_Video'} (Audio - MP3)`,
            size: 'Unknown',
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
      if (!shortUrl.startsWith('1')) {
        shortUrl = '1' + shortUrl;
      }
    }

    if (!shortUrl) {
      return res.status(400).json({ error: "Invalid share link. Please paste a valid TeraBox, YouTube, Instagram, Facebook, or TikTok link." });
    }

    const ndusToken = process.env.TERABOX_NDUS || process.env.NDUS || process.env.ndus || process.env.NUDUS || process.env.nudus || "";
    const tbApp = new TeraBoxApp(ndusToken);

    // Dynamically adjust domain settings to match the user's regional domain
    if (cleanUrl.includes('1024tera.com') || cleanUrl.includes('1024terabox.com') || cleanUrl.includes('terasharefile.com')) {
      tbApp.TERABOX_DOMAIN = '1024tera.com';
      tbApp.params.whost = 'https://www.1024tera.com';
      tbApp.params.uhost = 'https://c-all.1024tera.com';
    } else {
      tbApp.TERABOX_DOMAIN = 'terabox.com';
      tbApp.params.whost = 'https://www.terabox.com';
      tbApp.params.uhost = 'https://c-all.terabox.com';
    }

    // 1. Try resolving anonymously first to avoid regional cluster redirects (like dm.1024tera.com)
    console.log(`[Parse] Attempting anonymous resolution for shortUrl: ${shortUrl}`);
    const anonApp = new TeraBoxApp("");
    anonApp.params.ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    anonApp.TERABOX_DOMAIN = cleanUrl.includes('1024tera.com') || cleanUrl.includes('1024terabox.com') || cleanUrl.includes('terasharefile.com')
      ? '1024tera.com'
      : 'terabox.com';
    anonApp.params.whost = `https://www.${anonApp.TERABOX_DOMAIN}`;
    anonApp.params.uhost = `https://c-all.${anonApp.TERABOX_DOMAIN}`;

    let listData;
    try {
      listData = await anonApp.shortUrlList(shortUrl);
      console.log(`[Parse] Anonymous response:`, JSON.stringify(listData));
    } catch (e) {
      console.log(`[Parse] Anonymous resolution failed with error:`, e.message);
    }

    // 2. If anonymous fails or returns error, fallback to logged-in NDUS session
    if (!listData || listData.errno !== 0) {
      console.log(`[Parse] Falling back to logged-in NDUS session...`);
      const ndusToken = process.env.TERABOX_NDUS || process.env.NDUS || process.env.ndus || process.env.NUDUS || process.env.nudus || "";
      if (ndusToken) {
        const app = new TeraBoxApp(ndusToken);
        app.params.ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        app.TERABOX_DOMAIN = anonApp.TERABOX_DOMAIN;
        app.params.whost = anonApp.params.whost;
        app.params.uhost = anonApp.params.uhost;

        try {
          listData = await app.shortUrlList(shortUrl);
          console.log(`[Parse] NDUS session response:`, JSON.stringify(listData));
        } catch (e) {
          console.error(`[Parse] NDUS session failed with error:`, e.message);
        }
      }
    }

    if (!listData || listData.errno !== 0) {
      const errCode = listData ? listData.errno : 'Unknown';
      console.error(`TeraBox API returned error code: ${errCode}`);
      return res.status(400).json({ error: `TeraBox API returned error code ${errCode}` });
    }

    const formattedList = (listData.list || []).map((file) => ({
      name: file.server_filename || 'video.mp4',
      size: typeof file.size === 'number' ? formatBytes(file.size) : file.size || 'Unknown',
      thumbnail: file.thumbs?.url3 || file.thumbs?.url1 || '',
      dlink: file.dlink || '',
    }));

    console.log(`Successfully resolved ${formattedList.length} files.`);
    return res.status(200).json({
      list: formattedList,
    });
  } catch (error) {
    console.error("Link resolution failed:", error);
    return res.status(500).json({
      error: error.message || "Failed to resolve link. Please try again.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Local parse server running on port ${PORT}`);
});
