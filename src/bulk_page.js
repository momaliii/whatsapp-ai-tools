'use strict';

const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const { MessageMedia } = require('whatsapp-web.js');
const { getConfig, setConfig } = require('./config');

function createBulkPage(opts = {}) {
  const getClient = typeof opts.getClient === 'function' ? opts.getClient : () => null;
  const app = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

  app.get('/', (req, res) => res.send(render()));

  // Templates CRUD
  app.post('/templates/save', express.urlencoded({ extended: true }), (req, res) => {
    const cfg = getConfig();
    const list = Array.isArray(cfg.bulkTemplates) ? cfg.bulkTemplates.slice() : [];
    const name = String(req.body.name || '').trim();
    const template = String(req.body.template || '');
    const caption = String(req.body.caption || '');
    if (name) {
      const i = list.findIndex(t => t.name === name);
      if (i >= 0) list[i] = { name, template, caption };
      else list.push({ name, template, caption });
      setConfig({ ...cfg, bulkTemplates: list });
    }
    res.redirect('/bulk');
  });
  app.get('/templates/list', (req, res) => {
    const cfg = getConfig();
    res.json({ templates: Array.isArray(cfg.bulkTemplates) ? cfg.bulkTemplates : [] });
  });

  // Preview/parse recipients + variables
  app.post('/prepare', upload.single('file'), (req, res) => {
    try {
      let rows = [];
      const text = (req.body.numbers || '').trim();
      if (text) {
        // Parse manually entered numbers
        const textRows = text.split(/\n/).map(line => {
          const cols = line.split(/,|\t/).map(s => s.trim()).filter(Boolean);
          return cols;
        }).filter(row => row.length > 0);
        rows = rows.concat(textRows);
      }
      
      if (req.file && req.file.buffer) {
        const name = (req.file.originalname || '').toLowerCase();
        if (name.endsWith('.csv') || name.endsWith('.txt')) {
          // Improved CSV/TXT parsing with proper handling of quoted fields
          const fileText = req.file.buffer.toString('utf8');
          const fileRows = parseCSV(fileText);
          rows = rows.concat(fileRows);
        } else if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
          // Improved Excel parsing
          const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          const excelRows = XLSX.utils.sheet_to_json(sheet, { 
            header: 1, 
            defval: '', // Use empty string for empty cells
            raw: false  // Convert all values to strings
          });
          rows = rows.concat(excelRows);
        }
      }
      
      // Clean and validate rows
      rows = rows.filter(row => row && row.length > 0 && row[0]); // Remove empty rows
      
      const headers = (req.body.headers || '').split(',').map(s => s.trim()).filter(Boolean);
      const recipients = rows.map((cols, index) => {
        const number = String(cols[0] || '').replace(/\D/g, '');
        if (!number) return null;
        
        const vars = buildVars(headers, cols);
        return { number, vars, rowIndex: index + 1 };
      }).filter(r => r && r.number);
      
      res.json({ recipients, totalRows: rows.length, validRecipients: recipients.length });
    } catch (error) {
      console.error('Bulk prepare error:', error);
      res.status(400).json({ error: 'Parse failed: ' + error.message });
    }
  });

  // Start sending
  app.post('/start', upload.single('asset'), async (req, res) => {
    const client = getClient();
    if (!client) return res.status(503).json({ error: 'Client not connected' });
    try {
      const payload = JSON.parse(req.body.payload || '{}');
      const { recipients = [], template = '', minDelaySec = 2, maxDelaySec = 5, randomOrder = false, caption = '' } = payload;
      let media = null;
      if (req.file) {
        const uploadsDir = path.join(__dirname, '..', 'uploads');
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
        const filename = `${Date.now()}_${req.file.originalname.replace(/[^\w\.\-]/g,'_')}`;
        const absPath = path.join(uploadsDir, filename);
        fs.writeFileSync(absPath, req.file.buffer);
        media = MessageMedia.fromFilePath(absPath);
      }
      const jobs = randomOrder ? shuffle(recipients.slice()) : recipients.slice();
      runBulkJob(client, jobs, template, minDelaySec*1000, maxDelaySec*1000, media, caption);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: 'Invalid payload' });
    }
  });

  app.get('/progress', (req, res) => {
    res.json(currentProgress);
  });

  app.get('/report', (req, res) => {
    const view = String(req.query.view || '');
    const report = lastReport || { id: null, rows: [] };
    if (view === '1') {
      const rowsHtml = report.rows.map(r => `<tr><td>${r.id}</td><td>${r.number}</td><td>${r.status}</td></tr>`).join('');
      return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Campaign Report</title><link rel="stylesheet" href="/assets/style.css"/></head><body><div class="container"><h1>Campaign Report #${report.id||'-'}</h1><table class="card"><thead><tr><th>ID</th><th>Number</th><th>Status</th></tr></thead><tbody>${rowsHtml}</tbody></table></div></body></html>`);
    }
    res.json(report);
  });

  app.get('/report/download', (req, res) => {
    const report = lastReport || { id: null, rows: [] };
    const filename = `campaign-${report.id || 'latest'}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(report, null, 2));
  });

  app.post('/control', (req, res) => {
    const action = String(req.body.action||'').toLowerCase();
    if (action==='pause') bulkState.paused = true;
    if (action==='resume') bulkState.paused = false;
    if (action==='stop') bulkState.stopped = true;
    res.json({ ok: true, state: bulkState });
  });

  return app;
}

function buildVars(headers, cols){
  const v = {};
  
  // Map headers to their corresponding columns (starting from column 1, since column 0 is the phone number)
  headers.forEach((h, i) => { 
    v[h] = String(cols[i + 1] || '').trim(); 
  });
  
  // Generic column aliases: VAR1..VAR10 map to columns 1..10 (after phone number)
  for (let i = 1; i <= 10; i++) {
    const value = String(cols[i] || '').trim();
    v['VAR' + i] = value;
    v['var' + i] = value;
  }
  
  // System variables
  v.date = new Date().toLocaleDateString();
  v.time = new Date().toLocaleTimeString();
  v.random = Math.floor(Math.random()*1e6).toString();
  
  return v;
}

// Improved CSV parsing function that handles quoted fields properly
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  const rows = [];
  
  for (const line of lines) {
    const cols = [];
    let current = '';
    let inQuotes = false;
    let i = 0;
    
    while (i < line.length) {
      const char = line[i];
      
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          // Escaped quote
          current += '"';
          i += 2;
        } else {
          // Toggle quote state
          inQuotes = !inQuotes;
          i++;
        }
      } else if (char === ',' && !inQuotes) {
        // End of column
        cols.push(current.trim());
        current = '';
        i++;
      } else {
        current += char;
        i++;
      }
    }
    
    // Add the last column
    cols.push(current.trim());
    rows.push(cols);
  }
  
  return rows;
}

function fillTemplate(tpl, vars){
  if (!tpl) return '';
  
  return String(tpl).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
    const value = vars[key];
    if (value === undefined || value === null) {
      console.warn(`Missing variable: ${key} in template: ${tpl}`);
      return `[MISSING:${key}]`;
    }
    return String(value);
  });
}

let bulkState = { paused: false, stopped: false };
let currentProgress = { total: 0, sent: 0, failed: 0, done: false, reportId: null };
let lastReport = { id: null, rows: [] };

async function runBulkJob(client, recipients, template, minDelayMs, maxDelayMs, media, caption){
  bulkState = { paused: false, stopped: false };
  const reportId = String(Date.now());
  const rows = [];
  const checked = await precheckRecipients(client, recipients);
  currentProgress = { total: checked.length, sent: 0, failed: 0, done: false, reportId };
  for (const r of checked) {
    if (bulkState.stopped) break;
    while (bulkState.paused) await sleep(500);
    if (!r.jid) {
      currentProgress.failed++;
      rows.push({ id: rows.length + 1, number: r.number, status: 'no-whatsapp' });
      continue;
    }
    try {
      const text = fillTemplate(template, r.vars || {});
      const jid = typeof r.jid === 'string' ? r.jid : (r.jid && r.jid._serialized) ? r.jid._serialized : (r.number + '@c.us');
      if (media) {
        await client.sendMessage(jid, media, { caption: fillTemplate(caption, r.vars||{}) || undefined });
        if (text) await client.sendMessage(jid, text);
      } else if (text) {
        await client.sendMessage(jid, text);
      }
      currentProgress.sent++;
      rows.push({ id: rows.length + 1, number: r.number, status: 'sent' });
    } catch (e) {
      currentProgress.failed++;
      rows.push({ id: rows.length + 1, number: r.number, status: 'failed' });
    }
    const delay = minDelayMs + Math.floor(Math.random()*Math.max(1, (maxDelayMs - minDelayMs)));
    await sleep(delay);
  }
  currentProgress.done = true;
  lastReport = { id: reportId, rows };
}

async function precheckRecipients(client, recipients){
  try {
    const unique = Array.from(new Set(recipients.map(r => r.number)));
    const numberToJid = {};
    let index = 0;
    const concurrency = Math.min(8, Math.max(1, unique.length));
    async function worker(){
      while (index < unique.length) {
        const i = index++;
        const num = unique[i];
        try {
          const id = await client.getNumberId(num);
          numberToJid[num] = id && (id._serialized || null);
        } catch {
          numberToJid[num] = null;
        }
      }
    }
    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.all(workers);
    return recipients.map(r => ({ ...r, jid: numberToJid[r.number] || null }));
  } catch {
    return recipients.map(r => ({ ...r, jid: null }));
  }
}

function shuffle(a){ for (let i=a.length-1; i>0; i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]];} return a; }
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

function render(){
  return `<!DOCTYPE html>
  <html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Bulk Send</title><link rel="stylesheet" href="/assets/style.css"/></head>
  <body>
    <button class="btn btn-ghost menu-fab" id="openMenu" type="button" title="Menu">☰</button>
    <div class="layout">
      ${require('./ui').renderNav('bulk')}
      <main class="main"><div class="container">
        <h1>Bulk Send</h1>
        <div class="card">
          <form id="prepForm" method="post" action="/bulk/prepare" enctype="multipart/form-data">
            <label>Template (supports {{name}}, {{date}}, {{time}}, {{random}})</label>
            <textarea name="template" rows="4" placeholder="Hello {{name}}, today is {{date}} at {{time}}."></textarea>
            <div class="row">
              <div><label>Saved Templates</label><select id="tplPicker"><option value="">-- Select --</option></select></div>
              <div><label>Save as</label><input id="tplName" placeholder="Welcome"/></div>
              <div style="align-self:flex-end"><button class="btn btn-outline" type="button" id="saveTplBtn">Save</button></div>
            </div>
            <div class="row">
              <div><label>Numbers (first column is number; next columns match headers)</label><textarea name="numbers" rows="4" placeholder="+14155551234,John\n+20123456789,Ali"></textarea></div>
              <div><label>Upload file (CSV/XLSX/TXT)</label><input type="file" name="file"/></div>
            </div>
            <label>Headers for variables (comma separated, e.g. name,orderId)</label>
            <input name="headers" placeholder="name,orderId"/>
            <button class="btn mt-8" type="submit">Prepare</button>
          </form>
          
          <div class="card mt-8" style="background: #f8f9fa; border-left: 4px solid #007bff;">
            <h3 style="margin-top: 0; color: #007bff;">📋 Data Format Guide</h3>
            <p><strong>File Format:</strong> CSV, XLSX, or TXT files with comma or tab separation</p>
            <p><strong>Column Structure:</strong></p>
            <ul>
              <li><strong>Column 1:</strong> Phone number (required)</li>
              <li><strong>Column 2+:</strong> Variables that match your headers</li>
            </ul>
            <p><strong>Example CSV:</strong></p>
            <pre style="background: white; padding: 8px; border-radius: 4px; font-size: 12px;">+1234567890,John Doe,Order123,Product A,Category 1,Price 100
+9876543210,Jane Smith,Order456,Product B,Category 2,Price 200</pre>
            <p><strong>Headers:</strong> <code>name,orderId,product,category,price</code> (comma-separated, no spaces)</p>
            <p><strong>Template:</strong> <code>Hello {{name}}, your order {{orderId}} for {{product}} ({{category}}) at {{price}} is ready!</code></p>
            <p><strong>Generic Variables:</strong> You can also use <code>{{VAR1}}</code> through <code>{{VAR10}}</code> to access columns 1-10 directly</p>
          </div>
        </div>
        <div class="card mt-8" id="debugSection" style="display: none;">
          <h3>🔍 Debug Information</h3>
          <div id="debugContent"></div>
        </div>
        
        <div class="card mt-16">
          <h2>Send</h2>
          <form id="sendForm" method="post" action="/bulk/start" enctype="multipart/form-data">
            <label>Attachment (optional)</label>
            <input type="file" name="asset" accept="image/*,audio/*,video/*,application/pdf,application/zip"/>
            <label>Caption (for image/video/file)</label>
            <input name="caption" placeholder="{{name}}, your report"/>
            <div class="row">
              <div><label>Min delay (sec)</label><input name="minDelaySec" value="2"/></div>
              <div><label>Max delay (sec)</label><input name="maxDelaySec" value="5"/></div>
              <div><label>Random order</label><select name="randomOrder"><option value="false">No</option><option value="true">Yes</option></select></div>
            </div>
            <input type="hidden" name="payload" id="payloadField"/>
            <div class="row"><button class="btn" type="submit" id="startBtn">Start</button>
              <button class="btn btn-outline" type="button" id="pauseBtn">Pause</button>
              <button class="btn btn-outline" type="button" id="resumeBtn">Resume</button>
              <button class="btn btn-outline" type="button" id="stopBtn">Stop</button>
            </div>
          </form>
          <table class="card mt-8" id="progressTable"><thead><tr><th>Total</th><th>Sent</th><th>Failed</th><th class="hidden" id="reportHead"></th></tr></thead><tbody><tr><td id="tTotal">0</td><td id="tSent">0</td><td id="tFailed">0</td><td id="reportCell" class="hidden"></td></tr></tbody></table>
          <div class="row mt-8 hidden" id="reportActions">
            <a class="btn btn-outline" href="/bulk/report?view=1" target="_blank">View report</a>
            <a class="btn" href="/bulk/report/download">Download JSON</a>
          </div>
        </div>
      </div></main>
    </div>
    <script>
      (function(){
        const root=document.documentElement; const saved=localStorage.getItem('theme'); if(saved==='dark') root.setAttribute('data-theme','dark');
        document.getElementById('toggleTheme')?.addEventListener('click',()=>{const d=root.getAttribute('data-theme')==='dark'; if(d){root.removeAttribute('data-theme'); localStorage.setItem('theme','light');} else {root.setAttribute('data-theme','dark'); localStorage.setItem('theme','dark');}});
        document.getElementById('openMenu')?.addEventListener('click',()=>document.body.classList.toggle('sidebar-open'))
        let recipients=[];
        const prepForm=document.getElementById('prepForm'); const sendForm=document.getElementById('sendForm');
        const payloadField=document.getElementById('payloadField');
        const prog=document.getElementById('prog'); const fail=document.getElementById('fail');
        prepForm.addEventListener('submit', async (e)=>{
          e.preventDefault();
          try {
            const fd=new FormData(prepForm);
            const res=await fetch('/bulk/prepare',{method:'POST',body:fd});
            const data=await res.json();
            
            if (data.error) {
              alert('Error: ' + data.error);
              return;
            }
            
            recipients=(data.recipients||[]).map(r=>({ ...r, number: String(r.number||'').replace(/\\D/g,'') }));
            
            // Show detailed feedback
            const message = 'Prepared ' + recipients.length + ' recipients from ' + data.totalRows + ' total rows.\\n\\n' +
                          'Valid recipients: ' + data.validRecipients + '\\n' +
                          'Invalid rows: ' + (data.totalRows - data.validRecipients);
            
            if (recipients.length > 0) {
              // Show preview of first recipient
              const first = recipients[0];
              const preview = '\\n\\nPreview of first recipient:\\nPhone: ' + first.number + '\\nVariables: ' + JSON.stringify(first.vars, null, 2);
              alert(message + preview);
              
              // Show debug section
              const debugSection = document.getElementById('debugSection');
              const debugContent = document.getElementById('debugContent');
              if (debugSection && debugContent) {
                debugSection.style.display = 'block';
                debugContent.innerHTML = '<p><strong>Available Variables:</strong></p>' +
                  '<ul>' + Object.keys(first.vars).map(k => '<li><code>{{' + k + '}}</code> = "' + first.vars[k] + '"</li>').join('') + '</ul>' +
                  '<p><strong>Sample Message:</strong></p>' +
                  '<pre style="background: #f5f5f5; padding: 8px; border-radius: 4px;">' + 
                  document.querySelector('[name=template]').value.replace(/\\{\\{\\s*(\\w+)\\s*\\}\\}/g, function(match, key) {
                    return first.vars[key] || '[MISSING:' + key + ']';
                  }) + '</pre>';
              }
            } else {
              alert(message + '\\n\\nNo valid recipients found. Please check your data format.');
            }
          } catch (error) {
            console.error('Prepare error:', error);
            alert('Failed to prepare recipients: ' + error.message);
          }
        });
        sendForm.addEventListener('submit', async (e)=>{
          e.preventDefault();
          try {
            if (!recipients.length) { alert('Please click Prepare first to load recipients.'); return; }
            const tpl = sendForm.querySelector('[name=template]')?.value || document.querySelector('[name=template]')?.value || '';
            const minDelaySec = parseInt(sendForm.minDelaySec?.value || '2', 10);
            const maxDelaySec = parseInt(sendForm.maxDelaySec?.value || '5', 10);
            const randomOrder = sendForm.randomOrder?.value === 'true';
            const caption = sendForm.caption?.value || '';
            payloadField.value = JSON.stringify({ recipients, template: tpl, minDelaySec, maxDelaySec, randomOrder, caption });
            const fd=new FormData(sendForm);
            const res=await fetch('/bulk/start',{method:'POST',body:fd});
            const ok=await res.json();
            if (!ok || !ok.ok) alert('Failed to start');
          } catch(err) {
            console.error(err);
            alert('Failed to start');
          }
        });
        async function refresh(){
          const s=await fetch('/bulk/progress').then(r=>r.json());
          document.getElementById('tTotal').textContent=s.total;
          document.getElementById('tSent').textContent=s.sent;
          document.getElementById('tFailed').textContent=s.failed;
          if (s && s.done) {
            const head=document.getElementById('reportHead'); const cell=document.getElementById('reportCell'); const actions=document.getElementById('reportActions');
            if (head && cell) {
              head.classList.remove('hidden'); cell.classList.remove('hidden');
              head.textContent='Report';
              cell.innerHTML = '<a class="btn btn-outline" href="/bulk/report?view=1" target="_blank">View</a> <a class="btn" href="/bulk/report/download">Download JSON</a>';
            }
            if (actions) actions.classList.remove('hidden');
          }
        }
        setInterval(refresh, 2000); refresh();
        document.getElementById('pauseBtn').onclick=()=>fetch('/bulk/control',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'action=pause'});
        document.getElementById('resumeBtn').onclick=()=>fetch('/bulk/control',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'action=resume'});
        document.getElementById('stopBtn').onclick=()=>fetch('/bulk/control',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'action=stop'});

        // Load templates
        (async function loadTpl(){
          const data = await fetch('/bulk/templates/list').then(r=>r.json()).catch(()=>({templates:[]}));
          const sel=document.getElementById('tplPicker');
          data.templates.forEach(t=>{ const o=document.createElement('option'); o.value=t.name; o.textContent=t.name; sel.appendChild(o); });
          sel.onchange=()=>{
            const t=data.templates.find(x=>x.name===sel.value);
            if (t){ document.querySelector('[name=template]').value=t.template||''; document.querySelector('[name=caption]').value=t.caption||''; }
          };
          document.getElementById('saveTplBtn').onclick=async()=>{
            const name=document.getElementById('tplName').value.trim();
            const template=document.querySelector('[name=template]').value;
            const caption=document.querySelector('[name=caption]').value;
            if (!name) return alert('Enter a name');
            const fd=new URLSearchParams(); fd.set('name',name); fd.set('template',template); fd.set('caption',caption);
            await fetch('/bulk/templates/save',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:fd});
            location.reload();
          };
        })();
      })();
    </script>
  </body></html>`;
}

module.exports = { createBulkPage };


