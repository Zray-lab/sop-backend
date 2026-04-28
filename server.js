const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => {
  res.send('✅ SOP 后端大脑已启动！');
});

app.post('/api/coze', (req, res) => {
  res.json({ success: true, message: '接口已连通' });
});

app.post('/api/feishu', (req, res) => {
  res.json({ success: true, message: '接口已连通' });
});

app.listen(PORT, () => {
  console.log(`🚀 服务运行在端口: ${PORT}`);
});
