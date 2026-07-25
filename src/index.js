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
            raw_message, timestamp, status,
            (ROW_NUMBER() OVER (PARTITION BY gift_card_code ORDER BY timestamp ASC) > 1) AS is_duplicate
          FROM submissions 
          ORDER BY timestamp DESC
        `;
        const { results } = await env.DB.prepare(query).all();
        return new Response(JSON.stringify({ success: true, data: results }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // 3. API to submit and parse card data (with Duplication Prevention)
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
        
        if (extraction.gift_card_code) {
          // Check if gift_card_code already exists to prevent duplication
          const existing = await env.DB.prepare('SELECT id FROM submissions WHERE gift_card_code = ?')
            .bind(extraction.gift_card_code)
            .first();
          if (existing) {
            return new Response(JSON.stringify({ 
              success: true, 
              data: extraction,
              is_duplicate: true,
              message: "This card code already exists in the database. Submission ignored."
            }), {
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
          }
        }

        // Save to D1
        await env.DB.prepare(`
          INSERT INTO submissions (phone_number, gift_card_name, gift_card_code, payment_method, payment_details, total_amount, raw_message, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'unpaid')
        `).bind(
          extraction.phone_number || null,
          extraction.gift_card_name || null,
          extraction.gift_card_code || null,
          extraction.payment_method || null,
          extraction.payment_details || null,
          extraction.total_amount || null,
          text
        ).run();

        return new Response(JSON.stringify({ success: true, data: extraction, is_duplicate: false }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // 4. API to run arbitrary secure SQL queries (used by Render backend)
      if (url.pathname === '/api/sql' && request.method === 'POST') {
        const { sql, params } = await request.json();
        if (!sql) {
          return new Response(JSON.stringify({ success: false, error: 'No SQL provided' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        try {
          let query = env.DB.prepare(sql);
          if (params && Array.isArray(params)) {
            query = query.bind(...params);
          }
          const { results } = await query.all();
          return new Response(JSON.stringify({ success: true, results }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        } catch (e) {
          return new Response(JSON.stringify({ success: false, error: e.message }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
      }

      // 5. API to run Workers AI model (used by Render backend to host AI model queries)
      if (url.pathname === '/api/ai' && request.method === 'POST') {
        const { messages, model } = await request.json();
        if (!messages) {
          return new Response(JSON.stringify({ success: false, error: 'No messages provided' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        const selectedModel = model || '@cf/meta/llama-3.1-8b-instruct-fast';
        try {
          const aiResponse = await env.AI.run(selectedModel, { messages });
          return new Response(JSON.stringify({ success: true, response: aiResponse.response }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        } catch (e) {
          return new Response(JSON.stringify({ success: false, error: e.message }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
      }

      // 6. API to update status of a submission directly
      if (url.pathname === '/api/update-status' && request.method === 'POST') {
        const { id, status } = await request.json();
        if (!id || !status) {
          return new Response(JSON.stringify({ success: false, error: 'Missing id or status' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
        await env.DB.prepare('UPDATE submissions SET status = ? WHERE id = ?').bind(status, id).run();
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // 7. API to delete a submission permanently (Hard Delete)
      if (url.pathname === '/api/delete' && request.method === 'POST') {
        const { id } = await request.json();
        if (!id) {
          return new Response(JSON.stringify({ success: false, error: 'Missing id' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
        await env.DB.prepare('DELETE FROM submissions WHERE id = ?').bind(id).run();
        return new Response(JSON.stringify({ success: true }), {
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

We need to extract the gift card submission details, regardless of how messy or raw the text is.
- "gift_card_code": Extract the main voucher/alphanumeric code or ID (e.g. "RA-R8L4EGUL6PSK6UHR", "PU3HE-TYK6L-J6YTS", etc.). Look carefully for any code starting with RA-, PU-, or other alphanumeric strings.
  * CRITICAL: If the message is a question, database command, or update instruction (e.g., "Update submission 4...", "how many in bin", "delete code ..."), do NOT extract any fields. Return null for all keys so that the query/chat handler processes the message instead.
- "gift_card_name": Extract the name of the gift card (e.g. "League of Legends Gift Card—575 RP", "Plasma wings", etc.).
- "phone_number": Extract any phone number (e.g. 9923397516, +919999999999, etc.).
- "payment_method": Extract the method (UPI, USDT, Paytm, GPAY, Gift Card, etc.).
- "payment_details": Extract the payment address/ID/mail/number (e.g. 9923397516@ybl or melodylofivibes@oksbi).
- "total_amount": Extract the amount / coins value or total price (e.g. 370/-, 720, $10, 10000 coins).`;

  try {
    const response = await ai.run('@cf/meta/llama-3.1-8b-instruct-fast', {
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
  
  // Find potential gift card code (e.g. RA-..., PU-..., or alphanumeric-alphanumeric formats)
  let code = getMatch(/(?:Gift Card Code|गिफ्ट कार्ड कोड)\s*:\s*([^\n]+)/i);
  if (!code) {
    const raMatch = text.match(/\b(RA-[A-Z0-9]+)\b/i) || text.match(/\b(PU-[A-Z0-9]+)\b/i);
    if (raMatch) {
      code = raMatch[1];
    }
  }

  // Find payment details (e.g. UPI VPA format or wallet)
  let payDetails = getMatch(/(?:Payment Details|पेमेंट की जानकारी)\s*:\s*([^\n]+)/i);
  if (!payDetails) {
    const upiMatch = text.match(/\b([a-zA-Z0-9.\-_]+@[a-zA-Z0-9]+)\b/);
    if (upiMatch) {
      payDetails = upiMatch[1];
    }
  }
  
  return {
    phone_number: getMatch(/(?:Phone Number|मोबाइल नंबर)\s*:\s*([^\n]+)/i) || getMatch(/\b(\d{10})\b/),
    gift_card_name: getMatch(/(?:Gift Card Name|गिफ्ट कार्ड का नाम)\s*:\s*([^\n]+)/i) || getMatch(/\d+\)\s*([A-Za-z0-9\s—\-]+Gift Card[^\n]*)/i),
    gift_card_code: code,
    payment_method: getMatch(/(?:Payment Method|पेमेंट का तरीका)\s*:\s*([^\n]+)/i) || "UPI",
    payment_details: payDetails,
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
  <title>Kouzu — Submissions Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-color: #0c0b08;
      --card-bg: #141310;
      --card-hover: #1c1a15;
      --border-color: rgba(212, 175, 55, 0.12);
      --text-main: #f5f4f0;
      --text-muted: #a39e93;
      --gold: #d4af37;
      --gold-light: #f3e5ab;
      --gold-glow: rgba(212, 175, 55, 0.08);
      --accent-danger: #ff5252;
      --accent-success: #00e676;
      --transition-speed: 0.25s;
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
        radial-gradient(at 50% 0%, rgba(212, 175, 55, 0.07) 0px, transparent 60%),
        radial-gradient(at 100% 100%, rgba(212, 175, 55, 0.02) 0px, transparent 40%);
      background-attachment: fixed;
    }

    header {
      padding: 1.5rem 2rem;
      border-bottom: 1px solid var(--border-color);
      display: flex;
      justify-content: space-between;
      align-items: center;
      backdrop-filter: blur(12px);
      background-color: rgba(12, 11, 8, 0.7);
      position: sticky;
      top: 0;
      z-index: 10;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    h1 {
      font-size: 1.3rem;
      font-weight: 600;
      letter-spacing: -0.02em;
      background: linear-gradient(to right, var(--gold-light), var(--gold));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .container {
      flex: 1;
      max-width: 1300px;
      width: 100%;
      margin: 0 auto;
      padding: 2.5rem 2rem;
      display: flex;
      flex-direction: column;
      gap: 2rem;
    }

    .controls-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 1rem;
    }

    .tabs {
      display: flex;
      background: rgba(212, 175, 55, 0.03);
      padding: 0.25rem;
      border-radius: 10px;
      border: 1px solid var(--border-color);
    }

    .tab-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      padding: 0.5rem 1.25rem;
      font-family: inherit;
      font-size: 0.9rem;
      font-weight: 500;
      border-radius: 8px;
      cursor: pointer;
      transition: all var(--transition-speed) ease;
    }

    .tab-btn:hover {
      color: var(--text-main);
    }

    .tab-btn.active {
      background: var(--card-bg);
      color: var(--gold);
      border: 1px solid rgba(212, 175, 55, 0.2);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }

    .btn-refresh {
      background: rgba(212, 175, 55, 0.04);
      color: var(--text-main);
      border: 1px solid var(--border-color);
      padding: 0.6rem 1.2rem;
      border-radius: 8px;
      font-family: inherit;
      font-weight: 500;
      font-size: 0.9rem;
      cursor: pointer;
      transition: all var(--transition-speed) ease;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .btn-refresh:hover {
      background: rgba(212, 175, 55, 0.08);
      border-color: rgba(212, 175, 55, 0.3);
      color: var(--gold-light);
    }

    /* Responsive Grid for Card Boxes */
    .submissions-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
      gap: 1.5rem;
    }

    .submission-card {
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 14px;
      padding: 1.5rem;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
      transition: all var(--transition-speed) cubic-bezier(0.4, 0, 0.2, 1);
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
      position: relative;
      overflow: hidden;
    }

    .submission-card::after {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: 14px;
      padding: 1px;
      background: linear-gradient(to bottom right, rgba(212, 175, 55, 0.25), transparent, rgba(212, 175, 55, 0.05));
      -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      -webkit-mask-composite: xor;
      mask-composite: exclude;
      pointer-events: none;
    }

    .submission-card:hover {
      transform: translateY(-4px);
      background: var(--card-hover);
      border-color: rgba(212, 175, 55, 0.3);
      box-shadow: 0 10px 30px var(--gold-glow), 0 4px 20px rgba(0, 0, 0, 0.5);
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(255, 255, 255, 0.03);
      padding-bottom: 0.75rem;
    }

    .card-time {
      font-size: 0.8rem;
      color: var(--text-muted);
    }

    .card-status-badges {
      display: flex;
      gap: 0.35rem;
    }

    .gift-card-info {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
    }

    .label {
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted);
      font-weight: 500;
    }

    .card-title {
      font-size: 1.15rem;
      font-weight: 600;
      color: var(--text-main);
    }

    .code-container {
      margin-top: 0.25rem;
    }

    .code-container code {
      font-family: monospace;
      background: rgba(212, 175, 55, 0.06);
      border: 1px solid rgba(212, 175, 55, 0.15);
      color: var(--gold-light);
      padding: 0.3rem 0.6rem;
      border-radius: 6px;
      font-size: 0.85rem;
      display: inline-block;
      letter-spacing: 0.05em;
    }

    .card-details-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
      background: rgba(255, 255, 255, 0.01);
      padding: 0.85rem;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.02);
    }

    .detail-item {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .detail-item.full-width {
      grid-column: span 2;
    }

    .value {
      font-size: 0.88rem;
      color: var(--text-main);
    }

    .payment-details {
      color: var(--text-muted);
      font-size: 0.8rem;
    }

    .gold-text {
      color: var(--gold);
    }

    .font-bold {
      font-weight: 600;
    }

    .font-medium {
      font-weight: 500;
    }

    .badge-paid {
      background: rgba(0, 230, 118, 0.1);
      color: var(--accent-success);
      border: 1px solid rgba(0, 230, 118, 0.2);
    }

    .badge-unpaid {
      background: rgba(212, 175, 55, 0.1);
      color: var(--gold);
      border: 1px solid rgba(212, 175, 55, 0.2);
    }

    .badge-dup {
      background: rgba(255, 82, 82, 0.1);
      color: var(--accent-danger);
      border: 1px solid rgba(255, 82, 82, 0.2);
    }

    .badge {
      display: inline-flex;
      align-items: center;
      padding: 0.25rem 0.6rem;
      border-radius: 6px;
      font-size: 0.72rem;
      font-weight: 600;
      gap: 0.25rem;
    }

    .card-actions {
      display: flex;
      gap: 0.5rem;
      margin-top: auto;
      border-top: 1px solid rgba(255, 255, 255, 0.03);
      padding-top: 0.85rem;
    }

    .action-btn {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border-color);
      color: var(--text-main);
      padding: 0.5rem 0.85rem;
      border-radius: 8px;
      cursor: pointer;
      font-family: inherit;
      font-size: 0.8rem;
      font-weight: 500;
      transition: all var(--transition-speed) ease;
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      flex: 1;
      justify-content: center;
    }

    .action-btn:hover {
      background: rgba(212, 175, 55, 0.08);
      border-color: rgba(212, 175, 55, 0.3);
    }

    .action-btn.pay-btn:hover {
      background: rgba(0, 230, 118, 0.12);
      border-color: var(--accent-success);
      color: var(--accent-success);
    }

    .action-btn.delete-btn:hover {
      background: rgba(255, 82, 82, 0.12);
      border-color: var(--accent-danger);
      color: var(--accent-danger);
    }

    .action-btn.restore-btn:hover {
      background: rgba(212, 175, 55, 0.12);
      border-color: var(--gold);
      color: var(--gold);
    }

    .empty-state {
      grid-column: 1 / -1;
      padding: 5rem 2rem;
      text-align: center;
      color: var(--text-muted);
      border: 1px dashed var(--border-color);
      border-radius: 12px;
      background: rgba(212, 175, 55, 0.01);
    }

    footer {
      padding: 2.5rem 2rem;
      border-top: 1px solid var(--border-color);
      text-align: center;
      font-size: 0.85rem;
      color: var(--text-muted);
      margin-top: auto;
      background-color: rgba(12, 11, 8, 0.9);
    }

    footer a {
      color: var(--gold);
      text-decoration: none;
      font-weight: 500;
      transition: color var(--transition-speed) ease;
    }

    footer a:hover {
      color: var(--gold-light);
      text-decoration: underline;
    }

    @media (max-width: 768px) {
      header {
        padding: 1.25rem 1.5rem;
        flex-direction: column;
        gap: 1rem;
        align-items: flex-start;
      }
      .btn-refresh {
        width: 100%;
        justify-content: center;
      }
      .controls-row {
        flex-direction: column;
        align-items: stretch;
      }
      .tabs {
        width: 100%;
      }
      .tab-btn {
        flex: 1;
        text-align: center;
      }
      .container {
        padding: 1.5rem 1rem;
      }
      .submissions-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="url(#goldGradient)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <defs>
          <linearGradient id="goldGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#f3e5ab" />
            <stop offset="100%" stop-color="#d4af37" />
          </linearGradient>
        </defs>
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
      </svg>
      <h1>GCXodeBot Dashboard</h1>
    </div>
    <button class="btn-refresh" onclick="fetchData()">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
      Refresh
    </button>
  </header>

  <div class="container">
    <div class="controls-row">
      <div class="tabs">
        <button id="inbox-tab" class="tab-btn active" onclick="switchTab('inbox')">Submissions</button>
        <button id="bin-tab" class="tab-btn" onclick="switchTab('bin')">Bin</button>
      </div>
    </div>

    <div id="submissions-grid" class="submissions-grid">
      <div class="empty-state">Loading submissions...</div>
    </div>
  </div>

  <footer>
    <p>Developed and designed by <a href="https://kouzu.in/" target="_blank" rel="noopener noreferrer">Kouzu</a></p>
  </footer>

  <script>
    let currentTab = 'inbox';
    let submissionsData = [];

    async function fetchData() {
      const grid = document.getElementById('submissions-grid');
      try {
        const res = await fetch('/api/data');
        const json = await res.json();
        
        if (!json.success || !json.data) {
          grid.innerHTML = '<div class="empty-state">No submissions found</div>';
          return;
        }

        submissionsData = json.data;
        renderData();
      } catch (err) {
        grid.innerHTML = \`<div class="empty-state" style="color:var(--accent-danger)">Error loading data: \${err.message}</div>\`;
      }
    }

    async function deletePermanently(id) {
      if (!confirm('Are you sure you want to permanently delete this submission from the database? This action cannot be undone.')) {
        return;
      }
      try {
        const res = await fetch('/api/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id })
        });
        const json = await res.json();
        if (json.success) {
          fetchData();
        } else {
          alert('Failed to delete permanently: ' + json.error);
        }
      } catch (err) {
        alert('Error deleting permanently: ' + err.message);
      }
    }

    async function updateStatus(id, status) {
      try {
        const res = await fetch('/api/update-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, status })
        });
        const json = await res.json();
        if (json.success) {
          fetchData();
        } else {
          alert('Failed to update status: ' + json.error);
        }
      } catch (err) {
        alert('Error updating status: ' + err.message);
      }
    }

    function switchTab(tab) {
      currentTab = tab;
      document.getElementById('inbox-tab').classList.toggle('active', tab === 'inbox');
      document.getElementById('bin-tab').classList.toggle('active', tab === 'bin');
      renderData();
    }

    function renderData() {
      const grid = document.getElementById('submissions-grid');
      
      // Filter based on tab
      const filtered = submissionsData.filter(row => {
        const rowStatus = row.status || 'unpaid';
        if (currentTab === 'inbox') {
          return rowStatus !== 'bin';
        } else {
          return rowStatus === 'bin';
        }
      });

      if (filtered.length === 0) {
        grid.innerHTML = \`<div class="empty-state">No submissions in \${currentTab}</div>\`;
        return;
      }

      grid.innerHTML = filtered.map(row => {
        const date = new Date(row.timestamp).toLocaleString();
        const rowStatus = row.status || 'unpaid';
        
        // Construct status badges
        let statusBadges = '';
        if (rowStatus === 'paid') {
          statusBadges += '<span class="badge badge-paid">Paid</span> ';
        } else if (rowStatus === 'unpaid') {
          statusBadges += '<span class="badge badge-unpaid">Unpaid</span> ';
        }
        
        if (row.is_duplicate) {
          statusBadges += '<span class="badge badge-dup">Duplicate</span>';
        }

        // Action Buttons
        let actionButtons = '';
        if (currentTab === 'inbox') {
          if (rowStatus === 'unpaid') {
            actionButtons += \`<button class="action-btn pay-btn" onclick="updateStatus(\${row.id}, 'paid')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              Mark Paid
            </button>\`;
          }
          actionButtons += \`<button class="action-btn delete-btn" onclick="updateStatus(\${row.id}, 'bin')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            Move Bin
          </button>\`;
          actionButtons += \`<button class="action-btn delete-btn" style="border-color: rgba(255, 82, 82, 0.25); color: var(--accent-danger);" onclick="deletePermanently(\${row.id})">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            Delete Permanently
          </button>\`;
        } else {
          // Bin tab
          actionButtons += \`<button class="action-btn restore-btn" onclick="updateStatus(\${row.id}, 'unpaid')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><polyline points="16 3 21 3 21 8"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><polyline points="8 21 3 21 3 16"/></svg>
            Restore
          </button>\`;
          actionButtons += \`<button class="action-btn delete-btn" style="border-color: rgba(255, 82, 82, 0.25); color: var(--accent-danger);" onclick="deletePermanently(\${row.id})">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            Delete Permanently
          </button>\`;
        }

        return \`
          <div class="submission-card \${row.is_duplicate ? 'duplicate-card' : ''}">
            <div class="card-header">
              <div class="card-time">\${date}</div>
              <div class="card-status-badges">\${statusBadges}</div>
            </div>
            
            <div class="gift-card-info">
              <span class="label">Gift Card</span>
              <h3 class="card-title">\${row.gift_card_name || 'N/A'}</h3>
              <div class="code-container">
                <code>\${row.gift_card_code || 'N/A'}</code>
              </div>
            </div>
            
            <div class="card-details-grid">
              <div class="detail-item">
                <span class="label">Phone</span>
                <span class="value">\${row.phone_number || 'N/A'}</span>
              </div>
              <div class="detail-item">
                <span class="label">Amount</span>
                <span class="value gold-text font-bold">\${row.total_amount || 'N/A'}</span>
              </div>
              <div class="detail-item full-width">
                <span class="label">Payment</span>
                <span class="value font-medium">\${row.payment_method || 'N/A'} <span class="payment-details">(\${row.payment_details || 'N/A'})</span></span>
              </div>
            </div>
            
            <div class="card-actions">
              \${actionButtons}
            </div>
          </div>
        \`;
      }).join('');
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

  try {
    await db.prepare(`ALTER TABLE submissions ADD COLUMN status TEXT DEFAULT 'unpaid'`).run();
  } catch (e) {
    // Column might already exist, ignore
  }

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_gift_card_code ON submissions(gift_card_code)
  `).run();
}

