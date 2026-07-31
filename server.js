import express from 'express';
import cors from 'cors';
import { TeraBoxApp } from './api.js';

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
    const match = url.match(/\/s\/([A-Za-z0-9_-]+)/);
    if (!match) {
      return res.status(400).json({ error: "Invalid share link. Please paste a valid TeraBox link." });
    }
    const shortUrl = match[1];

    // NDUS token can be loaded from env or left empty
    const ndusToken = process.env.TERABOX_NDUS || "";
    const tbApp = new TeraBoxApp(ndusToken);

    console.log(`Resolving URL: ${url} (shorturl: ${shortUrl})...`);
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
  console.log(`TeraBox resolution API server is running on http://localhost:${PORT}`);
  console.log(`Press Ctrl+C to stop.`);
});
