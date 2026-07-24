export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS Headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Auto-initialize D1 schema if not exists
      await ensureTable(env.DB);

      // 1. Web UI Dashboard at /
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return new Response(getDashboardHTML(), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      // 2. API to get all submissions
      if (url.pathname === '/api/data' && request.method === 'GET') {
        const query = `
          SELECT 
            id, phone_number, gift_card_name, gift_card_code, 
            payment_method, payment_details, total_amount, 
            raw_message, timestamp,
            (ROW_NUMBER() OVER (PARTITION BY gift_card_code ORDER BY timestamp ASC) > 1) AS is_duplicate
          FROM submissions 
          ORDER BY timestamp DESC
        `;
        const { results } = await env.DB.prepare(query).all();
        return new Response(JSON.stringify({ success: true, data: results }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // 3. API to submit and parse card data
      if (url.pathname === '/api/submit' && request.method === 'POST') {
        const { text } = await request.json();
        if (!text) {
          return new Response(JSON.stringify({ success: false, error: 'No text provided' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        // Call LLM to extract fields
        const extraction = await extractDataUsingAI(env.AI, text);
        
        // Save to D1
        await env.DB.prepare(`
          INSERT INTO submissions (phone_number, gift_card_name, gift_card_code, payment_method, payment_details, total_amount, raw_message)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          extraction.phone_number || null,
          extraction.gift_card_name || null,
          extraction.gift_card_code || null,
          extraction.payment_method || null,
          extraction.payment_details || null,
          extraction.total_amount || null,
          text
        ).run();

        return new Response(JSON.stringify({ success: true, data: extraction }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // 4. API to query/chat using database data
      if (url.pathname === '/api/query' && request.method === 'POST') {
        const { query } = await request.json();
        if (!query) {
          return new Response(JSON.stringify({ success: false, error: 'No query provided' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        // Fetch some relevant context from the database
        const dbData = await env.DB.prepare(`
          SELECT phone_number, gift_card_name, gift_card_code, payment_method, payment_details, total_amount, timestamp
          FROM submissions
          ORDER BY timestamp DESC
          LIMIT 50
        `).all();

        const context = JSON.stringify(dbData.results, null, 2);

        // Generate response using LLM
        const systemPrompt = `You are a helpful database assistant for a Telegram Bot.
You have access to the following recent gift card submissions database in JSON format:
${context}

Use this database to answer the user's questions. 
If the user asks for details (such as gift card code, UPI ID/payment details, phone number, etc.) for a specific person or gift card name, look it up in the database.
If the information is not present or you cannot find it, state that clearly. Keep the response friendly, concise, and direct.`;

        const response = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: query }
          ]
        });

        return new Response(JSON.stringify({ success: true, response: response.response }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      return new Response('Not Found', { status: 404 });
    } catch (err) {
      return new Response(JSON.stringify({ success: false, error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
  }
};

// Helper function to extract info via Workers AI
async function extractDataUsingAI(ai, text) {
  const systemPrompt = `You are a data extraction assistant. Extract details from the user's message and return them in a strict JSON format. Do not write any conversational text or markdown code blocks (e.g. do not wrap in \`\`\`json). Just output the raw JSON object.
If a field is missing, set it to null.

JSON Keys to extract:
- "phone_number": Extract any phone number (e.g. 6200512399).
- "gift_card_name": Extract the gift card name (e.g. Plasma wings).
- "gift_card_code": Extract the alphanumeric code / voucher code.
- "payment_method": Extract the method (UPI, USDT, Gift Card, etc.).
- "payment_details": Extract the payment address/ID/mail (e.g. melodylofivibes@oksbi).
- "total_amount": Extract the amount / coins value or total price (e.g. 720 or 10000 coins).`;

  try {
    const response = await ai.run('@cf/meta/llama-3-8b-instruct', {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text }
      ]
    });
    
    // Parse JSON safely
    const cleanText = response.response.trim().replace(/^```json/, '').replace(/```$/, '').trim();
    return JSON.parse(cleanText);
  } catch (e) {
    // Fallback simple regex parsing if LLM or parsing fails
    console.error("AI extraction failed, using fallback parsing:", e);
    return fallbackParse(text);
  }
}

function fallbackParse(text) {
  const getMatch = (regex) => {
    const match = text.match(regex);
    return match ? match[1].trim() : null;
  };
  
  return {
    phone_number: getMatch(/(?:Phone Number|मोबाइल नंबर)\s*:\s*([^\n]+)/i),
    gift_card_name: getMatch(/(?:Gift Card Name|गिफ्ट कार्ड का नाम)\s*:\s*([^\n]+)/i),
    gift_card_code: getMatch(/(?:Gift Card Code|गिफ्ट कार्ड कोड)\s*:\s*([^\n]+)/i),
    payment_method: getMatch(/(?:Payment Method|पेमेंट का तरीका)\s*:\s*([^\n]+)/i),
    payment_details: getMatch(/(?:Payment Details|पेमेंट की जानकारी)\s*:\s*([^\n]+)/i),
    total_amount: getMatch(/(?:Total Amount|कुल राशि)\s*:\s*([^\n]+)/i)
  };
}

// Beautiful Dashboard HTML
function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GCXodeBot Submissions Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-color: #0b0f19;
      --card-bg: rgba(17, 24, 39, 0.7);
      --border-color: rgba(255, 255, 255, 0.08);
      --text-main: #f3f4f6;
      --text-muted: #9ca3af;
      --primary: #6366f1;
      --primary-hover: #4f46e5;
      --accent-danger: #ef4444;
      --accent-success: #10b981;
    }
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      font-family: 'Outfit', sans-serif;
      background-color: var(--bg-color);
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      background-image: 
        radial-gradient(at 0% 0%, rgba(99, 102, 241, 0.15) 0px, transparent 50%),
        radial-gradient(at 100% 100%, rgba(239, 68, 68, 0.05) 0px, transparent 50%);
    }

    header {
      padding: 1.5rem 2rem;
      border-bottom: 1px solid var(--border-color);
      display: flex;
      justify-content: space-between;
      align-items: center;
      backdrop-filter: blur(12px);
    }

    h1 {
      font-size: 1.5rem;
      font-weight: 700;
      letter-spacing: -0.025em;
      background: linear-gradient(to right, #818cf8, #e0e7ff);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .container {
      flex: 1;
      max-width: 1400px;
      width: 100%;
      margin: 0 auto;
      padding: 2rem;
    }

    .card {
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      backdrop-filter: blur(20px);
      box-shadow: 0 10px 30px -10px rgba(0, 0, 0, 0.5);
      overflow: hidden;
      margin-bottom: 2rem;
    }

    .table-container {
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
    }

    th {
      background: rgba(255, 255, 255, 0.02);
      padding: 1rem 1.5rem;
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      font-weight: 600;
      border-bottom: 1px solid var(--border-color);
    }

    td {
      padding: 1.25rem 1.5rem;
      font-size: 0.95rem;
      border-bottom: 1px solid var(--border-color);
    }

    tr:hover td {
      background: rgba(255, 255, 255, 0.01);
    }

    .badge {
      display: inline-flex;
      align-items: center;
      padding: 0.25rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
    }

    .badge-duplicate {
      background: rgba(239, 68, 68, 0.15);
      color: var(--accent-danger);
      border: 1px solid rgba(239, 68, 68, 0.2);
    }

    .badge-original {
      background: rgba(16, 185, 129, 0.15);
      color: var(--accent-success);
      border: 1px solid rgba(16, 185, 129, 0.2);
    }

    .code-text {
      font-family: monospace;
      background: rgba(255, 255, 255, 0.06);
      padding: 0.2rem 0.4rem;
      border-radius: 4px;
      font-size: 0.9rem;
    }

    .timestamp {
      color: var(--text-muted);
      font-size: 0.85rem;
    }

    .btn-refresh {
      background: var(--primary);
      color: white;
      border: none;
      padding: 0.6rem 1.2rem;
      border-radius: 8px;
      font-family: inherit;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .btn-refresh:hover {
      background: var(--primary-hover);
    }

    .empty-state {
      padding: 4rem 2rem;
      text-align: center;
      color: var(--text-muted);
    }
  </style>
</head>
<body>
  <header>
    <h1>GCXodeBot Submissions Dashboard</h1>
    <button class="btn-refresh" onclick="fetchData()">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
      Refresh
    </button>
  </header>

  <div class="container">
    <div class="card">
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Phone Number</th>
              <th>Gift Card Name</th>
              <th>Gift Card Code</th>
              <th>Payment Info</th>
              <th>Amount</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody id="data-body">
            <tr>
              <td colspan="7" class="empty-state">Loading submissions...</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    async function fetchData() {
      const tbody = document.getElementById('data-body');
      try {
        const res = await fetch('/api/data');
        const json = await res.json();
        
        if (!json.success || !json.data || json.data.length === 0) {
          tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No submissions found</td></tr>';
          return;
        }

        tbody.innerHTML = json.data.map(row => {
          const date = new Date(row.timestamp).toLocaleString();
          const badgeClass = row.is_duplicate ? 'badge-duplicate' : 'badge-original';
          const badgeText = row.is_duplicate ? 'Duplicate Submission' : 'Original';
          
          return \`
            <tr>
              <td class="timestamp">\${date}</td>
              <td>\${row.phone_number || '-'}</td>
              <td><strong>\${row.gift_card_name || '-'}</strong></td>
              <td><span class="code-text">\${row.gift_card_code || '-'}</span></td>
              <td>
                <div style="font-size:0.9rem">\${row.payment_method || '-'}</div>
                <div style="font-size:0.8rem; color:var(--text-muted)">\${row.payment_details || '-'}</div>
              </td>
              <td><strong>\${row.total_amount || '-'}</strong></td>
              <td><span class="badge \${badgeClass}">\${badgeText}</span></td>
            </tr>
          \`;
        }).join('');
      } catch (err) {
        tbody.innerHTML = \`<tr><td colspan="7" class="empty-state" style="color:var(--accent-danger)">Error loading data: \${err.message}</td></tr>\`;
      }
    }

    // Load on start
    fetchData();
  </script>
</body>
</html>`;
}

// Helper to auto-create submissions table if it doesn't exist
async function ensureTable(db) {
  await db.prepare(`
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
    )
  `).run();
  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_gift_card_code ON submissions(gift_card_code)
  `).run();
}

