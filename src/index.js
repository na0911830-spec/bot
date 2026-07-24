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

        return new Response(JSON.stringify({ success: true, data: extraction }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // 4. API to query/chat using database data
      if (url.pathname === '/api/query' && request.method === 'POST') {
        const { query, history } = await request.json();
        if (!query) {
          return new Response(JSON.stringify({ success: false, error: 'No query provided' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        // Fetch some relevant context from the database
        const dbData = await env.DB.prepare([
          'SELECT id, phone_number, gift_card_name, gift_card_code, payment_method, payment_details, total_amount, status, timestamp',
          'FROM submissions',
          'ORDER BY timestamp DESC',
          'LIMIT 50'
        ].join(' ')).all();

        const context = JSON.stringify(dbData.results, null, 2);

        // Generate response using LLM
        const systemPrompt = `You are an internal organizational database assistant developed and designed by Kouzu, a developer agency that develops websites, apps, and AI agents for businesses, professionals, and individuals (https://kouzu.in/). You assist team members in looking up and managing gift card submission data.

You have access to the following recent gift card submissions database in JSON format:
${context}

Use this database to answer the user's questions. 
If the user asks for details (such as gift card code, UPI ID/payment details, phone number, status, etc.) for a specific person or gift card name, look it up in the database.
If the information is not present or you cannot find it, state that clearly. Keep the response professional, direct, concise, and tailored for internal company operations.

You also have the power to update the status of existing submissions (e.g., mark as paid, delete / put in bin, or restore). 
If the user requests an action like "mark as paid", "delete", "put in bin", "remove", "restore", or "unpaid" for any submission:
1. Identify the relevant submission's ID from the database context.
2. At the end of your response, append an action block. The action block must be a JSON block wrapped in a markdown code block starting with \`\`\`action.

Examples:
To mark as paid:
\`\`\`action
{"action": "update_status", "id": 12, "status": "paid"}
\`\`\`

To delete / put in bin:
\`\`\`action
{"action": "update_status", "id": 12, "status": "bin"}
\`\`\`

To restore / mark as unpaid:
\`\`\`action
{"action": "update_status", "id": 12, "status": "unpaid"}
\`\`\``;

        const messages = [
          { role: 'system', content: systemPrompt }
        ];

        // Append conversation history
        if (history && Array.isArray(history)) {
          messages.push(...history);
        }

        // Append current message
        messages.push({ role: 'user', content: query });

        const response = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fast', {
          messages
        });

        let replyText = response.response;
        const actionMatch = replyText.match(/```action\s*([\s\S]*?)\s*```/);
        let actionResult = null;
        if (actionMatch) {
          try {
            const actionData = JSON.parse(actionMatch[1].trim());
            if (actionData.action === 'update_status' && actionData.id && actionData.status) {
              await env.DB.prepare('UPDATE submissions SET status = ? WHERE id = ?')
                .bind(actionData.status, actionData.id)
                .run();
              
              // Remove action block from display reply
              replyText = replyText.replace(/```action[\s\S]*?```/, '').trim();
              if (actionData.status === 'paid') {
                replyText += "\n\n✅ *Status Update:* Submission has been marked as paid.";
              } else if (actionData.status === 'bin') {
                replyText += "\n\n🗑️ *Status Update:* Submission has been moved to the bin (deleted).";
              } else if (actionData.status === 'unpaid') {
                replyText += "\n\n🔄 *Status Update:* Submission has been restored to unpaid.";
              }
            }
          } catch (e) {
            console.error("Failed to parse or execute action:", e);
          }
        }

        return new Response(JSON.stringify({ success: true, response: replyText }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // 5. API to update status of a submission directly
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
  <title>Kouzu — Submissions Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-color: #080b11;
      --card-bg: #111622;
      --card-hover: #161c2b;
      --border-color: rgba(255, 255, 255, 0.05);
      --text-main: #f3f4f6;
      --text-muted: #8e9aae;
      --primary: #4f46e5;
      --primary-hover: #6366f1;
      --accent-danger: #ef4444;
      --accent-success: #10b981;
      --accent-warning: #f59e0b;
      --transition-speed: 0.2s;
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
        radial-gradient(at 0% 0%, rgba(79, 70, 229, 0.12) 0px, transparent 45%),
        radial-gradient(at 100% 100%, rgba(239, 68, 68, 0.03) 0px, transparent 45%);
      background-attachment: fixed;
    }

    header {
      padding: 1.75rem 2rem;
      border-bottom: 1px solid var(--border-color);
      display: flex;
      justify-content: space-between;
      align-items: center;
      backdrop-filter: blur(12px);
      background-color: rgba(8, 11, 17, 0.7);
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
      font-size: 1.35rem;
      font-weight: 600;
      letter-spacing: -0.02em;
      background: linear-gradient(to right, #a5b4fc, #e0e7ff);
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
      gap: 1.5rem;
    }

    /* Tabs Layout */
    .controls-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 1rem;
    }

    .tabs {
      display: flex;
      background: rgba(255, 255, 255, 0.03);
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
      color: var(--text-main);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
    }

    .btn-refresh {
      background: rgba(255, 255, 255, 0.04);
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
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.15);
    }

    .card {
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 10px 40px -15px rgba(0, 0, 0, 0.4);
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
      background: rgba(255, 255, 255, 0.01);
      padding: 1.1rem 1.5rem;
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted);
      font-weight: 600;
      border-bottom: 1px solid var(--border-color);
    }

    td {
      padding: 1.25rem 1.5rem;
      font-size: 0.92rem;
      border-bottom: 1px solid var(--border-color);
      vertical-align: middle;
    }

    tr:last-child td {
      border-bottom: none;
    }

    tr:hover td {
      background: rgba(255, 255, 255, 0.01);
    }

    .badge-paid {
      background: rgba(16, 185, 129, 0.1);
      color: var(--accent-success);
      border: 1px solid rgba(16, 185, 129, 0.2);
    }

    .badge-unpaid {
      background: rgba(245, 158, 11, 0.1);
      color: var(--accent-warning);
      border: 1px solid rgba(245, 158, 11, 0.2);
    }

    .badge-dup {
      background: rgba(239, 68, 68, 0.1);
      color: var(--accent-danger);
      border: 1px solid rgba(239, 68, 68, 0.2);
    }

    .badge {
      display: inline-flex;
      align-items: center;
      padding: 0.25rem 0.6rem;
      border-radius: 6px;
      font-size: 0.75rem;
      font-weight: 600;
      gap: 0.25rem;
    }

    .code-text {
      font-family: monospace;
      background: rgba(255, 255, 255, 0.05);
      padding: 0.2rem 0.45rem;
      border-radius: 4px;
      font-size: 0.85rem;
      color: #cbd5e1;
      border: 1px solid rgba(255, 255, 255, 0.03);
    }

    .timestamp {
      color: var(--text-muted);
      font-size: 0.85rem;
    }

    .action-btn {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border-color);
      color: var(--text-main);
      padding: 0.4rem 0.75rem;
      border-radius: 6px;
      cursor: pointer;
      font-family: inherit;
      font-size: 0.8rem;
      font-weight: 500;
      transition: all var(--transition-speed) ease;
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
    }

    .action-btn:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.15);
    }

    .action-btn.pay-btn:hover {
      background: rgba(16, 185, 129, 0.15);
      border-color: var(--accent-success);
      color: #34d399;
    }

    .action-btn.delete-btn:hover {
      background: rgba(239, 68, 68, 0.15);
      border-color: var(--accent-danger);
      color: #f87171;
    }

    .action-btn.restore-btn:hover {
      background: rgba(79, 70, 229, 0.15);
      border-color: var(--primary-hover);
      color: #a5b4fc;
    }

    .actions-cell {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }

    .empty-state {
      padding: 5rem 2rem;
      text-align: center;
      color: var(--text-muted);
    }

    /* Footer styling with Kouzu brand */
    footer {
      padding: 2.5rem 2rem;
      border-top: 1px solid var(--border-color);
      text-align: center;
      font-size: 0.85rem;
      color: var(--text-muted);
      margin-top: auto;
      background-color: rgba(8, 11, 17, 0.9);
    }

    footer a {
      color: var(--text-main);
      text-decoration: none;
      font-weight: 500;
      transition: color var(--transition-speed) ease;
    }

    footer a:hover {
      color: var(--primary-hover);
      text-decoration: underline;
    }

    /* Responsiveness */
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
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="url(#gradient)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <defs>
          <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#818cf8" />
            <stop offset="100%" stop-color="#3b82f6" />
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

    <div class="card">
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Phone Number</th>
              <th>Gift Card</th>
              <th>Gift Card Code</th>
              <th>Payment Details</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="data-body">
            <tr>
              <td colspan="8" class="empty-state">Loading submissions...</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <footer>
    <p>Developed and designed by <a href="https://kouzu.in/" target="_blank" rel="noopener noreferrer">Kouzu</a></p>
  </footer>

  <script>
    let currentTab = 'inbox';
    let submissionsData = [];

    async function fetchData() {
      const tbody = document.getElementById('data-body');
      try {
        const res = await fetch('/api/data');
        const json = await res.json();
        
        if (!json.success || !json.data) {
          tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No submissions found</td></tr>';
          return;
        }

        submissionsData = json.data;
        renderData();
      } catch (err) {
        tbody.innerHTML = \`<tr><td colspan="8" class="empty-state" style="color:var(--accent-danger)">Error loading data: \${err.message}</td></tr>\`;
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
      const tbody = document.getElementById('data-body');
      
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
        tbody.innerHTML = \`<tr><td colspan="8" class="empty-state">No submissions in \${currentTab}</td></tr>\`;
        return;
      }

      tbody.innerHTML = filtered.map(row => {
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
            Delete
          </button>\`;
        } else {
          // Bin tab
          actionButtons += \`<button class="action-btn restore-btn" onclick="updateStatus(\${row.id}, 'unpaid')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><polyline points="16 3 21 3 21 8"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><polyline points="8 21 3 21 3 16"/></svg>
            Restore
          </button>\`;
        }

        return \`
          <tr>
            <td class="timestamp">\${date}</td>
            <td>\${row.phone_number || '-'}</td>
            <td><strong>\${row.gift_card_name || '-'}</strong></td>
            <td><span class="code-text">\${row.gift_card_code || '-'}</span></td>
            <td>
              <div style="font-weight:500; font-size:0.9rem">\${row.payment_method || '-'}</div>
              <div style="font-size:0.8rem; color:var(--text-muted)">\${row.payment_details || '-'}</div>
            </td>
            <td><strong>\${row.total_amount || '-'}</strong></td>
            <td><div style="display:flex; gap:0.25rem; flex-wrap:wrap">\${statusBadges}</div></td>
            <td><div class="actions-cell">\${actionButtons}</div></td>
          </tr>
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

