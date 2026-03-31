/**
 * ARIA Agent Backend — Zero-dependency Node.js server
 * Uses only built-in Node.js modules. Run with: node server.js
 *
 * What this does:
 *  - Stores all user data in JSON files (persists across restarts)
 *  - Checks Gmail for new financial emails every 5 minutes
 *  - Runs intelligence agents after every email check
 *  - Exposes a REST API the frontend polls every 30 seconds
 *  - New alerts appear as OS notifications in the browser automatically
 */

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

const PORT     = process.env.PORT || 3001;
const DATA_DIR = path.join(__dirname, 'data');

// ── Ensure data directory exists ─────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── macOS Push Notifications ──────────────────────────────────────────────────
function notify(title, body) {
  // Only on macOS — silently skips on other platforms
  if (process.platform !== 'darwin') return;
  const esc = s => s.replace(/\\/g,'\\\\').replace(/"/g,'\\"');
  exec(`osascript -e 'display notification "${esc(body)}" with title "ARIA 🔔" subtitle "${esc(title)}"'`, () => {});
}

function notifyNewAlerts(added) {
  // Load already-notified IDs so we never fire the same alert twice
  const notified = Store.read('notified_ids', { ids: [] });
  const notifiedSet = new Set(notified.ids);
  const toNotify = added.filter(a => !notifiedSet.has(a.id) && a.priority >= 75);
  toNotify.forEach(a => {
    notify(a.title, a.body);
    notifiedSet.add(a.id);
    console.log(`[Notify] 🔔 ${a.title}`);
  });
  if (toNotify.length) {
    Store.write('notified_ids', { ids: [...notifiedSet].slice(-200) });
  }
}

// ── Persistent JSON store ─────────────────────────────────────────────────────
const Store = {
  _path(name){ return path.join(DATA_DIR, name + '.json'); },
  read(name, def={}){
    try { return JSON.parse(fs.readFileSync(this._path(name), 'utf8')); }
    catch(e){ return def; }
  },
  write(name, data){
    fs.writeFileSync(this._path(name), JSON.stringify(data, null, 2));
  }
};

// ── Gmail API helper (uses built-in https) ────────────────────────────────────
const Gmail = {
  async get(token, path, params=''){
    const url = `https://gmail.googleapis.com/gmail/v1/users/me${path}?${params}`;
    return new Promise((resolve, reject) => {
      const req = https.get(url, { headers: { Authorization: 'Bearer ' + token }}, res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
          catch(e){ reject(e); }
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Gmail timeout')); });
    });
  },

  async listIds(token, q, max=80){
    let ids = [], pageToken = '';
    while(ids.length < max){
      const ps = `q=${encodeURIComponent(q)}&maxResults=50${pageToken ? '&pageToken='+pageToken : ''}`;
      const r = await this.get(token, '/messages', ps);
      if(r.status !== 200) break;
      if(r.data.messages) ids.push(...r.data.messages.map(m => m.id));
      if(!r.data.nextPageToken || ids.length >= max) break;
      pageToken = r.data.nextPageToken;
    }
    return ids.slice(0, max);
  },

  async getMessage(token, id){
    const r = await this.get(token, '/messages/' + id, 'format=full');
    return r.status === 200 ? r.data : null;
  },

  header(msg, name){
    const h = msg.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase());
    return h ? h.value : '';
  },

  body(msg){
    const parts = msg.payload?.parts || [];
    const all = [msg.payload, ...parts, ...parts.flatMap(p => p.parts||[])];
    let txt = '', html = '';
    for(const p of all){
      if(!p?.body?.data) continue;
      const d = Buffer.from(p.body.data.replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf8');
      if(p.mimeType === 'text/plain') txt += d;
      else if(p.mimeType === 'text/html') html += d;
    }
    if(!txt && html) txt = html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
    return txt.substring(0, 3000);
  }
};

// ── OpenAI email analysis ─────────────────────────────────────────────────────
const AI = {
  async analyzeEmails(openaiKey, emails){
    if(!openaiKey || !emails.length) return emails.map(e => this._fallback(e)).filter(Boolean);
    const results = [];
    for(let i = 0; i < emails.length; i += 4){
      const batch = emails.slice(i, i+4);
      try { results.push(...await this._callOpenAI(openaiKey, batch)); }
      catch(e){ results.push(...batch.map(e => this._fallback(e)).filter(Boolean)); }
      await new Promise(r => setTimeout(r, 200));
    }
    return results;
  },

  async _callOpenAI(key, emails){
    const today = new Date().toISOString().slice(0,10);
    const block = emails.map((e,i) =>
      `EMAIL ${i}:\nFrom:${e.from}\nSubject:${e.subject}\nDate:${e.date}\nBody:\n${e.body}`
    ).join('\n---\n');

    const prompt = `You are an expert financial email analyst. Today is ${today}.
Return a JSON array. Each item must have ALL these exact fields:
{"emailIndex":0,"actualVendor":"Netflix","billingPlatform":"Direct","productDescription":"Netflix Premium Monthly","amount":49.99,"currency":"AED","category":"streaming","type":"subscription","emailType":"receipt","isOverdue":false,"isRecurring":true,"billingPeriod":"monthly","billingCycleDay":15,"planTier":"Premium","isTrial":false,"dueDate":"","accountRef":"","dateStr":"${today}"}

emailType: receipt|invoice|upcoming|overdue_notice|booking_confirmation|refund
category: software_ai|streaming|telecom|utilities|food|health|shopping|finance|hotels_travel|transport|insurance|education|other
type: subscription|one_time|hotel|flight|utility_bill|insurance|refund|unknown

RULES:
- ONE email can have MULTIPLE items (Apple receipt with 3 apps = 3 items)
- actualVendor = real service name (never sender name)
- Skip non-financial emails
- Return ONLY valid JSON array

${block}`;

    const body = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 2000
    });

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + key,
          'Content-Length': Buffer.byteLength(body)
        }
      }, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try {
            const r = JSON.parse(data);            const raw = r.choices[0].message.content.trim()
              .replace(/^```json?\s*/,'').replace(/\s*```$/,'');
            const items = JSON.parse(raw);
            const now = new Date().toISOString();
            resolve(items.map((x,i) => {
              const s = emails[x.emailIndex] || emails[0];
              return {
                id: s.id + '_' + i,
                source: 'ai',
                actualVendor: x.actualVendor || 'Unknown',
                amount: parseFloat(x.amount) || 0,
                currency: x.currency || 'AED',
                category: x.category || 'other',
                type: x.type || 'unknown',
                emailType: x.emailType || 'receipt',
                isOverdue: !!x.isOverdue,
                isRecurring: !!x.isRecurring,
                billingPeriod: x.billingPeriod || '',
                billingCycleDay: parseInt(x.billingCycleDay) || 0,
                planTier: x.planTier || '',
                isTrial: !!x.isTrial,
                dueDate: x.dueDate || '',
                accountRef: x.accountRef || '',
                productDescription: x.productDescription || '',
                dateStr: x.dateStr || s.date,
                from: s.from,
                subject: s.subject,
                processedAt: now
              };
            }));
          } catch(e){ reject(e); }
        });
      });
      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('OpenAI timeout')); });
      req.write(body);
      req.end();
    });
  },

  _fallback(email){
    const sub = (email.subject||'').toLowerCase();
    const from = (email.from||'').toLowerCase();
    const body = (email.body||'').toLowerCase();
    const m = (email.subject+' '+email.body).match(/(?:AED|USD|\$|£|€)\s?(\d[\d,.]*)/);
    const amount = m ? parseFloat(m[1].replace(/,/g,'')) : 0;
    if(!amount) return null;
    let cat='other', type='unknown', isRecurring=false;
    let vendor = email.from.replace(/<.*>/,'').trim().split('@')[0];
    if(from.includes('netflix'))  { cat='streaming';   vendor='Netflix';   isRecurring=true; type='subscription'; }
    else if(from.includes('spotify')) { cat='streaming'; vendor='Spotify'; isRecurring=true; type='subscription'; }
    else if(from.includes('openai')||sub.includes('chatgpt')){ cat='software_ai'; vendor='ChatGPT'; isRecurring=true; type='subscription'; }
    else if(from.includes('dewa'))    { cat='utilities'; vendor='DEWA';   type='utility_bill'; }
    else if(from.includes('etisalat')){ cat='telecom';  vendor='Etisalat'; type='utility_bill'; }
    else if(from.includes('apple'))   { cat='software_ai'; vendor='Apple'; isRecurring=true; type='subscription'; }
    const overdueKw=['overdue','past due','final notice','outstanding','payment failed'];
    const upcomingKw=['renews on','upcoming charge','will be charged','auto-renew'];
    let emailType = 'receipt', isOverdue = false;
    if(overdueKw.some(k=>sub.includes(k)||body.includes(k))){ emailType='overdue_notice'; isOverdue=true; }
    else if(upcomingKw.some(k=>sub.includes(k)||body.includes(k))){ emailType='upcoming'; }
    return { id: email.id+'_0', source:'fallback', actualVendor:vendor, amount, currency:'AED',
      category:cat, type, emailType, isOverdue, isRecurring, billingPeriod: isRecurring?'monthly':'one_time',
      billingCycleDay: new Date(email.date).getDate()||0, planTier:'', isTrial:false, dueDate:'',
      accountRef:'', productDescription: email.subject.substring(0,60), dateStr: email.date,
      from: email.from, subject: email.subject, processedAt: new Date().toISOString() };
  }
};

