const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { fetchAll: fetchLivePrices, getCached: getCachedPrices } = require('./fetcher');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 内存缓存
const cache = new Map();
const priceHistory = new Map(); // 关键词 -> [{time, avgPrice, minPrice, maxPrice, count}]

// 用户提报存储（内存，后续可换数据库）
const userReports = new Map(); // keyword -> [{price, platform, reporter, timestamp}]

// 实时价格缓存
let livePrices = null;
let lastFetchTime = 0;
const FETCH_INTERVAL = 6 * 60 * 60 * 1000; // 6小时刷新一次

/**
 * 获取实时价格数据（带缓存）
 */
async function getLivePrices() {
  const now = Date.now();

  // 先检查内存缓存
  if (livePrices && (now - lastFetchTime) < FETCH_INTERVAL) {
    return livePrices;
  }

  // 尝试读取文件缓存
  const cached = getCachedPrices();
  if (cached) {
    livePrices = cached;
    lastFetchTime = new Date(cached.fetchTime).getTime();
    return cached;
  }

  // 重新抓取
  try {
    console.log('[价格抓取] 开始抓取实时数据...');
    livePrices = await fetchLivePrices();
    lastFetchTime = Date.now();
    console.log(`[价格抓取] 完成，获取 ${livePrices.merged} 条数据`);
    return livePrices;
  } catch (err) {
    console.log('[价格抓取] 失败:', err.message);
    return null;
  }
}

// 启动时预加载
getLivePrices();

// ===== 转转采集模块（稳定，无需签名）=====
async function searchZhuanzhuan(keyword) {
  const results = [];

  try {
    // 转转搜索接口
    const searchUrl = 'https://app.zhuanzhuan.com/zz/transfer/search.json';
    const params = {
      q: keyword,
      pageNo: 1,
      pageSize: 20,
      sortType: 0,
    };

    const response = await axios.get(searchUrl, {
      params,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 ZhuanZhuanApp/11.10.0',
        'Referer': 'https://2.zhuanzhuan.com/',
      },
      timeout: 8000,
    });

    const items = response.data?.data?.list || response.data?.data?.itemList || [];
    for (const item of items) {
      const info = item.itemInfo || item;
      const price = parseFloat(info.price || info.nowPrice || info.soldPrice || 0);
      const itemId = info.itemId || info.id || info.goodsId || '';
      if (price > 0 && itemId) {
        results.push({
          id: 'zz_' + itemId,
          title: info.title || info.name || '',
          price,
          originalPrice: parseFloat(info.oldPrice || info.originalPrice || price * 1.3),
          url: `https://2.zhuanzhuan.com/item/${itemId}.html`,
          image: (info.imgUrl || info.thumbUrl || info.imageUrl || '').replace('//', 'https://'),
          location: (info.areaName || info.cityName || info.region || '').replace(/\|/g, ' '),
          quality: info.qualityDesc || info.newDegree || '',
          platform: '转转',
          browseCount: parseInt(info.browseCount || info.viewCount || 0),
          timestamp: Date.now(),
        });
      }
    }
  } catch (err) {
    console.log('转转搜索失败:', err.message);
  }

  return results;
}

// ===== 闲鱼 mtop 接口（需签名）=====
let xianyuToken = '';
let xianyuTokenTime = 0;

async function getXianyuToken() {
  // 每30分钟刷新一次token
  if (xianyuToken && Date.now() - xianyuTokenTime < 30 * 60 * 1000) {
    return xianyuToken;
  }

  try {
    const response = await axios.get('https://h5api.m.taobao.com/h5/mtop.taobao.idlefish.search.api/1.0/', {
      params: { jsv: '2.7.2', appKey: '12574478' },
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
        'Referer': 'https://www.goofish.com/',
      },
      timeout: 5000,
    });

    const setCookie = response.headers['set-cookie'] || [];
    for (const cookie of setCookie) {
      const match = cookie.match(/_m_h5_tk=([^;]+)/);
      if (match) {
        xianyuToken = match[1].split('_')[0];
        xianyuTokenTime = Date.now();
        return xianyuToken;
      }
    }
  } catch (err) {
    console.log('获取闲鱼token失败:', err.message);
  }

  return '';
}

