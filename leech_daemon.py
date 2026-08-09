import os
import sys
import time
import asyncio
import logging
import requests
from pymongo import MongoClient
from bson.objectid import ObjectId

# Set up logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("LeechDaemon")

# Add current directory to path to import config
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
try:
    import config
    BOT_TOKEN = getattr(config, 'BOT_TOKEN', '')
    API_ID = getattr(config, 'TELEGRAM_API', 0)
    API_HASH = getattr(config, 'TELEGRAM_HASH', '')
except ImportError:
    logger.error("Could not import config.py. Please run this script in the root of mirror-leech-telegram-bot.")
    sys.exit(1)

# Pyrogram / Kurigram imports
try:
    from pyrogram import Client
except ImportError:
    try:
        from kurigram import Client
    except ImportError:
        logger.error("Neither pyrogram nor kurigram is installed. Please install it inside your venv.")
        sys.exit(1)

# MongoDB Connection
# We use the hardcoded MongoDB URI of the user as fallback or read from env
MONGODB_URI = os.getenv("MONGODB_URI", "mongodb+srv://anihubyt:Zxcvbnmm9193@cluster0.qv5tu12.mongodb.net/terabox_downloader?appName=Cluster0")

try:
    client = MongoClient(MONGODB_URI)
    db = client.get_default_database()
    # In case default database is not resolved properly:
    if db is None or db.name == 'test':
        db = client['terabox_downloader']
    tasks_collection = db['leechtasks']
    logger.info("Connected to MongoDB successfully.")
except Exception as e:
    logger.error(f"MongoDB connection failed: {e}")
    sys.exit(1)

# Initialize Pyrogram Bot Client
bot = Client("leech_daemon_session", api_id=API_ID, api_hash=API_HASH, bot_token=BOT_TOKEN)

# Video extension list
VIDEO_EXTS = ('.mp4', '.mkv', '.webm', '.avi', '.mov', '.flv', '.m4v', '.3gp')

async def download_file(url, local_path):
    logger.info(f"Downloading {url} to {local_path}...")
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Referer': 'https://www.terabox.com/'
    }
    
    # Download in chunks using requests (blocking call run in executor)
    def do_download():
        with requests.get(url, headers=headers, stream=True, timeout=60) as r:
            r.raise_for_status()
            with open(local_path, 'wb') as f:
                for chunk in r.iter_content(chunk_size=1024 * 1024): # 1MB chunks
                    if chunk:
                        f.write(chunk)
                        
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, do_download)
    logger.info(f"Downloaded successfully: {local_path}")

async def process_task(task):
    task_id = task['_id']
    chat_id = task['chatId']
    message_id = task.get('messageId')
    dlink = task['dlink']
    filename = task['filename']

    logger.info(f"Processing task {task_id} for chat {chat_id} - file: {filename}")
    
    # Update status to processing
    tasks_collection.update_one({'_id': task_id}, {'$set': {'status': 'processing'}})
    
    # Notify user that download started
    try:
        progress_msg = await bot.send_message(
            chat_id=chat_id, 
            text=f"📥 <b>VPS:</b> Downloading file...\n<code>{filename}</code>",
            reply_to_message_id=message_id
        )
    except Exception as e:
        logger.warning(f"Could not send progress message: {e}")
        progress_msg = None

    # Create downloads directory if not exists
    os.makedirs("downloads", exist_ok=True)
    local_path = os.path.join("downloads", filename)

    try:
        # 1. Download the file
        await download_file(dlink, local_path)
        
        # 2. Update progress message
        if progress_msg:
            try:
                await progress_msg.edit_text(f"📤 <b>VPS:</b> Uploading to Telegram...\n<code>{filename}</code>")
            except Exception:
                pass
                
        # 3. Upload to Telegram
        logger.info(f"Uploading {local_path} to Telegram...")
        
        # Progress callback for Pyrogram
        last_update = 0
        async def upload_progress(current, total):
            nonlocal last_update
            now = time.time()
            if now - last_update > 5: # update every 5 seconds
                last_update = now
                percentage = (current / total) * 100
                mb_current = current / (1024 * 1024)
                mb_total = total / (1024 * 1024)
                try:
                    if progress_msg:
                        await progress_msg.edit_text(
                            f"📤 <b>VPS:</b> Uploading to Telegram...\n"
                            f"<code>{filename}</code>\n"
                            f"<b>Progress:</b> {percentage:.1f}% ({mb_current:.1f}/{mb_total:.1f} MB)"
                        )
                except Exception:
                    pass

        # Send as video if it is a video file, otherwise send as document
        is_video = filename.lower().endswith(VIDEO_EXTS)
        if is_video:
            await bot.send_video(
                chat_id=chat_id,
                video=local_path,
                caption=f"📂 <b>File:</b> <code>{filename}</code>\n\nUploaded via VPS Leech Queue.",
                reply_to_message_id=message_id,
                progress=upload_progress
            )
        else:
            await bot.send_document(
                chat_id=chat_id,
                document=local_path,
                caption=f"📂 <b>File:</b> <code>{filename}</code>\n\nUploaded via VPS Leech Queue.",
                reply_to_message_id=message_id,
                progress=upload_progress
            )

        # Update status to completed
        tasks_collection.update_one({'_id': task_id}, {'$set': {'status': 'completed'}})
        logger.info(f"Task {task_id} completed successfully.")
        
        # Delete progress message and local file
        if progress_msg:
            try:
                await progress_msg.delete()
            except Exception:
                pass

    except Exception as err:
        logger.error(f"Failed to process task {task_id}: {err}")
        # Update status to failed
        tasks_collection.update_one({'_id': task_id}, {
            '$set': {
                'status': 'failed',
                'error': str(err)
            }
        })
        # Notify user about failure
        try:
            if progress_msg:
                await progress_msg.edit_text(f"❌ <b>VPS Error:</b> Failed to leech file <code>{filename}</code>.\nError: <code>{str(err)}</code>")
            else:
                await bot.send_message(
                    chat_id=chat_id,
                    text=f"❌ <b>VPS Error:</b> Failed to leech file <code>{filename}</code>.\nError: <code>{str(err)}</code>",
                    reply_to_message_id=message_id
                )
        except Exception as msg_err:
            logger.error(f"Failed to send error notification: {msg_err}")

    finally:
        # Ensure clean up of downloaded file
        if os.path.exists(local_path):
            try:
                os.remove(local_path)
                logger.info(f"Cleaned up local file: {local_path}")
            except Exception as e:
                logger.error(f"Failed to delete local file {local_path}: {e}")

async def main():
    logger.info("Starting Leech Daemon loop...")
    async with bot:
        while True:
            try:
                # Poll database for one pending task
                task = tasks_collection.find_one({'status': 'pending'})
                if task:
                    await process_task(task)
                else:
                    # No tasks, sleep for 10 seconds
                    await asyncio.sleep(10)
            except Exception as e:
                logger.error(f"Error in main loop: {e}")
                await asyncio.sleep(10)

if __name__ == "__main__":
    asyncio.run(main())
