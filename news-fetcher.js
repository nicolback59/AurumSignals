'use strict';

// Google News RSS feeds — geopolitical, macro, MNQ, MGC
const FEEDS = [
  {
    url: 'https://news.google.com/rss/search?q=geopolitical+risk+US+economy+markets&hl=en-US&gl=US&ceid=US:en',
    category: 'GEOPOLITICAL',
  },
  {
    url: 'https://news.google.com/rss/search?q=federal+reserve+interest+rates+inflation+economy&hl=en-US&gl=US&ceid=US:en',
    category: 'MACRO',
  },
  {
    url: 'https://news.google.com/rss/search?q=nasdaq+futures+NQ+technology+stocks&hl=en-US&gl=US&ceid=US:en',
    category: 'MNQ',
  },
  {
    url: 'https://news.google.com/rss/search?q=gold+futures+GC+precious+metals&hl=en-US&gl=US&ceid=US:en',
    category: 'MGC',
  },
];

function extractTag(block, tag) {
  const cdataRe = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i');
  const plainRe = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = cdataRe.exec(block) || plainRe.exec(block);
  return m ? m[1].trim() : '';
}

function parseRSS(xml, category) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block   = m[1];
    const title   = extractTag(block, 'title');
    const pubDate = extractTag(block, 'pubDate');
    const source  = extractTag(block, 'source') || 'Google News';
    const desc    = extractTag(block, 'description')
      .replace(/<[^>]+>/g, '')   // strip HTML tags from description
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .trim()
      .slice(0, 300);
    // Google News wraps actual article URL in a redirect — use as-is
    const link = extractTag(block, 'link') || '';
    if (title && title.length > 5) {
      items.push({ category, title, source, link, summary: desc, pubDate });
    }
  }
  return items;
}

async function fetchFeed(feedDef) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(feedDef.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 NQ-Signal-Pro/3.0' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    return parseRSS(xml, feedDef.category);
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function fetchAllNews() {
  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  const items = [];
  for (const r of results) {
    if (r.status === 'fulfilled') items.push(...r.value);
    // failed feeds are silently skipped — network may be restricted
  }
  return items;
}

module.exports = { fetchAllNews };