function generateSign(token, timestamp, appKey, data) {
  const str = `${token}&${timestamp}&${appKey}&${data}`;
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

async function searchXianyuMtop(keyword) {
  const results = [];

  try {
    const appKey = '12574478';
    const token = await getXianyuToken();
    const timestamp = Date.now();
    const data = JSON.stringify({
      keyword: keyword,
      sortField: 0,
      priceLow: 0,
      priceHigh: 0,
      page: 1,
      rows: 20,
    });

    const sign = generateSign(token, timestamp.toString(), appKey, data);

    const response = await axios.get('https://h5api.m.taobao.com/h5/mtop.taobao.idlefish.search.api/1.0/', {
      params: {
        jsv: '2.7.2',
        appKey,
        t: timestamp,
        sign,
        api: 'mtop.taobao.idlefish.search.api',
        v: '1.0',
        type: 'jsonp',
        dataType: 'jsonp',
        timeout: 10000,
        data,
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
        'Referer': 'https://www.goofish.com/',
      },
      timeout: 10000,
    });

    // 尝试解析JSONP响应
    let jsonData = response.data;
    if (typeof jsonData === 'string') {
      const match = jsonData.match(/\((\{[\s\S]*\})\)/);
      if (match) jsonData = JSON.parse(match[1]);
    }

    const items = jsonData?.data?.resultList || [];
    for (const item of items) {
      const info = item.data || item;
      const price = parseFloat(info.price || info.soldPrice || 0);
      if (price > 0) {
        results.push({
          id: 'xy_' + (info.itemId || info.id || Date.now()),
          title: info.title || info.desc || '',
          price,
          originalPrice: parseFloat(info.originalPrice || price * 1.3),
          url: `https://www.goofish.com/item/${info.itemId || info.id}`,
          image: (info.picUrl || info.mainPic || '').replace('//', 'https://'),
          location: info.area || info.city || '',
          platform: '闲鱼',
          wantCount: parseInt(info.wantCount || info.collectCount || 0),
          timestamp: Date.now(),
        });
      }
    }
  } catch (err) {
    console.log('闲鱼mtop搜索失败:', err.message);
  }

  return results;
}

// 闲鱼搜索 - 使用公开的搜索接口
async function searchXianyu(keyword, page = 1) {
  const results = [];
  
  try {
    // 闲鱼移动端搜索接口（无需登录的公开搜索）
    const url = `https://s.taobao.com/search`;
    const params = {
      q: keyword,
      imgfile: '',
      js: 1,
      stats_click: 'search_radio_all:1',
      initiative_id: 'staobaoz_' + Date.now(),
      ie: 'utf8',
      bcoffset: 0,
      ntoffset: 0,
      p4ppushleft: '1,48',
      s: (page - 1) * 44,
    };

    const headers = {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 AliApp(TB/9.6.3)',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Referer': 'https://s.taobao.com/',
    };

    const response = await axios.get(url, {
      params,
      headers,
      timeout: 8000,
    });

    // 尝试解析返回的JSON数据
    const html = response.data;
    const match = html.match(/g_page_config\s*=\s*(\{[\s\S]*?\});\s*(?:g_srp_cache|window)/);
    if (match) {
      const pageConfig = JSON.parse(match[1]);
      const itemList = pageConfig?.mods?.itemlist?.data?.auctions || [];
      
      for (const item of itemList.slice(0, 20)) {
        const price = parseFloat(item.view_price || item.price || 0);
        if (price > 0) {
          results.push({
            id: item.nid || item.item_id,
            title: item.raw_title || item.title || '',
            price: price,
            originalPrice: parseFloat(item.reserve_price || price),
            url: `https://item.taobao.com/item.htm?id=${item.nid}`,
            image: item.pic_url ? ('https:' + item.pic_url) : '',
            location: item.item_loc || '',
            salesCount: parseInt(item.view_sales || 0),
            platform: '淘宝',
            timestamp: Date.now(),
          });
        }
      }
    }
  } catch (err) {
    console.log('淘宝搜索失败，使用备用方案:', err.message);
  }
  
  return results;
}

// 闲鱼H5搜索（备用方案）
async function searchXianyuH5(keyword) {
  const results = [];
  
  try {
    const url = 'https://h5api.m.taobao.com/h5/mtop.taobao.idlefish.search.api/1.0/';
    const data = {
      data: JSON.stringify({
        keyword: keyword,
        sortField: 0,
        priceLow: 0,
        priceHigh: 0,
        page: 1,
        rows: 20,
      })
    };
    
    const response = await axios.post(url, data, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://www.goofish.com/',
      },
      timeout: 8000,
    });
    
    const items = response.data?.data?.items || [];
    for (const item of items) {
      const info = item.data || item;
      const price = parseFloat(info.price || info.soldPrice || 0);
      if (price > 0) {
        results.push({
          id: info.itemId || info.id,
          title: info.title || '',
          price: price,
          url: `https://www.goofish.com/item?id=${info.itemId}`,
          image: info.picUrl || '',
          location: info.area || '',
          platform: '闲鱼',
          timestamp: Date.now(),
        });
      }
    }
  } catch (err) {
    console.log('闲鱼H5搜索失败:', err.message);
  }
  
  return results;
}

// 生成模拟数据（当真实数据获取失败时使用）
function generateMockData(keyword) {
  const basePrice = getBasePrice(keyword);
  const items = [];
  const platforms = ['闲鱼', '淘宝二手'];
  const locations = ['北京', '上海', '广州', '深圳', '成都', '杭州', '武汉', '西安'];
  
  const templates = generateTitleTemplates(keyword);
  
  for (let i = 0; i < 20; i++) {
    const variation = (Math.random() - 0.3) * 0.6; // 偏低价分布
    const price = Math.round(basePrice * (1 + variation) / 10) * 10;
    const platform = platforms[Math.floor(Math.random() * platforms.length)];
    
    items.push({
      id: 'mock_' + i + '_' + Date.now(),
      title: templates[i % templates.length] + (Math.random() > 0.5 ? '（包邮）' : ''),
      price: Math.max(price, 50),
      originalPrice: Math.round(price * (1.5 + Math.random() * 0.5) / 10) * 10,
      url: '#',
      image: `https://picsum.photos/seed/${keyword}${i}/200/200`,
      location: locations[Math.floor(Math.random() * locations.length)],
      salesCount: Math.floor(Math.random() * 100),
      platform: platform,
      timestamp: Date.now() - Math.floor(Math.random() * 3600000),
      isMock: true,
    });
  }
  
  return items.sort((a, b) => a.price - b.price);
}