// ── Intelligence Agents ───────────────────────────────────────────────────────
const Agents = {
  run(items, upcomingRaw, overdueAlerts){
    const alerts = [];
    alerts.push(...this.billSpikeDetector(items));
    alerts.push(...this.duplicateSubscriptionDetector(items));
    alerts.push(...this.unusedSubscriptionDetector(items));
    alerts.push(...this.renewalAlerts(upcomingRaw));
    alerts.push(...this.overdueDetector(overdueAlerts));
    alerts.push(...this.spendInsights(items));
    return alerts.sort((a,b) => b.priority - a.priority);
  },

  billSpikeDetector(items){
    const cards = [];
    const byVendor = {};
    items.filter(i=>i.isRecurring).forEach(i=>{
      const ym = (i.dateStr||'').slice(0,7);
      if(!byVendor[i.actualVendor]) byVendor[i.actualVendor] = {};
      byVendor[i.actualVendor][ym] = (byVendor[i.actualVendor][ym]||0) + i.amount;
    });
    for(const vendor in byVendor){
      const months = Object.keys(byVendor[vendor]).sort().reverse();
      if(months.length < 2) continue;
      const cur = byVendor[vendor][months[0]];
      const prev = byVendor[vendor][months[1]];
      if(prev > 0 && cur > prev * 1.25){
        const pct = Math.round((cur-prev)/prev*100);
        cards.push({
          id: 'spike_'+vendor.replace(/\s+/g,'_')+'_'+months[0],
          type:'alert', icon:'🚨', vendor,
          title: `${vendor} bill spiked ${pct}%`,
          body: `${vendor} went from AED ${prev.toFixed(2)} to AED ${cur.toFixed(2)} — up ${pct}% vs last month.`,
          tier: pct>50 ? 1 : 2, priority: pct>50 ? 95 : 85,
          ts: new Date().toISOString(), seen: false
        });
      }
    }
    return cards;
  },

  duplicateSubscriptionDetector(items){
    const cards = [];
    const byVendorMonth = {};
    items.filter(i=>i.isRecurring).forEach(i=>{
      const ym = (i.dateStr||'').slice(0,7);
      const key = `${i.actualVendor}|${ym}`;
      if(!byVendorMonth[key]) byVendorMonth[key] = [];
      byVendorMonth[key].push(i);
    });
    for(const key in byVendorMonth){
      const group = byVendorMonth[key];
      if(group.length > 1){
        const vendor = key.split('|')[0];
        const total = group.reduce((s,i)=>s+i.amount,0);
        const annualSave = ((total - group[0].amount) * 12).toFixed(0);
        cards.push({
          id: 'dupe_'+vendor.replace(/\s+/g,'_')+'_'+key.split('|')[1],
          type:'savings', icon:'💸', vendor,
          title: `Duplicate ${vendor} charges detected`,
          body: `Charged ${group.length}× in the same month — AED ${total.toFixed(2)} total. Cancel duplicates to save AED ${annualSave}/year.`,
          savingsAmount: parseFloat(annualSave), tier: 2, priority: 82,
          ts: new Date().toISOString(), seen: false
        });
      }
    }
    return cards;
  },

  unusedSubscriptionDetector(items){
    const cards = [];
    const today = new Date();
    const seen = new Set();
    items.filter(i=>i.isRecurring && i.amount>0).forEach(i=>{
      if(seen.has(i.actualVendor)) return;
      const itemDate = new Date(i.dateStr);
      const daysSince = (today - itemDate) / (1000*60*60*24);
      if(daysSince >= 45 && daysSince < 120){
        seen.add(i.actualVendor);
        cards.push({
          id: 'unused_'+i.actualVendor.replace(/\s+/g,'_'),
          type:'reminder', icon:'📅', vendor: i.actualVendor,
          title: `${i.actualVendor} — still using it?`,
          body: `Last charge was ${Math.floor(daysSince)} days ago (AED ${i.amount.toFixed(2)}/mo). No recent activity detected.`,
          tier: 3, priority: 65,
          ts: new Date().toISOString(), seen: false
        });
      }
    });
    return cards;
  },

  renewalAlerts(upcomingRaw){
    const cards = [];
    const today = new Date();
    (upcomingRaw||[]).forEach(item=>{
      const dueDate = new Date(item.dueDate || item.dateStr);
      const daysUntil = (dueDate - today) / (1000*60*60*24);
      if(daysUntil > 0 && daysUntil <= 7){
        cards.push({
          id: 'renewal_'+item.actualVendor.replace(/\s+/g,'_')+'_'+(item.dueDate||item.dateStr),
          type:'reminder', icon:'📅', vendor: item.actualVendor,
          title: `${item.actualVendor} renews in ${Math.ceil(daysUntil)} day${Math.ceil(daysUntil)>1?'s':''}`,
          body: `AED ${item.amount.toFixed(2)} will be charged on ${dueDate.toDateString().substring(4)}.`,
          tier: 2, priority: 75,
          ts: new Date().toISOString(), seen: false
        });      }
    });
    return cards;
  },

  overdueDetector(overdueAlerts){
    return (overdueAlerts||[]).map(item => ({
      id: 'overdue_'+item.actualVendor.replace(/\s+/g,'_'),
      type:'alert', icon:'🚨', vendor: item.actualVendor,
      title: `${item.actualVendor} payment OVERDUE`,
      body: `Outstanding balance: AED ${item.amount.toFixed(2)}. Pay now to avoid penalties or service interruption.`,
      tier: 1, priority: 100,
      ts: new Date().toISOString(), seen: false
    }));
  },

  spendInsights(items){
    const cards = [];
    const cats = {};
    items.forEach(i=>{
      const ym = (i.dateStr||'').slice(0,7);
      const key = `${i.category||'other'}|${ym}`;
      if(!cats[key]) cats[key] = 0;
      cats[key] += i.amount;
    });
    const byCat = {};
    for(const key in cats){
      const [cat, ym] = key.split('|');
      if(!byCat[cat]) byCat[cat] = {};
      byCat[cat][ym] = cats[key];
    }
    const catLabels = { streaming:'Streaming', software_ai:'Software & AI', telecom:'Telecom',
      utilities:'Utilities', shopping:'Shopping', food:'Food delivery', health:'Health',
      finance:'Finance', hotels_travel:'Travel', transport:'Transport', other:'Other' };
    for(const cat in byCat){
      const months = Object.keys(byCat[cat]).sort().reverse();
      if(months.length < 2) continue;
      const cur = byCat[cat][months[0]];
      const prev = byCat[cat][months[1]];
      if(prev > 0 && cur > prev * 1.4){
        const pct = Math.round((cur-prev)/prev*100);
        cards.push({
          id: 'insight_'+cat+'_'+months[0],
          type:'insight', icon:'🧠', category: cat,
          title: `${catLabels[cat]||cat} spending up ${pct}%`,
          body: `AED ${cur.toFixed(0)} this month vs AED ${prev.toFixed(0)} last month — ${pct}% increase.`,
          tier: 3, priority: 60,
          ts: new Date().toISOString(), seen: false
        });
      }
    }
    return cards;
  }
};

