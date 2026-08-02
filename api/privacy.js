export default function handler(req, res) {
  res.setHeader('Content-Type', 'text/html');
  return res.status(200).send(`
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
}
