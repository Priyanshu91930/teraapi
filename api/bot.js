import parseHandler from './parse.js';
import { connectToDatabase, LeechTask } from '../db.js';

// Send a simple message to Telegram
async function sendMessage(chatId, text, replyToMessageId = null, replyMarkup = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN is missing');
    return null;
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const body = {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_to_message_id: replyToMessageId
    };
    if (replyMarkup) {
      body.reply_markup = replyMarkup;
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return await response.json();
  } catch (err) {
    console.error('Error sending message:', err);
    return null;
  }
}

// Send photo to Telegram
async function sendPhoto(chatId, photoUrl, caption, replyToMessageId = null, replyMarkup = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  const url = `https://api.telegram.org/bot${token}/sendPhoto`;
  try {
    const body = {
      chat_id: chatId,
      photo: photoUrl,
      caption: caption,
      parse_mode: 'HTML',
      reply_to_message_id: replyToMessageId
    };
    if (replyMarkup) {
      body.reply_markup = replyMarkup;
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return response;
  } catch (err) {
    console.error('Error sending photo:', err);
    return null;
  }
}

// Answer Callback Query
async function answerCallbackQuery(callbackQueryId, text = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  const url = `https://api.telegram.org/bot${token}/answerCallbackQuery`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text: text
      })
    });
  } catch (err) {
    console.error('Error answering callback query:', err);
  }
}

