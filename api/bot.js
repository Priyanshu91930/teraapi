import parseHandler from './parse.js';
import { connectToDatabase, LeechTask, User, SystemConfig } from '../db.js';

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

// Check if user is admin (from DB or env ADMIN_CHAT_ID)
async function isAdmin(userId) {
  // Check env ADMIN_CHAT_ID first (comma-separated list)
  if (process.env.ADMIN_CHAT_ID) {
    const adminIds = process.env.ADMIN_CHAT_ID.split(',').map(id => id.trim());
    if (adminIds.includes(String(userId))) return true;
  }
  // Check DB for admin role
  try {
    const db = await connectToDatabase();
    if (db) {
      const user = await User.findOne({ email: userId.toString() });
      if (user && user.role === 'admin') return true;
    }
  } catch (e) {}
  return false;
}

// Check if user is member of channel(s) (force sub)
async function checkForceSub(userId) {
  const channelIds = process.env.FORCE_SUB_CHANNEL_ID;
  if (!channelIds) return { ok: true }; // No force sub configured
  
  const channels = channelIds.split(',').map(id => id.trim()).filter(Boolean);
  if (channels.length === 0) return { ok: true };
  
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, error: 'Bot token missing' };
  
  for (const channelId of channels) {
    try {
      const url = `https://api.telegram.org/bot${token}/getChatMember`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: channelId, user_id: userId })
      });
      const data = await response.json();
      if (!data.ok) return { ok: false, error: data.description, channelId };
      const status = data.result.status;
      if (!['member', 'administrator', 'creator'].includes(status)) {
        return { ok: false, status, channelId };
      }
    } catch (err) {
      console.error('Force sub check error:', err);
      return { ok: false, error: err.message, channelId };
    }
  }
  return { ok: true };
}

// Check if user is member of group(s) (for link access)
async function checkGroupMembership(userId) {
  const groupIds = process.env.FORCE_SUB_GROUP_ID;
  if (!groupIds) return { ok: true }; // No group requirement
  
  const groups = groupIds.split(',').map(id => id.trim()).filter(Boolean);
  if (groups.length === 0) return { ok: true };
  
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, error: 'Bot token missing' };
  
  for (const groupId of groups) {
    try {
      const url = `https://api.telegram.org/bot${token}/getChatMember`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: groupId, user_id: userId })
      });
      const data = await response.json();
      if (!data.ok) return { ok: false, error: data.description, groupId };
      const status = data.result.status;
      if (!['member', 'administrator', 'creator'].includes(status)) {
        return { ok: false, status, groupId };
      }
    } catch (err) {
      console.error('Group membership check error:', err);
      return { ok: false, error: err.message, groupId };
    }
  }
  return { ok: true };
}

