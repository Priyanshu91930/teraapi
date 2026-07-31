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

  try {
    const lowerUrl = url.toLowerCase();

    // 1. YouTube Downloader
    if (lowerUrl.includes('youtube.com') || lowerUrl.includes('youtu.be')) {
      console.log(`Resolving YouTube URL: ${url}...`);
      const yt = await youtube(url);
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
      console.log(`Resolving Instagram URL: ${url}...`);
      const ig = await igdl(url);
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
      console.log(`Resolving TikTok URL: ${url}...`);
      const tt = await ttdl(url);
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
      console.log(`Resolving Facebook URL: ${url}...`);
      const fb = await fbdown(url);
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
    const match = url.match(/\/s\/([A-Za-z0-9_-]+)/);
    if (!match) {
      return res.status(400).json({ error: "Invalid share link. Please paste a valid TeraBox, YouTube, Instagram, Facebook, or TikTok link." });
    }
    const shortUrl = match[1];

    const ndusToken = process.env.TERABOX_NDUS || "";
    const tbApp = new TeraBoxApp(ndusToken);

    console.log(`Resolving TeraBox URL: ${url} (shorturl: ${shortUrl})...`);
    const listData = await tbApp.shortUrlList(shortUrl);

    if (listData.errno !== 0) {
      console.error(`TeraBox API returned error code: ${listData.errno}`);
      return res.status(400).json({ error: `TeraBox API returned error code ${listData.errno}` });
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
