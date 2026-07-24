import os
import logging
import asyncio
import urllib.request
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from telegram import Update
from telegram.ext import (
    ApplicationBuilder,
    ContextTypes,
    MessageHandler,
    CommandHandler,
    filters,
)

# Hardcoded configurations for Render deployment
TOKEN = "8689128856:AAEXXeVEFCd_KsrHvmkCvzL0-A8uYGFEdcA"
WORKER_URL = "https://bot.na0911830.workers.dev"
PING_URL = "https://laughing-octo-funicular-hz51.onrender.com"

# Configure Logging
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", level=logging.INFO
)
logger = logging.getLogger(__name__)

# --- Health Check HTTP Server (For Render Port Binding) ---
class HealthCheckHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"OK")

    def log_message(self, format, *args):
        # Suppress request logging to keep output clean
        return

def run_health_check_server():
    port = int(os.environ.get("PORT", 8080))
    server = HTTPServer(("0.0.0.0", port), HealthCheckHandler)
    logger.info(f"Health check HTTP server started on port {port}")
    server.serve_forever()

# --- Background Keep-Alive Ping ---
async def ping_loop():
    """Pings Render URL every 40 seconds to prevent sleeping."""
    logger.info(f"Starting keep-alive ping loop for {PING_URL}")
    while True:
        try:
            # Run blocking request in executor to avoid blocking event loop
            req = urllib.request.Request(
                PING_URL,
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"}
            )
            await asyncio.to_thread(urllib.request.urlopen, req, timeout=10)
            logger.info("Successfully pinged Render server.")
        except Exception as e:
            logger.error(f"Keep-alive ping failed: {e}")
        await asyncio.sleep(40)

# --- Telegram Bot Handlers ---
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    welcome_text = (
        "👋 Welcome to @gcxodebot!\n\n"
        "To submit gift cards, send them in the following format:\n\n"
        "📞 Phone Number:\n"
        "🎫 Gift Card Name:\n"
        "🔑 Gift Card Code:\n"
        "💳 Payment Method:\n"
        "📝 Payment Details:\n"
        "💰 Total Amount:\n\n"
        "Or, you can ask me anything about submitted data (e.g., 'What is the payment details for 6200512399?')"
    )
    await update.message.reply_text(welcome_text)

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text
    if not text:
        return

    # Heuristic to detect if it's a submission format
    is_submission = any(
        kw in text.lower()
        for kw in ["gift card code", "गिफ्ट कार्ड कोड", "payment method", "पेमेंट का तरीका", "phone number"]
    )

    if is_submission:
        await update.message.reply_chat_action("typing")
        try:
            # Send to Worker /api/submit
            import json
            req = urllib.request.Request(
                f"{WORKER_URL}/api/submit",
                data=json.dumps({"text": text}).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                },
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=15) as response:
                res_data = json.loads(response.read().decode("utf-8"))

            if res_data.get("success"):
                extracted = res_data["data"]
                success_msg = (
                    "✅ Submission Received & Parsed successfully!\n\n"
                    f"📞 Phone: {extracted.get('phone_number') or 'N/A'}\n"
                    f"🎫 Card Name: {extracted.get('gift_card_name') or 'N/A'}\n"
                    f"🔑 Code: {extracted.get('gift_card_code') or 'N/A'}\n"
                    f"💳 Payment: {extracted.get('payment_method') or 'N/A'}\n"
                    f"📝 Details: {extracted.get('payment_details') or 'N/A'}\n"
                    f"💰 Amount: {extracted.get('total_amount') or 'N/A'}"
                )
                await update.message.reply_text(success_msg)
            else:
                await update.message.reply_text(
                    f"❌ Failed to parse data. Error: {res_data.get('error', 'Unknown error')}"
                )
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8")
            logger.error(f"HTTP Error from Worker submit: {e} - Response Body: {err_body}")
            await update.message.reply_text(f"❌ Backend submission error: {e.reason}")
        except Exception as e:
            logger.error(f"Error communicating with Worker submit: {e}")
            await update.message.reply_text("❌ Backend error. Please try again later.")
    else:
        # Treat as general database query / question
        await update.message.reply_chat_action("typing")
        try:
            import json
            req = urllib.request.Request(
                f"{WORKER_URL}/api/query",
                data=json.dumps({"query": text}).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                },
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=15) as response:
                res_data = json.loads(response.read().decode("utf-8"))

            if res_data.get("success"):
                await update.message.reply_text(res_data["response"])
            else:
                await update.message.reply_text(
                    f"❌ Failed to query database: {res_data.get('error', 'Unknown error')}"
                )
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8")
            logger.error(f"HTTP Error from Worker query: {e} - Response Body: {err_body}")
            await update.message.reply_text(f"❌ Backend query error: {e.reason}")
        except Exception as e:
            logger.error(f"Error communicating with Worker query: {e}")
            await update.message.reply_text("❌ Backend query error. Please try again later.")

async def main():
    # Start Render Port health check HTTP server in a separate thread
    threading.Thread(target=run_health_check_server, daemon=True).start()

    # Build the telegram application
    app = ApplicationBuilder().token(TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    # Add keep-alive background ping loop to event loop
    loop = asyncio.get_running_loop()
    loop.create_task(ping_loop())

    logger.info("Bot started. Polling messages...")
    await app.initialize()
    await app.start()
    await app.updater.start_polling()

    # Keep running
    while True:
        await asyncio.sleep(3600)

if __name__ == "__main__":
    asyncio.run(main())