// ── Email Sync Agent ──────────────────────────────────────────────────────────
const EmailAgent = {
  running: false,

  async run(userId){
    if(this.running){ console.log('[Agent] Already running, skipping'); return; }
    this.running = true;
    console.log(`[Agent] Starting email sync for user ${userId} at ${new Date().toLocaleTimeString()}`);

    try {
      const creds = Store.read('credentials');
      const user = creds[userId];
      if(!user || !user.googleToken){ console.log('[Agent] No Google token, skipping'); return; }

      // Check if token is known to be expired — signal frontend to refresh
      if(user.tokenExpired){
        console.log('[Agent] Token expired, waiting for frontend to refresh...');
        this.running = false;
        return;
      }

      const queries = [
        'subject:(receipt OR invoice OR bill OR payment OR subscription) newer_than:6m',
        'from:(apple.com OR netflix.com OR spotify.com OR amazon.com OR noon.com OR openai.com OR dewa.gov.ae OR etisalat.ae) newer_than:6m',
        'subject:(hotel OR "booking confirmation" OR reservation OR itinerary) newer_than:3m'
      ];

      const allIds = new Set();
      const processed = Store.read('processed_ids', {});
      const userProcessed = processed[userId] || [];
      const processedSet = new Set(userProcessed);

      for(const q of queries){
        try {
          const ids = await Gmail.listIds(user.googleToken, q, 60);
          ids.forEach(id => allIds.add(id));
        } catch(e) {
          // 401 = token expired — tell frontend to send a fresh one
          if(e.message && (e.message.includes('401') || e.message.includes('403'))){
            console.log('[Agent] Gmail token expired (401/403). Flagging for frontend refresh...');
            const creds2 = Store.read('credentials');
            if(creds2[userId]) { creds2[userId].tokenExpired = true; Store.write('credentials', creds2); }
            this.running = false;
            return;
          }
          throw e;
        }
        await new Promise(r => setTimeout(r, 300));
      }

      // Only process NEW emails we haven't seen
      const newIds = [...allIds].filter(id => !processedSet.has(id));
      console.log(`[Agent] Found ${allIds.size} total, ${newIds.length} new emails to process`);

      if(!newIds.length){
        console.log('[Agent] No new emails, running agents on existing data');
        this._runAgents(userId);
        return;
      }

      // Fetch new emails
      const emails = [];
      for(let i = 0; i < Math.min(newIds.length, 40); i++){
        try {
          const msg = await Gmail.getMessage(user.googleToken, newIds[i]);
          if(!msg) continue;
          emails.push({
            id: newIds[i],
            from: Gmail.header(msg, 'from'),
            subject: Gmail.header(msg, 'subject'),
            date: Gmail.header(msg, 'date').substring(0,10),
            body: Gmail.body(msg)
          });
          if(i % 10 === 0) console.log(`[Agent] Fetched ${i+1}/${Math.min(newIds.length,40)} emails`);
          await new Promise(r => setTimeout(r, 80));
        } catch(e){ /* skip */ }
      }

      // AI analysis
      console.log(`[Agent] Sending ${emails.length} emails to AI...`);
      const newItems = await AI.analyzeEmails(user.openaiKey, emails);
      console.log(`[Agent] AI extracted ${newItems.length} transactions`);

      // Merge with existing data
      const userData = Store.read('user_data', {});
      if(!userData[userId]) userData[userId] = { items:[], upcomingRaw:[], overdueAlerts:[], emailCount:0, lastSync:null };
      const ud = userData[userId];

      // Add new items (dedup by id)
      const existingIds = new Set(ud.items.map(i=>i.id));
      const receipts = newItems.filter(x => !x.isOverdue && x.emailType!=='overdue_notice' && x.emailType!=='invoice' && x.emailType!=='upcoming' && x.amount>0);
      const upcoming = newItems.filter(x => !x.isOverdue && (x.emailType==='invoice'||x.emailType==='upcoming') && x.amount>0);
      const overdue  = newItems.filter(x => x.isOverdue || x.emailType==='overdue_notice');

      receipts.filter(x=>!existingIds.has(x.id)).forEach(x=>ud.items.push(x));
      upcoming.forEach(x=>{ if(!ud.upcomingRaw.find(e=>e.id===x.id)) ud.upcomingRaw.push(x); });
      overdue.forEach(x=>{ if(!ud.overdueAlerts.find(e=>e.id===x.id)) ud.overdueAlerts.push(x); });
      ud.emailCount = (ud.emailCount||0) + emails.length;
      ud.lastSync = new Date().toISOString();

      Store.write('user_data', userData);

      // Mark emails as processed
      processed[userId] = [...new Set([...userProcessed, ...newIds])].slice(-500); // keep last 500
      Store.write('processed_ids', processed);

      // Run intelligence agents
      this._runAgents(userId);
      console.log(`[Agent] Sync complete. Total items: ${ud.items.length}`);

    } catch(e){
      console.error('[Agent] Error:', e.message);
    } finally {
      this.running = false;
    }
  },

  _runAgents(userId){
    const userData = Store.read('user_data', {});
    const ud = userData[userId];    if(!ud) return;

    const newAlerts = Agents.run(ud.items, ud.upcomingRaw, ud.overdueAlerts);

    // Merge with existing alerts (don't duplicate same id)
    const alertsStore = Store.read('alerts', {});
    if(!alertsStore[userId]) alertsStore[userId] = [];
    const existingIds = new Set(alertsStore[userId].map(a=>a.id));
    const added = newAlerts.filter(a => !existingIds.has(a.id));
    alertsStore[userId] = [...added, ...alertsStore[userId]].slice(0, 50); // keep latest 50
    Store.write('alerts', alertsStore);

    if(added.length){
      console.log(`[Agents] Generated ${added.length} new alert(s):`);
      added.forEach(a => console.log(`  [${a.type.toUpperCase()}] ${a.title}`));
      notifyNewAlerts(added); // 🔔 fire macOS system notifications
    } else {
      console.log('[Agents] No new alerts');
    }
  }
};

