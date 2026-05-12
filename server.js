const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const { load } = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
  });
}

function httpPostStream(url, body, onData, onEnd, onError) {
  const data = JSON.stringify(body);
  const u = new URL(url);
  const req = https.request({
    hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
  }, res => { res.on('data', onData); res.on('end', onEnd); res.on('error', onError); });
  req.on('error', onError);
  req.setTimeout(120000, () => req.destroy(new Error('timeout')));
  req.write(data); req.end();
}

function detectLang(text) {
  const s = text.slice(0, 300);
  const zh = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const ja = (s.match(/[\u3040-\u30ff]/g) || []).length;
  if (ja > 5) return 'ja';
  if (zh > 5) return 'zh';
  return 'en';
}

async function scrape(url) {
  const is69 = url.includes('69shuba.com');
  const headers = is69 ? { 'Accept-Language': 'zh-CN,zh;q=0.9', 'Referer': 'https://www.69shuba.com/' } : {};
  const { body } = await httpGet(url, headers);
  const $ = load(body);
  const title = $('h1').first().text().trim() || $('title').text().split('-')[0].trim();
  $('script,style,nav,header,footer,.ad,.ads,#ads,.comment,#comment,.sidebar').remove();
  const sels = is69
    ? ['.txtnav', '.readcontent', '#content']
    : ['#content', '.content', '.chapter-content', '.entry-content', 'article', '.post-content', '.chapter'];
  let content = '';
  for (const sel of sels) {
    const t = $(sel).text().trim();
    if (t.length > 300) { content = t; break; }
  }
  if (!content) content = $('body').text();
  return { title, content: content.replace(/\s{3,}/g, '\n\n').trim().slice(0, 8000) };
}

app.get('/health', (_, res) => res.json({ ok: true }));

app.post('/fetch', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const { title, content } = await scrape(url);
    res.json({ title, content, lang: detectLang(content) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/translate', async (req, res) => {
  const { content, lang, style, glossary, novelName } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  const langNames = { zh: 'จีน', en: 'อังกฤษ', ja: 'ญี่ปุ่น', th: 'ไทย' };
  const styleNames = { literary: 'วรรณกรรม สละสลวย มีอารมณ์', casual: 'ทั่วไป เป็นธรรมชาติ', formal: 'ทางการ สุภาพ' };
  let glossaryBlock = '';
  if (glossary && glossary.length) {
    const catLabel = { char: 'ตัวละคร', place: 'สถานที่', term: 'คำเรียกเฉพาะ', title: 'ยศ/ตำแหน่ง' };
    glossaryBlock = '\n\nคำศัพท์เฉพาะ (บังคับใช้คำเหล่านี้เท่านั้น):\n'
      + glossary.map(e => `- "${e.orig}" = "${e.thai}" [${catLabel[e.cat] || e.cat}]`).join('\n');
  }
  const isRefine = lang === 'th';
  const prompt = isRefine
    ? `เรียบเรียงข้อความภาษาไทยนี้ใหม่ให้ลื่นไหล รักษาความหมายเดิม${glossaryBlock}\n\n${content}\n\nแสดงเฉพาะข้อความที่เรียบเรียงแล้ว:`
    : `คุณคือนักแปลนิยายมืออาชีพชาวไทย${novelName ? ` กำลังแปลเรื่อง "${novelName}"` : ''}
กฎ: อ่านทั้งหมดก่อน วิเคราะห์บริบท แปลสไตล์ ${styleNames[style] || styleNames.literary} ห้ามแปลทีละประโยค เรียบเรียงให้ลื่นไหล${glossaryBlock}
ต้นฉบับ (ภาษา${langNames[lang] || lang}):
---
${content}
---
แสดงเฉพาะคำแปล ไม่ต้องมีคำอธิบาย:`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?key=${GEMINI_API_KEY}&alt=sse`;
  let buffer = '';
  httpPostStream(geminiUrl,
    { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 8192 } },
    chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const d = line.slice(6).trim();
        if (!d || d === '[DONE]') continue;
        try {
          const j = JSON.parse(d);
          const text = j?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) res.write(`data: ${JSON.stringify({ text })}\n\n`);
        } catch (e) {}
      }
    },
    () => { res.write('data: [DONE]\n\n'); res.end(); },
    e => { res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`); res.end(); }
  );
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