function getBasePrice(keyword) {
  const kw = keyword.toLowerCase();
  const priceMap = {
    // ===== 内存（2026年5月真实二手价）=====
    // DDR4 价格稳定低位
    'ddr4 16g': 220, 'ddr4 32g': 420, 'ddr4 8g': 100,
    // DDR5 价格已从暴涨回落但仍较高
    'ddr5 32g': 1800, 'ddr5 16g': 550, 'ddr5 8g': 280,
    // 品牌内存
    '金士顿': 260, '芝奇': 400, '海盗船': 420, '英睿达': 220,
    '威刚': 200, '光威': 180, '阿斯加特': 190,
    '内存条': 300, '内存': 280,

    // ===== 显卡（2026年5月真实二手价，来源：闲鱼/知乎/ZOL行情）=====
    // 50系（Blackwell，二手已有流通，注意：5060Ti 16G目前超值！）
    'rtx 5090': 16500, 'rtx 5080': 9500, 'rtx 5070 ti': 6200,
    'rtx 5070': 4200, 'rtx 5060 ti 16g': 3200, 'rtx 5060 ti': 2500,
    'rtx 5060': 2100, 'rtx 5050': 1800,
    // 40系（二手降价明显）
    'rtx 4090': 11000, 'rtx 4080 super': 6800, 'rtx 4080': 6200,
    'rtx 4070 ti super': 4600, 'rtx 4070 ti': 4200,
    'rtx 4070 super': 3600, 'rtx 4070': 3200,
    'rtx 4060 ti': 2000, 'rtx 4060': 1650,
    // 30系
    'rtx 3090 ti': 4800, 'rtx 3090': 4200,
    'rtx 3080 ti': 3400, 'rtx 3080': 2800,
    'rtx 3070 ti': 2200, 'rtx 3070': 1900,
    'rtx 3060 ti': 1700, 'rtx 3060': 1300,
    // AMD RDNA4（9000系，2025年发布）
    'rx 9070xt': 4000, 'rx 9070': 3400, 'rx 9060xt': 2200, 'rx 9060': 1800,
    // AMD RDNA3
    'rx 7900xtx': 4800, 'rx 7900xt': 3800, 'rx 7900gre': 2800,
    'rx 7800xt': 2500, 'rx 7700xt': 2000, 'rx 7600xt': 1500, 'rx 7600': 1250,
    // AMD RDNA2
    'rx 6950xt': 2500, 'rx 6900xt': 2200, 'rx 6800xt': 1900,
    'rx 6750xt': 1400, 'rx 6700xt': 1200, 'rx 6650xt': 1050, 'rx 6600xt': 950, 'rx 6600': 800,
    '显卡': 2500, 'rtx': 3000, 'gpu': 2500,

    // ===== CPU（2026年5月二手行情）=====
    // AMD AM5（锐龙9000系）
    '9950x3d': 4500, '9950x': 3800, '9900x3d': 3200, '9900x': 2600,
    '9700x3d': 2200, '9700x': 1800, '9600x3d': 1600, '9600x': 1200, '9600': 900,
    // AMD AM5（锐龙7000系）
    '7950x3d': 3500, '7950x': 2800, '7900x3d': 2800, '7900x': 2200,
    '7800x3d': 1800, '7700x': 1300, '7600x': 1000, '7500f': 600, '7600': 850,
    // AMD AM4
    '5800x3d': 2200, '5700x3d': 1600, '5900x': 1100, '5800x': 750,
    '5700x': 600, '5600x': 480, '5600': 380, '5500': 300,
    // Intel 15代（Arrow Lake）
    'ultra 9 285k': 3800, 'ultra 7 265k': 2500, 'ultra 5 245k': 1800,
    // Intel 14代
    'i9 14900k': 3200, 'i9 14900': 2600, 'i7 14700k': 2200, 'i7 14700': 1800,
    'i5 14600k': 1500, 'i5 14500': 1100, 'i5 14400': 850,
    // Intel 13代
    'i9 13900k': 2800, 'i7 13700k': 1900, 'i5 13600k': 1200,
    'i5 13500': 900, 'i5 13400': 750, 'i5 13100': 500,
    // Intel 12代
    'i9 12900k': 2200, 'i7 12700k': 1500, 'i5 12600k': 900,
    'i5 12400': 480, 'i3 12100': 380,
    'cpu': 800, '处理器': 800,

    // ===== 主板（2026年5月二手行情）=====
    // AMD AM5
    'x870e': 1800, 'x870': 1500, 'b850': 1100, 'x670e': 1200, 'x670': 1000,
    'b650e': 850, 'b650': 700, 'b650m': 650, 'a620': 450,
    // AMD AM4
    'x570s': 550, 'x570': 500, 'b550': 320, 'b550m': 280,
    'b450': 180, 'b450m': 160, 'a520': 130,
    // Intel 800系（LGA1851）
    'z890': 2000, 'b860': 900, 'h810': 600,
    // Intel 700系
    'z790': 1300, 'b760': 600, 'b760m': 550, 'h770': 700,
    // Intel 600系
    'z690': 900, 'b660': 450, 'b660m': 400, 'h670': 550,
    '主板': 500,

    // ===== SSD（2026年5月二手行情）=====
    '4tb ssd': 1200, '4tb nvme': 1300,
    '2tb ssd': 550, '2tb nvme': 600,
    '1tb ssd': 280, '1tb nvme': 300,
    '512g ssd': 160, '512g nvme': 180,
    '三星990pro': 480, '三星990': 400, '三星980pro': 350,
    'sn850x': 420, 'sn850': 350, 'sn770': 280,
    '致态tiplus7100': 320, '致态': 260,
    '宏碁掠夺者': 250, '爱国者': 200, '铠侠': 240,
    '固态硬盘': 300, 'ssd': 300, 'nvme': 320,

    // ===== 电源（2026年5月真实二手价）=====
    '850w': 400, '750w': 350, '650w': 280, '550w': 200,
    '海韵': 500, '振华': 400, '长城': 250, '航嘉': 220,
    '电源': 300,

    // ===== 散热（2026年5月真实二手价）=====
    '360水冷': 350, '240水冷': 250, '水冷': 300,
    '利民': 80, '猫头鹰': 350, '散热器': 150, '风冷': 100,

    // ===== 机箱/外设 =====
    '机箱': 150, 'itx机箱': 200, 'atx机箱': 180,
    '显示器': 800, '4k显示器': 1600, '2k显示器': 900, '1080p显示器': 500,
    '电竞显示器': 1200, '带鱼屏': 1500,
    '键盘': 200, '机械键盘': 300, '客制化键盘': 500,
    '鼠标': 100, '电竞鼠标': 150, '键鼠': 250,
    '耳机': 150, '电竞耳机': 250, '音箱': 200,
  };

  // 先匹配长关键词（更精确）
  const sorted = Object.entries(priceMap).sort((a, b) => b[0].length - a[0].length);
  for (const [key, val] of sorted) {
    if (kw.includes(key)) return val;
  }

  // 模糊匹配
  if (kw.includes('ddr')) return kw.includes('ddr5') ? 800 : 200;
  if (kw.includes('rtx') || kw.includes('rx ')) return 2500;
  if (kw.includes('i5') || kw.includes('i7') || kw.includes('i9')) return 1000;
  if (kw.includes('5600') || kw.includes('5800') || kw.includes('5900') || kw.includes('7500') || kw.includes('7600') || kw.includes('7700') || kw.includes('7800')) return 1200;

  return 200 + Math.random() * 800;
}