// ── REST API Router ───────────────────────────────────────────────────────────
async function router(req, res){
  // Redirect localhost → 127.0.0.1 only when running locally (not on cloud)
  if(!process.env.PORT && req.headers.host && req.headers.host.startsWith('localhost')){
    res.writeHead(302, { Location: 'http://127.0.0.1:3001' + req.url });
    res.end();
    return;
  }

  // CORS — allow the frontend on any port
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS'){ res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];
  const qs  = Object.fromEntries(new URLSearchParams(req.url.split('?')[1]||''));

  // ── Serve aria-new.html at / and /aria-new.html ──────────────────────────────
  // This lets the app run at http://localhost:3001 so Google OAuth works
  if(req.method==='GET' && (url==='/' || url==='/aria-new.html' || url==='/index.html')){
    // Check same directory first, then parent folder (legacy fallback)
    let htmlPath = path.join(__dirname, 'aria-new.html');
    if(!fs.existsSync(htmlPath)) htmlPath = path.join(__dirname, '..', 'aria-new.html');
    try {
      const html = fs.readFileSync(htmlPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch(e) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('aria-new.html not found at: ' + htmlPath);
    }
    return;
  }

  function json(data, status=200){
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  function body(cb){
    let data = '';
    req.on('data', d => data += d);
    req.on('end', () => { try{ cb(JSON.parse(data||'{}')); } catch(e){ json({error:'bad json'},400); } });
  }

  // ── POST /api/register — frontend sends credentials ─────────────────────────
  if(req.method==='POST' && url==='/api/register'){
    body(({ userId='default', googleToken, openaiKey, googleClientId, rapidApiKey })=>{
      const creds = Store.read('credentials');
      const existing = creds[userId] || {};
      creds[userId] = { ...existing, googleToken, openaiKey, googleClientId, rapidApiKey: rapidApiKey || existing.rapidApiKey || '', updatedAt: new Date().toISOString(), tokenExpired: false };
      Store.write('credentials', creds);
      console.log(`[API] Credentials registered for user: ${userId}`);
      // Trigger immediate sync
      setTimeout(() => EmailAgent.run(userId), 500);
      json({ ok: true, message: 'Registered. Sync starting in background.' });
    });
    return;
  }

  // ── POST /api/register-spotify — store Spotify token for podcast agent ──────
  if(req.method==='POST' && url==='/api/register-spotify'){
    body(({ userId='default', spotifyToken, spotifyRefreshToken, spotifyClientId })=>{
      const creds = Store.read('credentials');
      if(!creds[userId]) creds[userId] = {};
      if(spotifyToken) creds[userId].spotifyToken = spotifyToken;
      if(spotifyRefreshToken) creds[userId].spotifyRefreshToken = spotifyRefreshToken;
      if(spotifyClientId) creds[userId].spotifyClientId = spotifyClientId;
      Store.write('credentials', creds);
      console.log(`[API] Spotify token stored for ${userId}`);
      json({ ok: true });
    });
    return;
  }

  // ── GET /api/spotify/search — search for shows by name ──────────────────────
  if(req.method==='GET' && url==='/api/spotify/search'){
    const userId = qs.userId || 'default';
    const query = qs.q || '';
    if(!query){ json({ shows:[] }); return; }
    let creds = Store.read('credentials');
    let token = creds[userId]?.spotifyToken;
    if(!token){ json({ error:'No Spotify token — reconnect Spotify in Apps tab', shows:[] }); return; }

    const doSearch = async (tok) => {
      const apiUrl = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=show&limit=8&market=US`;
      return new Promise((resolve) => {
        const req2 = https.get(apiUrl, { headers:{ Authorization:'Bearer '+tok }}, res=>{
          let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{ resolve(JSON.parse(d)); }catch(e){ resolve({}); } });
        });
        req2.on('error',()=>resolve({})); req2.setTimeout(10000,()=>{ req2.destroy(); resolve({}); });
      });
    };

    let r = await doSearch(token);
    // If token expired, refresh and retry once
    if(r.error?.status === 401){
      console.log('[Spotify] Search got 401 — refreshing token...');
      const newToken = await refreshSpotifyToken(userId);
      if(newToken){ r = await doSearch(newToken); }
    }
    const shows = (r.shows?.items||[]).map(s=>({ id:s.id, name:s.name, publisher:s.publisher, totalEpisodes:s.total_episodes, description:(s.description||'').substring(0,120) }));
    json({ shows });
    return;
  }

  // ── GET /api/spotify/my-shows — get user's saved/followed shows ─────────────
  if(req.method==='GET' && url==='/api/spotify/my-shows'){
    const userId = qs.userId || 'default';
    const creds = Store.read('credentials');
    const token = creds[userId]?.spotifyToken;
    if(!token){ json({ error:'No Spotify token', shows:[] }); return; }
    const apiUrl = `https://api.spotify.com/v1/me/shows?limit=50`;
    const r = await new Promise((resolve) => {
      const req2 = https.get(apiUrl, { headers:{ Authorization:'Bearer '+token }}, res=>{
        let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{ resolve(JSON.parse(d)); }catch(e){ resolve({}); } });
      });
      req2.on('error',()=>resolve({})); req2.setTimeout(10000,()=>{ req2.destroy(); resolve({}); });
    });
    // If 403 (scope missing), still return gracefully
    if(r.error){ json({ error: r.error.message, shows:[], needsScope: r.error.status===403 }); return; }
    const shows = (r.items||[]).map(i=>({ id:i.show?.id, name:i.show?.name, publisher:i.show?.publisher, totalEpisodes:i.show?.total_episodes })).filter(s=>s.id);
    json({ shows });
    return;
  }

  // ── POST /api/sync — trigger manual sync ────────────────────────────────────
  if(req.method==='POST' && url==='/api/sync'){
    body(({ userId='default' })=>{
      setTimeout(() => EmailAgent.run(userId), 100);
      json({ ok: true, message: 'Sync triggered' });
    });
    return;
  }

  // ── GET /api/alerts — poll for new alerts ───────────────────────────────────
  if(req.method==='GET' && url==='/api/alerts'){
    const userId = qs.userId || 'default';
    const since  = qs.since ? new Date(qs.since) : new Date(0);
    const alertsStore = Store.read('alerts', {});
    const all = (alertsStore[userId]||[]);
    const newAlerts = all.filter(a => new Date(a.ts) > since && !a.seen);
    json({ alerts: newAlerts, total: all.length });
    return;
  }

  // ── POST /api/alerts/dismiss — mark alert as seen ───────────────────────────
  if(req.method==='POST' && url==='/api/alerts/dismiss'){
    body(({ userId='default', alertId })=>{
      const alertsStore = Store.read('alerts', {});
      const userAlerts = alertsStore[userId]||[];      const alert = userAlerts.find(a => a.id === alertId);
      if(alert) alert.seen = true;
      Store.write('alerts', alertsStore);
      json({ ok: true });
    });
    return;
  }

  // ── GET /api/data — full user data ──────────────────────────────────────────
  if(req.method==='GET' && url==='/api/data'){
    const userId = qs.userId || 'default';
    const userData = Store.read('user_data', {});
    const ud = userData[userId] || { items:[], upcomingRaw:[], overdueAlerts:[], emailCount:0, lastSync:null };
    const alertsStore = Store.read('alerts', {});
    json({ ...ud, alerts: alertsStore[userId]||[] });
    return;
  }

  // ── GET /api/status — health check ──────────────────────────────────────────
  if(req.method==='GET' && url==='/api/status'){
    const userId = qs.userId || 'default';
    const userData = Store.read('user_data', {});
    const ud = userData[userId] || {};
    const creds = Store.read('credentials');
    const user = creds[userId] || {};
    json({
      ok: true,
      agentRunning: EmailAgent.running,
      lastSync: ud.lastSync || null,
      itemCount: (ud.items||[]).length,
      nextSyncIn: '5 minutes (auto)',
      needsTokenRefresh: !!user.tokenExpired,
      version: '1.0.0'
    });
    return;
  }

  // ── GET/POST /api/watchlist — stocks + podcasts the user tracks ─────────────
  if(req.method==='GET' && url==='/api/watchlist'){
    const userId = qs.userId || 'default';
    const wl = Store.read('watchlists', {});
    json(wl[userId] || { stocks:[], podcasts:[] });
    return;
  }
  if(req.method==='POST' && url==='/api/watchlist'){
    body(({ userId='default', stocks=[], podcasts=[] })=>{
      const wl = Store.read('watchlists', {});
      wl[userId] = { stocks, podcasts, updatedAt: new Date().toISOString() };
      Store.write('watchlists', wl);
      console.log(`[Watchlist] Saved for ${userId}: ${stocks.length} stocks, ${podcasts.length} podcasts`);
      json({ ok: true });
    });
    return;
  }

  // ── POST /api/intelligence/run — trigger on-demand intelligence scan ─────────
  if(req.method==='POST' && url==='/api/intelligence/run'){
    body(({ userId='default' })=>{
      setTimeout(() => IntelligenceAgent.run(userId), 100);
      json({ ok: true, message: 'Intelligence scan started' });
    });
    return;
  }

  // ── GET /api/intelligence — get latest intelligence cards ───────────────────
  if(req.method==='GET' && url==='/api/intelligence'){
    const userId = qs.userId || 'default';
    const intel = Store.read('intelligence', {});
    json({ cards: intel[userId] || [] });
    return;
  }

  // ── GET/POST /api/trips — trip watchlist (upcoming travel) ───────────────────
  if(req.method==='GET' && url==='/api/trips'){
    const userId = qs.userId || 'default';
    const trips = Store.read('trips', {});
    json({ trips: trips[userId] || [] });
    return;
  }
  if(req.method==='POST' && url==='/api/trips'){
    body(({ userId='default', trips })=>{
      const t = Store.read('trips', {});
      t[userId] = trips || [];
      Store.write('trips', t);
      json({ ok: true });
    });
    return;
  }

  // ── POST /api/trips/run — run TripAgent now for all upcoming trips ────────────
  if(req.method==='POST' && url==='/api/trips/run'){
    body(({ userId='default' })=>{
      setTimeout(() => TripAgent.run(userId), 100);
      json({ ok: true, message: 'Trip agent started — results in your feed shortly' });
    });
    return;
  }

  // ── GET /api/accommodation/results — latest agent-generated accommodation cards
  if(req.method==='GET' && url==='/api/accommodation/results'){
    const userId = qs.userId || 'default';
    const accom = Store.read('accommodation', {});
    json({ cards: accom[userId] || [] });
    return;
  }

  // ── GET /api/news — latest RSS news cards ──────────────────────────────────
  if(req.method==='GET' && url==='/api/news'){
    const userId = qs.userId || 'default';
    const news = Store.read('news', {});
    json({ cards: news[userId] || [] });
    return;
  }

  // ── POST /api/news/run — trigger news fetch now ─────────────────────────────
  if(req.method==='POST' && url==='/api/news/run'){
    const userId = qs.userId || 'default';
    setTimeout(() => NewsAgent.run(userId), 100);
    json({ ok: true, message: 'News scan started' });
    return;
  }

  // ── GET /api/property — latest property research cards ─────────────────────
  if(req.method==='GET' && url==='/api/property'){
    const userId = qs.userId || 'default';
    const prop = Store.read('property', {});
    json({ cards: prop[userId] || [] });
    return;
  }

  // ── POST /api/property/run — trigger property research now ─────────────────
  if(req.method==='POST' && url==='/api/property/run'){
    const userId = qs.userId || 'default';
    setTimeout(() => PropertyAgent.run(userId), 100);
    json({ ok: true, message: 'Property scan started' });
    return;
  }

  // ── GET/POST /api/property/watchlist — manage property searches ─────────────
  if(req.method==='GET' && url==='/api/property/watchlist'){
    const userId = qs.userId || 'default';
    const wl = Store.read('watchlists', {})[userId] || {};
    json({ properties: wl.properties || [] });
    return;
  }

  if(req.method==='POST' && url==='/api/property/watchlist'){
    body(req, data => {
      const userId = data.userId || 'default';
      const wl = Store.read('watchlists', {});
      if(!wl[userId]) wl[userId] = {};
      if(!wl[userId].properties) wl[userId].properties = [];
      if(data.action === 'add' && data.query){
        const entry = { query: data.query, type: data.propertyType || 'any', budget: data.budget || null, addedAt: new Date().toISOString() };
        // Deduplicate by query
        wl[userId].properties = wl[userId].properties.filter(p => p.query !== data.query);
        wl[userId].properties.push(entry);
        wl[userId].updatedAt = new Date().toISOString();
        Store.write('watchlists', wl);
        // Kick off research immediately
        setTimeout(() => PropertyAgent.run(userId), 500);
        json({ ok: true, properties: wl[userId].properties });
      } else if(data.action === 'remove' && data.query){
        wl[userId].properties = (wl[userId].properties || []).filter(p => p.query !== data.query);
        Store.write('watchlists', wl);
        json({ ok: true, properties: wl[userId].properties });
      } else {
        json({ error: 'Invalid action' }, 400);
      }
    });
    return;
  }

  json({ error: 'Not found' }, 404);
}
// ── Accommodation Agent (GPT-powered research + direct search links) ───────────
const AccommodationAgent = {

  _gptCall(openaiKey, prompt, maxTokens=600){
    const body = JSON.stringify({
      model: 'gpt-4o-mini',
      messages:[{ role:'user', content: prompt }],
      temperature:0.3, max_tokens: maxTokens, response_format:{ type:'json_object' }
    });
    return new Promise((resolve) => {
      const req = https.request({ hostname:'api.openai.com', path:'/v1/chat/completions', method:'POST',
        headers:{ 'Content-Type':'application/json','Authorization':'Bearer '+openaiKey,'Content-Length':Buffer.byteLength(body) }
      }, res => {
        let d=''; res.on('data',c=>d+=c);
        res.on('end',()=>{ try{ resolve(JSON.parse(JSON.parse(d).choices[0].message.content)); }catch(e){ resolve(null); }});
      });
      req.on('error',()=>resolve(null));
      req.setTimeout(25000,()=>{req.destroy();resolve(null)});
      req.write(body); req.end();
    });
  },

  async parseQuery(openaiKey, query){
    const today = new Date().toISOString().slice(0,10);
    const result = await this._gptCall(openaiKey,
      `Today is ${today}. Extract accommodation search parameters from: "${query}"\nReturn ONLY JSON: {"destination":"city name","checkin":"YYYY-MM-DD","checkout":"YYYY-MM-DD","guests":2}\nCalculate relative dates from today. Return valid JSON only.`,
      150
    );
    return result || {};
  },

  // Build Airbnb / Booking.com / Hotels.com search URLs from parameters
  buildSearchUrls(destination, checkin, checkout, guests){
    const enc = encodeURIComponent;
    const ci = checkin || '', co = checkout || '', g = guests || 2;
    // Airbnb
    const airbnb = `https://www.airbnb.com/s/${enc(destination)}/homes?checkin=${ci}&checkout=${co}&adults=${g}&place_id=`;
    // Booking.com
    const bkCi = ci.replace(/-/g,'-'), bkCo = co.replace(/-/g,'-');
    const booking = `https://www.booking.com/searchresults.html?ss=${enc(destination)}&checkin=${bkCi}&checkout=${bkCo}&group_adults=${g}&no_rooms=1&selected_currency=USD`;
    // Hotels.com
    const hotels = `https://www.hotels.com/search.do?q-destination=${enc(destination)}&q-check-in=${ci}&q-check-out=${co}&q-rooms=1&q-room-0-adults=${g}`;
    // VRBO
    const vrbo = `https://www.vrbo.com/search?destination=${enc(destination)}&startDate=${ci}&endDate=${co}&adults=${g}`;
    return { airbnb, booking, hotels, vrbo };
  },

  async research(openaiKey, { destination, checkin, checkout, guests, budget, currency='USD' }){
    console.log(`[Accommodation] Researching ${destination} | ${checkin}\u2192${checkout} | ${guests} guests`);
    const nights = checkin && checkout ? Math.round((new Date(checkout)-new Date(checkin))/86400000) : null;
    const budgetNote = budget ? `Budget: up to ${budget} ${currency}/night.` : '';
    const nightsNote = nights ? `${nights} nights.` : '';
    const urls = this.buildSearchUrls(destination, checkin, checkout, guests);

    const prompt = `You are a luxury travel concierge with deep knowledge of global accommodation markets. Research the best stays for:\nDestination: ${destination}\nDates: ${checkin||'flexible'} to ${checkout||'flexible'} (${nightsNote})\nGuests: ${guests}\n${budgetNote}\n\nReturn ONLY this JSON structure (no markdown):\n{\n  "overview": "2-3 sentence overview covering the best neighbourhoods, vibe, and what to watch out for",\n  "priceRange": "Realistic nightly price range, e.g. $150-800/night",\n  "picks": [\n    {\n      "id": "pick_1",\n      "name": "Specific descriptive name, e.g. 'Mayfair Georgian Townhouse', 'Shoreditch Loft Studio'",\n      "area": "Exact neighbourhood (e.g. Mayfair, Shoreditch, Notting Hill)",\n      "type": "Entire apartment|Villa|Studio|Penthouse|Townhouse|Boutique hotel|Serviced apartment|Loft",\n      "bedrooms": 2,\n      "bathrooms": 1,\n      "maxGuests": 4,\n      "estimatedPrice": "USD 200/night",\n      "estimatedTotal": "USD 1000 total",\n      "amenities": ["WiFi", "Pool", "Kitchen", "Parking", "Gym", "Concierge"],\n      "whyPick": "One sharp, specific sentence on why this is worth considering",\n      "badge": "Best Value|Top Rated|ARIA's Pick|Best Location|Most Unique|Hidden Gem|Luxury|Business-Ready",\n      "airbnbSearchUrl": "${urls.airbnb}",\n      "bookingSearchUrl": "${urls.booking}"\n    }\n  ],\n  "ariasTip": "ARIA's single most important insider tip for booking in ${destination} right now",\n  "bestArea": "The single best neighbourhood for this specific trip"\n}\n\nGive EXACTLY 12 picks. Maximise diversity: spread across different neighbourhoods, price tiers (budget/mid/premium/luxury), property types, and guest profiles (couples, families, business). Every pick must be in a different area if possible. Prices must be realistic for ${destination}. Return valid JSON only.`;

    const result = await this._gptCall(openaiKey, prompt, 3500);
    if(!result || !result.picks) return [];

    return (result.picks || []).map((p, i) => ({
      id: `gpt_${Date.now()}_${i}`,
      name: p.name || `Option ${i+1}`,
      type: p.type || 'Entire place',
      area: p.area || destination,
      city: destination,
      bedrooms: p.bedrooms || 0,
      bathrooms: p.bathrooms || 0,
      maxGuests: p.maxGuests || guests,
      amenities: p.amenities || [],
      priceDisplay: p.estimatedPrice || '',
      priceTotal: p.estimatedTotal || '',
      estimatedPrice: p.estimatedPrice || '',
      ariasTake: p.whyPick || '',
      badge: p.badge || "ARIA's Pick",
      overview: i === 0 ? result.overview : '',
      priceRange: i === 0 ? result.priceRange : '',
      ariasTip: i === 0 ? result.ariasTip : '',
      bestArea: i === 0 ? result.bestArea : '',
      url: p.airbnbSearchUrl || urls.airbnb,
      bookingUrl: p.bookingSearchUrl || urls.booking,
      hotelsUrl: urls.hotels,
      vrboUrl: urls.vrbo,
      source: 'aria_research',
      ariaPick: true
    }));
  }
};

// ── Travel Agent — one agent for all trip research. Runs every hour. ──────────
// Replaces both TripAgent and PropertyAgent. Reads trips watchlist and
// researches every destination: accommodation picks + area intel + booking links.
const TravelAgent = {
  running: false,

  // Keep backward-compat alias so old endpoint code still works
  get TripAgent(){ return this; },

  async run(userId){
    if(this.running){ console.log('[TravelAgent] Already running, skipping'); return; }
    this.running = true;
    console.log(`[TravelAgent] Starting hourly research for ${userId}`);

    try {
      const creds  = Store.read('credentials');
      const user   = creds[userId] || {};
      if(!user.openaiKey){
        console.log('[TravelAgent] No OpenAI key, skipping');
        return;
      }

      const tripsStore = Store.read('trips', {});
      // Include all trips: future trips + open-ended searches (no checkin = standing research)
      const trips = (tripsStore[userId] || []).filter(t => {
        if(!t.checkin) return true; // open-ended destination research — always run
        return new Date(t.checkin) >= new Date(new Date().toDateString());
      });

      if(!trips.length){
        console.log('[TravelAgent] No trips in watchlist, skipping');
        return;
      }

      console.log(`[TravelAgent] Researching ${trips.length} destination(s)...`);

      const newCards = [];
      for(const trip of trips){
        try {
          console.log(`[TravelAgent] Researching ${trip.destination}`);
          const picks = await AccommodationAgent.research(user.openaiKey, {
            destination: trip.destination,
            checkin:     trip.checkin  || '',
            checkout:    trip.checkout || '',
            guests:      trip.guests   || 2,
            budget:      trip.budget   || '',
            currency:    trip.currency || 'USD'
          });

          if(!picks || !picks.length){
            console.log(`[TravelAgent] No picks returned for ${trip.destination}`);
            continue;
          }
          const cardId = `trip_${trip.destination.replace(/\s+/g,'_').toLowerCase()}_${trip.checkin||'open'}`;
          newCards.push({
            id:          cardId,
            type:        'accommodation',
            icon:        '🧳',
            destination: trip.destination,
            checkin:     trip.checkin  || '',
            checkout:    trip.checkout || '',
            guests:      trip.guests   || 2,
            picks,
            overview:    picks[0]?.overview  || '',
            priceRange:  picks[0]?.priceRange || '',
            ariasTip:    picks[0]?.ariasTip   || '',
            bestArea:    picks[0]?.bestArea   || '',
            generatedAt: new Date().toISOString(),
            seen: false
          });

          const isNewSearch = !Store.read('accommodation', {})[userId]?.find(c => c.id === cardId);
          if(isNewSearch){
            notify(
              `\u2708\ufe0f ${trip.destination} \u2014 ${picks.length} options ready`,
              `ARIA found ${picks.length} stays across every price point${trip.checkin ? ' for your '+trip.checkin+' trip' : ''}`
            );
          }

          console.log(`[TravelAgent] \u2713 ${trip.destination} \u2014 ${picks.length} picks`);
          await new Promise(r => setTimeout(r, 1000)); // rate-limit GPT calls
        } catch(e){
          console.error(`[TravelAgent] Error researching ${trip.destination}:`, e.message);
        }
      }

      if(newCards.length){
        const accom = Store.read('accommodation', {});
        const existing = (accom[userId] || []).filter(c => {
          return (Date.now() - new Date(c.generatedAt||0).getTime()) < 24*60*60*1000; // keep last 24h
        });
        const newIds = new Set(newCards.map(c => c.id));
        accom[userId] = [...newCards, ...existing.filter(c => !newIds.has(c.id))].slice(0, 50);
        Store.write('accommodation', accom);
        console.log(`[TravelAgent] Saved ${newCards.length} destination card(s) to feed`);
      } else {
        console.log('[TravelAgent] No cards generated this run');
      }

    } catch(e){
      console.error('[TravelAgent] Fatal error:', e.message);
    } finally {
      this.running = false;
    }
  }
};

// Backward-compat alias \u2014 old endpoints still call TripAgent.run()
const TripAgent = TravelAgent;

// \u2500\u2500 News Agent \u2014 free RSS feeds, no API key needed \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const NewsAgent = {
  running: false,

  // RSS feeds by category \u2014 all free, no auth required
  FEEDS: [
    { url: 'https://feeds.bbci.co.uk/news/business/rss.xml',          category: 'Business',       icon: '\ud83d\udcf0' },
    { url: 'https://feeds.bbci.co.uk/news/technology/rss.xml',        category: 'Tech',            icon: '\ud83d\udcbb' },
    { url: 'https://feeds.bbci.co.uk/news/world/rss.xml',             category: 'World',           icon: '\ud83c\udf0d' },
    { url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', category: 'Markets',     icon: '\ud83d\udcc8' },
    { url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',           category: 'Markets',         icon: '\ud83d\udcca' },
  ],

  fetchRSS(feedUrl){
    return new Promise((resolve) => {
      const urlObj = new URL(feedUrl);
      const mod = urlObj.protocol === 'https:' ? https : http;
      const opts = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ARIABot/1.0)', 'Accept': 'application/rss+xml, application/xml, text/xml' }
      };
      const req = mod.get(opts, res => {
        // Follow redirects
        if(res.statusCode >= 300 && res.statusCode < 400 && res.headers.location){
          return this.fetchRSS(res.headers.location).then(resolve);
        }
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => resolve(body));
      });
      req.on('error', () => resolve(''));
      req.setTimeout(12000, () => { req.destroy(); resolve(''); });
    });
  },

  parseRSS(xml){
    const items = [];
    const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
    let match;
    while((match = itemRegex.exec(xml)) !== null){
      const block = match[1];
      const get = (tag) => {
        const m = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}[^>]*>([^<]*)</${tag}>`, 'i'));
        return m ? (m[1] || m[2] || '').trim() : '';
      };
      const title = get('title');
      const pubDate = get('pubDate');
      const source = get('source') || '';
      if(title) items.push({ title, pubDate, source });
    }
    return items;
  },

  timeAgo(dateStr){
    if(!dateStr) return '';
    const d = new Date(dateStr);
    if(isNaN(d)) return '';
    const diff = (Date.now() - d) / 60000; // minutes
    if(diff < 60) return `${Math.round(diff)}m ago`;
    if(diff < 1440) return `${Math.round(diff/60)}h ago`;
    return `${Math.round(diff/1440)}d ago`;
  },

  async run(userId){
    if(this.running){ console.log('[NewsAgent] Already running'); return; }
    this.running = true;
    console.log(`[NewsAgent] Fetching news for ${userId}`);

    try {
      const allCards = [];
      const now = new Date().toISOString();

      for(const feed of this.FEEDS){
        try {
          console.log(`[NewsAgent] Fetching: ${feed.category}`);
          const xml = await this.fetchRSS(feed.url);
          if(!xml){ console.log(`[NewsAgent] Empty response for ${feed.category}`); continue; }

          const items = this.parseRSS(xml);
          if(!items.length){ continue; }

          // Take the freshest 5 stories from this feed
          const stories = items.slice(0, 5).map(i => ({
            title: i.title,
            source: feed.category,
            ago: this.timeAgo(i.pubDate)
          }));

          allCards.push({
            id: `news_${feed.category.toLowerCase()}_${now.slice(0,10)}`,
            type: 'news',
            icon: feed.icon,
            category: feed.category,
            title: `${feed.category} Headlines`,
            summary: '',
            stories,
            priority: feed.category === 'Markets' ? 68 : feed.category === 'Business' ? 65 : 60,
            ts: now,
            seen: false
          });

          console.log(`[NewsAgent] \u2713 ${feed.category} \u2014 ${stories.length} stories`);
          await new Promise(r => setTimeout(r, 300));
        } catch(e){ console.error(`[NewsAgent] Error for ${feed.category}:`, e.message); }
      }

      if(allCards.length){
        const existing = Store.read('news', {});
        const todayKey = now.slice(0,10);
        existing[userId] = allCards; // replace with today's news
        Store.write('news', existing);
        console.log(`[NewsAgent] Saved ${allCards.length} news category cards`);
        notify('Morning Briefing Ready', `${allCards.length} news feeds updated \u2014 check ARIA`);
      }
    } catch(e){
      console.error('[NewsAgent] Fatal error:', e.message);
    } finally {      this.running = false;
    }
  }
};

// PropertyAgent is merged into TravelAgent — add the location as a trip without dates
// to get ongoing research. This alias keeps old endpoint references working.
const PropertyAgent = {
  running: false,
  async run(userId){ return TravelAgent.run(userId); }
};

// ── Stock Intelligence Agent ───────────────────────────────────────────────────
const StockAgent = {
  async fetchPrice(ticker){
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=5d&interval=1d`;
    return new Promise((resolve) => {
      const req = https.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      }, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            const meta = j.chart?.result?.[0]?.meta;
            const closes = j.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
            const validCloses = closes.filter(Boolean);
            if(!meta || validCloses.length < 2) { resolve(null); return; }
            const prev = validCloses[validCloses.length - 2];
            const curr = validCloses[validCloses.length - 1];
            const changePct = ((curr - prev) / prev * 100).toFixed(2);
            resolve({
              ticker, name: meta.longName || meta.shortName || ticker,
              price: curr.toFixed(2), prev: prev.toFixed(2),
              changePct: parseFloat(changePct),
              currency: meta.currency || 'USD',
              exchange: meta.exchangeName || ''
            });
          } catch(e){ resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    });
  },

  async fetchNews(ticker, companyName){
    // Use Yahoo Finance news endpoint
    const query = encodeURIComponent(`${ticker} ${companyName} stock`);
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${query}&newsCount=5&quotesCount=0`;
    return new Promise((resolve) => {
      const req = https.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      }, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            const news = (j.news || []).slice(0, 5).map(n => ({
              title: n.title,
              publisher: n.publisher,
              time: new Date(n.providerPublishTime * 1000).toLocaleDateString()
            }));
            resolve(news);
          } catch(e){ resolve([]); }
        });
      });
      req.on('error', () => resolve([]));
      req.setTimeout(10000, () => { req.destroy(); resolve([]); });
    });
  },

  async analyzeWithAI(openaiKey, stockData, newsItems){
    if(!openaiKey || !stockData) return null;
    const newsText = newsItems.map(n => `\u2022 ${n.title} (${n.publisher}, ${n.time})`).join('\n');
    const prompt = `Stock: ${stockData.name} (${stockData.ticker})\nPrice: ${stockData.price} ${stockData.currency} (${stockData.changePct > 0 ? '+' : ''}${stockData.changePct}% today)\n\nRecent news:\n${newsText || 'No recent news found'}\n\nIn 2-3 sentences, explain: (1) what drove today's price movement if notable, (2) one key insight from the news that matters for the next 7 days. Be specific and direct. No generic advice.`;

    const body = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3, max_tokens: 200
    });
    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + openaiKey, 'Content-Length': Buffer.byteLength(body) }
      }, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try { resolve(JSON.parse(data).choices[0].message.content.trim()); }
          catch(e){ resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(20000, () => { req.destroy(); resolve(null); });
      req.write(body); req.end();
    });
  }
};

