/* 仅供本地集成测试用的静态文件服务器（http://127.0.0.1:8899） */
const http = require('http');
const fs = require('fs');
const path = require('path');

/* 本包是自包含的：web/ 与 core/ 都在脚本所在目录下，所以根目录就是这里。
   （这一份原本是仓库里的 test/server.js，那边根目录需要往上一层。） */
const ROOT = __dirname;
const PORT = Number(process.env.PORT || process.argv[2] || 8899);
const TYPES = {
  '.html': 'text/html;charset=utf-8',
  '.js': 'text/javascript;charset=utf-8',
  '.css': 'text/css;charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json;charset=utf-8',
};

http.createServer((req, res) => {
  const url = decodeURIComponent(String(req.url || '/').split('?')[0]);
  const rel = url === '/' ? 'test/harness.html' : url.replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain;charset=utf-8' });
      res.end('not found: ' + rel);
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log('test server: http://127.0.0.1:' + PORT + '/test/harness.html');
});