function generateTitleTemplates(keyword) {
  const kw = keyword.toLowerCase();
  // 电脑配件专用标题
  if (kw.includes('内存') || kw.includes('ddr') || kw.includes('金士顿') || kw.includes('芝奇') || kw.includes('海盗船')) {
    return [
      `${keyword} 32GB 台式机内存 全新仅拆封`,
      `【99新】${keyword} 质保还在 支持验货`,
      `${keyword} 升级换下来的 成色极佳`,
      `自用${keyword} 16G*2 双通道 稳定无错`,
      `${keyword} 原盒保修 个人升级闲置`,
      `二手${keyword} 测过无坏道 可小刀`,
      `${keyword} 时序 tight 游戏帧数拉满`,
      `【低价】${keyword} 2条装 包邮`,
      `${keyword} 旗舰店购入 发票可查`,
      `退坑出 ${keyword} 买来没用多久`,
    ];
  }
  if (kw.includes('显卡') || kw.includes('rtx') || kw.includes('rx ') || kw.includes('gpu')) {
    return [
      `${keyword} 个人自用 挖矿绝缘 成色好`,
      `【9新】${keyword} 箱说全 保修期内`,
      `${keyword} 非矿卡 游戏玩家自用`,
      `升级出的${keyword} 满血无拆修`,
      `${keyword} 原价购入 现低价出 不议价`,
      `二手${keyword} 3DMark跑分正常`,
      `${keyword} 带原装包装 送DP线`,
      `急出${keyword} 同城面交优先`,
      `${keyword} 全自动台式机拆的 功能完好`,
      `【学生党】${keyword} 支持验机 包邮`,
    ];
  }
  if (kw.includes('cpu') || kw.includes('处理器') || kw.includes('5800') || kw.includes('5600') || kw.includes('7800') || kw.includes('7600') || kw.includes('i5') || kw.includes('i7')) {
    return [
      `${keyword} 散片/盒装 自用升级闲置`,
      `【9新】${keyword} 不超频 状态完美`,
      `${keyword} 原盒带散热器 个人闲置`,
      `台式机升级出 ${keyword} 跑分正常`,
      `${keyword} 无维修 无打磨 支持验货`,
      `二手${keyword} 价格美丽 可小刀`,
      `${keyword} 换平台出了 保修内`,
      `【包邮】${keyword} 送硅脂`,
      `${keyword} 游戏办公都行 性能强`,
      `个人闲置${keyword} 成色好`,
    ];
  }
  if (kw.includes('主板') || kw.includes('b450') || kw.includes('b550') || kw.includes('b650') || kw.includes('x570')) {
    return [
      `${keyword} 主板 全新仅通电测试`,
      `【9新】${keyword} 全接口正常 无维修`,
      `${keyword} M.2+DDR4 支持PCIe4.0`,
      `升级换下来的${keyword} BIOS已刷最新`,
      `${keyword} 带WiFi版 箱说全`,
      `二手${keyword} 供电强悍 超频无压力`,
      `${keyword} 个人自用 成色极佳`,
      `【实拍】${keyword} 所有插槽完好`,
    ];
  }
  if (kw.includes('ssd') || kw.includes('固态') || kw.includes('nvme') || kw.includes('硬盘')) {
    return [
      `${keyword} 固态硬盘 读速7000+ 几乎全新`,
      `【99新】${keyword} 用了几个月 TBW余量很多`,
      `${keyword} 全新未拆封 多买了一条`,
      `${keyword} 做系统盘超快 个人闲置`,
      `二手${keyword} 无坏块 SMART健康`,
      `${keyword} 发热低 带散热片`,
      `升级出${keyword} 速度正常`,
      `【包邮】${keyword} 官方旗舰店购入`,
    ];
  }
  if (kw.includes('电源') || kw.includes('散热') || kw.includes('水冷') || kw.includes('机箱')) {
    return [
      `${keyword} 99新 升级换代出的`,
      `【自用】${keyword} 功能完好 颜色正`,
      `${keyword} 原装正品 旗舰店买的`,
      `二手${keyword} 测试正常 包邮`,
      `${keyword} 个人闲置 成色好`,
      `退坑出${keyword} 低价处理`,
      `${keyword} 全新买来没用过`,
      `【包邮】${keyword} 支持验货`,
    ];
  }
  // 通用电脑配件
  return [
    `${keyword} 99新 个人闲置 急出`,
    `【9新】${keyword} 功能完好 箱说全`,
    `${keyword} 升级换下来的 成色极佳`,
    `二手${keyword} 支持验货 可小刀`,
    `${keyword} 旗舰店购入 发票在`,
    `${keyword} 自用出售 价格美丽`,
    `【实拍】${keyword} 同城面交优先`,
    `${keyword} 全新仅拆封 买错型号`,
    `优质二手${keyword} 测试正常`,
    `个人闲置${keyword} 包邮`,
  ];
}