// ── Spotify Token Refresh (backend) ───────────────────────────────────────────
async function refreshSpotifyToken(userId){
  const creds = Store.read('credentials');
  const user = creds[userId] || {};
  if(!user.spotifyRefreshToken || !user.spotifyClientId) return null;
  const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(user.spotifyRefreshToken)}&client_id=${encodeURIComponent(user.spotifyClientId)}`;
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'accounts.spotify.com', path: '/api/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          if(!r.access_token){ resolve(null); return; }
          // Persist new token
          const creds2 = Store.read('credentials');
          if(creds2[userId]){
            creds2[userId].spotifyToken = r.access_token;
            if(r.refresh_token) creds2[userId].spotifyRefreshToken = r.refresh_token;
            Store.write('credentials', creds2);
          }
          console.log(`[Spotify] Token refreshed for ${userId}`);
          resolve(r.access_token);
        } catch(e){ resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

// ── Podcast Intelligence Agent ─────────────────────────────────────────────────
const PodcastAgent = {
  async searchShow(spotifyToken, name){
    const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(name)}&type=show&limit=3&market=US`;
    return new Promise((resolve) => {
      const req = https.get(url, {
        headers: { 'Authorization': 'Bearer ' + spotifyToken }
      }, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            const show = j.shows?.items?.[0];
            resolve(show ? { id: show.id, name: show.name, publisher: show.publisher } : null);
          } catch(e){ resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    });
  },

  async getRecentEpisodes(spotifyToken, showId, limit=5){
    const url = `https://api.spotify.com/v1/shows/${showId}/episodes?limit=${limit}&market=US`;
    return new Promise((resolve) => {
      const req = https.get(url, {
        headers: { 'Authorization': 'Bearer ' + spotifyToken }
      }, res => {
        let data = '';
        res.on('data', d => data += d);        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            const episodes = (j.items || []).map(e => ({
              name: e.name,
              date: e.release_date,
              description: (e.description || '').substring(0, 800),
              duration_min: Math.round((e.duration_ms || 0) / 60000)
            }));
            resolve(episodes);
          } catch(e){ resolve([]); }
        });
      });
      req.on('error', () => resolve([]));
      req.setTimeout(10000, () => { req.destroy(); resolve([]); });
    });
  },

  async extractInsights(openaiKey, showName, episodes){
    if(!openaiKey || !episodes.length) return null;
    const epText = episodes.map((e, i) =>
      `Episode ${i+1}: "${e.name}" (${e.date}, ${e.duration_min} min)\n${e.description}`
    ).join('\n\n');

    const prompt = `You are a sharp investment analyst giving a quick briefing to a busy investor. Analyze these recent podcast episodes from "${showName}" and return ONLY a JSON object.\n\nEpisodes:\n${epText}\n\nReturn this exact JSON structure (no markdown, no extra text):\n{\n  "headline": "One punchy sentence \u2014 the single most important market insight from these episodes",\n  "bullets": [\n    "TICKER/Company: what was said and why it matters to investors",\n    "TICKER/Company: what was said and why it matters to investors",\n    "TICKER/Company: what was said and why it matters to investors"\n  ],\n  "stocks": ["TICK1", "TICK2", "TICK3"],\n  "sentiment": "bullish|bearish|mixed",\n  "recommendation": "ARIA's actionable take: specific thing to watch or do based on this episode (mention tickers, price levels, or catalysts if known)"\n}\n\nRules: max 3 bullets, each under 12 words, plain text only. stocks = ticker symbols only. Return valid JSON, nothing else.`;

    const body = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3, max_tokens: 500,
      response_format: { type: 'json_object' }
    });
    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + openaiKey, 'Content-Length': Buffer.byteLength(body) }
      }, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try {
            const text = JSON.parse(data).choices[0].message.content.trim();
            resolve(JSON.parse(text));
          } catch(e){ resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(25000, () => { req.destroy(); resolve(null); });
      req.write(body); req.end();
    });
  }
};

