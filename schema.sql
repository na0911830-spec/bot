-- Schema for Telegram Bot Gift Card submissions
CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_number TEXT,
    gift_card_name TEXT,
    gift_card_code TEXT,
    payment_method TEXT,
    payment_details TEXT,
    total_amount TEXT,
    raw_message TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_gift_card_code ON submissions(gift_card_code);