// Build force sub join keyboard (supports multiple)
// For numeric IDs (-100...), uses invite link from env FORCE_SUB_INVITE_LINKS
function buildForceSubKeyboard(channelIds, groupIds, inviteLinks = {}) {
  const keyboard = { inline_keyboard: [] };
  const channels = channelIds ? channelIds.split(',').map(id => id.trim()).filter(Boolean) : [];
  const groups = groupIds ? groupIds.split(',').map(id => id.trim()).filter(Boolean) : [];
  
  channels.forEach((ch, i) => {
    const inviteKey = ch.startsWith('-') ? `channel_${ch}` : `channel_${ch}`;
    const inviteUrl = inviteLinks[inviteKey] || (ch.startsWith('@') ? `https://t.me/${ch.replace('@', '')}` : `https://t.me/${ch}`);
    const display = ch.startsWith('@') ? ch : `Channel ${i+1}`;
    keyboard.inline_keyboard.push([{ text: `📢 Join ${display}`, url: inviteUrl }]);
  });
  groups.forEach((gr, i) => {
    const inviteKey = gr.startsWith('-') ? `group_${gr}` : `group_${gr}`;
    const inviteUrl = inviteLinks[inviteKey] || (gr.startsWith('@') ? `https://t.me/${gr.replace('@', '')}` : `https://t.me/${gr}`);
    const display = gr.startsWith('@') ? gr : `Group ${i+1}`;
    keyboard.inline_keyboard.push([{ text: `👥 Join ${display}`, url: inviteUrl }]);
  });
  keyboard.inline_keyboard.push([{ text: "✅ I've Joined", callback_data: "force_sub_check" }]);
  return keyboard;
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

    // 0. Handle Chat Join Request (for join request mode)
    if (update.chat_join_request) {
      const joinRequest = update.chat_join_request;
      const chatId = joinRequest.chat.id;
      const userId = joinRequest.from.id;
      
      // Only approve if this chat is in our force sub channels/groups
      const channelIds = process.env.FORCE_SUB_CHANNEL_ID || '';
      const groupIds = process.env.FORCE_SUB_GROUP_ID || '';
      const allowedChats = [...channelIds.split(','), ...groupIds.split(',')].map(id => id.trim()).filter(Boolean);
      
      if (allowedChats.includes(String(chatId))) {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (token) {
          try {
            await fetch(`https://api.telegram.org/bot${token}/approveChatJoinRequest`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, user_id: userId })
            });
            console.log(`[Bot] Approved join request for user ${userId} in chat ${chatId}`);
          } catch (e) {
            console.error('[Bot] Failed to approve join request:', e);
          }
        }
      }
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

          const activeTask = await LeechTask.findOne({
            chatId: chatId,
            status: { $in: ['pending', 'processing'] }
          });

          if (activeTask) {
            await answerCallbackQuery(callbackQuery.id, '⚠️ You already have a task in the queue. Please wait for it to complete!');
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

      // Force Sub Check Callback
      if (data === 'force_sub_check') {
        const userId = callbackQuery.from.id;
        
        // Check channel
        const channelCheck = await checkForceSub(userId);
        if (!channelCheck.ok) {
          await answerCallbackQuery(callbackQuery.id, '❌ You have not joined the channel yet!', true);
          return res.status(200).send('OK');
        }
        
        // Check group if configured
        const groupCheck = await checkGroupMembership(userId);
        if (!groupCheck.ok) {
          await answerCallbackQuery(callbackQuery.id, '❌ You have not joined the group yet!', true);
          return res.status(200).send('OK');
        }
        
        // Both passed - update message
        await answerCallbackQuery(callbackQuery.id, '✅ Access granted! You can now use the bot.', true);
        
        // Update message to show success
        try {
          const token = process.env.TELEGRAM_BOT_TOKEN;
          await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              message_id: messageId,
              text: '✅ <b>Verification Successful!</b>\n\nYou can now send links to get direct download links.',
              parse_mode: 'HTML'
            })
          });
        } catch (e) {}
        
        return res.status(200).send('OK');
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
      // Check force sub even for /start
      const userId = message.from.id;
      const forceSub = await checkForceSub(userId);
      if (!forceSub.ok) {
        const inviteLinks = {};
        try { Object.assign(inviteLinks, JSON.parse(process.env.FORCE_SUB_INVITE_LINKS || '{}')); } catch {}
        const keyboard = buildForceSubKeyboard(
          process.env.FORCE_SUB_CHANNEL_ID,
          process.env.FORCE_SUB_GROUP_ID,
          inviteLinks
        );
        await sendMessage(chatId, 
          `🔒 <b>Access Restricted</b>\n\n` +
          `You must join our channel/group to use this bot:\n\n` +
          `• Join Channel: <code>${forceSub.channelId || 'N/A'}</code>\n` +
          `• Join Group: <code>${process.env.FORCE_SUB_GROUP_ID || 'N/A'}</code>\n\n` +
          `After joining, click <b>✅ I've Joined</b> below.`,
          message.message_id,
          keyboard
        );
        return res.status(200).send('OK');
      }
      
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

    // Force sub check for all non-command messages
    const userId = message.from.id;
    const forceSub = await checkForceSub(userId);
    if (!forceSub.ok) {
      const inviteLinks = {};
      try { Object.assign(inviteLinks, JSON.parse(process.env.FORCE_SUB_INVITE_LINKS || '{}')); } catch {}
      const keyboard = buildForceSubKeyboard(
        process.env.FORCE_SUB_CHANNEL_ID,
        process.env.FORCE_SUB_GROUP_ID,
        inviteLinks
      );
      await sendMessage(chatId, 
        `🔒 <b>Access Restricted</b>\n\n` +
        `You must join our channel to use this bot.\n\n` +
        `Channel: <code>${forceSub.channelId || process.env.FORCE_SUB_CHANNEL_ID || 'N/A'}</code>\n\n` +
        `After joining, click <b>✅ I've Joined</b> below.`,
        message.message_id,
        keyboard
      );
      return res.status(200).send('OK');
    }

    // Detect if it's a URL
    const urlPattern = /(https?:\/\/[^\s]+)/gi;
    const match = text.match(urlPattern);

    if (!match) {
      await sendMessage(chatId, '❌ Please send a valid link.', message.message_id);
      return res.status(200).send('OK');
    }

    // Admin check: only admin can send links in private chat
    // Non-admin users must be in the group to get links
    const isPrivateChat = message.chat.type === 'private';
    const userIsAdmin = await isAdmin(userId);
    
    if (isPrivateChat && !userIsAdmin) {
      // Check group membership
      const groupCheck = await checkGroupMembership(userId);
      if (!groupCheck.ok) {
        const inviteLinks = {};
        try { Object.assign(inviteLinks, JSON.parse(process.env.FORCE_SUB_INVITE_LINKS || '{}')); } catch {}
        const keyboard = buildForceSubKeyboard(
          process.env.FORCE_SUB_CHANNEL_ID,
          process.env.FORCE_SUB_GROUP_ID,
          inviteLinks
        );
        await sendMessage(chatId, 
          `🔒 <b>Group Membership Required</b>\n\n` +
          `To use this bot in private chat, you must join our group:\n\n` +
          `Group: <code>${process.env.FORCE_SUB_GROUP_ID || 'N/A'}</code>\n\n` +
          `After joining, click <b>✅ I've Joined</b> below.`,
          message.message_id,
          keyboard
        );
        return res.status(200).send('OK');
      }
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
        apiKey: process.env.API_KEY
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
    const apiKey = process.env.API_KEY;

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
      
      const websiteDomain = 'teraboxdownloader.co.in';
      const downloadLink = `https://${websiteDomain}/?url=${encodeURIComponent(targetUrl)}`;

      const caption = `📂 Name: <code>${file.name}</code>\n` +
        `⚖️ Size: ${file.size}`;

      // Construct Inline Keyboard Markup
      const replyMarkup = {
        inline_keyboard: [
          [
            { text: "⚡ Download / Play Video", url: downloadLink }
          ]
        ]
      };

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