// ── Master Intelligence Agent ──────────────────────────────────────────────────
const IntelligenceAgent = {
  running: false,

  async run(userId){
    if(this.running){ console.log('[Intelligence] Already running'); return; }
    this.running = true;
    console.log(`[Intelligence] Starting scan for ${userId}`);

    try {
      const creds = Store.read('credentials');
      const user = creds[userId] || {};
      const wl = Store.read('watchlists', {})[userId] || { stocks:[], podcasts:[] };

      if(!wl.stocks.length && !wl.podcasts.length){
        console.log('[Intelligence] No watchlist items, skipping');
        return;
      }

      const cards = [];
      const now = new Date().toISOString();

      // ── Stock Analysis ────────────────────────────────────────────────────
      for(const ticker of wl.stocks){
        try {
          console.log(`[Intelligence] Fetching stock: ${ticker}`);
          const stockData = await StockAgent.fetchPrice(ticker);
          if(!stockData) { console.log(`[Intelligence] No data for ${ticker}`); continue; }

          const news = await StockAgent.fetchNews(ticker, stockData.name);
          const insight = await StockAgent.analyzeWithAI(user.openaiKey, stockData, news);

          const absChange = Math.abs(stockData.changePct);
          const direction = stockData.changePct >= 0 ? '\ud83d\udcc8' : '\ud83d\udcc9';
          const sign = stockData.changePct >= 0 ? '+' : '';

          cards.push({
            id: `stock_${ticker}_${now.slice(0,10)}`,
            type: 'intelligence',
            subtype: 'stock',
            icon: direction,
            ticker,
            name: stockData.name,
            title: `${stockData.name} (${ticker}) ${sign}${stockData.changePct}%`,
            body: insight || `Trading at ${stockData.currency} ${stockData.price} (${sign}${stockData.changePct}% today). ${news[0] ? 'Top news: ' + news[0].title : ''}`,
            price: stockData.price,
            changePct: stockData.changePct,
            currency: stockData.currency,
            news: news.slice(0, 3),
            priority: absChange > 5 ? 85 : absChange > 2 ? 70 : 55,
            ts: now, seen: false
          });

          // Notify for big moves
          if(absChange >= 3){
            notify(`${ticker} ${sign}${stockData.changePct}%`, `${stockData.name} is ${stockData.changePct >= 0 ? 'up' : 'down'} ${absChange}% \u2014 ${news[0]?.title || 'check ARIA for details'}`);
          }

          await new Promise(r => setTimeout(r, 500));
        } catch(e){ console.error(`[Intelligence] Stock error ${ticker}:`, e.message); }
      }

      // ── Podcast Analysis ─────────────────────────────────────────────────
      const spotifyToken = user.spotifyToken;
      if(wl.podcasts.length && spotifyToken){
        for(const podcastName of wl.podcasts){
          try {
            console.log(`[Intelligence] Fetching podcast: ${podcastName}`);
            const show = await PodcastAgent.searchShow(spotifyToken, podcastName);
            if(!show){ console.log(`[Intelligence] Show not found: ${podcastName}`); continue; }

            const episodes = await PodcastAgent.getRecentEpisodes(spotifyToken, show.id, 5);
            if(!episodes.length){ continue; }

            const insight = await PodcastAgent.extractInsights(user.openaiKey, show.name, episodes);
            if(!insight) continue;

            cards.push({
              id: `podcast_${show.id}_${now.slice(0,10)}`,
              type: 'intelligence',
              subtype: 'podcast',
              icon: '\ud83c\udf99\ufe0f',
              showName: show.name,
              publisher: show.publisher,
              title: `${show.name} \u2014 Weekly Intel`,
              body: insight.headline || '',
              bullets: insight.bullets || [],
              stocks: insight.stocks || [],
              sentiment: insight.sentiment || 'neutral',
              recommendation: insight.recommendation || '',
              episodeCount: episodes.length,
              latestEpisode: episodes[0]?.name || '',
              latestDate: episodes[0]?.date || '',
              priority: 72,
              ts: now, seen: false
            });

            notify(`${show.name} \u2014 Intel Ready`, `ARIA extracted market insights from ${episodes.length} recent episodes`);
            await new Promise(r => setTimeout(r, 500));
          } catch(e){ console.error(`[Intelligence] Podcast error ${podcastName}:`, e.message); }
        }
      } else if(wl.podcasts.length && !spotifyToken){
        console.log('[Intelligence] Podcast watchlist exists but no Spotify token');
      }
      // ── Save cards ────────────────────────────────────────────────────────
      if(cards.length){
        const intel = Store.read('intelligence', {});
        const existing = (intel[userId] || []).filter(c => {
          // Keep cards from last 7 days
          return (Date.now() - new Date(c.ts).getTime()) < 7 * 24 * 60 * 60 * 1000;
        });
        // Replace same-day cards for same ticker/show
        const newIds = new Set(cards.map(c => c.id));
        const merged = [...cards, ...existing.filter(c => !newIds.has(c.id))].slice(0, 100);
        intel[userId] = merged;
        Store.write('intelligence', intel);
        console.log(`[Intelligence] Saved ${cards.length} intelligence cards`);
      } else {
        console.log('[Intelligence] No cards generated this run');
      }

    } catch(e){
      console.error('[Intelligence] Fatal error:', e.message);
    } finally {
      this.running = false;
    }
  }
};