// 更新历史价格记录
function updatePriceHistory(keyword, items) {
  if (items.length === 0) return;
  
  const prices = items.map(i => i.price).filter(p => p > 0);
  const avgPrice = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  
  if (!priceHistory.has(keyword)) {
    priceHistory.set(keyword, []);
  }
  
  const history = priceHistory.get(keyword);
  history.push({
    time: Date.now(),
    avgPrice,
    minPrice,
    maxPrice,
    count: prices.length,
  });
  
  // 只保留最近50条
  if (history.length > 50) history.shift();
}

// API路由
app.get('/api/search', async (req, res) => {
  const { keyword, forceRefresh } = req.query;
  if (!keyword) return res.status(400).json({ error: '请输入关键词' });
  
  const cacheKey = keyword.toLowerCase();
  const now = Date.now();
  const cacheTimeout = 5 * 60 * 1000; // 5分钟缓存
  
  // 检查缓存
  if (!forceRefresh && cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (now - cached.time < cacheTimeout) {
      return res.json({ ...cached.data, fromCache: true, cacheAge: Math.round((now - cached.time) / 1000) });
    }
  }
  
  let items = [];
  let dataSource = 'live';

  // 优先使用实时抓取的数据
  const livePrices = await getLivePrices();
  if (livePrices?.prices) {
    const kw = keyword.toLowerCase();
    for (const [product, info] of Object.entries(livePrices.prices)) {
      const productLower = product.toLowerCase();
      if (productLower.includes(kw) || kw.includes(productLower.split(' ')[0])) {
        items.push({
          id: 'live_' + product.replace(/\s/g, '_'),
          title: product,
          price: info.medianPrice,
          originalPrice: info.maxPrice,
          url: '#',
          image: '',
          location: '全网行情',
          platform: info.sources?.[0] || '行情抓取',
          isLiveData: true,
          samples: info.samples,
          priceRange: { min: info.minPrice, max: info.maxPrice },
          timestamp: new Date(livePrices.fetchTime).getTime(),
        });
      }
    }
    if (items.length > 0) dataSource = 'live-realtime';
  }

  // 合并用户提报数据
  const reports = userReports.get(keyword.toLowerCase()) || [];
  for (const report of reports) {
    items.push({
      id: 'report_' + report.timestamp + '_' + Math.random().toString(36).slice(2),
      title: `${keyword} 用户提报价格`,
      price: report.price,
      originalPrice: report.price,
      url: '#',
      image: '',
      location: report.city || '',
      platform: report.platform || '用户提报',
      isUserReport: true,
      timestamp: report.timestamp,
    });
  }

  // 如果实时数据不足，补充模拟数据
  if (items.length < 3) {
    const mockItems = generateMockData(keyword);
    if (items.length === 0) {
      items = mockItems;
      dataSource = 'mock';
    } else {
      items = [...items, ...mockItems.slice(0, 8)];
      dataSource = items.some(i => i.isLiveData) ? 'live-mixed' : 'mixed';
    }
  }

  // 去重并排序
  const uniqueItems = items.filter((item, index, self) =>
    index === self.findIndex(t => t.id === item.id)
  ).sort((a, b) => a.price - b.price);

  // 计算统计
  const prices = uniqueItems.map(i => i.price);
  const avgPrice = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);

  // 更新历史
  updatePriceHistory(keyword, uniqueItems);

  const result = {
    keyword,
    items: uniqueItems,
    stats: { avgPrice, minPrice, maxPrice, count: uniqueItems.length },
    dataSource,
    hasLiveData: items.some(i => i.isLiveData),
    timestamp: now,
  };

  cache.set(cacheKey, { data: result, time: now });
  res.json({ ...result, fromCache: false });
});

app.get('/api/history', (req, res) => {
  const { keyword } = req.query;
  if (!keyword) return res.status(400).json({ error: '请输入关键词' });
  
  const history = priceHistory.get(keyword.toLowerCase()) || 
                  generateMockHistory(keyword);
  res.json({ keyword, history });
});

// 生成模拟历史数据
function generateMockHistory(keyword) {
  const basePrice = getBasePrice(keyword);
  const history = [];
  const now = Date.now();
  
  for (let i = 23; i >= 0; i--) {
    const noise = (Math.random() - 0.5) * 0.15;
    const trend = -i * 0.003; // 轻微下跌趋势（二手商品）
    const avgPrice = Math.round(basePrice * (1 + noise + trend) / 10) * 10;
    history.push({
      time: now - i * 3600000,
      avgPrice,
      minPrice: Math.round(avgPrice * 0.75 / 10) * 10,
      maxPrice: Math.round(avgPrice * 1.3 / 10) * 10,
      count: Math.floor(15 + Math.random() * 25),
    });
  }
  return history;
}

app.get('/api/trending', (req, res) => {
  const trending = [
    { keyword: 'RTX 5070', count: 2856, avgPrice: 4800, category: 'gpu' },
    { keyword: 'RTX 5060', count: 2243, avgPrice: 2600, category: 'gpu' },
    { keyword: 'DDR5 32G', count: 2100, avgPrice: 1800, category: 'memory' },
    { keyword: '9600X', count: 1687, avgPrice: 1200, category: 'cpu' },
    { keyword: 'RTX 4070', count: 1543, avgPrice: 3800, category: 'gpu' },
    { keyword: '7800X3D', count: 1421, avgPrice: 1800, category: 'cpu' },
    { keyword: '1TB NVMe SSD', count: 3210, avgPrice: 300, category: 'ssd' },
    { keyword: 'DDR4 16G', count: 4200, avgPrice: 220, category: 'memory' },
    { keyword: 'RX 9070XT', count: 1123, avgPrice: 4200, category: 'gpu' },
    { keyword: 'B850 主板', count: 987, avgPrice: 1100, category: 'motherboard' },
    { keyword: '2TB 固态硬盘', count: 1876, avgPrice: 550, category: 'ssd' },
    { keyword: '750W 电源', count: 1987, avgPrice: 350, category: 'psu' },
  ];
  res.json({ trending });
});

