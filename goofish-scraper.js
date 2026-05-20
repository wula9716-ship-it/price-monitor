// 闲鱼爬虫 - 使用 Puppeteer 模拟浏览器
const puppeteer = require('puppeteer-core');

const EDGE_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

async function searchGoofish(keyword, maxItems = 20) {
  const browser = await puppeteer.launch({
    executablePath: EDGE_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--no-first-run', '--disable-extensions'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    const url = `https://www.goofish.com/search?q=${encodeURIComponent(keyword)}`;
    console.log(`[闲鱼] 正在访问: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });

    // 等待商品列表加载
    try {
      await page.waitForSelector('[class*="item"], [class*="card"], [class*="product"]', { timeout: 8000 });
    } catch (e) {
      console.log('[闲鱼] 等待选择器超时，尝试继续提取...');
    }

    // 额外等待，确保数据渲染完
    await new Promise(r => setTimeout(r, 2000));

    // 提取页面内容
    const items = await page.evaluate(() => {
      const results = [];
      
      // 方案1：闲鱼新版页面结构 - 搜索所有可能包含商品信息的元素
      const allElements = document.querySelectorAll('a[href*="/item"], [class*="ItemCard"], [class*="item-card"], [class*="feed-card"], [class*="goods"]');
      
      allElements.forEach(el => {
        try {
          const title = el.querySelector('[class*="title"], [class*="name"], h3, h4')?.textContent?.trim();
          const priceEl = el.querySelector('[class*="price"], [class*="Price"]');
          const priceText = priceEl?.textContent?.replace(/[^\d.]/g, '');
          const price = parseFloat(priceText);
          const link = el.href || el.querySelector('a')?.href;
          const img = el.querySelector('img')?.src;
          
          if (title && price > 0 && link) {
            results.push({
              title: title.substring(0, 100),
              price,
              url: link,
              image: img || '',
              platform: '闲鱼',
            });
          }
        } catch (e) {}
      });

      // 方案2：如果上面没找到，尝试更通用的提取
      if (results.length === 0) {
        const links = document.querySelectorAll('a[href*="goofish.com"]');
        links.forEach(el => {
          const title = el.getAttribute('title') || el.textContent?.trim()?.substring(0, 100);
          const priceMatch = el.textContent?.match(/(\d+\.?\d*)/);
          const price = parseFloat(priceMatch?.[1]);
          const link = el.href;
          
          if (title && price > 0 && price < 100000 && link) {
            results.push({
              title,
              price,
              url: link,
              image: el.querySelector('img')?.src || '',
              platform: '闲鱼',
            });
          }
        });
      }

      // 方案3：从整个页面文本提取价格和标题
      if (results.length === 0) {
        const bodyText = document.body.innerText;
        const pricePattern = /[\s\S]{0,80}?(?:¥|元)\s*(\d+\.?\d*)[\s\S]{0,30}/g;
        let match;
        let count = 0;
        while ((match = pricePattern.exec(bodyText)) && count < 20) {
          const price = parseFloat(match[1]);
          if (price > 10 && price < 100000) {
            results.push({
              title: match[0].trim().substring(0, 100),
              price,
              url: '#',
              image: '',
              platform: '闲鱼',
            });
            count++;
          }
        }
      }

      return results;
    });

    console.log(`[闲鱼] 找到 ${items.length} 件商品`);
    return items.slice(0, maxItems);
  } catch (err) {
    console.log(`[闲鱼] 爬取失败: ${err.message}`);
    return [];
  } finally {
    await browser.close();
  }
}

// 用作独立测试
if (require.main === module) {
  const keyword = process.argv[2] || 'DDR4 16G';
  searchGoofish(keyword).then(items => {
    console.log('\n=== 结果 ===');
    items.forEach((item, i) => {
      console.log(`${i + 1}. ¥${item.price} - ${item.title}`);
    });
    if (items.length === 0) console.log('未找到商品');
    process.exit(0);
  });
}

module.exports = { searchGoofish };
