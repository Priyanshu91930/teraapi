import { TeraBoxApp } from '../api.js';

function formatBytes(bytes, decimals = 2) {
  if (!bytes || isNaN(bytes)) return 'Unknown';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

export default async function handler(req, res) {
  // Handle CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "url query parameter is required" });
  }

  try {
    // Extract shortUrl code (e.g., matching the suffix after /s/ in the link)
    const match = url.match(/\/s\/([A-Za-z0-9_-]+)/);
    if (!match) {
      return res.status(400).json({ error: "Invalid share link. Please paste a valid TeraBox link." });
    }
    const shortUrl = match[1];

    // Instantiate TeraBoxApp using NDUS token from environment variables (if provided)
    const ndusToken = process.env.TERABOX_NDUS || "";
    const app = new TeraBoxApp(ndusToken);

    // Call the shortUrlList method to fetch files metadata and download links
    const listData = await app.shortUrlList(shortUrl);

    if (listData.errno !== 0) {
      return res.status(400).json({ error: `TeraBox API returned error code ${listData.errno}` });
    }

    // Format list for mobile app consumption
    const formattedList = (listData.list || []).map((file) => ({
      name: file.server_filename || 'video.mp4',
      size: typeof file.size === 'number' ? formatBytes(file.size) : file.size || 'Unknown',
      thumbnail: file.thumbs?.url3 || file.thumbs?.url1 || '',
      dlink: file.dlink || '',
    }));

    return res.status(200).json({
      list: formattedList,
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Failed to resolve link. Please verify the URL and try again.",
    });
  }
}