// ── Scheduled Agents ──────────────────────────────────────────────────────────
function scheduleAgents(){
  // Check Gmail every 5 minutes
  const INTERVAL_MS = 5 * 60 * 1000;
  setInterval(() => {
    const creds = Store.read('credentials');
    Object.keys(creds).forEach(userId => {
      if(creds[userId].googleToken){
        console.log(`[Scheduler] Triggering 5-min email check for ${userId}`);
        EmailAgent.run(userId);
      }
    });
  }, INTERVAL_MS);

  // Morning digest check at startup (and would repeat if server ran overnight)
  const now = new Date();
  const msUntil8AM = (() => {
    const t = new Date(now); t.setHours(8,0,0,0);
    if(t <= now) t.setDate(t.getDate()+1);
    return t - now;
  })();
  setTimeout(() => {
    console.log('[Scheduler] Morning digest check');
    const creds = Store.read('credentials');
    Object.keys(creds).forEach(userId => { if(creds[userId].googleToken) EmailAgent.run(userId); });
    setInterval(() => {
      const creds2 = Store.read('credentials');
      Object.keys(creds2).forEach(userId => { if(creds2[userId].googleToken) EmailAgent.run(userId); });
    }, 24*60*60*1000);
  }, msUntil8AM);

  console.log(`[Scheduler] Email check every 5 minutes. Morning digest in ${Math.round(msUntil8AM/60000)} minutes.`);

  // Intelligence scan — runs every 6 hours (market open + close + overnight + morning)
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  setInterval(() => {
    const creds2 = Store.read('credentials');
    Object.keys(creds2).forEach(userId => {
      console.log(`[Scheduler] 6-hour intelligence scan for ${userId}`);
      IntelligenceAgent.run(userId);
    });
  }, SIX_HOURS);
  console.log('[Scheduler] Intelligence scan every 6 hours.');

  // News scan — runs every 2 hours (no API key required, free RSS)
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  setInterval(() => {
    const creds2 = Store.read('credentials');
    Object.keys(creds2).forEach(userId => {
      console.log(`[Scheduler] 2-hour news scan for ${userId}`);
      NewsAgent.run(userId);
    });
  }, TWO_HOURS);
  console.log('[Scheduler] News scan every 2 hours.');

  // Property scan — runs daily at 7 AM
  const msUntil7AM = (() => {
    const t = new Date(now); t.setHours(7,0,0,0);
    if(t <= now) t.setDate(t.getDate()+1);
    return t - now;
  })();
  setTimeout(() => {
    const creds = Store.read('credentials');
    Object.keys(creds).forEach(userId => { if(creds[userId].openaiKey) PropertyAgent.run(userId); });
    setInterval(() => {
      const creds2 = Store.read('credentials');
      Object.keys(creds2).forEach(userId => { if(creds2[userId].openaiKey) PropertyAgent.run(userId); });
    }, 24*60*60*1000);
    console.log('[Scheduler] Daily property scan fired at 7 AM');
  }, msUntil7AM);
  console.log(`[Scheduler] Property scan in ${Math.round(msUntil7AM/60000)} minutes (7 AM daily).`);

  // Travel Agent — runs every hour, researches all trips + destinations in watchlist
  const ONE_HOUR = 60 * 60 * 1000;
  setInterval(() => {
    const creds2 = Store.read('credentials');
    Object.keys(creds2).forEach(userId => {
      if(creds2[userId].openaiKey){
        console.log(`[Scheduler] Hourly travel research for ${userId}`);
        TravelAgent.run(userId);
      }
    });
  }, ONE_HOUR);
  console.log('[Scheduler] Travel Agent runs every hour.');
}

