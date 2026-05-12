const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = () =>
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?key=${GEMINI_API_KEY}&alt=sse`;

function detectLang(text) {
  const sample = text.slice(0, 200);
  const zh = (sample.match(/[\u4e00-\u9fff]/g) || []).length;
  const ja = (sample.match(/[\u3040-\u30ff]/g) || []).length;
  if (ja > 5) return 'ja';
  if (zh > 5) return 'zh';
  return 'en';
}

async function scrape69shuba(url) {
  const res = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Referer': 'https://www.69shuba.com/'
    }
  });
  const $ = cheerio.load(res.data);
  const title = $('h1').first().text().trim() || $('title').text().split('-')[0].trim();
  let content = $('.txtnav').text() || $('.readcontent').text() || $('#content').text();
  if (!content) {
    $('script, style, nav, header, footer, .ad, .ads, #ads').remove();
    content = $('body').text();
  }
  content = content.replace(/\s{3,}/g, '\n\n').trim();
  return { title, content };
}

async function scrapeGeneric(url) {
  const res = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml',
    }
  });
  const $ = cheerio.load(res.data);
  $('script, style, nav, header, footer, .ad, .ads, #ads, .comment, #comment, .sidebar').remove();
  const title = $('h1').first().text().trim() || $('title').text().trim();
  const selectors = ['#content','.content','.chapter-content','.text-left','.entry-content','article','.post-content','.chapter','.readcontent','.txtnav'];
  let content = '';
  for (const sel of selectors) {
    const t = $(sel).text().trim();
    if (t.length > 300) { content = t; break; }
  }
  if (!content) content = $('body').text();
  content = content.replace(/\s{3,}/g, '\n\n').trim();
  return { title, content };
}

app.get('/health', (_, res) => res.json({ ok: true }));

app.post('/fetch', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const result = url.includes('69shuba.com')
      ? await scrape69shuba(url)
      : await scrapeGeneric(url);
    const lang = detectLang(result.content);
    const content = result.content.slice(0, 8000);
    res.json({ title: result.title, content, lang });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/translate', async (req, res) => {
  const { content, lang, style, glossary, novelName } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });

  const langNames = { zh:'จีน', en:'อังกฤษ', ja:'ญี่ปุ่น', th:'ไทย' };
  const styleNames = {
    literary: 'วรรณกรรม สละสลวย มีอารมณ์ รักษาบรรยากาศต้นฉบับ',
    casual: 'ทั่วไป เป็นธรรมชาติ อ่านสนุก',
    formal: 'ทางการ สุภาพ เรียบร้อย'
  };

  let glossaryBlock = '';
  if (glossary && glossary.length) {
    const catLabel = { char:'ตัวละคร', place:'สถานที่', term:'คำเรียกเฉพาะ', title:'ยศ/ตำแหน่ง' };
    const lines = glossary.map(e => `- "${e.orig}" = "${e.thai}" [${catLabel[e.cat]||e.cat}]`).join('\n');
    glossaryBlock = `\n\nคำศัพท์เฉพาะของเรื่อง (บังคับใช้คำเหล่านี้เท่านั้น ห้ามทับศัพท์แทน):\n${lines}`;
  }

  const isRefine = lang === 'th';
  const prompt = isRefine
    ? `เรียบเรียงข้อความภาษาไทยนี้ใหม่ให้ลื่นไหล อ่านง่าย เป็นธรรมชาติมากขึ้น รักษาความหมายเดิมทุกอย่าง${glossaryBlock}\n\nข้อความ:\n${content}\n\nแสดงเฉพาะข้อความที่เรียบเรียงแล้ว ไม่ต้องมีคำอธิบาย:`
    : `คุณคือนักแปลนิยายมืออาชีพชาวไทย${novelName?` กำลังแปลเรื่อง "${novelName}"`:''}

กฎที่ต้องทำตามอย่างเคร่งครัด:
1. อ่านข้อความทั้งหมดก่อน วิเคราะห์บริบท อารมณ์ ตัวละคร และความสัมพันธ์
2. แปลเป็นภาษาไทยสไตล์: ${styleNames[style]||styleNames.literary}
3. ห้ามแปลทีละประโยคแบบตรงตัว — เรียบเรียงใหม่ให้ลื่นไหลเป็นธรรมชาติ
4. รักษาอารมณ์ บรรยากาศ และลีลาของต้นฉบับ
5. ใช้คำไทยที่เหมาะสมกับบริบท ไม่ทับศัพท์โดยไม่จำเป็น${glossaryBlock}

ข้อความต้นฉบับ (ภาษา${langNames[lang]||lang}):
---
${content}
---

แสดงเฉพาะคำแปลที่เรียบเรียงแล้ว ไม่ต้องมีคำอธิบายหรือคำนำ:`;

  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const geminiRes = await axios.post(GEMINI_URL(), {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 8192 }
    }, { responseType: 'stream', timeout: 120000 });

    let buffer = '';
    geminiRes.data.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const text = j?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) res.write(`data: ${JSON.stringify({ text })}\n\n`);
        } catch(e) {}
      }
    });

    geminiRes.data.on('end', () => { res.write('data: [DONE]\n\n'); res.end(); });
    geminiRes.data.on('error', e => { res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`); res.end(); });

  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
    res.end();
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
