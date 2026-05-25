const express = require('express');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const PORT = 8080;

// ── 飞书多维表格配置 ──────────────────────────────────────────
// FEISHU_APP_TOKEN：多维表格的 Base ID（所有表共用同一个 Base）
const FEISHU_APP_TOKEN = process.env.FEISHU_APP_TOKEN || 'AjRtb1tgqaWoMMsCQC4cuytinMc';

const FEISHU_TABLES = {
    TEMPLATE:  'tblNBF5wai4ABE1H',
    MATERIAL:  'tblZyrVRUZNTyhev', // 素材库 Table ID
    NOTES:     'tblCuLobecoQbOmW',
    BENCHMARK: 'tblzwpG0Lnhuadl3',
};

// ── 素材库独立配置（与发布库隔离）────────────────────────────
// 默认复用主 Base + MATERIAL 表；如有独立素材库，在 .env 中配置 LIBRARY_APP_TOKEN / LIBRARY_TABLE_ID 覆盖
const LIBRARY_APP_TOKEN = process.env.LIBRARY_APP_TOKEN || FEISHU_APP_TOKEN;
const LIBRARY_TABLE_ID  = process.env.LIBRARY_TABLE_ID  || FEISHU_TABLES.MATERIAL;

// ── 飞书 tenant_access_token 缓存 ────────────────────────────
let _feishuToken = null;
let _feishuTokenExpiry = 0;

async function getFeishuToken() {
    if (process.env.FEISHU_ACCESS_TOKEN) return process.env.FEISHU_ACCESS_TOKEN;
    if (_feishuToken && Date.now() < _feishuTokenExpiry) return _feishuToken;

    const appId     = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
        console.warn('[TOKEN] ⚠️ 未配置 FEISHU_APP_ID / FEISHU_APP_SECRET');
        return null;
    }

    const r = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        app_id: appId, app_secret: appSecret,
    }, { timeout: 8000 });

    _feishuToken = r.data.tenant_access_token;
    _feishuTokenExpiry = Date.now() + (r.data.expire - 300) * 1000;
    return _feishuToken;
}

async function feishuAuthHeader() {
    const token = await getFeishuToken();
    return {
        'Authorization': token ? `Bearer ${token}` : '',
        'Content-Type': 'application/json',
    };
}

// 专用于文件下载的鉴权头：只带 Authorization，不带 Content-Type
async function feishuDownloadHeader() {
    const token = await getFeishuToken();
    return token ? { 'Authorization': `Bearer ${token}` } : {};
}

// ── 核心解析助手：剥开 Coze Webhook 的多层洋葱皮 ─────────────
function parseCozeData(rawData) {
    if (rawData == null) return null;
    let parsed = rawData;

    // 第一层：{ code, data, ... } 外壳
    if (parsed !== null && typeof parsed === 'object' && 'data' in parsed) {
        parsed = parsed.data;
    }

    // 第二层：data 本身可能是 stringify 过的 JSON 字符串
    if (typeof parsed === 'string') {
        try {
            parsed = JSON.parse(parsed);
        } catch {
            console.error('[PARSE] 第一次 JSON.parse 失败，原始片段:', String(parsed).substring(0, 80));
            return null;
        }
    }

    // 第三层：有些 Webhook 会再套一层 output / result 字符串
    if (parsed !== null && typeof parsed === 'object') {
        const inner = parsed.output ?? parsed.result ?? parsed.content ?? null;
        if (typeof inner === 'string') {
            try {
                parsed = JSON.parse(inner);
            } catch {
                // inner 不是 JSON，保持当前层
            }
        }
    }

    return parsed;
}