// ── Start Server ──────────────────────────────────────────────────────────────
const server = http.createServer(router);
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
  console.log('\u2551         ARIA Agent Backend  v1.0           \u2551');
  console.log('\u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563');
  console.log(`\u2551  API:      http://localhost:${PORT}           \u2551`);
  console.log(`\u2551  Data:     ${DATA_DIR}  \u2551`);
  console.log('\u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563');
  console.log('\u2551  Agents:                                   \u2551');
  console.log('\u2551  \u2713 Email Parser      (every 5 min)         \u2551');
  console.log('\u2551  \u2713 Bill Spike        (after each sync)     \u2551');
  console.log('\u2551  \u2713 Renewal Alerts    (after each sync)     \u2551');
  console.log('\u2551  \u2713 Stock + Podcast   (startup + every 6hr) \u2551');
  console.log('\u2551  \u2713 News Headlines    (startup + every 2hr) \u2551');
  console.log('\u2551  \u2713 Travel Research   (startup + every 1hr) \u2551');
  console.log('\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d\n');

  scheduleAgents();

  // Run initial sync if credentials already exist
  const creds = Store.read('credentials');
  const users = Object.keys(creds).filter(u => creds[u].googleToken);
  if(users.length){
    console.log(`[Startup] Found ${users.length} user(s) with credentials \u2014 running initial sync`);
    setTimeout(() => users.forEach(u => EmailAgent.run(u)), 2000);
    // Run all agents immediately at startup so feed is populated right away
    setTimeout(() => {
      const c2 = Store.read('credentials');
      Object.keys(c2).forEach(u => {
        console.log(`[Startup] Running intelligence scan for ${u}`);
        IntelligenceAgent.run(u);
      });
    }, 8000);
    setTimeout(() => {
      const c3 = Store.read('credentials');
      Object.keys(c3).forEach(u => {
        console.log(`[Startup] Running news scan for ${u}`);
        NewsAgent.run(u);
      });
    }, 12000);
    setTimeout(() => {
      const c4 = Store.read('credentials');
      Object.keys(c4).forEach(u => {
        if(c4[u].openaiKey) {
          console.log(`[Startup] Running travel research for ${u}`);
          TravelAgent.run(u);
        }
      });
    }, 16000);
  } else {
    console.log('[Startup] No credentials yet. Waiting for user to connect Gmail...');
    console.log('[Startup] Open http://localhost:8080/aria-new.html and connect Gmail.\n');
  }
});

server.on('error', e => {
  if(e.code === 'EADDRINUSE') console.error(`\n\u274c Port ${PORT} in use. Kill the other process or change PORT.\n`);
  else console.error('Server error:', e);
});
