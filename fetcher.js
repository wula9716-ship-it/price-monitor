/**
 * 硬件价格数据抓取器
 * 数据源：知乎行情文 + 什么值得买 + 中关村在线
 */

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'prices.json');
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6小时缓存

// 确保缓存目录存在
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/**
 * 从知乎专栏抓取显卡行情文章
 */
async function fetchZhihuPrices() {
  const results = [];

  try {
    // 抓取最新的显卡行情文章列表
    const listRes = await axios.get('https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.zhihu.com/',
      },
      timeout: 10000,
    }).catch(() => null);

    // 备用：直接抓取已知的行情文章URL
    const articleUrls = [
      'https://zhuanlan.zhihu.com/p/2038387836332806327', // 5月显卡行情
      'https://zhuanlan.zhihu.com/p/1893674816814416486', // 4月闲鱼显卡价格
    ];

    for (const url of articleUrls) {
      try {
        const res = await axios.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Cookie': '_zap=1',
          },
          timeout: 10000,
        });

        const $ = cheerio.load(res.data);
        const content = $('article, .Post-RichText, .RichText').text() || $('body').text();

        // 提取显卡价格
        const gpuPatterns = [
          /RTX\s*5090[^：:]*?[¥￥]?\s*(\d{4,5})/gi,
          /RTX\s*5080[^：:]*?[¥￥]?\s*(\d{4,5})/gi,
          /RTX\s*5070\s*Ti[^：:]*?[¥￥]?\s*(\d{4,5})/gi,
          /RTX\s*5070[^：:]*?[¥￥]?\s*(\d{4,5})/gi,
          /RTX\s*5060\s*Ti\s*16[Gg][^：:]*?[¥￥]?\s*(\d{4,5})/gi,
          /RTX\s*5060\s*Ti[^：:]*?[¥￥]?\s*(\d{4,5})/gi,
          /RTX\s*5060[^：:]*?[¥￥]?\s*(\d{4,5})/gi,
          /RTX\s*4090[^：:]*?[¥￥]?\s*(\d{4,5})/gi,
          /RTX\s*4070\s*Ti[^：:]*?[¥￥]?\s*(\d{4,5})/gi,
          /RTX\s*4070[^：:]*?[¥￥]?\s*(\d{4,5})/gi,
          /RTX\s*4060\s*Ti[^：:]*?[¥￥]?\s*(\d{4,5})/gi,
          /RTX\s*4060[^：:]*?[¥￥]?\s*(\d{4,5})/gi,
          /RX\s*9070\s*XT[^：:]*?[¥￥]?\s*(\d{4,5})/gi,
          /RX\s*9070[^：:]*?[¥￥]?\s*(\d{4,5})/gi,
          /RX\s*9060\s*XT[^：:]*?[¥￥]?\s*(\d{4,5})/gi,
        ];

        for (const pattern of gpuPatterns) {
          let match;
          while ((match = pattern.exec(content)) !== null) {
            const product = match[0].split(/[¥￥]/)[0].trim();
            const price = parseInt(match[1]);
            if (price > 500 && price < 50000) {
              results.push({
                product: product.replace(/\s+/g, ' '),
                price,
                source: '知乎',
                url,
                date: new Date().toISOString(),
              });
            }
          }
        }

        console.log(`[知乎] 从 ${url} 提取到 ${results.length} 条数据`);
      } catch (err) {
        console.log(`[知乎] 文章抓取失败: ${err.message}`);
      }
    }
  } catch (err) {
    console.log('[知乎] 抓取失败:', err.message);
  }

  return results;
}

/**
 * 从什么值得买抓取硬件价格
 */
async function fetchSMZDMPrices() {
  const results = [];

  try {
    const res = await axios.get('https://search.smzdm.com/?c=faxian&s=RTX+5060&order=time', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 10000,
    });

    const $ = cheerio.load(res.data);
    const articles = [];

    $('a.feed-block-title, h5.feed-block-title a, .z-feed-title a').each((i, el) => {
      const href = $(el).attr('href');
      const title = $(el).text().trim();
      if (href && title && title.length > 5) {
        articles.push({ title, url: href });
      }
    });

    console.log(`[SMZDM] 找到 ${articles.length} 篇文章`);

    // 抓取前2篇
    for (const article of articles.slice(0, 2)) {
      try {
        const artRes = await axios.get(article.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          timeout: 10000,
        });

        const art$ = cheerio.load(artRes.data);
        const content = art$('.post-content, .article-content, .single-right-content').text();

        // 提取价格
        const pricePattern = /(\w[\w\s]*?(?:RTX|RX|DDR|CPU|SSD)[\w\s]*?)[：:]\s*[¥￥]?\s*(\d{4,5})/gi;
        let match;
        while ((match = pricePattern.exec(content)) !== null) {
          results.push({
            product: match[1].trim(),
            price: parseInt(match[2]),
            source: '什么值得买',
            article: article.title,
            date: new Date().toISOString(),
          });
        }
      } catch (err) {}
    }

    console.log(`[SMZDM] 提取到 ${results.length} 条数据`);
  } catch (err) {
    console.log('[SMZDM] 抓取失败:', err.message);
  }

  return results;
}

/**
 * 合并多个来源的价格数据，取中位数
 */
function mergePrices(allData) {
  const merged = {};

  for (const item of allData) {
    // 标准化产品名
    const key = item.product
      .replace(/\s+/g, ' ')
      .replace(/(8G|16G|16GB|8GB)/gi, '')
      .trim()
      .toUpperCase();

    if (!merged[key]) {
      merged[key] = { prices: [], sources: [] };
    }
    merged[key].prices.push(item.price);
    merged[key].sources.push(item.source);
  }

  const result = {};
  for (const [key, data] of Object.entries(merged)) {
    const sorted = data.prices.sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
      : sorted[mid];

    result[key] = {
      medianPrice: median,
      minPrice: sorted[0],
      maxPrice: sorted[sorted.length - 1],
      samples: sorted.length,
      sources: [...new Set(data.sources)],
    };
  }

  return result;
}

/**
 * 主函数
 */
async function fetchAll() {
  console.log('开始抓取硬件价格数据...\n');

  const [zhihuData, smzdmData] = await Promise.all([
    fetchZhihuPrices(),
    fetchSMZDMPrices(),
  ]);

  const allData = [...zhihuData, ...smzdmData];
  console.log(`\n共获取 ${allData.length} 条原始数据`);

  const merged = mergePrices(allData);

  const result = {
    fetchTime: new Date().toISOString(),
    rawCount: allData.length,
    merged: Object.keys(merged).length,
    prices: merged,
    raw: allData,
  };

  fs.writeFileSync(CACHE_FILE, JSON.stringify(result, null, 2));
  console.log(`数据已缓存到 ${CACHE_FILE}`);

  // 打印汇总
  console.log('\n=== 价格汇总 ===');
  for (const [product, info] of Object.entries(merged)) {
    console.log(`${product}: ¥${info.medianPrice} (${info.samples}条数据, 来源: ${info.sources.join(',')})`);
  }

  return result;
}

function getCached() {
  if (fs.existsSync(CACHE_FILE)) {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const age = Date.now() - new Date(data.fetchTime).getTime();
    if (age < CACHE_TTL) {
      console.log(`使用缓存数据（${Math.round(age / 60000)}分钟前）`);
      return data;
    }
  }
  return null;
}

if (require.main === module) {
  fetchAll().then(() => console.log('\n完成！')).catch(console.error);
}

module.exports = { fetchAll, getCached };