// ── WF1: 选题推荐 ─────────────────────────────────────────────
app.post('/api/topics', async (req, res) => {
    const { timestamp, exclude_topics } = req.body || {};
    const url = process.env.COZE_URL_TOPICS || 'https://zmxfghjn7j.coze.site/run';
    console.log('\n[WF1] 收到选题请求，Webhook:', url);
    try {
        const response = await axios.post(url, {
            app_token:      process.env.FEISHU_APP_TOKEN,
            table_id:       process.env.FEISHU_TABLE_ID,
            timestamp:      timestamp || Date.now(),
            nonce:          req.body?.nonce || Math.random().toString(36).slice(2),
            exclude_topics: exclude_topics || [],
        }, {
            headers: { 'Authorization': `Bearer ${process.env.COZE_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 90000,
        });

        console.log('[WF1] 原始返回:', JSON.stringify(response.data).substring(0, 200));
        const cleanData = parseCozeData(response.data);
        console.log('[WF1] 干净数据:', JSON.stringify(cleanData).substring(0, 200));

        let arr = cleanData?.recommended_topics || cleanData?.topics || (Array.isArray(cleanData) ? cleanData : [cleanData]);
        console.log(`[WF1] ✅ 抓取到 ${arr.length} 个选题`);
        res.json(arr);
    } catch (e) {
        console.error('[WF1] ❌', e.response ? JSON.stringify(e.response.data) : e.message);
        res.status(500).json([]);
    }
});

// ── WF2: 封面 & 标题生成 ──────────────────────────────────────
app.post('/api/covers', async (req, res) => {
    const { selected_topic } = req.body;
    if (!selected_topic) return res.status(400).json({ error: 'selected_topic is required' });

    const url = process.env.COZE_URL_COVERS;
    if (!url) return res.status(500).json({ error: 'COZE_URL_COVERS not configured' });

    console.log(`\n[WF2] 封面请求，选题: "${selected_topic}"，Webhook: ${url}`);
    try {
        const response = await axios.post(url, {
            selected_topic,
        }, {
            headers: { 'Authorization': `Bearer ${process.env.COZE_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 60000,
        });

        console.log('[WF2] 原始返回:', JSON.stringify(response.data).substring(0, 200));
        const cleanData = parseCozeData(response.data);
        console.log('[WF2] 干净数据:', JSON.stringify(cleanData).substring(0, 200));

        let arr = cleanData?.title_material_pairs || cleanData?.covers || (Array.isArray(cleanData) ? cleanData : [cleanData]);
        console.log(`[WF2] ✅ 获取到 ${arr.length} 个封面方案`);

        arr = arr.map((item, i) => {
            const imageUrl = item.coverImageUrl || item.image_url || item.imageUrl || item.url || item.cover_url || item.coverUrl || '';
            const desc     = item.search_tag || item.desc || '';
            const title    = item.title || '';
            if (!imageUrl) console.error(`[WF2] ⚠️ 第 ${i} 条未能返回有效图片链接`);
            return { ...item, coverImageUrl: imageUrl, imageUrl, desc, title };
        });

        console.log('[WF2] 下发给前端的首个封面:', arr[0]?.coverImageUrl);
        console.log('🔍 [后端发件] WF2 首个封面 URL:', arr[0]?.coverImageUrl || '未拿到数据');

        res.json(arr);
    } catch (e) {
        console.error('[WF2] ❌', e.response ? JSON.stringify(e.response.data) : e.message);
        res.status(500).json([]);
    }
});

// ── WF3: 正文 & 详情图生成 ────────────────────────────────────
app.post('/api/content-final', async (req, res) => {
    const { selected_topic, selected_title, selected_cover_url } = req.body;
    const selected_tag = req.body.selected_tag || req.body.desc || '';
    if (!selected_topic) return res.status(400).json({ error: 'selected_topic is required' });

    const url = process.env.COZE_URL_CONTENT;
    if (!url) return res.status(500).json({ error: 'COZE_URL_CONTENT not configured' });

    console.log(`\n[WF3] 正文生成请求，选题: "${selected_topic}"，标题: "${selected_title}"，标签: "${selected_tag}"，Webhook: ${url}`);
    try {
        const response = await axios.post(url, {
            selected_topic,
            selected_title:     selected_title     || '',
            selected_cover_url: selected_cover_url || '',
            selected_tag:       selected_tag,
        }, {
            headers: { 'Authorization': `Bearer ${process.env.COZE_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 120000,
        });

        console.log('[WF3] 原始返回:', response.data);
        const cleanData = parseCozeData(response.data);

        const result = {
            content:       cleanData?.content       || cleanData?.body      || cleanData?.正文     || '',
            topic_copy:    cleanData?.topic_copy    || cleanData?.tags      || cleanData?.话题标签 || '',
            detail_images: cleanData?.detail_images || cleanData?.images    || cleanData?.详情图   || [],
        };

        // 话题标签：优先 all_tags > tags > topic_copy，统一防御性补 #
        let rawTags = cleanData?.all_tags || cleanData?.tags || cleanData?.topic_copy || cleanData?.话题标签 || [];
        if (typeof rawTags === 'string') {
            try {
                const parsed = JSON.parse(rawTags);
                rawTags = Array.isArray(parsed) ? parsed : rawTags.split(/[\s,，]+/);
            } catch {
                rawTags = rawTags.split(/[\s,，]+/);
            }
        }
        if (!Array.isArray(rawTags)) rawTags = [];
        const processedTags = rawTags
            .map(t => String(t || '').trim())
            .filter(Boolean)
            .map(t => t.startsWith('#') ? t : `#${t}`);

        const tagsCopyFormat = cleanData?.tags_copy_format
            || (typeof cleanData?.topic_copy === 'string' ? cleanData.topic_copy : '')
            || processedTags.join(' ');

        if (typeof result.detail_images === 'string') {
            try { result.detail_images = JSON.parse(result.detail_images); } catch { result.detail_images = [result.detail_images]; }
        }
        if (!Array.isArray(result.detail_images)) result.detail_images = [];

        // Task 1a: 尝试解析 result.content（Coze 可能返回 JSON 字符串）
        let finalContent = result.content;
        try {
            const parsed = JSON.parse(result.content);
            if (parsed.content) finalContent = parsed.content;
        } catch (e) { /* 如果不是 JSON 则保持原样 */ }

        // Task 1b: 暴力清洗正文乱码（字符串截断法）
        let cleanContent = finalContent || '';
        if (typeof cleanContent === 'string') {
            // 1. 砍掉尾部跟着的 "tags": 或 "inspiration_sources":
            if (cleanContent.includes('"tags":')) cleanContent = cleanContent.split('"tags":')[0];
            if (cleanContent.includes('"inspiration_sources":')) cleanContent = cleanContent.split('"inspiration_sources":')[0];
            // 2. 清理头部的 JSON 标记
            cleanContent = cleanContent.replace(/^\{\s*"content":\s*"/i, '');
            // 3. 清理尾部的无效符号
            cleanContent = cleanContent.replace(/",?\s*$/g, '').trim();
        }

        console.log(`[WF3] ✅ 正文 ${cleanContent.length} 字，详情图 ${result.detail_images.length} 张，话题 ${processedTags.length} 个`);
        console.log('[WF3] 实际下发给前端的图片数量:', result.detail_images.length);
        console.log('[WF3] 话题标签:', processedTags);

        res.json({ ...result, content: cleanContent, tags: processedTags, tags_copy_format: tagsCopyFormat });
    } catch (e) {
        console.error('[WF3] ❌', e.response ? JSON.stringify(e.response.data) : e.message);
        res.status(500).json({ content: '', topic_copy: '', tags: [], tags_copy_format: '', detail_images: [] });
    }
});

// ── 图片代理 ───────────────────────
// 飞书直链/tmp_url 对单租户的并发与 QPS 都极敏感（错误码 99991400 = request trigger frequency limit）。
// 终极防护：严格串行单队列 + 每次打完飞书后强制 500ms 延时 + 内存缓存命中绕过延时 +
// 顶层 try/finally 锁兜底，绝对不会出现 isProcessingProxy 永远悬挂的死锁。
const PROXY_INTER_REQUEST_DELAY_MS = 500;
const PROXY_CACHE_MAX = 200;
const proxyQueue = [];
let isProcessingProxy = false;
const imgProxyCache = new Map();

const cacheGet = (key) => {
    if (!imgProxyCache.has(key)) return null;
    const v = imgProxyCache.get(key);
    imgProxyCache.delete(key);
    imgProxyCache.set(key, v);
    return v;
};
const cacheSet = (key, value) => {
    imgProxyCache.set(key, value);
    while (imgProxyCache.size > PROXY_CACHE_MAX) {
        const oldest = imgProxyCache.keys().next().value;
        imgProxyCache.delete(oldest);
    }
};

const isFeishuRateLimit = (errorBodyText, httpStatus) => {
    if (httpStatus === 429) return true;
    if (typeof errorBodyText === 'string' && errorBodyText.includes('99991400')) return true;
    if (typeof errorBodyText === 'string' && errorBodyText.includes('frequency limit')) return true;
    return false;
};

// 真正去打飞书的逻辑：单次执行（含限流感知重试）
const fetchFromFeishu = async (targetUrl) => {
    let lastErrorMsg = '';
    for (let i = 0; i < 4; i++) {
        try {
            const headers = await feishuDownloadHeader();
            const response = await axios.get(targetUrl, {
                responseType: 'arraybuffer',
                headers,
            });

            const buffer = Buffer.from(response.data);
            const contentType = (response.headers['content-type'] || '').toLowerCase();

            // 路径 A：直链已经直接返回图片二进制
            if (contentType.startsWith('image/')) {
                return { ok: true, buffer, contentType };
            }

            // 路径 B：飞书返回的是 JSON「提货单」，里面藏着真正的临时下载直链
            if (contentType.includes('application/json')) {
                const bodyText = buffer.toString('utf8');
                let parsed;
                try { parsed = JSON.parse(bodyText); } catch (_) { parsed = null; }

                // 限流仍走重试（飞书限流也是 200 + JSON 回）
                if (isFeishuRateLimit(bodyText, response.status)) {
                    lastErrorMsg = bodyText;
                    if (i === 3) break;
                    const delay = 1000 + Math.floor(Math.random() * 1000);
                    console.warn(`[Proxy] 飞书限流 99991400，第 ${i + 1} 次退避 ${delay}ms`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }

                const realImageUrl =
                    parsed?.data?.tmp_download_urls?.[0]?.tmp_download_url ||
                    parsed?.data?.tmp_download_url ||
                    parsed?.data?.download_url ||
                    parsed?.data?.url;

                if (!realImageUrl) {
                    console.error('[Proxy] 🚨 JSON 提货单里没找到 tmp_download_url：', bodyText.substring(0, 300));
                    lastErrorMsg = `No tmp_download_url in JSON: ${bodyText.substring(0, 300)}`;
                    break;
                }

                console.log(`[Proxy] 🎯 拿到提货单，二次跳转下载: ${realImageUrl.substring(0, 60)}...`);

                // 二次请求：tmp_download_url 通常是公开直链，但部分飞书空间仍需 token
                const realResp = await axios.get(realImageUrl, {
                    responseType: 'arraybuffer',
                    headers: await feishuDownloadHeader(),
                    timeout: 15000,
                });
                const realBuffer = Buffer.from(realResp.data);
                const realContentType = (realResp.headers['content-type'] || '').toLowerCase();

                if (!realContentType.startsWith('image/')) {
                    console.error(`[Proxy] 🚨 二次跳转后仍非图片 (Content-Type=${realContentType}):`, realBuffer.toString('utf8').substring(0, 300));
                    lastErrorMsg = `Second-hop returned non-image: ${realContentType}`;
                    break;
                }

                return { ok: true, buffer: realBuffer, contentType: realContentType };
            }

            // 路径 C：其它非图片响应，直接判失败暴露真凶
            const bodyText = buffer.toString('utf8');
            console.error(`[Proxy] 🚨 飞书返回了非预期格式 (Content-Type=${contentType}):`, bodyText.substring(0, 300));
            lastErrorMsg = `Unexpected Content-Type=${contentType}: ${bodyText.substring(0, 300)}`;
            break;
        } catch (error) {
            let bodyText = '';
            if (error.response?.data) {
                try { bodyText = Buffer.from(error.response.data).toString('utf-8'); } catch { bodyText = error.message; }
            } else {
                bodyText = error.message;
            }
            lastErrorMsg = bodyText;
            if (i === 3) break;
            const rateLimited = isFeishuRateLimit(bodyText, error.response?.status);
            const delay = rateLimited
                ? 1000 + Math.floor(Math.random() * 1000)
                : 500 + Math.floor(Math.random() * 500);
            if (rateLimited) console.warn(`[Proxy] 飞书限流 99991400，第 ${i + 1} 次退避 ${delay}ms`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    return { ok: false, error: lastErrorMsg };
};

async function processProxyQueue() {
    if (isProcessingProxy || proxyQueue.length === 0) return;
    isProcessingProxy = true;

    try {
        while (proxyQueue.length > 0) {
            const { url, req, res, resolve } = proxyQueue.shift();

            try {
                if (!url || url === 'undefined') {
                    if (!res.headersSent) res.status(400).send('Invalid URL');
                    continue;
                }

                // 1. 查缓存：命中无需延时，直接处理下一个
                const cached = cacheGet(url);
                if (cached) {
                    console.log(`[Proxy] ⚡ 命中缓存: ${url.substring(0, 40)}`);
                    if (!res.headersSent) {
                        res.setHeader('Content-Type', cached.contentType);
                        res.setHeader('X-Cache', 'HIT');
                        res.send(cached.buffer);
                    }
                    continue;
                }

                console.log(`[Proxy] ⏳ 正在向飞书请求: ${url.substring(0, 40)}`);

                // 2. 发起飞书请求（保留 app_token + 限流感知重试）
                const result = await fetchFromFeishu(url);

                if (!res.headersSent) {
                    if (result.ok) {
                        // 3. 存入缓存并发送
                        cacheSet(url, { buffer: result.buffer, contentType: result.contentType });
                        res.setHeader('Content-Type', result.contentType);
                        res.setHeader('X-Cache', 'MISS');
                        res.send(result.buffer);
                    } else {
                        console.error(`[Proxy] ❌ 请求失败: ${result.error}`);
                        res.status(500).send('Proxy Fetch Failed');
                    }
                }

                // 4. 核心防封锁：去飞书请求了就强制 500ms，无论成功失败
                await new Promise(r => setTimeout(r, PROXY_INTER_REQUEST_DELAY_MS));
            } catch (error) {
                console.error(`[Proxy] ❌ 队列异常:`, error.message);
                if (!res.headersSent) res.status(500).send('Proxy Fetch Failed');
                // 错误后也延时，防止连续报错被拉黑
                await new Promise(r => setTimeout(r, PROXY_INTER_REQUEST_DELAY_MS));
            } finally {
                // 关键：无论 try / catch 走哪条路，都要 resolve 路由 Promise，
                // 避免 Express handler 永远 pending
                if (typeof resolve === 'function') resolve();
            }
        }
    } finally {
        // 顶层 try/finally：哪怕循环体抛出未捕获异常也会归还锁，杜绝死锁
        isProcessingProxy = false;
        console.log(`[Proxy] 🎉 队列清空，当前空闲`);
    }
}

// 路由入口：把请求挂进队列，等待处理器顺序消费
app.get('/api/proxy-img', (req, res) => {
    return new Promise(resolve => {
        proxyQueue.push({ url: req.query.url, req, res, resolve });
        processProxyQueue();
    });
});

// ── 封面标题模板 ────────────────────
app.get('/api/title-templates', async (req, res) => {
    const appToken = process.env.FEISHU_APP_TOKEN;
    const tableId  = FEISHU_TABLES.TEMPLATE;

    try {
        const response = await axios.get(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
            { headers: await feishuAuthHeader(), params: { page_size: 50 }, timeout: 12000 }
        );

        const items = response.data?.data?.items || [];
        if (items.length === 0) return res.json(getDefaultTemplates());

        const templates = items.map((record, index) => {
            const f = record.fields || {};
            const pick = (val) => { if (val == null) return ''; if (Array.isArray(val)) return val[0]?.text ?? val[0] ?? ''; return String(val); };
            const opacity = typeof f['透明度'] === 'number' ? f['透明度'] : parseFloat(pick(f['透明度'] ?? f['背景透明度']) || '0.7');
            const posRaw = pick(f['位置'] ?? f['标题位置'] ?? '').toLowerCase();
            const position = posRaw.includes('top') || posRaw.includes('顶') ? 'top' : posRaw.includes('mid') || posRaw.includes('中') ? 'middle' : 'bottom';

            return {
                id: record.record_id || `tpl-${index}`, name: pick(f['模板名称'] ?? f['名称'] ?? f['name']) || `模板 ${index + 1}`,
                position, bgColor: pick(f['背景颜色'] ?? f['背景色'] ?? f['bg_color']) || 'rgba(0,0,0,0.7)', textColor: pick(f['主标题颜色'] ?? f['文字颜色'] ?? f['text_color']) || '#FFFFFF',
                accentColor: pick(f['强调色'] ?? f['accent_color']) || '#ADFF2F', bgOpacity: isNaN(opacity) ? 0.7 : Math.min(1, Math.max(0, opacity)),
                fontSize: parseInt(pick(f['字号'] ?? f['font_size']) || '15', 10), fontWeight: pick(f['字重'] ?? f['font_weight']) || 'bold',
                textAlign: pick(f['对齐方式'] ?? f['text_align']) || 'left', padding: pick(f['内边距'] ?? f['padding']) || '16px', border: pick(f['边框'] ?? f['border']) || 'none',
            };
        });
        res.json(templates);
    } catch (e) {
        res.json(getDefaultTemplates());
    }
});

function getDefaultTemplates() {
    return [
        { id: 'd1', name: '黑底荧光', position: 'bottom', bgColor: 'rgba(0,0,0,0.75)', textColor: '#ADFF2F', accentColor: '#ADFF2F', bgOpacity: 0.75, fontSize: 15, fontWeight: 'bold', textAlign: 'left', padding: '16px', border: 'none' },
        { id: 'd2', name: '纯白极简', position: 'bottom', bgColor: 'rgba(255,255,255,0.88)', textColor: '#111111', accentColor: '#555555', bgOpacity: 0.88, fontSize: 14, fontWeight: '600', textAlign: 'center', padding: '18px', border: 'none' },
    ];
}

// ── 飞书附件 Payload 格式化器 ────────────────────────────────
// Bitable 附件字段严格只接受 [{ file_token: "xxx" }]，
// 这里把前端回传的 URL 数组（含 proxy 外衣）剥成纯净的 file_token 数组。
const formatImagesForFeishu = (imageUrls) => {
    if (!Array.isArray(imageUrls)) return [];
    return imageUrls.map(url => {
        if (!url || typeof url !== 'string') return null;
        let realUrl = url;
        // 1. 脱掉前端 proxy 代理的外衣
        if (url.includes('proxy-img?url=')) {
            try { realUrl = decodeURIComponent(url.split('url=')[1]); } catch (_) {}
        }
        // 2. 提取原始 file_token
        let token = '';
        const match = realUrl.match(/medias\/([a-zA-Z0-9_-]+)\/download/);
        if (match && match[1]) token = match[1];
        return token ? { file_token: token } : null;
    }).filter(Boolean);
};

// ── 飞书图片上传：从 URL 下载后上传 ──────────────────────────
const uploadFeishuImage = async (imageUrl, appToken) => {
    try {
        const headers = await feishuAuthHeader();

        const imgResponse = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            headers: headers,
        });
        const buffer = imgResponse.data;

        const form = new FormData();
        form.append('file_name', 'image.jpg');
        form.append('parent_type', 'bitable_image');
        form.append('parent_node', appToken);
        form.append('size', buffer.length);
        form.append('file', buffer, 'image.jpg');

        const uploadHeaders = { ...headers, ...form.getHeaders() };

        const uploadRes = await axios.post(
            'https://open.feishu.cn/open-apis/drive/v1/medias/upload_all',
            form,
            { headers: uploadHeaders }
        );

        if (uploadRes.data.code !== 0) throw new Error(uploadRes.data.msg);
        return uploadRes.data.data.file_token;
    } catch (error) {
        const msg = error.response?.data?.msg || error.message;
        console.error('[FEISHU] 图片上传失败:', msg);
        return null;
    }
};

// ── 飞书图片上传：直接从 Buffer 上传（供 Base64 合成图使用）────
const uploadFeishuImageFromBuffer = async (buffer, appToken, fileName = 'cover.jpg') => {
    try {
        const headers = await feishuAuthHeader();

        const form = new FormData();
        form.append('file_name', fileName);
        form.append('parent_type', 'bitable_image');
        form.append('parent_node', appToken);
        form.append('size', buffer.length);
        form.append('file', buffer, fileName);

        const uploadHeaders = { ...headers, ...form.getHeaders() };

        const uploadRes = await axios.post(
            'https://open.feishu.cn/open-apis/drive/v1/medias/upload_all',
            form,
            { headers: uploadHeaders }
        );

        if (uploadRes.data.code !== 0) throw new Error(uploadRes.data.msg);
        return uploadRes.data.data.file_token;
    } catch (error) {
        const msg = error.response?.data?.msg || error.message;
        console.error('[FEISHU] Buffer 图片上传失败:', msg);
        return null;
    }
};

// ── WF3 回写飞书 ─────────────────────
// cover_base64：前端 html2canvas 合成的封面图（含标题文字），优先使用
// cover_url：原始底图 URL，仅在 cover_base64 缺失时降级使用
async function syncToFeishu({ topic, title, cover_url, cover_base64, body_text, tags, tags_copy_format, detail_images }) {
    const appToken = process.env.FEISHU_APP_TOKEN;
    const tableId  = FEISHU_TABLES.NOTES;
    // 入参 tags 已经由 WF3 统一加好 # 前缀，这里只做兜底防御
    let tagsArray;
    if (Array.isArray(tags)) {
        tagsArray = tags;
    } else if (typeof tags === 'string') {
        tagsArray = tags.split(/[\s,，]+/).filter(Boolean);
    } else {
        tagsArray = [];
    }
    tagsArray = tagsArray
        .map(t => String(t || '').trim())
        .filter(Boolean)
        .map(t => t.startsWith('#') ? t : `#${t}`);
    // 直接用预拼接的 tags_copy_format；缺省再走 join，但每个元素已带 #，不会再出现"只有首位带 #"
    const tagStr = (typeof tags_copy_format === 'string' && tags_copy_format.trim())
        ? tags_copy_format.trim()
        : tagsArray.join(' ');

    const fields = {
        // '关联选题': topic || '', // 已注释：关联记录(Link)字段不能写入普通字符串，会触发 LinkFieldConvFail
        '笔记标题': title || '',
        '正文内容': body_text || '',
        '话题标签': tagsArray,
        '话题（复制格式）': tagStr,
    };

    const feishuToken = await getFeishuToken();
    if (feishuToken) {
        // ── 封面图上传：优先使用 html2canvas 合成的 Base64（含标题文字）──
        let coverToken = null;
        if (cover_base64 && cover_base64.startsWith('data:image')) {
            console.log('[FEISHU] 使用 Base64 合成封面上传（含标题文字）');
            // 剥离 data URI 头部，转为 Buffer
            const base64Data = cover_base64.replace(/^data:image\/\w+;base64,/, '');
            const buffer = Buffer.from(base64Data, 'base64');
            coverToken = await uploadFeishuImageFromBuffer(buffer, appToken, 'cover_merged.jpg');
        } else if (cover_url) {
            console.log('[FEISHU] 降级：使用原始 cover_url 上传封面');
            coverToken = await uploadFeishuImage(cover_url, appToken);
        }
        if (coverToken) fields['封面图'] = [{ file_token: coverToken }];

        // ── 配图写入 ──────────────────────────────────────────────
        // 首选：detail_images 里若是飞书永久直链（含 medias/{token}/download），直接抽 token，零上传开销
        // 兜底：抽不到 token 的非飞书 URL，下载后再上传换取新 token
        if (detail_images && Array.isArray(detail_images) && detail_images.length > 0) {
            const imagesToProcess = detail_images.slice(0, 18);
            const directTokens = formatImagesForFeishu(imagesToProcess);

            // 标记哪些 URL 已经成功抽到了 token，剩下的走上传兜底
            const validTokens = [...directTokens];
            const extractedSet = new Set();
            for (const url of imagesToProcess) {
                let realUrl = url;
                if (typeof url === 'string' && url.includes('proxy-img?url=')) {
                    try { realUrl = decodeURIComponent(url.split('url=')[1]); } catch (_) {}
                }
                if (typeof realUrl === 'string' && /medias\/([a-zA-Z0-9_-]+)\/download/.test(realUrl)) {
                    extractedSet.add(url);
                }
            }
            const needsUpload = imagesToProcess.filter(u => !extractedSet.has(u));

            console.log(`[FEISHU] 配图 ${imagesToProcess.length} 张：直接复用 file_token ${directTokens.length} 张，需上传 ${needsUpload.length} 张`);

            for (const url of needsUpload) {
                const t = await uploadFeishuImage(url, appToken).catch(e => {
                    console.error('[FEISHU] 配图上传失败', e.message);
                    return null;
                });
                if (t) validTokens.push({ file_token: t });
                await new Promise(resolve => setTimeout(resolve, 300));
            }
            if (validTokens.length > 0) fields['配图'] = validTokens;
        }
    }
    console.log('🔍 [飞书写回排查] 前端传来的原始配图数组:', JSON.stringify(detail_images, null, 2));
    console.log('🔍 [飞书写回排查] 经过处理后，最终放入 fields 的图片 Payload:', JSON.stringify(fields['配图'], null, 2));
    const response = await axios.post(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
        { fields },
        { headers: await feishuAuthHeader(), timeout: 10000 }
    );
    const resData = response.data;
    if (resData.code !== 0) {
        throw new Error(`飞书API报错 [${resData.code}]: ${resData.msg}`);
    }
    const record_id = resData.data?.record?.record_id;
    if (!record_id) {
        throw new Error('飞书写入成功，但在返回体中未找到 record_id');
    }
    return record_id;
}

app.post('/api/sync-to-feishu', async (req, res) => {
    try {
        const recordId = await syncToFeishu(req.body);
        console.log('[FEISHU] ✅ 写入成功，record_id:', recordId);
        res.json({ success: true, record_id: recordId });
    } catch (error) {
        console.error('[FEISHU] ❌ 写入飞书失败:', error.message);
        const errorMsg = error.response?.data?.msg || error.response?.data?.message || error.message || '写入飞书失败';
        res.status(500).json({ success: false, error: errorMsg });
    }
});

// ── 素材库：拉取图片列表（支持 keyword 内存过滤）────────────────
// GET /api/library-images?keyword=xxx
// 真实列名：图片附件列 = '素材图片'，标签列 = '好物标签'
// 策略：拉取最多 30 条，再在 Node.js 内存中做 keyword 模糊匹配，
//       规避飞书 filter 对中文列名的 OData 语法兼容问题
app.get('/api/library-images', async (req, res) => {
    const keyword  = (req.query.keyword || '').trim();

    console.log(`\n[LIBRARY] 素材库请求，keyword="${keyword}"`);
    console.log(`[LIBRARY] app_token=${LIBRARY_APP_TOKEN}，table_id=${LIBRARY_TABLE_ID}`);

    try {
        // 分页拉取全量记录（飞书单次上限 500），用 page_token 循环直到 has_more=false
        const items = [];
        let pageToken = undefined;
        let page = 0;
        do {
            const params = { page_size: 500 };
            if (pageToken) params.page_token = pageToken;
            const response = await axios.get(
                `https://open.feishu.cn/open-apis/bitable/v1/apps/${LIBRARY_APP_TOKEN}/tables/${LIBRARY_TABLE_ID}/records`,
                { headers: await feishuAuthHeader(), params, timeout: 20000 }
            );
            const data = response.data?.data || {};
            const batch = data.items || [];
            items.push(...batch);
            pageToken = data.page_token;
            page++;
            console.log(`[LIBRARY] 第 ${page} 页，本批 ${batch.length} 条，累计 ${items.length} 条，has_more=${data.has_more}`);
            if (!data.has_more) break;
        } while (true);

        console.log(`[LIBRARY] 飞书全量拉取完毕，共 ${items.length} 条记录`);

        // ── 字段提取辅助 ──────────────────────────────────────────
        const pickStr = (v) => {
            if (!v) return '';
            if (Array.isArray(v)) return v.map(t => (typeof t === 'object' ? (t.text || t.value || '') : String(t))).join(',');
            return String(v);
        };

        // 首条记录打印全部字段名，方便核对列名（仅首次）
        if (items.length > 0) {
            console.log('[LIBRARY] 飞书字段名列表:', Object.keys(items[0].fields || {}));
        }

        const libraryImages = items.map(record => {
            const f = record.fields || {};

            // 图片 URL
            const imageField = f['素材图片'];
            let finalUrl = '';
            if (Array.isArray(imageField) && imageField.length > 0) {
                finalUrl = imageField[0].url || imageField[0].tmp_url || '';
            }

            // 各维度文本字段（已按飞书真实列名映射）
            const tags      = pickStr(f['好物标签'] ?? '');
            const scene     = pickStr(f['场景分类'] ?? '');
            const feature   = pickStr(f['拍摄特点'] ?? '');
            const remark    = pickStr(f['备注'] ?? '');
            const multitext = pickStr(f['多行文本'] ?? '');
            const recommend = pickStr(f['封面推荐'] ?? '');

            return {
                id:        record.record_id,
                imageUrl:  finalUrl,
                tags,
                scene,
                feature,
                remark,
                multitext,
                recommend, // 原始推荐级别字符串，用于排序
            };
        }).filter(img => img.imageUrl !== '');

        // ====== 核心替换代码 START ======
        const searchStr = (keyword || '').trim().toLowerCase();

        // 1. 核心场景判定
        const coreScenes = ['阳台','主卧','次卧','卧室','客厅','厨房','卫生间','浴室','书房','玄关','餐厅','儿童房','衣帽间'];
        const matchedScenes = coreScenes.filter(s => searchStr.includes(s));

        let filteredImages = [];

        if (matchedScenes.length > 0) {
            // 【严格模式】：标题包含明确场景，匹配飞书场景与标签
            filteredImages = libraryImages.filter(item => {
                const sceneText = (item.scene || '').toLowerCase();
                const tagsText = (item.tags || '').toLowerCase();
                return matchedScenes.some(s => sceneText.includes(s) || tagsText.includes(s));
            });
            console.log(`[LIBRARY] 严格模式 scenes=${JSON.stringify(matchedScenes)}，命中 ${filteredImages.length} 条`);
        } else {
            // 【泛化模式】：无明确场景，开启长短词双向大乱炖
            filteredImages = libraryImages.filter(item => {
                if (!searchStr) return true;

                // A. 长搜短（飞书所有文本 包含 搜索词）
                const haystack = [item.tags, item.scene, item.feature, item.remark, item.multitext].join(' ').toLowerCase();
                if (haystack.includes(searchStr)) return true;

                // B. 短搜长（搜索词 包含 飞书里的短标签）
                const rawTags = [item.tags, item.scene].join(',').replace(/，/g, ',');
                const shortTags = rawTags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);

                // 只要搜索词包含了标签里的任意短词（如搜索"租房免打孔"，包含飞书标签"租房"），即判定命中
                if (shortTags.some(tag => tag.length >= 2 && searchStr.includes(tag))) return true;

                return false;
            });
            console.log(`[LIBRARY] 泛化模式 searchStr="${searchStr}"，命中 ${filteredImages.length} 条`);
        }

        // 🌟 【无敌兜底机制】：如果过滤后竟然是 0 条，绝对不向前端返回空！降级为全库推荐。
        if (filteredImages.length === 0) {
            console.log(`[LIBRARY] ⚠️ "${searchStr}" 匹配结果为 0，触发无敌兜底，降级为全库 S/A 级推荐！`);
            filteredImages = [...libraryImages];
        }

        // ── 评级打分（复用于排序和补齐）────────────────────────────
        const gradeScore = (val) => {
            const s = (val || '').toLowerCase();
            if (s.includes('s')) return 3;
            if (s.includes('a')) return 2;
            if (s.includes('b')) return 1;
            return 0;
        };

        // 1. 命中结果按评级降序排列
        filteredImages.sort((a, b) => gradeScore(b.recommend) - gradeScore(a.recommend));

        const LIMIT = 30;

        // 2. 命中数量超限：直接截断
        if (filteredImages.length >= LIMIT) {
            const result = filteredImages.slice(0, LIMIT);
            console.log(`[LIBRARY] ✅ 命中 ${filteredImages.length} 条，截断至 ${LIMIT} 条下发`);
            return res.json(result);
        }

        // 3. 命中不足 30：从全量中捞 S 级图片严格去重后补齐
        const existingIds = new Set(filteredImages.map(img => img.id));
        const sLevelSupplements = libraryImages
            .filter(img => gradeScore(img.recommend) === 3 && !existingIds.has(img.id));

        const gap = LIMIT - filteredImages.length;
        const result = [...filteredImages, ...sLevelSupplements.slice(0, gap)];

        console.log(`[LIBRARY] ✅ 命中 ${filteredImages.length} 条，S级补齐 ${Math.min(sLevelSupplements.length, gap)} 条，最终下发 ${result.length} 条`);
        // ====== 核心替换代码 END ======

        res.json(result);
    } catch (e) {
        const errMsg = e.response ? JSON.stringify(e.response.data) : e.message;
        console.error('[LIBRARY] ❌ 素材库请求失败:', errMsg);
        res.status(500).json({ error: errMsg, images: [] });
    }
});

app.listen(PORT, () => {
    console.log(`\n🚀 SOP 引擎已切换至 Webhook 专线模式，端口 ${PORT} 待命！`);
});