// ===== 新增 API: 性价比排行 =====
const categoryKeywords = {
  gpu: {
    name: '显卡',
    icon: 'gpu',
    // 3DMark Time Spy 跑分基准: RTX 4060 = 100% (10619分)
    // performance = (实际跑分 / 10619) × 100
    items: [
      // 50系
      { keyword: 'RTX 5090', basePrice: 16500, newPrice: 19999, performance: 442 },
      { keyword: 'RTX 5080', basePrice: 9500, newPrice: 11999, performance: 311 },
      { keyword: 'RTX 5070Ti', basePrice: 6200, newPrice: 7499, performance: 262 },
      { keyword: 'RTX 5070', basePrice: 4200, newPrice: 5499, performance: 214 },
      { keyword: 'RTX 5060Ti 16G', basePrice: 3200, newPrice: 3999, performance: 151, highlight: true },
      { keyword: 'RTX 5060Ti', basePrice: 2500, newPrice: 3199, performance: 149, highlight: true },
      { keyword: 'RTX 5060', basePrice: 2100, newPrice: 2699, performance: 129 },
      // 40系
      { keyword: 'RTX 4090', basePrice: 11000, newPrice: 0, performance: 342 },
      { keyword: 'RTX 4080S', basePrice: 6800, newPrice: 0, performance: 266 },
      { keyword: 'RTX 4070TiS', basePrice: 4600, newPrice: 0, performance: 229 },
      { keyword: 'RTX 4070S', basePrice: 3600, newPrice: 0, performance: 198 },
      { keyword: 'RTX 4070', basePrice: 3200, newPrice: 4899, performance: 168 },
      { keyword: 'RTX 4060Ti', basePrice: 2000, newPrice: 3199, performance: 127 },
      { keyword: 'RTX 4060', basePrice: 1650, newPrice: 2399, performance: 100 },
      // 30系
      { keyword: 'RTX 3080', basePrice: 2800, newPrice: 0, performance: 166 },
      { keyword: 'RTX 3070', basePrice: 1900, newPrice: 0, performance: 128 },
      { keyword: 'RTX 3060Ti', basePrice: 1700, newPrice: 0, performance: 110 },
      { keyword: 'RTX 3060', basePrice: 1300, newPrice: 0, performance: 82 },
      // AMD RDNA4
      { keyword: 'RX 9070XT', basePrice: 4000, newPrice: 5499, performance: 287 },
      { keyword: 'RX 9070', basePrice: 3400, newPrice: 4499, performance: 253 },
      { keyword: 'RX 9060XT', basePrice: 2200, newPrice: 2999, performance: 156 },
      // AMD RDNA3
      { keyword: 'RX 7900XTX', basePrice: 4800, newPrice: 7999, performance: 287 },
      { keyword: 'RX 7900XT', basePrice: 3800, newPrice: 5999, performance: 252 },
      { keyword: 'RX 7800XT', basePrice: 2500, newPrice: 4099, performance: 189 },
      { keyword: 'RX 7600', basePrice: 1250, newPrice: 1999, performance: 103 },
    ],
  },
  cpu: {
    name: 'CPU',
    icon: 'cpu',
    items: [
      // AMD 9000系
      { keyword: '9950X3D', basePrice: 4500, newPrice: 5499, performance: 100 },
      { keyword: '9900X3D', basePrice: 3200, newPrice: 3999, performance: 92 },
      { keyword: '9700X3D', basePrice: 2200, newPrice: 2799, performance: 85 },
      { keyword: '9600X', basePrice: 1200, newPrice: 1599, performance: 68 },
      // AMD 7000系
      { keyword: '7800X3D', basePrice: 1800, newPrice: 2499, performance: 88 },
      { keyword: '7700X', basePrice: 1300, newPrice: 1799, performance: 72 },
      { keyword: '7600X', basePrice: 1000, newPrice: 1399, performance: 62 },
      { keyword: '7500F', basePrice: 600, newPrice: 899, performance: 52 },
      // AMD 5000系
      { keyword: '5800X3D', basePrice: 2200, newPrice: 0, performance: 82 },
      { keyword: '5900X', basePrice: 1100, newPrice: 0, performance: 70 },
      { keyword: '5600X', basePrice: 480, newPrice: 0, performance: 48 },
      { keyword: '5600', basePrice: 380, newPrice: 0, performance: 42 },
      // Intel 14/15代
      { keyword: 'i7 14700K', basePrice: 1900, newPrice: 2699, performance: 85 },
      { keyword: 'i5 14600K', basePrice: 1200, newPrice: 1799, performance: 72 },
      { keyword: 'i5 14400', basePrice: 750, newPrice: 1199, performance: 52 },
      // Intel 13代
      { keyword: 'i5 13600K', basePrice: 1000, newPrice: 1499, performance: 65 },
      { keyword: 'i5 12400', basePrice: 480, newPrice: 799, performance: 42 },
    ],
  },
  memory: {
    name: '内存',
    icon: 'memory',
    items: [
      { keyword: 'DDR5 32G', basePrice: 1800, newPrice: 899, performance: 90 },
      { keyword: 'DDR5 16G', basePrice: 550, newPrice: 499, performance: 70 },
      { keyword: 'DDR4 16G', basePrice: 220, newPrice: 299, performance: 50 },
      { keyword: 'DDR4 32G', basePrice: 420, newPrice: 549, performance: 65 },
      { keyword: 'DDR4 8G', basePrice: 100, newPrice: 159, performance: 30 },
      { keyword: '金士顿 DDR5 16G', basePrice: 480, newPrice: 549, performance: 68 },
    ],
  },
  ssd: {
    name: 'SSD',
    icon: 'ssd',
    items: [
      { keyword: '2TB NVMe', basePrice: 650, newPrice: 899, performance: 90 },
      { keyword: '1TB NVMe', basePrice: 300, newPrice: 459, performance: 75 },
      { keyword: '512G NVMe', basePrice: 200, newPrice: 289, performance: 55 },
      { keyword: '三星990 1TB', basePrice: 450, newPrice: 699, performance: 85 },
      { keyword: '致态 1TB', basePrice: 280, newPrice: 459, performance: 80 },
      { keyword: '2TB SSD', basePrice: 600, newPrice: 799, performance: 85 },
    ],
  },
  motherboard: {
    name: '主板',
    icon: 'motherboard',
    items: [
      { keyword: 'B650', basePrice: 800, newPrice: 999, performance: 85 },
      { keyword: 'B550', basePrice: 350, newPrice: 599, performance: 70 },
      { keyword: 'B550M', basePrice: 320, newPrice: 499, performance: 60 },
      { keyword: 'X570', basePrice: 600, newPrice: 999, performance: 80 },
      { keyword: 'B760', basePrice: 700, newPrice: 899, performance: 75 },
      { keyword: 'Z790', basePrice: 1500, newPrice: 1999, performance: 90 },
    ],
  },
  cooler: {
    name: '散热/电源',
    icon: 'cooler',
    items: [
      { keyword: '750W 电源', basePrice: 350, newPrice: 549, performance: 75 },
      { keyword: '850W 电源', basePrice: 400, newPrice: 699, performance: 85 },
      { keyword: '650W 电源', basePrice: 280, newPrice: 399, performance: 60 },
      { keyword: '利民 散热器', basePrice: 80, newPrice: 159, performance: 65 },
      { keyword: '360水冷', basePrice: 350, newPrice: 599, performance: 85 },
      { keyword: '240水冷', basePrice: 250, newPrice: 399, performance: 70 },
      { keyword: '猫头鹰 散热器', basePrice: 350, newPrice: 599, performance: 90 },
    ],
  },
};