// Edit Message Reply Markup
async function editMessageReplyMarkup(chatId, messageId, replyMarkup) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  const url = `https://api.telegram.org/bot${token}/editMessageReplyMarkup`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: replyMarkup
      })
    });
  } catch (err) {
    console.error('Error editing message reply markup:', err);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('Bot API is online! Send a POST update from Telegram.');
  }

  try {
    const update = req.body;
    if (!update) {
      return res.status(200).send('OK');
    }

    // 1. Handle Callback Query (e.g. user clicks "Get files into telegram")
    if (update.callback_query) {
      const callbackQuery = update.callback_query;
      const data = callbackQuery.data;
      const chatId = callbackQuery.message.chat.id;
      const messageId = callbackQuery.message.message_id;

      if (data && data.startsWith('leech_')) {
        const taskId = data.split('_')[1];
        try {
          const db = await connectToDatabase();
          if (!db) {
            await answerCallbackQuery(callbackQuery.id, '❌ Database connection failed. Cannot queue task.');
            return res.status(200).send('OK');
          }

          const task = await LeechTask.findById(taskId);
          if (task) {
            if (task.status === 'parsed') {
              task.status = 'pending';
              await task.save();

              await answerCallbackQuery(callbackQuery.id, '⏳ Queued! VPS will download and upload this file soon.');

              // Edit buttons to show queued status
              const originalKeyboard = callbackQuery.message.reply_markup.inline_keyboard;
              const directLinkUrl = originalKeyboard[0][0].url;

              const updatedMarkup = {
                inline_keyboard: [
                  [
                    { text: "⚡ Direct Download / Play", url: directLinkUrl },
                    { text: "⏳ Queued in VPS...", callback_data: "queued_dummy" }
                  ]
                ]
              };

              await editMessageReplyMarkup(chatId, messageId, updatedMarkup);
            } else {
              await answerCallbackQuery(callbackQuery.id, `Status is: ${task.status}`);
            }
          } else {
            await answerCallbackQuery(callbackQuery.id, '❌ Task not found in DB!');
          }
        } catch (dbErr) {
          console.error('Database callback query error:', dbErr);
          await answerCallbackQuery(callbackQuery.id, '❌ Database error occurred.');
        }
      }
      return res.status(200).send('OK');
    }

    // 2. Handle Message
    if (!update.message) {
      return res.status(200).send('OK');
    }

    const { message } = update;
    const chatId = message.chat.id;
    const text = message.text ? message.text.trim() : '';

    if (!text) {
      return res.status(200).send('OK');
    }

    // Handle commands
    if (text === '/start' || text === '/help') {
      const welcomeText = `👋 <b>Welcome to TeraBox & Media Downloader Bot!</b>\n\n` +
        `Send me any supported link, and I will generate a direct download link for you.\n\n` +
        `<b>Supported platforms:</b>\n` +
        `• TeraBox (terabox.com, 1024tera.com, etc.)\n` +
        `• YouTube\n` +
        `• Instagram\n` +
        `• Facebook\n` +
        `• TikTok\n\n` +
        `<i>Just paste/send the link directly here!</i>`;
      await sendMessage(chatId, welcomeText, message.message_id);
      return res.status(200).send('OK');
    }

    // Detect if it's a URL
    const urlPattern = /(https?:\/\/[^\s]+)/gi;
    const match = text.match(urlPattern);

    if (!match) {
      await sendMessage(chatId, '❌ Please send a valid link.', message.message_id);
      return res.status(200).send('OK');
    }

    const targetUrl = match[0];

    // Inform user that parsing is in progress
    const processingMsg = await sendMessage(chatId, '⏳ <i>Processing your link, please wait...</i>', message.message_id);
    const processingMsgId = processingMsg?.result?.message_id;

    // Call local parse handler using mocked request & response
    let responseData = null;
    let statusCode = 200;

    const mockReq = {
      method: 'GET',
      query: {
        url: targetUrl,
        apiKey: process.env.API_KEY || 'AnihubTeraSecureKey2026_xYz'
      },
      headers: {
        'x-forwarded-for': '127.0.0.1'
      },
      socket: {
        remoteAddress: '127.0.0.1'
      }
    };

    const mockRes = {
      setHeader: () => {},
      status: (code) => {
        statusCode = code;
        return {
          json: (data) => {
            responseData = data;
            return mockRes;
          },
          end: () => {
            return mockRes;
          }
        };
      }
    };

    try {
      await parseHandler(mockReq, mockRes);
    } catch (parseError) {
      console.error('Parse handler error:', parseError);
      statusCode = 500;
      responseData = { error: parseError.message || 'Internal parsing error' };
    }

    // Delete processing message
    if (processingMsgId) {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: processingMsgId })
      }).catch(() => {});
    }

    if (statusCode !== 200 || !responseData || responseData.error) {
      const errMsg = responseData?.error || 'Failed to parse the link. Please try again.';
      await sendMessage(chatId, `❌ <b>Error:</b> ${errMsg}`, message.message_id);
      return res.status(200).send('OK');
    }

    const files = responseData.list || [];
    if (files.length === 0) {
      await sendMessage(chatId, '❌ No downloadable files found for this link.', message.message_id);
      return res.status(200).send('OK');
    }

    const host = req.headers.host || 'teraapi-seven.vercel.app';
    const apiKey = process.env.API_KEY || 'AnihubTeraSecureKey2026_xYz';

    // Connect to database to save tasks
    let dbConnected = false;
    try {
      const db = await connectToDatabase();
      if (db) dbConnected = true;
    } catch (dbErr) {
      console.error('Database connection failed in bot message handler:', dbErr.message);
    }

    // Send each file details
    for (const file of files) {
      const isTeraBox = targetUrl.toLowerCase().includes('terabox') || 
                        targetUrl.toLowerCase().includes('1024tera') || 
                        targetUrl.toLowerCase().includes('terasharefile') ||
                        file.dlink.includes('terabox') ||
                        file.dlink.includes('1024terabox');
      
      const downloadLink = isTeraBox 
        ? `https://${host}/download?url=${encodeURIComponent(file.dlink)}&filename=${encodeURIComponent(file.name)}&apiKey=${apiKey}`
        : file.dlink;

      const caption = `<b>📂 Name:</b> <code>${file.name}</code>\n` +
        `<b>⚖️ Size:</b> ${file.size}\n\n` +
        `<b>🚀 Direct Download Link:</b>\n` +
        `<a href="${downloadLink}">Click here to Download / Play</a>`;

      // Construct Inline Keyboard Markup
      let replyMarkup = null;
      if (dbConnected) {
        try {
          // Save task to database in "parsed" status
          const task = await LeechTask.create({
            chatId: chatId,
            messageId: message.message_id,
            dlink: downloadLink, // Route through proxy so VPS downloads with correct headers
            filename: file.name,
            status: 'parsed'
          });

          if (task && task._id) {
            replyMarkup = {
              inline_keyboard: [
                [
                  { text: "⚡ Direct Download / Play", url: downloadLink },
                  { text: "📥 Get files into telegram", callback_data: `leech_${task._id}` }
                ]
              ]
            };
          }
        } catch (taskErr) {
          console.error('Failed to create LeechTask:', taskErr.message);
        }
      }

      // If database task creation failed or disabled, fallback to direct download button only
      if (!replyMarkup) {
        replyMarkup = {
          inline_keyboard: [
            [
              { text: "⚡ Direct Download / Play", url: downloadLink }
            ]
          ]
        };
      }

      let sentPhotoSuccess = false;
      if (file.thumbnail) {
        try {
          const photoRes = await sendPhoto(chatId, file.thumbnail, caption, message.message_id, replyMarkup);
          if (photoRes && photoRes.ok) {
            sentPhotoSuccess = true;
          }
        } catch (e) {
          console.error('Failed to send photo, fallback to text:', e.message);
        }
      }

      if (!sentPhotoSuccess) {
        await sendMessage(chatId, caption, message.message_id, replyMarkup);
      }
    }

    return res.status(200).send('OK');
  } catch (err) {
    console.error('General webhook error:', err);
    return res.status(200).send('OK');
  }
}