const budgetRanges = [
  { key: 'budget', name: '入门', range: [0, 500] },
  { key: 'mainstream', name: '主流', range: [500, 2000] },
  { key: 'highend', name: '高端', range: [2000, 5000] },
  { key: 'flagship', name: '旗舰', range: [5000, 99999] },
];

app.get('/api/ranking', (req, res) => {
  const { category, budget } = req.query;
  const cat = categoryKeywords[category] || categoryKeywords.gpu;

  let items = cat.items.map(item => {
    // 新算法: 每元性能 = 性能分 / 二手价(百元) × 10
    // 以RTX 4060为100%基准(3DMark Time Spy: 10619分)
    const performancePer100Yuan = (item.performance / (item.basePrice / 100));
    // 归一化到0-100分（基于最高性价比的卡）
    const maxPPY = 15; // 假设最高性价比约为15
    const valueScore = Math.min(Math.round((performancePer100Yuan / maxPPY) * 100), 100);

    // 计算24小时涨跌（基于价格与新品价的偏离度模拟）
    const priceDeviation = item.newPrice > 0 ? (item.basePrice - item.newPrice * 0.7) / item.newPrice : 0;
    const change24h = (priceDeviation * 3 + (Math.random() - 0.5) * 2).toFixed(1);

    return {
      keyword: item.keyword,
      avgPrice: item.basePrice,
      newPrice: item.newPrice,
      performance: item.performance,
      valueScore,
      change24h: parseFloat(change24h),
      trend: parseFloat(change24h) > 0 ? 'up' : parseFloat(change24h) < -2 ? 'down' : 'stable',
      category: category,
    };
  });

  // 按预算段筛选
  if (budget) {
    const range = budgetRanges.find(b => b.key === budget);
    if (range) {
      items = items.filter(item => item.avgPrice >= range.range[0] && item.avgPrice < range.range[1]);
    }
  }

  // 按性价比评分降序
  items.sort((a, b) => b.valueScore - a.valueScore);

  res.json({
    category: cat.name,
    budgetRanges,
    items,
  });
});

// ===== 新增 API: 今日热门 =====
app.get('/api/hot', (req, res) => {
  const now = Date.now();
  const hotItems = [
    { keyword: 'RTX 4070', avgPrice: 4500, change: -2.3, category: 'gpu', trend: 'down', reason: '40系降价趋势，近期低价频出' },
    { keyword: 'DDR5 32G', avgPrice: 1800, change: 5.1, category: 'memory', trend: 'up', reason: 'DDR5产能受限，价格回升' },
    { keyword: '5800X3D', avgPrice: 2450, change: -1.2, category: 'cpu', trend: 'stable', reason: '游戏神U价格稳定，AM4平台收官' },
    { keyword: '1TB NVMe SSD', avgPrice: 300, change: -3.5, category: 'ssd', trend: 'down', reason: '国产SSD扩产，持续降价' },
    { keyword: '7800X3D', avgPrice: 1900, change: -4.1, category: 'cpu', trend: 'down', reason: '新U发布压力，价格走低' },
    { keyword: '750W 电源', avgPrice: 350, change: 0.5, category: 'cooler', trend: 'stable', reason: 'ATX3.0电源供需平衡' },
  ];

  res.json({ hotItems, timestamp: now });
});

// ===== 新增 API: 单品详情 =====
app.get('/api/detail/:keyword', (req, res) => {
  const keyword = decodeURIComponent(req.params.keyword);
  const basePrice = getBasePrice(keyword);
  const history = priceHistory.get(keyword.toLowerCase()) || generateMockHistory(keyword);

  // 计算趋势
  const recentPrices = history.slice(-7).map(h => h.avgPrice);
  const trend = recentPrices.length >= 2
    ? ((recentPrices[recentPrices.length - 1] - recentPrices[0]) / recentPrices[0] * 100).toFixed(1)
    : 0;

  const minHistorical = Math.min(...history.map(h => h.minPrice));
  const maxHistorical = Math.max(...history.map(h => h.maxPrice));
  const avgHistorical = Math.round(history.reduce((a, h) => a + h.avgPrice, 0) / history.length);

  // 查找同类推荐
  const category = Object.entries(categoryKeywords).find(([, cat]) =>
    cat.items.some(item => keyword.toLowerCase().includes(item.keyword.toLowerCase()))
  );
  const recommendations = category
    ? category[1].items
        .filter(item => item.keyword.toLowerCase() !== keyword.toLowerCase())
        .slice(0, 3)
        .map(item => ({ keyword: item.keyword, avgPrice: item.basePrice }))
    : [];

  res.json({
    keyword,
    currentPrice: basePrice,
    trend: parseFloat(trend),
    trendDirection: parseFloat(trend) > 2 ? 'up' : parseFloat(trend) < -2 ? 'down' : 'stable',
    minHistorical,
    maxHistorical,
    avgHistorical,
    history,
    recommendations,
    platforms: ['闲鱼', '转转', '淘宝二手'],
  });
});

// ===== 新增 API: 用户提报 =====
app.post('/api/report', (req, res) => {
  const { keyword, price, platform, city, image } = req.body;

  if (!keyword || !price) {
    return res.status(400).json({ error: '关键词和价格不能为空' });
  }

  const key = keyword.toLowerCase();
  if (!userReports.has(key)) {
    userReports.set(key, []);
  }

  const report = {
    price: parseFloat(price),
    platform: platform || '用户提报',
    city: city || '',
    image: image || '',
    timestamp: Date.now(),
    reporter: 'anonymous',
  };

  userReports.get(key).push(report);

  // 多人提报取中位数作为共识价
  const allPrices = userReports.get(key).map(r => r.price).sort((a, b) => a - b);
  const mid = Math.floor(allPrices.length / 2);
  const consensusPrice = allPrices.length % 2 === 0
    ? Math.round((allPrices[mid - 1] + allPrices[mid]) / 2)
    : allPrices[mid];

  res.json({
    success: true,
    report,
    stats: {
      reportCount: allPrices.length,
      consensusPrice,
    },
  });
});

// ===== 新增 API: 提报统计 =====
app.get('/api/report/stats', (req, res) => {
  const totalReports = Array.from(userReports.values()).reduce((sum, reports) => sum + reports.length, 0);
  const coveredKeywords = userReports.size;

  const categoryStats = {};
  for (const [keyword, reports] of userReports) {
    const prices = reports.map(r => r.price);
    categoryStats[keyword] = {
      count: reports.length,
      avgPrice: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
      minPrice: Math.min(...prices),
      maxPrice: Math.max(...prices),
      consensusPrice: (() => {
        const sorted = [...prices].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0 ? Math.round((sorted[mid-1] + sorted[mid]) / 2) : sorted[mid];
      })(),
    };
  }

  res.json({
    totalReports,
    coveredKeywords,
    categoryStats,
  });
});

// ===== 新增 API: 品类列表 =====
app.get('/api/categories', (req, res) => {
  const categories = Object.entries(categoryKeywords).map(([key, val]) => ({
    key,
    name: val.name,
    icon: val.icon,
    itemCount: val.items.length,
    priceRange: {
      min: Math.min(...val.items.map(i => i.basePrice)),
      max: Math.max(...val.items.map(i => i.basePrice)),
    },
  }));
  res.json({ categories });
});

// ===== API: 实时价格数据 =====
app.get('/api/live-prices', async (req, res) => {
  const prices = await getLivePrices();
  if (prices) {
    res.json({
      success: true,
      fetchTime: prices.fetchTime,
      count: prices.merged,
      prices: prices.prices,
    });
  } else {
    res.json({ success: false, error: '暂无实时数据' });
  }
});

// ===== API: 手动刷新价格 =====
app.post('/api/refresh-prices', async (req, res) => {
  try {
    livePrices = null;
    lastFetchTime = 0;
    const prices = await getLivePrices();
    res.json({
      success: true,
      message: `已刷新，获取 ${prices?.merged || 0} 条数据`,
      fetchTime: prices?.fetchTime,
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ===== API: 搜索商品（增强版，优先使用实时数据） =====
app.get('/api/search-enhanced', async (req, res) => {
  const { keyword } = req.query;
  if (!keyword) return res.status(400).json({ error: '请输入关键词' });

  const prices = await getLivePrices();
  const kw = keyword.toLowerCase();

  // 从实时数据中查找匹配项
  const matched = [];
  if (prices?.prices) {
    for (const [product, info] of Object.entries(prices.prices)) {
      const productLower = product.toLowerCase();
      if (productLower.includes(kw) || kw.includes(productLower)) {
        matched.push({
          product,
          medianPrice: info.medianPrice,
          minPrice: info.minPrice,
          maxPrice: info.maxPrice,
          samples: info.samples,
          sources: info.sources,
        });
      }
    }
  }

  res.json({
    keyword,
    liveData: matched,
    hasLiveData: matched.length > 0,
  });
});

// Vercel serverless 导出
module.exports = app;

// 本地开发时启动服务器
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`价格监控服务器运行在 http://localhost:${PORT}`);
    console.log(`API: /api/search, /api/ranking, /api/hot, /api/live-prices, /api/refresh-prices`);
  });
}
