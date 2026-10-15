/* ============================================================================
 * 网页版：把 ui.js 的捕获结果转成 SVG，供 Figma 网页版直接使用
 *
 * ui.js 是插件和网页版共用的捕获引擎，它按照「插件主线程」的协议往外发消息
 * （parent.postMessage）。在网页里 parent === window，所以这里把 postMessage
 * 接管掉：收到 render 快照就自己渲染 SVG，再把 done 消息喂回 ui.js，
 * 这样日志、报告、按钮状态这些界面逻辑完全复用，不用改 ui.js 一行。
 *
 * 本文件下半部分是纯粹的前端交互增强（状态、缩放、提示、快捷操作），
 * 全部围绕 ui.js 已有的 DOM 约定工作，不改动捕获引擎。
 * ========================================================================== */
(function () {
  'use strict';

  const app = {
    payload: null,
    svg: null,
    svgUrl: null,
    png: null,
    imageMap: new Map(),
    busy: false,
    zoom: 'fit',
  };
  window.__h2f = app;

  const $id = (id) => document.getElementById(id);
  const SVG_RUN = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l14 9-14 9z"/></svg>';
  const SVG_SPIN = '<svg class="spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9" /></svg>';

  /* ------------------------------ 接管消息 ------------------------------- */

  const nativePostMessage = window.postMessage.bind(window);

  window.postMessage = function (msg, targetOrigin, transfer) {
    const pm = msg && msg.pluginMessage;
    if (pm && pm.type === 'render') {
      onRender(pm.payload);
      return undefined;
    }
    if (pm && pm.type === 'get-image') {
      /* 插件的按需取图协议：网页版在渲染前一次性解析，这里直接回空避免等待 */
      return undefined;
    }
    if (pm && pm.type === 'notify') {
      if (typeof log === 'function') log(String(pm.message || ''), 'warn');
      return undefined;
    }
    try {
      return nativePostMessage(msg, targetOrigin || '*', transfer);
    } catch (e) {
      return undefined;
    }
  };

  /* ------------------------------ 图片内嵌 ------------------------------- */

  function blobToBase64(blob) {
    return new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || '').split(',')[1] || null);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(blob);
    });
  }

  function mimeFromUrl(url) {
    const m = /^data:([^;,]+)/i.exec(url || '');
    if (m) return m[1];
    const ext = (/\.([a-z0-9]+)(?:[?#]|$)/i.exec(url || '') || [])[1];
    const map = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif' };
    return map[(ext || '').toLowerCase()] || 'image/png';
  }

  async function toDataUrl(item) {
    const entry = (typeof state !== 'undefined' && state.images) ? state.images.get(item.ref) : null;
    const known = (entry && entry.dataUrl) || (entry && entry.url) || item.url || '';
    if (/^data:/i.test(known)) return known;
    if (!known || known === '(内联 dataURL)') return null;
    try {
      const res = await fetch(known, { mode: 'cors', credentials: 'omit' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const b64 = await blobToBase64(blob);
      if (!b64) throw new Error('读取失败');
      return 'data:' + (blob.type && /^image\//.test(blob.type) ? blob.type : mimeFromUrl(known)) + ';base64,' + b64;
    } catch (e) {
      return null;
    }
  }

  async function resolveImages(payload) {
    const list = payload.images || [];
    const map = new Map();
    let done = 0;
    await Promise.all(list.map(async (item) => {
      const dataUrl = await toDataUrl(item);
      if (dataUrl) map.set(item.ref, dataUrl);
      done++;
      if (typeof setProgress === 'function') setProgress('内嵌图片', done, list.length);
    }));
    return map;
  }

  /* ------------------------------ 快照 -> SVG ---------------------------- */

  function countRecords(rec) {
    let n = 1;
    if (rec && rec.children) for (const c of rec.children) n += countRecords(c);
    return n;
  }

  function countTexts(rec) {
    let n = rec && rec.t === 'text' ? 1 : 0;
    if (rec && rec.children) for (const c of rec.children) n += countTexts(c);
    return n;
  }

  function fontCount(rec, set) {
    if (rec && rec.t === 'text' && rec.text) {
      set.add([(rec.text.families || []).join(','), rec.text.weight, rec.text.italic ? 1 : 0].join('|'));
    }
    if (rec && rec.children) for (const c of rec.children) fontCount(c, set);
    return set;
  }

  /* 快照 -> SVG 的统一入口：内嵌图片、生成 SVG、汇总提示 */
  async function handlePayload(payload) {
    const imageMap = await resolveImages(payload);
    if (typeof log === 'function') log('生成 SVG…');
    const built = H2FSvg.build(payload, imageMap);
    const warns = (payload.warnings || []).concat(built.warnings);
    warns.push('SVG 路线经由 Figma 的 SVG 导入：逐边描边、混合模式、内阴影、clip-path 等会丢失或降级；'
      + '字体按字体族名引用，Figma 用已安装的同名字体渲染，网络字体不会跟随。');
    return {
      svg: built.svg,
      counts: built.counts,
      bytes: built.bytes,
      warnings: warns,
      imageMap,
      w: payload.meta.w,
      h: payload.meta.h,
    };
  }

  async function onRender(payload) {
    /* 单文件路径也把快照交给 handlePayload，拿到图层数后即释放，避免长期占内存 */
    const snapshot = {
      payload,
      w: payload.meta.w,
      h: payload.meta.h,
      name: (payload.meta.title || 'html-snapshot').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60),
    };
    app.busy = true;
    setButtons(false);
    setStatus('running', '生成 SVG…');
    if (typeof log === 'function') log('把图片内嵌进 SVG…');

    try {
      const built = await handlePayload(payload);
      app.svg = built.svg;
      app.svgCounts = built.counts;
      app.w = built.w;
      app.h = built.h;
      app.name = snapshot.name;
      /* 单文件路径按原样保留快照（测试与调试都依赖 window.__h2f.payload），
         批量路径则在每项完成后立刻释放，避免多份快照同时驻留 */
      app.payload = payload;
      app.imageMap = built.imageMap;

      /* 单文件路径：引擎刚跑完，沙箱（state.stage）还在，顺手抽一份交互 */
      if (window.H2FInteract && typeof state !== 'undefined' && state.stage) {
        try {
          const ix = window.H2FInteract.extract(state.stage, { pagePath: app.name || '' });
          app.interactions = ix.interactions;
          payload.interactions = ix.interactions;
          if (ix.interactions.length && typeof log === 'function') {
            log('识别到 ' + ix.interactions.length + ' 条交互跳转、' + ix.hoverRules.length + ' 条 :hover 规则', 'ok');
          }
        } catch (e) { /* 交互提取失败不影响出图 */ }
      }

      showPreview(built.svg);

      const warns = built.warnings;
      const c = built.counts;
      app.lastLine = 'SVG 就绪：' + Math.round(built.bytes / 1024) + ' KB，' + c.rect + ' 矩形 / ' + c.path + ' 路径 / '
        + c.text + ' 文本 / ' + c.image + ' 图片 / ' + c.gradient + ' 渐变';
      if (typeof log === 'function') log(app.lastLine, 'ok');
      toast('SVG 已生成 · ' + fmtInt(built.w) + ' × ' + fmtInt(built.h), 'ok');
      if (window.innerWidth <= 1080) setDrawer(false);

      if (typeof window.onmessage === 'function') {
        window.onmessage({
          data: {
            pluginMessage: {
              type: 'done',
              stats: {
                nodes: countRecords(payload.root),
                texts: countTexts(payload.root),
                images: built.imageMap.size,
                fonts: fontCount(payload.root, new Set()).size,
              },
              warnings: warns,
            },
          },
        });
      }
    } catch (e) {
      setStatus('error', '生成失败');
      if (typeof log === 'function') log('生成 SVG 失败：' + (e && e.message ? e.message : e), 'error');
      toast('生成 SVG 失败：' + (e && e.message ? e.message : e), 'error');
      if (typeof window.onmessage === 'function') {
        window.onmessage({ data: { pluginMessage: { type: 'error', message: String(e && e.message || e) } } });
      }
    } finally {
      app.busy = false;
      setButtons(!!app.svg);
    }
  }

  /* ------------------------------- 预览 ---------------------------------- */

  function fmtInt(n) {
    const v = Math.round(Number(n) || 0);
    return v.toLocaleString('en-US');
  }

  function updateMetaChips() {
    const box = $id('meta-chips');
    if (!box) return;
    if (!app.svg) { box.innerHTML = ''; return; }
    const c = app.svgCounts || {};
    const layers = (c.rect || 0) + (c.path || 0) + (c.text || 0) + (c.image || 0);
    const chips = [
      ['brand', fmtInt(app.w) + ' × ' + fmtInt(app.h)],
      ['', Math.max(1, Math.round((app.svg || '').length / 1024)) + ' KB'],
      ['', fmtInt(layers) + ' 图层'],
    ];
    if (c.text) chips.push(['', fmtInt(c.text) + ' 文本']);
    if (c.image) chips.push(['', fmtInt(c.image) + ' 图片']);
    box.innerHTML = chips.map(([cls, text]) =>
      '<span class="mchip' + (cls ? ' ' + cls : '') + '">' + text + '</span>').join('');
  }

  function setZoom(mode) {
    app.zoom = mode;
    const wrap = $id('canvas-wrap');
    const stage = $id('preview-stage');
    if (wrap) {
      wrap.classList.toggle('no-fit', mode === '100');
      wrap.classList.toggle('is-zoomed', mode === '100');
    }
    if (stage) stage.style.transform = 'none';
    const fit = $id('btn-fit');
    const full = $id('btn-100');
    if (fit) fit.setAttribute('aria-pressed', mode === 'fit' ? 'true' : 'false');
    if (full) full.setAttribute('aria-pressed', mode === '100' ? 'true' : 'false');
    if (wrap) { wrap.scrollTop = 0; wrap.scrollLeft = 0; }
  }

  let emptyDefaultText = null;

  function clearPreview(message) {
    app.svg = null;
    app.svgCounts = null;
    app.payload = null;
    app.imageMap = new Map();
    app.name = 'html-snapshot';
    setButtons(false);
    const img = $id('preview');
    if (img) img.removeAttribute('src');
    const stage = $id('preview-stage');
    if (stage) stage.classList.remove('has-content');
    const chips = $id('meta-chips');
    if (chips) chips.innerHTML = '';
    const empty = $id('preview-empty');
    if (empty) {
      empty.style.display = '';
      const p = empty.querySelector('p');
      if (p) {
        if (emptyDefaultText == null) emptyDefaultText = p.textContent;
        p.textContent = message || emptyDefaultText;
      }
    }
  }

  function showPreview(svg) {
    const img = $id('preview');
    if (!img) return;
    if (app.svgUrl) URL.revokeObjectURL(app.svgUrl);
    app.svgUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    img.src = app.svgUrl;
    const stage = $id('preview-stage');
    if (stage) stage.classList.add('has-content');
    const empty = $id('preview-empty');
    if (empty) empty.style.display = 'none';
    updateMetaChips();
    setZoom(app.zoom || 'fit');
    /* 让结果立刻可见（窄屏时左栏在上） */
    const wrap = $id('canvas-wrap');
    if (wrap) {
      wrap.classList.remove('flash');
      void wrap.offsetWidth;
      wrap.classList.add('flash');
      setTimeout(() => wrap.classList.remove('flash'), 900);
    }
  }

  /* ------------------------------- 导出 ---------------------------------- */

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 500);
  }

  function setButtons(enabled) {
    for (const id of ['btn-svg', 'btn-copy', 'btn-png', 'btn-open']) {
      const el = $id(id);
      if (el) el.disabled = !enabled;
    }
  }

  function svgBlob() {
    return new Blob([app.svg], { type: 'image/svg+xml;charset=utf-8' });
  }

  function saveSvg() {
    if (!app.svg) return;
    download(svgBlob(), app.name + '.svg');
    if (typeof log === 'function') log('已下载 ' + app.name + '.svg —— 拖进 Figma 网页版画布即可', 'ok');
    toast('已下载 ' + app.name + '.svg', 'ok');
  }

  async function copySvg() {
    if (!app.svg) return;
    const btn = $id('btn-copy');
    const flash = (text, cls) => {
      if (!btn) return;
      const orig = btn.getAttribute('data-label') || btn.textContent;
      btn.setAttribute('data-label', orig);
      btn.textContent = text;
      setTimeout(() => { if (btn.getAttribute('data-label') === orig) btn.textContent = orig; }, 1500);
      toast(text, cls || 'ok');
    };
    try {
      if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([app.svg], { type: 'text/html' }),
            'text/plain': new Blob([app.svg], { type: 'text/plain' }),
          }),
        ]);
        if (typeof log === 'function') log('已按矢量格式复制，去 Figma 画布 Ctrl/Cmd+V 粘贴', 'ok');
        flash('已复制 ✓');
        return;
      }
      throw new Error('当前浏览器不支持写入 HTML 剪贴板');
    } catch (e) {
      try {
        await navigator.clipboard.writeText(app.svg);
        if (typeof log === 'function') log('已复制纯文本。纯文本粘贴到 Figma 可能只会变成文本图层，建议改用「下载 SVG」再拖入', 'warn');
        flash('已复制文本', 'warn');
      } catch (e2) {
        if (typeof log === 'function') log('复制失败，请改用「下载 SVG」：' + (e2 && e2.message ? e2.message : e2), 'error');
        toast('复制失败，请改用「下载 SVG」', 'error');
      }
    }
  }

  async function savePng() {
    if (!app.svg) return;
    const btn = $id('btn-png');
    const scale = 2;
    const w = Math.round((app.w || 0) * scale);
    const h = Math.round((app.h || 0) * scale);
    if (btn) { btn.disabled = true; btn.textContent = '导出中…'; }
    try {
      const url = URL.createObjectURL(svgBlob());
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = () => rej(new Error('SVG 光栅化失败'));
        img.src = url;
      });
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      const c2 = cv.getContext('2d');
      c2.fillStyle = '#fff';
      c2.fillRect(0, 0, w, h);
      c2.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
      if (!blob) throw new Error('导出失败（画布被跨域污染）');
      download(blob, app.name + '@2x.png');
      if (typeof log === 'function') log('已下载 ' + app.name + '@2x.png（' + w + '×' + h + '）。注意：网络字体在光栅化时同样不会被加载', 'warn');
      toast('已下载 PNG @2x · ' + w + ' × ' + h, 'ok');
    } catch (e) {
      if (typeof log === 'function') log('PNG 导出失败：' + (e && e.message ? e.message : e), 'error');
      toast('PNG 导出失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '下载 PNG @2x'; }
    }
  }

  function openSvg() {
    if (!app.svgUrl) return;
    window.open(app.svgUrl, '_blank');
  }

  /* --------------------------- 轻提示 / 状态 ----------------------------- */

  let toastTimer = null;

  function toast(message, cls) {
    const box = $id('toasts');
    if (!box || !message) return;
    const el = document.createElement('div');
    el.className = 'toast' + (cls ? ' ' + cls : '');
    el.textContent = message;
    box.appendChild(el);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 240);
    }, 2600);
    clearTimeout(toastTimer);
  }

  /* 提示固定在预览面板右下角（不随画布滚动） */
  function watchToasts() {
    const box = $id('toasts');
    if (!box) return;
    new MutationObserver(() => {
      while (box.children.length > 3) box.removeChild(box.firstChild);
    }).observe(box, { childList: true });
  }

  function setStatus(state, text) {
    const pill = $id('status-pill');
    const label = $id('status-text');
    if (pill) pill.setAttribute('data-state', state);
    if (label && text) label.textContent = text;
  }

  function setRunLabel(text) {
    const l = $id('run-label');
    const icon = $id('run-icon');
    if (l) l.textContent = text;
    const btn = $id('btn-run');
    if (btn) btn.title = text === '生成中…' ? '正在捕获并生成，可按 Esc 取消' : 'Ctrl/⌘ + Enter';
    if (icon && icon.parentNode) {
      const holder = document.createElement('span');
      holder.innerHTML = text === '生成中…' ? SVG_SPIN : SVG_RUN;
      icon.parentNode.replaceChild(holder.firstChild, icon);
    }
  }

  /* ui.js 直接写 #progress-label，这里只按文案派生视觉状态（批量模式的文案由 batchProgress 负责，不要覆盖） */
  function watchProgressLabel() {
    const label = $id('progress-label');
    if (!label) return;
    const sync = () => {
      if (batch.running) return;
      const t = label.textContent || '';
      let state = 'idle';
      let text = t;
      if (/^完成/.test(t)) state = 'done';
      else if (/失败|错误|取消/.test(t)) state = 'error';
      else if (t && t !== '待开始') state = 'running';
      if (state === 'idle') text = '待开始 · Ctrl/⌘ + Enter 开始';
      if (state === 'running') setStatus('running', t.split(' ')[0] || '处理中');
      else if (state === 'done') setStatus('done', '已完成');
      label.setAttribute('data-state', state);
      if (label.textContent !== text) label.textContent = text;
    };
    new MutationObserver(sync).observe(label, { childList: true, characterData: true, subtree: true });
    sync();
  }

  function watchRunButton() {
    const btn = $id('btn-run');
    if (!btn) return;
    const sync = () => {
      setRunLabel(btn.disabled ? (batch.running ? '批量生成中…' : '生成中…') : '开始生成');
      if (btn.disabled) setStatus('running', batch.running ? '批量处理中' : '处理中');
      else if (!app.busy && app.svg) setStatus('done', '已完成');
    };
    new MutationObserver(sync).observe(btn, { attributes: true, attributeFilter: ['disabled'] });
    sync();
  }

  /* --------------------------- 日志与结果面板 ---------------------------- */

  function wireLogPanel() {
    const logBox = $id('log');
    const reportBox = $id('report');
    const tabLog = $id('tab-log');
    const tabReport = $id('tab-report');
    const count = $id('report-count');
    const note = $id('log-note');
    const copyLog = $id('btn-copy-log');
    const card = $id('card-log');
    if (!logBox || !tabLog || !tabReport) return;

    const show = (which) => {
      const isLog = which === 'log';
      logBox.style.display = isLog ? '' : 'none';
      if (reportBox) reportBox.style.display = isLog ? 'none' : '';
      tabLog.setAttribute('aria-selected', isLog ? 'true' : 'false');
      tabReport.setAttribute('aria-selected', isLog ? 'false' : 'true');
    };
    tabLog.onclick = () => show('log');
    tabReport.onclick = () => show('report');

    /* 日志卡片滚动到可见：卡片本身吸顶，之后左栏滚动时标题栏会留在顶部 */
    function revealLog() {
      const scroller = document.querySelector('.left-scroll');
      if (!card || !scroller) return;
      const cr = card.getBoundingClientRect();
      const sr = scroller.getBoundingClientRect();
      const margin = 12;
      if (cr.top < sr.top + margin) scroller.scrollBy({ top: cr.top - sr.top - margin, behavior: 'smooth' });
      else if (cr.bottom > sr.bottom - margin) scroller.scrollBy({ top: Math.min(cr.bottom - sr.bottom + margin, cr.top - sr.top - margin), behavior: 'smooth' });
    }

    /* 结果区出现内容时更新计数徽标，并在完成后把结果推到眼前 */
    if (reportBox) {
      new MutationObserver(() => {
        const has = reportBox.children.length > 0;
        if (count) {
          const n = reportBox.querySelectorAll('.warn-list li').length;
          count.style.display = has ? '' : 'none';
          count.textContent = n ? String(n) : '·';
          count.title = n ? n + ' 条提示与限制' : '捕获统计';
        }
        if (has) {
          show('report');
          if (card) card.open = true;
          const last = (logBox.textContent || '').trim().split('\n').slice(-1)[0] || '';
          if (note) note.textContent = last.slice(0, 40);
        }
      }).observe(reportBox, { childList: true });
    }

    /* 日志变化时更新摘要；新的一行出现时滚到底部，并在日志卡片不在视野里时把它带进来 */
    let autoRevealed = false;
    if (card) card.addEventListener('toggle', () => { autoRevealed = true; });
    new MutationObserver(() => {
      const lines = logBox.querySelectorAll('.log-line');
      const last = lines.length ? lines[lines.length - 1].textContent : '';
      if (note && last) note.textContent = last.slice(0, 40);
      logBox.scrollTop = logBox.scrollHeight;
      if (!autoRevealed) { revealLog(); autoRevealed = true; }
      const isErr = /失败|错误/.test(last);
      if (isErr) setStatus('error', '出错了');
    }).observe(logBox, { childList: true });

    if (copyLog) {
      copyLog.onclick = async () => {
        const text = logBox.textContent || '';
        if (!text.trim()) { toast('日志为空', 'warn'); return; }
        try {
          await navigator.clipboard.writeText(text);
          toast('已复制全部日志', 'ok');
        } catch (e) {
          toast('复制失败', 'error');
        }
      };
    }

    /* 单击某一行日志即可单独复制 */
    logBox.addEventListener('click', async (ev) => {
      const line = ev.target && ev.target.closest ? ev.target.closest('.log-line') : null;
      if (!line) return;
      try {
        await navigator.clipboard.writeText(line.textContent || '');
        toast('已复制该行日志', 'ok');
      } catch (e) { /* 剪贴板不可用时静默 */ }
    });
  }

  /* ui.js 调用 report() 时会同时查找到这里的同名函数：网页版把结果列表收进一个
     定高滚动区，并让提示默认只展开前几条（按「展开全部」查看剩余），
     免得几十条提示把侧栏撑出屏幕。DOM 契约与 ui.js 保持一致。 */
  const WARN_PREVIEW = 6;

  function renderReport(data) {
    const box = $id('report');
    if (!box || !box.querySelectorAll) return;
    box.innerHTML = '';
    const body = document.createElement('div');
    body.className = 'report-body';
    const stats = (data && data.stats) || {};
    const items = [
      ['图层总数', stats.nodes],
      ['文本图层', stats.texts],
      ['图片资源', stats.images],
      ['字体数', stats.fonts],
      ['捕获元素', data && data.captureStats ? data.captureStats.elements : '-'],
      ['捕获文本', data && data.captureStats ? data.captureStats.texts : '-'],
    ];
    const wrap = document.createElement('div');
    wrap.className = 'stats';
    for (const it of items) {
      if (it[1] == null) continue;
      const cell = document.createElement('div');
      cell.className = 'stat';
      cell.innerHTML = '<b>' + it[1] + '</b><span>' + it[0] + '</span>';
      wrap.appendChild(cell);
    }
    body.appendChild(wrap);

    const warns = (data && data.warnings) || [];
    if (warns.length) {
      const h = document.createElement('div');
      h.className = 'sect-title';
      h.textContent = '提示与限制（' + warns.length + '）';
      body.appendChild(h);
      const ul = document.createElement('ul');
      ul.className = 'warn-list';
      warns.forEach((w, i) => {
        const li = document.createElement('li');
        li.textContent = w;
        if (i >= WARN_PREVIEW) li.className = 'warn-hidden';
        ul.appendChild(li);
      });
      body.appendChild(ul);
      if (warns.length > WARN_PREVIEW) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'warn-more';
        btn.textContent = '展开另外 ' + (warns.length - WARN_PREVIEW) + ' 条';
        btn.onclick = () => {
          ul.querySelectorAll('.warn-hidden').forEach((li) => li.classList.remove('warn-hidden'));
          btn.remove();
        };
        body.appendChild(btn);
      }
    }
    box.appendChild(body);
  }

  /* ==========================================================================
   * 批量模式：一次导入多个 .html，排队逐个捕获并导出
   *
   * 队列项只保存「文件名 + 源码」，渲染结果按需产出，随时可以重新生成。
   * 逐项处理时直接调用 ui.js 的捕获引擎（buildDocument / loadStage /
   * settleStage / capture），拿到快照后再走同一条 SVG 生成路径，
   * 因此批量结果与单文件结果完全一致。
   * ======================================================================== */

  const batch = {
    items: [],
    activeId: null,
    running: false,
    cancel: false,
    token: 0,
    restored: 0,
  };
  app.batch = batch;
  app.batchAddFiles = (files) => batchAddFiles(files);

  const BATCH_KEY = 'h2f.web.batch.v1';
  const BATCH_LIMIT = 80;              /* 单次队列上限，避免一次读爆内存 */
  const BATCH_PERSIST_BYTES = 1200000; /* 只把不太大的队列写进 localStorage */
  let batchSeq = 0;
  const batchStore = (() => {
    try { return typeof localStorage !== 'undefined' && !!localStorage; } catch (e) { return false; }
  })();

  function sanitizeName(name) {
    const base = String(name || 'untitled')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+/, '');
    return (base || 'untitled').slice(0, 80);
  }

  function bytesText(n) {
    const v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
    return (v / 1048576).toFixed(2) + ' MB';
  }

  /* ------------------------------ 队列维护 ------------------------------- */

  function batchAdd(files) {
    const list = Array.prototype.slice.call(files || []).filter(Boolean);
    if (!list.length) return 0;
    let room = BATCH_LIMIT - batch.items.length;
    if (room <= 0) {
      toast('队列已达上限 ' + BATCH_LIMIT + ' 个文件', 'warn');
      return 0;
    }
    if (list.length > room) {
      toast('队列上限 ' + BATCH_LIMIT + ' 个，只加入前 ' + room + ' 个', 'warn');
    }
    const accepted = [];
    for (const f of list.slice(0, room)) {
      const type = String(f.type || '');
      if (!/\.html?$/i.test(f.name || '') && type.indexOf('html') < 0) continue;
      accepted.push({
        id: ++batchSeq,
        name: f.name || ('file-' + batchSeq + '.html'),
        size: f.size || 0,
        source: f.source != null ? String(f.source) : null,
        file: f.source != null ? null : f,
      });
    }
    if (!accepted.length) {
      toast('没找到可用的 .html 文件', 'warn');
      return 0;
    }
    accepted.forEach((it) => batch.items.push(it));
    renderBatch();
    saveBatch();
    return accepted.length;
  }

  async function batchAddFiles(files) {
    if (!files || !files.length) return;
    const n = batchAdd(files);
    if (n) {
      if (typeof setTab === 'function') setTab('file');
      toast('已加入 ' + n + ' 个文件，共 ' + batch.items.length + ' 个待处理', 'ok');
    }
    await batchHydrate();
  }

  /* ===================== 整包（VFS）与交互全景画布 ====================== */
  /* 承接 core/vfs.js（整包解析）、core/interactions.js（交互提取）与
     core/flow.js（全景画布 + 结构树）。三者都是纯逻辑模块，这里只做接线：
       整包 → 队列 → 每页内联后交给捕获引擎 → 抽交互 → 合成全景画布 */

  const pack = { vfs: null, flow: null };

  function packReady() {
    return !!(window.H2FVfs && window.H2FInteract && window.H2FFlow);
  }

  function packSummary(text) {
    const el = $id('pack-summary');
    if (!el) return;
    if (!text) { el.style.display = 'none'; el.textContent = ''; return; }
    el.style.display = 'block';
    el.textContent = text;
  }

  /* 导入整包：解 ZIP / 递归读文件夹 → VFS → 每个 HTML 成为一个队列项。
     源码不在这里读，等轮到该页时再 bundle（内联 CSS 与图片），避免一次吃满内存 */
  async function packIngest(input, label) {
    if (!packReady()) { toast('整包模块未加载（core/vfs.js 缺失）', 'error'); return; }
    if (!pack.vfs) pack.vfs = window.H2FVfs.create();
    setStatus('running', '解析整包…');
    if (typeof log === 'function') log('解析整包' + (label ? '：' + label : '') + '…');

    let stats;
    try {
      stats = await pack.vfs.ingest(input, (msg) => { if (typeof log === 'function') log('  ' + msg); });
    } catch (e) {
      const m = e && e.message ? e.message : String(e);
      setStatus('error', '整包解析失败');
      toast('整包解析失败：' + m, 'error');
      if (typeof log === 'function') log('整包解析失败：' + m, 'error');
      return;
    }
    if (!stats.html) {
      setStatus('error', '包里没有 HTML');
      toast('这个包里没有找到 HTML 页面', 'warn');
      return;
    }

    /* 新的整包替换掉上一批整包页面；单独添加的普通文件保留 */
    batch.items = batch.items.filter((it) => !it.vfsPath);
    const pages = pack.vfs.pages();
    const room = Math.max(0, BATCH_LIMIT - batch.items.length);
    const use = pages.slice(0, room);
    for (const p of use) {
      batch.items.push({
        id: ++batchSeq,
        name: p.path,
        size: p.rawHtml.length,
        source: null,
        file: null,
        vfsPath: p.path,
        status: 'pending',
        error: '',
      });
    }
    if (pages.length > use.length) toast('页面超过队列上限 ' + BATCH_LIMIT + '，只加入前 ' + use.length + ' 个', 'warn');
    renderBatch();
    saveBatch();
    syncFlowButtons();
    setStatus('idle', '待开始');
    packSummary('VFS：' + stats.html + ' HTML · ' + stats.css + ' CSS · ' + stats.assets + ' 资源'
      + (stats.skipped.length ? ' · 跳过 ' + stats.skipped.length + ' 项' : ''));
    if (typeof log === 'function') {
      log('整包就绪：' + stats.html + ' 个页面、' + stats.css + ' 个样式表、' + stats.assets + ' 个资源', 'ok');
      stats.skipped.slice(0, 8).forEach((s) => log('  ⚠ ' + s, 'warn'));
    }
    toast('整包已导入：' + use.length + ' 个页面', 'ok');
  }

  /* 把所有已完成的页面拼成一张全景画布（页面并排 + 跳转连线） */
  function buildFlow() {
    if (!window.H2FFlow) return null;
    const done = batch.items.filter((it) => it.status === 'done' && it.result && it.result.svg);
    if (!done.length) { pack.flow = null; return null; }
    /* 每页后面紧跟它自己的 :hover 状态稿，左右对照看效果 */
    const pages = [];
    for (const it of done) {
      const name = it.vfsPath || it.name;
      pages.push({
        name: name,
        w: it.result.w,
        h: it.result.h,
        svg: it.result.svg,
        interactions: it.result.interactions || [],
      });
      for (const st of (it.result.states || [])) {
        pages.push({
          name: name + ' ▸ :hover ' + st.base,
          w: st.w,
          h: st.h,
          svg: st.svg,
          interactions: [],
        });
      }
    }
    pack.flow = window.H2FFlow.build(pages, {});
    return pack.flow;
  }

  function syncFlowButtons() {
    const has = batch.items.some((it) => it.status === 'done' && it.result && it.result.svg);
    ['btn-flow', 'btn-flow-svg', 'btn-flow-json'].forEach((id) => {
      const b = $id(id);
      if (b) b.disabled = !has;
    });
  }

  function showFlow() {
    const flow = buildFlow();
    if (!flow || !flow.svg) { toast('先生成至少一个页面', 'warn'); return; }
    showPreview(flow.svg);
    app.svg = flow.svg;
    app.flowView = true;
    if (typeof log === 'function') {
      log('全景交互画布：' + flow.pages.length + ' 页 · ' + flow.wires + ' 条跳转连线 · ' + flow.w + '×' + flow.h, 'ok');
    }
    toast('已切到全景交互画布（' + flow.wires + ' 条连线）', 'ok');
  }

  function exportFlowSvg() {
    const flow = buildFlow();
    if (!flow || !flow.svg) { toast('先生成至少一个页面', 'warn'); return; }
    download(new Blob([flow.svg], { type: 'image/svg+xml;charset=utf-8' }), 'html-to-figma-flow.svg');
    if (typeof log === 'function') log('已导出全景画布 SVG（' + flow.pages.length + ' 页 / ' + flow.wires + ' 条连线）', 'ok');
  }

  function exportFlowJson() {
    if (!window.H2FFlow) return;
    const done = batch.items.filter((it) => it.status === 'done' && it.result);
    if (!done.length) { toast('先生成至少一个页面', 'warn'); return; }
    const flow = pack.flow || buildFlow();
    const json = window.H2FFlow.toJson(done.map((it) => ({
      name: it.vfsPath || it.name,
      w: it.result.w,
      h: it.result.h,
      svg: it.result.svg,
      tree: it.result.tree || null,
      interactions: it.result.interactions || [],
      hoverRules: it.result.hoverRules || [],
      warnings: it.result.warnings || [],
    })), { canvas: flow ? { w: flow.w, h: flow.h } : null });
    download(new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' }), 'html-to-figma-flow.json');
    if (typeof log === 'function') {
      log('已导出交互结构树：' + json.summary.pages + ' 页 / ' + json.summary.interactions + ' 条交互', 'ok');
    }
  }

  /* 把当前预览切成低保真线框稿：对已保存的快照做变换，不必重新捕获 */
  /** 勾没勾「弹层单独成稿」（默认开） */
  function overlayOn() {
    const el = document.getElementById('overlayStates');
    return !(el && !el.checked);
  }

  /** 勾没勾「白色衬底」 */
  function backdropOn() {
    const el = document.getElementById('backdrop');
    return !!(el && el.checked);
  }

  async function toggleLowfi() {
    const payload = app.payload;
    if (!window.H2FLowfi) { toast('低保真模块未加载', 'error'); return; }
    if (!payload) { toast('当前没有可用的快照：直接勾选左侧「低保真线框稿」重新生成即可', 'warn'); return; }
    if (payload.lowfi) { toast('当前已经是低保真稿', 'warn'); return; }
    let low = window.H2FLowfi.transform(payload, {});
    if (backdropOn() && window.H2FBackdrop) low = window.H2FBackdrop.apply(low, {});
    const built = await handlePayload(low);
    showPreview(built.svg);
    app.svg = built.svg;
    app.payload = low;
    const cur = batch.items.find((it) => it.id === batch.activeId);
    if (cur && cur.result) {
      cur.result.svg = built.svg;
      cur.result.w = built.w;
      cur.result.h = built.h;
      cur.result.lowfi = true;
      renderBatch();
    }
    if (typeof log === 'function') log('已把当前预览切到低保真线框稿', 'ok');
    toast('低保真线框稿就绪', 'ok');
  }

  /* 给测试与调试留出口（test/flow-test.js 走这里） */
  app.pack = pack;
  app.packIngest = packIngest;
  app.buildFlow = buildFlow;
  app.showFlow = showFlow;
  app.exportFlowSvg = exportFlowSvg;
  app.exportFlowJson = exportFlowJson;
  app.syncFlowButtons = syncFlowButtons;
  app.toggleLowfi = toggleLowfi;
  /* 供共用面板（core/session.js 的文件模式）把多选文件丢进批量队列 */
  app.batchAddFiles = batchAddFiles;
  /* 每页的捕获结果摘要：交互表、hover 规则、图层树 */
  app.results = () => batch.items.filter((it) => it.result).map((it) => ({
    name: it.vfsPath || it.name,
    status: it.status,
    w: it.result.w,
    h: it.result.h,
    interactions: it.result.interactions || [],
    hoverRules: it.result.hoverRules || [],
    interactionStats: it.result.interactionStats || null,
    states: (it.result.states || []).map((s) => ({
      selector: s.selector, base: s.base, elements: s.elements,
      changedCount: s.changedCount, changed: s.changed || [],
    })),
    tree: it.result.tree || null,
    warnings: it.result.warnings || [],
  }));
  /* 完整结构树（与「导出交互 JSON」按钮同源） */
  app.flowJson = () => {
    const done = app.results();
    if (!done.length || !window.H2FFlow) return null;
    const flow = pack.flow || buildFlow();
    return window.H2FFlow.toJson(done, { canvas: flow ? { w: flow.w, h: flow.h } : null });
  };

  /* 懒加载源码：加入时只拿 File 引用，真正要用的时候再读，避免一次占满内存 */
  function readFileText(file) {
    return new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => resolve(null);
      fr.readAsText(file, 'utf-8');
    });
  }

  async function batchHydrate() {
    for (const it of batch.items) {
      if (it.source != null) continue;

      /* 整包页面：轮到它的时候才 bundle（把外部 CSS 与图片内联进来），
         于是引擎看到的是一份自给自足的 HTML，相对路径不再是问题 */
      if (it.vfsPath && pack.vfs) {
        try {
          const bundled = await pack.vfs.bundle(it.vfsPath);
          it.source = bundled.html;
          it.missing = bundled.missing || [];
          if (it.missing.length && typeof log === 'function') {
            log('  ⚠ ' + it.name + '：' + it.missing.length + ' 个相对资源没找到，已按原样保留', 'warn');
            it.missing.slice(0, 4).forEach((m) => log('     · ' + m, 'warn'));
          }
        } catch (e) {
          it.status = 'error';
          it.error = '整包内联失败：' + (e && e.message ? e.message : e);
        }
        renderBatch();
        continue;
      }

      if (!it.file) continue;
      it.source = await readFileText(it.file);
      it.file = null;
      if (it.source == null) {
        it.status = 'error';
        it.error = '读取失败';
      }
      renderBatch();
    }
  }

  function batchRemove(id) {
    const i = batch.items.findIndex((x) => x.id === id);
    if (i < 0) return;
    const [it] = batch.items.splice(i, 1);
    if (batch.activeId === id) batch.activeId = batch.items.length ? batch.items[Math.min(i, batch.items.length - 1)].id : null;
    renderBatch();
    saveBatch();
    if (batch.activeId) showBatchItem(batch.activeId);
    else clearPreview();
    if (it) toast('已移除 ' + it.name, 'ok');
  }

  function batchClear() {
    if (!batch.items.length) return;
    batch.items = [];
    batch.activeId = null;
    renderBatch();
    saveBatch();
    clearPreview();
    toast('已清空队列', 'ok');
  }

  function batchPending() {
    return batch.items.filter((it) => it.status !== 'done');
  }

  function batchSummary() {
    let done = 0, error = 0, pending = 0;
    batch.items.forEach((it) => {
      if (it.status === 'done') done++;
      else if (it.status === 'error') error++;
      else pending++;
    });
    return { total: batch.items.length, done, error, pending };
  }

  function batchProgress(text) {
    const bar = $id('bar-fill');
    const label = $id('progress-label');
    const s = batchSummary();
    const finished = s.done + s.error;
    const pct = s.total ? Math.round(finished / s.total * 100) : 0;
    if (bar) bar.style.width = pct + '%';
    if (label) {
      label.setAttribute('data-state', s.total && finished === s.total ? (s.error ? 'error' : 'done') : 'running');
      label.textContent = text || ('批量 ' + finished + '/' + s.total + ' · 成功 ' + s.done + (s.error ? ' · 失败 ' + s.error : '') + (s.pending ? ' · 待处理 ' + s.pending : ''));
    }
    return pct;
  }

  /* 队列为空时给一个可点的入口，避免用户找不到「添加文件」 */
  function wireBatchEmptyAction(list) {
    if (!list) return;
    list.addEventListener('click', (ev) => {
      const link = ev.target && ev.target.closest ? ev.target.closest('.inline-link') : null;
      if (!link) return;
      const file = $id('file');
      if (file) file.click();
    });
  }

  /* ------------------------------ 队列渲染 ------------------------------- */

  function batchStateOf(it) {
    if (it.status === 'done') return ['state-done', '✓', '已完成'];
    if (it.status === 'error') return ['state-error', '!', it.error || '失败'];
    if (it.status === 'running') return ['state-running', '', '处理中…'];
    return ['state-pending', '', it.source == null ? '待处理 · 读取中' : '待处理'];
  }

  function renderBatch() {
    const list = $id('batch-list');
    const count = $id('batch-count');
    const progress = $id('batch-progress');
    const s = batchSummary();

    if (count) {
      count.textContent = s.total ? String(s.total) : '0';
      count.classList.toggle('has-error', s.error > 0);
      count.classList.toggle('all-ok', s.total > 0 && s.error === 0 && s.done === s.total);
      count.title = s.total ? (s.done + ' 成功 · ' + s.error + ' 失败 · ' + s.pending + ' 待处理') : '队列为空';
    }

    if (list) {
      list.textContent = '';
      if (!s.total) {
        const li = document.createElement('li');
        li.className = 'batch-empty';
        li.innerHTML = '把多个 .html 一起拖进页面，或 <button type="button" class="inline-link">选择文件</button>。'
          + '队列里的每一项都会按当前视口与还原选项单独生成一份 SVG。';
        list.appendChild(li);
      }
      batch.items.forEach((it) => {
        const li = document.createElement('li');
        li.className = 'batch-item' + (it.id === batch.activeId ? ' is-active' : '');
        li.setAttribute('data-id', String(it.id));
        li.title = it.name + (it.error ? '\n' + it.error : '');

        const main = document.createElement('div');
        main.className = 'bi-main';
        const name = document.createElement('div');
        name.className = 'bi-name';
        const dot = document.createElement('span');
        const st = batchStateOf(it);
        dot.className = 'bstate ' + st[0];
        dot.textContent = st[1];
        const txt = document.createElement('span');
        txt.textContent = it.name;
        if (it.status === 'error') txt.className = 'err';
        name.appendChild(dot);
        name.appendChild(txt);

        const sub = document.createElement('div');
        sub.className = 'bi-sub' + (it.status === 'error' ? ' bad' : '');
        if (it.status === 'done' && it.result) {
          const c = it.result.counts;
          const layers = (c.rect || 0) + (c.path || 0) + (c.text || 0) + (c.image || 0);
          sub.textContent = it.result.w + ' × ' + it.result.h + ' · ' + Math.max(1, Math.round(it.result.size / 1024)) + ' KB · '
            + layers + ' 图层 · ' + c.text + ' 文本';
        } else if (it.status === 'error') {
          sub.textContent = st[2];
        } else {
          sub.textContent = st[2] + ' · ' + bytesText(it.size || (it.source ? it.source.length : 0));
        }
        main.appendChild(name);
        main.appendChild(sub);

        const dl = document.createElement('button');
        dl.type = 'button';
        dl.className = 'bi-dl';
        dl.setAttribute('data-act', 'download');
        dl.textContent = '下载';
        dl.disabled = it.status !== 'done';

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'bi-del';
        del.setAttribute('data-act', 'remove');
        del.setAttribute('aria-label', '移除 ' + it.name);
        del.textContent = '×';

        li.appendChild(main);
        li.appendChild(dl);
        li.appendChild(del);
        list.appendChild(li);
      });
    }

    if (progress && !batch.running) {
      if (!s.total) progress.textContent = '还没有文件。点「添加文件」或把多个 .html 一起拖进来。';
      else if (s.pending) progress.textContent = '队列 ' + s.total + ' 个 · 已完成 ' + s.done + (s.error ? ' · 失败 ' + s.error : '') + ' · 待处理 ' + s.pending;
      else progress.textContent = '队列 ' + s.total + ' 个 · 全部完成：成功 ' + s.done + (s.error ? ' · 失败 ' + s.error : '');
    }

    syncBatchButtons();
  }

  function syncBatchButtons() {
    const s = batchSummary();
    const run = $id('btn-batch-run');
    const zip = $id('btn-batch-zip');
    const clear = $id('btn-batch-clear');
    if (run) {
      run.disabled = batch.running || s.pending === 0;
      run.textContent = batch.running ? '生成中…' : (s.pending ? '全部生成' + (s.done + s.error ? '（剩余 ' + s.pending + '）' : '') : '已全部生成');
    }
    if (zip) zip.disabled = batch.running || s.done === 0;
    if (clear) clear.disabled = batch.running || s.total === 0;
  }

  function selectBatchItem(id) {
    if (!batch.items.some((it) => it.id === id)) return;
    batch.activeId = id;
    renderBatch();
    showBatchItem(id);
  }

  /* 选中项同时回填到「粘贴 HTML」输入框，切到那个 tab 就是可编辑的单文件模式 */
  function showBatchItem(id) {
    const it = batch.items.find((x) => x.id === id);
    if (!it) return;
    const ta = $id('html');
    if (ta && it.source != null) ta.value = it.source;
    if (it.status === 'done' && it.result) setPreview(it.result, it.result.payload);
    else clearPreview('还没有生成这个文件。点「全部生成」按当前视口逐个复刻。');
  }

  /* 批量生成时为了控内存，只让「当前这一项」的快照驻留
     （window.__h2f.payload 始终可用），处理完下一项后上一份自然被回收 */
  function setPreview(result, payload) {
    app.svg = result.svg;
    app.svgCounts = result.counts;
    app.w = result.w;
    app.h = result.h;
    app.name = result.name;
    app.imageMap = result.imageMap || new Map();
    app.payload = payload || null;
    showPreview(result.svg);
    setButtons(true);
  }

  /* -------------------------------- ZIP ---------------------------------- */

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* 只做 存储(store) 打包：无依赖、结果确定，任何解压工具（含 Figma 导入）都能读 */
  function makeZip(entries) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    const u16 = (v) => [v & 0xFF, (v >>> 8) & 0xFF];
    const u32 = (v) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];

    entries.forEach((entry) => {
      const nameBytes = enc.encode(entry.name);
      const data = entry.data instanceof Uint8Array ? entry.data : enc.encode(String(entry.data));
      const crc = crc32(data);
      const local = [].concat(
        [0x50, 0x4B, 0x03, 0x04], u16(20), u16(0x0800), u16(0),
        u16(0), u16(0), u32(crc), u32(data.length), u32(data.length),
        u16(nameBytes.length), u16(0)
      );
      const header = new Uint8Array(local);
      parts.push(header, nameBytes, data);
      central.push({ nameBytes, crc, size: data.length, offset });
      offset += header.length + nameBytes.length + data.length;
    });

    const cdParts = [];
    let cdSize = 0;
    central.forEach((e) => {
      const rec = new Uint8Array([].concat(
        [0x50, 0x4B, 0x01, 0x02], u16(20), u16(20), u16(0x0800), u16(0),
        u16(0), u16(0), u32(e.crc), u32(e.size), u32(e.size),
        u16(e.nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(e.offset)
      ));
      cdParts.push(rec, e.nameBytes);
      cdSize += rec.length + e.nameBytes.length;
    });

    const eocd = new Uint8Array([].concat(
      [0x50, 0x4B, 0x05, 0x06], u16(0), u16(0),
      u16(central.length), u16(central.length), u32(cdSize), u32(offset), u16(0)
    ));
    return new Blob(parts.concat(cdParts, [eocd]), { type: 'application/zip' });
  }

  function zipBaseName() {
    if (!batch.items.length) return 'h2f-batch';
    const first = sanitizeName(batch.items[0].name).replace(/\.html?$/i, '');
    return (first || 'h2f-batch').slice(0, 40) + (batch.items.length > 1 ? '-等' + batch.items.length + '个' : '');
  }

  function svgEntryName(it, used) {
    let name = sanitizeName(it.name).replace(/\.html?$/i, '') + '.svg';
    if (used.has(name)) {
      let n = 2;
      while (used.has(name.replace(/\.svg$/i, '-' + n + '.svg'))) n++;
      name = name.replace(/\.svg$/i, '-' + n + '.svg');
    }
    used.add(name);
    return name;
  }

  function buildIndexMd(usedNames) {
    const rows = batch.items.map((it, i) => {
      const nm = (usedNames.get(it.id) || '').replace(/\|/g, '\\|');
      if (it.status === 'done' && it.result) {
        const c = it.result.counts;
        const layers = (c.rect || 0) + (c.path || 0) + (c.text || 0) + (c.image || 0);
        return '| ' + nm + ' | ' + it.result.w + ' × ' + it.result.h + ' | ' + layers + ' | ' + c.text
          + ' | ' + Math.max(1, Math.round(it.result.size / 1024)) + ' KB |';
      }
      return '| ' + nm + ' | — | — | — | 失败：' + String(it.error || '未生成').replace(/\|/g, '\\|') + ' |';
    });
    return [
      '# HTML → Figma 批量导出',
      '',
      '生成时间：' + new Date().toLocaleString() + '  ',
      '文件数：' + batch.items.length + '（成功 ' + batchSummary().done + ' · 失败 ' + batchSummary().error + '）',
      '',
      '| SVG | 画板尺寸 | 图层 | 文本 | 体积 |',
      '| --- | --- | --- | --- | --- |',
    ].concat(rows, [
      '',
      '## 用法',
      '',
      '1. 解压本压缩包，把其中的 `.svg` 全部选中，一次性拖进 Figma 网页版画布；',
      '   也可点左侧「在新窗口查看」逐个确认后再拖入。',
      '2. SVG 是矢量：文本仍是文本图层，矩形仍是矩形；字体按字体族名引用，',
      '   需 Figma 端装有同名字体（网络字体不会跟随）。',
      '3. 逐边描边、混合模式、内阴影、clip-path 在 SVG 导入时会丢失或降级。',
      '',
    ]).join('\n');
  }

  function exportBatchZip() {
    const items = batch.items.filter((it) => it.status === 'done' && it.result);
    if (!items.length) {
      toast('还没有可导出的结果，先点「全部生成」', 'warn');
      return;
    }
    const used = new Set();
    const names = new Map();
    const entries = items.map((it) => {
      const nm = svgEntryName(it, used);
      names.set(it.id, nm);
      return { name: nm, data: it.result.svg };
    });
    entries.push({ name: 'index.md', data: buildIndexMd(names) });
    const blob = makeZip(entries);
    const base = zipBaseName();
    download(blob, base + '.zip');
    if (typeof log === 'function') log('已打包 ' + items.length + ' 个 SVG + index.md → ' + base + '.zip', 'ok');
    toast('已下载 ZIP：' + items.length + ' 个 SVG · ' + bytesText(blob.size), 'ok');
  }

  function downloadBatchItem(id) {
    const it = batch.items.find((x) => x.id === id);
    if (!it || it.status !== 'done' || !it.result) return;
    download(new Blob([it.result.svg], { type: 'image/svg+xml;charset=utf-8' }), it.result.name + '.svg');
    toast('已下载 ' + it.result.name + '.svg', 'ok');
  }

  /* ------------------------------ 顺序生成 ------------------------------- */

  async function processQueueItem(it, opts) {
    it.status = 'running';
    renderBatch();
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    if (typeof log === 'function') {
      log('[' + (batch.items.indexOf(it) + 1) + '/' + batch.items.length + '] ' + it.name);
    }
    if (it.source == null) await batchHydrate();
    if (it.source == null) throw new Error('读取源码失败');

    let doc = buildDocument(it.source, opts);
    if (opts.probeRoutes && window.H2FRouteProbe) doc = window.H2FRouteProbe.injectHook(doc);
    let stage = null;
    try {
      stage = await loadStage(doc, opts);
      if (stage.fallbackNote && typeof log === 'function') log('  ' + stage.fallbackNote, 'warn');
      await settleStage(stage, opts);
      let payload = capture(stage, opts);
      payload.captureStats = payload.stats;

      /* 交互提取：复用同一份已排版的沙箱，连线的 rect 与图层坐标完全同源 */
      let ix = null;
      if (window.H2FInteract) {
        try {
          ix = window.H2FInteract.extract(stage, { pagePath: it.vfsPath || it.name });
          payload.interactions = ix.interactions;
        } catch (e) {
          if (typeof log === 'function') log('  ⚠ 交互提取失败：' + (e && e.message ? e.message : e), 'warn');
        }
      }

      /* 运行时路由探测：补上写在 JS 里的跳转（放在 capture 之后，它会真的点页面） */
      let ixList = ix ? ix.interactions : [];
      if (opts.probeRoutes && window.H2FRouteProbe && window.H2FInteract) {
        try {
          const probe = await window.H2FRouteProbe.probe(stage, { pagePath: it.vfsPath || it.name, maxClicks: 24 });
          if (probe.interactions.length) {
            ixList = window.H2FInteract.merge(ixList, probe.interactions);
            if (typeof log === 'function') {
              log('  运行时路由探测：识别出 ' + probe.interactions.length + ' 条 JS 绑定跳转'
                + (probe.restored ? '' : '（URL 未能完全还原）'));
            }
          }
        } catch (e) {
          if (typeof log === 'function') log('  ⚠ 路由探测失败：' + (e && e.message ? e.message : e), 'warn');
        }
      }
      payload.interactions = ixList;

      let stateResults = [];

      /* 页内弹层：把 :target 规则临时套上再重捕一次，产出「弹层打开」画板 */
      if (overlayOn() && window.H2FOverlay && ix && ix.interactions.length) {
        try {
          const ols = await window.H2FOverlay.captureOverlays(stage, { captureOpts: opts }, ix.interactions, capture);
          for (const ov of ols) {
            let op = (opts.lowfi && window.H2FLowfi) ? window.H2FLowfi.transform(ov.payload, {}) : ov.payload;
            if (backdropOn() && window.H2FBackdrop) op = window.H2FBackdrop.apply(op, {});
            const builtOv = await handlePayload(op);
            stateResults.push({
              kind: 'overlay',
              target: ov.target,
              selector: ov.payload.overlayState.selector,
              base: ov.target,
              elements: ov.payload.overlayState.elements,
              svg: builtOv.svg,
              w: builtOv.w,
              h: builtOv.h,
              changedCount: 0,
              changed: [],
            });
          }
          if (ols.length && typeof log === 'function') log('  ＋ 弹层稿 ' + ols.length + ' 张', 'ok');
          /* 前端路由的每个视图：注入初始路由后重新加载再捕一次 */
          if (window.H2FViewStates && window.H2FLoadStage) {
            const routes = window.H2FViewStates.collectRoutes(ix.interactions || []);
            for (const r of routes) {
              try {
                const vHtml = window.H2FViewStates.injectRoute(bundled.html, r);
                const vStage = await window.H2FLoadStage(buildDocument(vHtml, opts), opts);
                try {
                  await settleStage(vStage, opts);
                  let vp = capture(vStage, opts);
                  if (opts.lowfi && window.H2FLowfi) vp = window.H2FLowfi.transform(vp, {});
                  if (backdropOn() && window.H2FBackdrop) vp = window.H2FBackdrop.apply(vp, {});
                  const builtV = await handlePayload(vp);
                  stateResults.push({
                    kind: 'view', target: r, selector: r, base: r, elements: vp.stats.elements,
                    svg: builtV.svg, w: builtV.w, h: builtV.h, changedCount: 0, changed: [],
                  });
                  if (typeof log === 'function') log('  ＋ 视图 ' + r + '（' + vp.meta.w + ' × ' + vp.meta.h + '）', 'ok');
                } finally {
                  if (vStage.frame && vStage.frame.parentNode) vStage.frame.parentNode.removeChild(vStage.frame);
                }
              } catch (e) {
                if (typeof log === 'function') log('  视图 ' + r + ' 失败：' + (e && e.message ? e.message : e), 'warn');
              }
            }
          }
        } catch (e) {
          if (typeof log === 'function') log('  弹层稿失败：' + (e && e.message ? e.message : e), 'warn');
        }
      }

      /* :hover 状态稿：把 hover 声明临时套到元素上再重捕一次，产出「悬停态」画板 */
      if (opts.hoverStates && window.H2FStates && ix && ix.hoverRules.length) {
        try {
          const captured = await window.H2FStates.captureStates(stage, { captureOpts: opts }, ix.hoverRules, capture);
          const diffs = window.H2FStates.diffStates(payload, captured);
          for (const s of captured) {
            let sp = (opts.lowfi && window.H2FLowfi) ? window.H2FLowfi.transform(s.payload, {}) : s.payload;
            if (backdropOn() && window.H2FBackdrop) sp = window.H2FBackdrop.apply(sp, {});
            const builtState = await handlePayload(sp);
            const d = diffs.filter((x) => x.selector === s.selector)[0] || { changedCount: 0, changed: [] };
            stateResults.push({
              selector: s.selector,
              base: s.base,
              elements: s.elements,
              svg: builtState.svg,
              w: builtState.w,
              h: builtState.h,
              changedCount: d.changedCount,
              changed: (d.changed || []).slice(0, 20),
            });
          }
          if (stateResults.length && typeof log === 'function') {
            log('  :hover 状态稿 ' + stateResults.length + ' 张（'
              + stateResults.map((x) => x.base + ' 变化 ' + x.changedCount + ' 处').join('、') + '）');
          }
        } catch (e) {
          if (typeof log === 'function') log('  ⚠ 状态稿生成失败：' + (e && e.message ? e.message : e), 'warn');
        }
      }

      /* 低保真线框稿：快照层变换，SVG 与 Figma 两条出口共用同一份规则 */
      if (opts.lowfi && window.H2FLowfi) {
        payload = window.H2FLowfi.transform(payload, {});
        if (typeof log === 'function') log('  低保真线框稿（灰阶色块 / 文字占位条 / 图片与图标均为纯色块）');
      }
      /* 白色衬底：垫在页面外面的一圈白边（可与低保真叠用） */
      if (backdropOn() && window.H2FBackdrop) {
        payload = window.H2FBackdrop.apply(payload, {});
        if (typeof log === 'function') log('  白色衬底：每边 ' + window.H2FBackdrop.PAD + 'px');
      }

      const built = await handlePayload(payload);

      it.result = {
        svg: built.svg,
        counts: built.counts,
        size: built.bytes,
        w: built.w,
        h: built.h,
        warnings: built.warnings,
        payload,
        imageMap: built.imageMap,
        name: sanitizeName(it.name).replace(/\.html?$/i, ''),
        interactions: ixList,
        hoverRules: ix ? ix.hoverRules : [],
        interactionStats: ix ? ix.stats : null,
        states: stateResults,
        /* 图层树在这里就压成轻量 JSON：批量跑完 payload 会被释放 */
        tree: (window.H2FFlow && payload.root) ? window.H2FFlow.mapNode(payload.root, 0) : null,
      };
      it.status = 'done';
      it.error = '';
      if (typeof log === 'function') {
        const ixInfo = (it.result.interactions && it.result.interactions.length)
          ? ' · ' + it.result.interactions.length + ' 交互' : '';
        log('  ✓ ' + built.w + ' × ' + built.h + ' · ' + Math.max(1, Math.round(built.bytes / 1024)) + ' KB · '
          + built.counts.text + ' 文本' + ixInfo, 'ok');
      }
    } finally {
      disposeStage(stage);
    }
  }

  function disposeStage(stage) {
    if (!stage) return;
    if (stage.blobUrl) {
      try { URL.revokeObjectURL(stage.blobUrl); } catch (e) { /* 忽略 */ }
    }
    if (stage.frame && stage.frame.parentNode) stage.frame.parentNode.removeChild(stage.frame);
    if (stage.hostWrap && stage.hostWrap.parentNode) stage.hostWrap.parentNode.removeChild(stage.hostWrap);
  }

  async function batchRun() {
    if (batch.running || !batch.items.length) return;
    if (typeof state !== 'undefined' && state.running) {
      toast('单个文件还在生成，稍后再试', 'warn');
      return;
    }
    batch.running = true;
    batch.cancel = false;
    batch.token++;
    const runToken = batch.token;

    const runBtn = $id('btn-run');
    const cancelBtn = $id('btn-cancel');
    if (runBtn) runBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = false;
    /* 批量期间导出按钮统一禁用，避免导出到一半的结果 */
    setButtons(false);
    setRunLabel('批量生成中…');
    setStatus('running', '批量处理中');
    batchProgress('批量开始：0/' + batch.items.length);
    if (typeof log === 'function') log('批量生成开始：' + batch.items.length + ' 个文件', 'ok');

    const queue = batch.items.slice();
    let ok = 0, fail = 0, stopped = false;
    let lastPayload = null, lastPayloadItem = null;

    for (let i = 0; i < queue.length; i++) {
      if (batch.cancel || runToken !== batch.token) { stopped = true; break; }
      const it = queue[i];
      const opts = readOptions();
      opts.source = 'file';
      opts.html = it.source || '';
      try {
        await processQueueItem(it, opts);
        ok++;
      } catch (e) {
        if (batch.cancel || runToken !== batch.token) { it.status = 'pending'; stopped = true; break; }
        it.status = 'error';
        it.error = String(e && e.message ? e.message : e);
        fail++;
        if (typeof log === 'function') log('  ✗ ' + it.name + '：' + it.error, 'error');
      }
      if (it.status === 'done') {
        setPreview(it.result, it.result.payload);
        /* 队列里只留 SVG 字符串：快照交给「当前预览项」持有，其余立刻释放 */
        lastPayload = it.result.payload;
        lastPayloadItem = it;
        it.result.payload = null;
        it.result.imageMap = null;
      }
      renderBatch();
      batchProgress();
      await new Promise((r) => setTimeout(r, 24));
    }

    batch.running = false;
    if (runBtn) runBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = true;
    setRunLabel('开始生成');
    renderBatch();
    saveBatch();

    const endState = stopped ? '已取消' : (fail ? '部分失败' : '全部完成');
    batchProgress(endState + '：成功 ' + ok + ' · 失败 ' + fail + (stopped ? ' · 其余未处理' : ''));
    setStatus(stopped ? 'idle' : (fail ? 'error' : 'done'), endState);
    if (typeof log === 'function') log(endState + '：成功 ' + ok + '，失败 ' + fail, fail ? 'warn' : 'ok');
    toast(endState + '：成功 ' + ok + ' 个' + (fail ? '，失败 ' + fail + ' 个' : ''), fail ? 'warn' : 'ok');

    /* 全景交互画布：把所有已完成的页面并排成一张画布，并画出跳转连线 */
    buildFlow();
    syncFlowButtons();

    /* 完成后把第一个成功的结果放进预览；顺带保留它的快照，
       让 window.__h2f.payload 在批量跑完后依然指向「当前预览的那一份」 */
    const first = queue.find((x) => x.status === 'done');
    if (first && !stopped) {
      /* 优先挑「快照还留着」的那一项作为当前预览项：
         低保真切换、交互 JSON 之类的按需操作需要它 */
      const pick = (lastPayloadItem && lastPayloadItem.status === 'done') ? lastPayloadItem : first;
      batch.activeId = pick.id;
      const keep = pick === lastPayloadItem ? lastPayload : null;
      setPreview(pick.result, keep);
      renderBatch();
    } else {
      setButtons(!!app.svg);
    }
  }

  function cancelBatch() {
    if (!batch.running) return false;
    batch.cancel = true;
    if (typeof log === 'function') log('已请求取消批量生成，当前文件处理完后停止', 'warn');
    toast('正在停止批量生成…', 'warn');
    return true;
  }

  /* ------------------------------ 队列持久化 ----------------------------- */

  function saveBatch() {
    if (!batchStore) return;
    /* 整包导入的页面源码是运行时从 VFS 内联出来的（含 dataURL，体积很大），
       刷新后 VFS 已不在内存里，所以整包队列不写 localStorage */
    if (batch.items.some((it) => it.vfsPath)) {
      localStorage.removeItem(BATCH_KEY);
      return;
    }
    try {
      const total = batch.items.reduce((n, it) => n + (it.source ? it.source.length : 0), 0);
      if (!batch.items.length || total > BATCH_PERSIST_BYTES) {
        localStorage.removeItem(BATCH_KEY);
        return;
      }
      localStorage.setItem(BATCH_KEY, JSON.stringify({
        activeId: batch.activeId,
        items: batch.items.map((it) => (it.status === 'done'
          ? { name: it.name, size: it.size, source: it.source }
          : { name: it.name, size: it.size, source: it.source, status: it.status, error: it.error })),
      }));
    } catch (e) { /* 配额不足就放弃记忆 */ }
  }

  function loadBatch() {
    if (!batchStore) return;
    try {
      const raw = localStorage.getItem(BATCH_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) || {};
      const items = Array.isArray(data.items) ? data.items : [];
      items.forEach((it) => {
        if (!it || typeof it.source !== 'string') return;
        batch.items.push({
          id: ++batchSeq,
          name: String(it.name || 'untitled.html'),
          size: Number(it.size) || it.source.length,
          source: it.source,
          status: it.status === 'error' ? 'error' : 'pending',
          error: it.error || '',
        });
      });
      if (batch.items.length) {
        batch.restored = batch.items.length;
        batch.activeId = batch.items[0].id;
      }
    } catch (e) { /* 忽略 */ }
  }

  /* ------------------------------ 队列界面接线 --------------------------- */

  function wireBatch() {
    const file = $id('file');
    if (file) {
      file.value = '';
      file.onchange = (ev) => {
        const files = Array.prototype.slice.call((ev.target.files) || []);
        if (!files.length) return;
        batchAddFiles(files).then(() => { file.value = ''; });
      };
    }

    const add = $id('btn-batch-add');
    if (add) add.onclick = () => { if (file) file.click(); };
    const runBtn = $id('btn-batch-run');
    if (runBtn) runBtn.onclick = () => batchRun();
    const zipBtn = $id('btn-batch-zip');
    if (zipBtn) zipBtn.onclick = exportBatchZip;
    const clear = $id('btn-batch-clear');
    if (clear) clear.onclick = batchClear;

    /* 整包导入：.zip 或整个文件夹 */
    const packZipBtn = $id('btn-pack-zip');
    const packZipInput = $id('pack-zip');
    if (packZipBtn && packZipInput) {
      packZipBtn.onclick = () => { packZipInput.value = ''; packZipInput.click(); };
      packZipInput.onchange = async (ev) => {
        const files = Array.prototype.slice.call(ev.target.files || []);
        if (files.length) await packIngest(files, files[0].name);
        ev.target.value = '';
      };
    }
    const packFolderBtn = $id('btn-pack-folder');
    const packFolderInput = $id('pack-folder');
    if (packFolderBtn && packFolderInput) {
      packFolderBtn.onclick = () => { packFolderInput.value = ''; packFolderInput.click(); };
      packFolderInput.onchange = async (ev) => {
        const files = Array.prototype.slice.call(ev.target.files || []);
        if (files.length) await packIngest(files, '文件夹（' + files.length + ' 个文件）');
        ev.target.value = '';
      };
    }
    const flowBtn = $id('btn-flow');
    if (flowBtn) flowBtn.onclick = showFlow;

    const list = $id('batch-list');
    if (list) {
      list.addEventListener('click', (ev) => {
        const row = ev.target && ev.target.closest ? ev.target.closest('.batch-item') : null;
        if (!row) return;
        const id = Number(row.getAttribute('data-id'));
        const act = ev.target.getAttribute ? ev.target.getAttribute('data-act') : null;
        if (act === 'remove') { batchRemove(id); return; }
        if (act === 'download') { downloadBatchItem(id); return; }
        selectBatchItem(id);
      });
    }
    wireBatchEmptyAction(list);

    loadBatch();
    renderBatch();
    if (batch.restored) {
      toast('已恢复上次的队列：' + batch.restored + ' 个文件', 'ok');
      if (batch.activeId) showBatchItem(batch.activeId);
      if (typeof log === 'function') log('恢复队列 ' + batch.restored + ' 个文件（源码已保存，可直接重新生成）');
    }
  }

  /* ------------------------------ 拖入文件 ------------------------------- */

  /* 左栏只负责视觉反馈与计数，真正读文件统一交给下面的全局处理，
     避免同一个文件被两个 drop 监听器各读一次 */
  function wireDrop() {
    const zone = $id('drop-zone');
    if (!zone) return;
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    const hasFiles = (e) => !!(e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0);
    ['dragenter', 'dragover'].forEach((t) => zone.addEventListener(t, (e) => {
      stop(e);
      zone.classList.add('dragging');
      if (hasFiles(e)) document.body.classList.add('dragging-file');
    }));
    zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
    zone.addEventListener('drop', (e) => {
      zone.classList.remove('dragging');
      document.body.classList.remove('dragging-file');
      /* 不 stopPropagation：让文件冒泡到 window 的统一处理 */
    });
  }

  /* 整页拖放：一次可以拖入多个 .html，全部进队列 */
  function wireGlobalDrop() {
    let depth = 0;
    const hasFiles = (e) => !!(e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0);
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      depth++;
      document.body.classList.add('dragging-file');
    });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('dragleave', () => {
      depth--;
      if (depth <= 0) { depth = 0; document.body.classList.remove('dragging-file'); }
    });
    window.addEventListener('drop', (e) => {
      depth = 0;
      document.body.classList.remove('dragging-file');
      const zone = $id('drop-zone');
      if (zone) zone.classList.remove('dragging');
      const dt = e.dataTransfer;
      const files = Array.prototype.slice.call((dt && dt.files) || []);
      if (!files.length) return;
      e.preventDefault();

      /* 整包优先：拖入 .zip 或文件夹时走 VFS（相对路径的 CSS/图片会被内联，
         而不是像单个 .html 那样因为取不到相对资源而留灰块） */
      const first = files[0];
      const entry = (dt && dt.items && dt.items[0] && dt.items[0].webkitGetAsEntry)
        ? dt.items[0].webkitGetAsEntry() : null;
      if ((first && /\.zip$/i.test(first.name)) || (entry && entry.isDirectory)) {
        packIngest(dt, entry && entry.isDirectory ? '文件夹' : first.name);
        return;
      }
      batchAddFiles(files);
    });
  }

  /* ------------------------------ 头部与选项 ----------------------------- */

  /* 记住上次用的选项（视口、还原选项等）。file:// 或隐私模式下 localStorage
     可能不可用，全部包在 try 里，失败就退化成「不记忆」。 */
  const PREFS_KEY = 'h2f.web.prefs.v1';
  const PREFS = {
    vw: 'value', vh: 'value', crop: 'value', textMode: 'value',
    shadowScale: 'value', maxNodes: 'value',
    disableAnimation: 'checked', capturePseudo: 'checked',
    zIndexSort: 'checked', allowScripts: 'checked', backdrop: 'checked', overlayStates: 'checked',
  };
  const hasStore = (() => {
    try { return typeof localStorage !== 'undefined' && !!localStorage; } catch (e) { return false; }
  })();

  function savePrefs() {
    if (!hasStore) return;
    try {
      const out = {};
      Object.keys(PREFS).forEach((id) => {
        const el = $id(id);
        if (!el) return;
        out[id] = PREFS[id] === 'checked' ? !!el.checked : el.value;
      });
      localStorage.setItem(PREFS_KEY, JSON.stringify(out));
    } catch (e) { /* 忽略 */ }
  }

  function loadPrefs() {
    if (!hasStore) return;
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) || {};
      Object.keys(PREFS).forEach((id) => {
        const el = $id(id);
        if (!el || !(id in data)) return;
        if (PREFS[id] === 'checked') el.checked = !!data[id];
        else if (typeof data[id] === 'string' && data[id].length <= 40) el.value = data[id];
      });
    } catch (e) { /* 忽略 */ }
  }

  function wirePrefs() {
    Object.keys(PREFS).forEach((id) => {
      const el = $id(id);
      if (!el) return;
      el.addEventListener('change', savePrefs);
      if (id === 'maxNodes') el.addEventListener('input', savePrefs);
    });
  }

  function wirePresets() {
    const vw = $id('vw');
    const vh = $id('vh');
    document.querySelectorAll('[data-preset]').forEach((btn) => {
      btn.onclick = () => {
        const [w, h] = String(btn.getAttribute('data-preset')).split('x');
        if (vw) vw.value = w;
        if (vh) vh.value = h;
        savePrefs();
        toast('视口已设为 ' + w + ' × ' + h, 'ok');
      };
    });
    const syncNote = () => {
      const note = $id('opt-note');
      const mode = $id('textMode');
      const max = $id('maxNodes');
      if (note && mode && max) {
        note.textContent = (mode.value === 'line' ? '逐行' : '整块') + ' · ' + (max.value || '20000') + ' 图层';
      }
    };
    ['textMode', 'maxNodes'].forEach((id) => {
      const el = $id(id);
      if (el) el.addEventListener('input', syncNote);
      if (el) el.addEventListener('change', syncNote);
    });
    syncNote();
  }

  function wireReset() {
    const btn = $id('btn-reset');
    if (!btn) return;
    btn.onclick = () => {
      const ta = $id('html');
      if (ta) ta.value = '';
      const url = $id('url');
      if (url) url.value = '';
      clearPreview();
      setStatus('idle', '就绪');
      setRunLabel('开始生成');
      const label = $id('progress-label');
      if (label) {
        label.removeAttribute('data-state');
        label.textContent = '待开始 · Ctrl/⌘ + Enter 开始';
      }
      const bar = $id('bar-fill');
      if (bar) bar.style.width = '0%';
      const report = $id('report');
      if (report) report.innerHTML = '';
      const logBox = $id('log');
      if (logBox) logBox.innerHTML = '';
      const note = $id('log-note');
      if (note) note.textContent = '待开始';
      const count = $id('report-count');
      if (count) count.style.display = 'none';
      /* 队列不删，只把生成状态清掉，方便换一组选项重新跑 */
      if (batch.items.length) {
        batch.items.forEach((it) => { it.status = 'pending'; it.error = ''; it.result = null; });
        batchProgress();
        renderBatch();
        toast('已清空日志与结果（队列保留 ' + batch.items.length + ' 个文件）', 'ok');
        return;
      }
      toast('已重置输入与结果', 'ok');
    };
  }

  function wireShortcuts() {
    window.addEventListener('keydown', (ev) => {
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod && ev.key === 'Enter') {
        ev.preventDefault();
        const run = $id('btn-run');
        if (run && !run.disabled) run.click();
        return;
      }
      if (ev.key === 'Escape') {
        if (drawerOpen()) { setDrawer(false); return; }
        if (batch.running) { cancelBatch(); return; }
        const cancel = $id('btn-cancel');
        if (cancel && !cancel.disabled) { cancel.click(); return; }
        const ae = document.activeElement;
        if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) ae.blur();
      }
    });
  }

  /* 窄屏抽屉：设置面板默认收起，预览优先 */
  function setDrawer(open) {
    document.body.classList.toggle('drawer-open', !!open);
    const btn = $id('btn-drawer');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function drawerOpen() {
    return document.body.classList.contains('drawer-open');
  }

  function wireDrawer() {
    const btn = $id('btn-drawer');
    if (btn) btn.onclick = () => setDrawer(!drawerOpen());
    /* 宽屏恢复分栏时收起抽屉状态 */
    window.addEventListener('resize', () => { if (window.innerWidth > 1080) setDrawer(false); });
  }

  function wireEmptyActions() {
    const demo = $id('btn-demo');
    if (demo) demo.onclick = () => {
      if (typeof SAMPLE_HTML === 'string') {
        const ta = $id('html');
        if (ta) ta.value = SAMPLE_HTML;
        if (typeof setTab === 'function') setTab('paste');
      }
      const run = $id('btn-run');
      if (run && !run.disabled) run.click();
    };
    const batchBtn = $id('btn-demo-batch');
    if (batchBtn) batchBtn.onclick = () => {
      const file = $id('file');
      if (file) file.click();
    };
    const readme = $id('btn-open-readme');
    if (readme) readme.onclick = () => {
      const w = window.open('../README.md', '_blank');
      if (!w) toast('说明文档：../README.md', 'warn');
    };
  }

  /* -------------------------------- 启动 --------------------------------- */

  function boot() {
    setButtons(false);
    const bind = (id, fn) => {
      const el = $id(id);
      if (el) el.onclick = fn;
    };
    bind('btn-svg', saveSvg);
    bind('btn-copy', copySvg);
    bind('btn-png', savePng);
    bind('btn-open', openSvg);
    bind('btn-lowfi', toggleLowfi);
    bind('btn-flow-svg', exportFlowSvg);
    bind('btn-flow-json', exportFlowJson);
    syncFlowButtons();

    const fit = $id('btn-fit');
    if (fit) fit.onclick = () => setZoom('fit');
    const full = $id('btn-100');
    if (full) full.onclick = () => setZoom('100');

    loadPrefs();
    wireDrop();
    wireGlobalDrop();
    wireBatch();
    wireLogPanel();
    wirePresets();
    wirePrefs();
    wireReset();
    wireShortcuts();
    wireDrawer();
    wireEmptyActions();
    watchToasts();
    watchProgressLabel();
    watchRunButton();

    const run = $id('btn-run');
    if (run) {
      const prev = run.onclick;
      run.onclick = (ev) => {
        /* 有队列就走批量；没有队列时，把「粘贴 HTML」里的内容当成一个任务，
           这样单文件和批量是同一条路径，行为保持一致 */
        if (batch.items.length) { batchRun(); return; }
        const ta = $id('html');
        const text = ta ? ta.value.trim() : '';
        if (text) {
          batchAdd([{
            name: 'pasted-' + new Date().toISOString().slice(0, 10) + '.html',
            size: text.length,
            source: ta.value,
          }]);
          batchRun();
          return;
        }
        clearPreview();
        setStatus('running', '处理中');
        setRunLabel('生成中…');
        const note = $id('log-note');
        if (note) note.textContent = '运行中…';
        if (typeof prev === 'function') prev.call(run, ev);
      };
    }

    /* 取消按钮：批量进行中优先取消批量 */
    const cancelBtn = $id('btn-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', () => cancelBatch());
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();


/* ============================ 视口自动识别 ============================
 * 与插件端同一套判据（core/viewport.js）：按 meta viewport 与媒体查询断点判断端型，
 * 自动填好视口与画板范围；用户手动改任一项即关闭自动。
 * 函数声明追加在文件末尾即可 —— 声明会提升，上面的调用点照样能用到。
 * ==================================================================== */

function applyAutoViewportWeb(opts) {
  const auto = document.getElementById('autoViewport');
  if (!auto || !auto.checked || !window.H2FViewport) return null;
  const seed = (document.getElementById('html') || {}).value || '';
  if (!seed) return null;
  const s = window.H2FViewport.suggestForHtml(seed);
  const vw = document.getElementById('vw');
  const vh = document.getElementById('vh');
  const crop = document.getElementById('crop');
  if (vw) vw.value = s.w;
  if (vh) vh.value = s.h;
  if (crop) crop.value = s.crop;
  /* opts 早就生成好了，这里必须同步，否则引擎用的还是旧视口 */
  if (opts) { opts.viewportWidth = s.w; opts.viewportHeight = s.h; opts.cropMode = s.crop; }
  const preset = document.getElementById('devicePreset');
  if (preset) {
    const key = s.w + 'x' + s.h;
    preset.value = preset.querySelector('option[value="' + key + '"]') ? key : '';
  }
  const note = document.getElementById('autoNote');
  if (note) {
    const L = { mobile: '手机', tablet: '平板', desktop: '桌面' };
    note.textContent = '自动识别为' + (L[s.form] || s.form) + '（' + s.why + '）：'
      + s.w + ' × ' + s.h + '，画板范围「'
      + (s.crop === 'viewport' ? '一屏' : (s.crop === 'document' ? '整个文档' : '贴合内容')) + '」';
  }
  if (typeof log === 'function') log('端型自动识别：' + s.w + ' × ' + s.h, 'ok');
  return s;
}

function wireViewportUi() {
  const preset = document.getElementById('devicePreset');
  if (preset) {
    preset.addEventListener('change', function () {
      const m = /^(\d+)x(\d+)$/.exec(preset.value || '');
      if (!m) return;
      const vw = document.getElementById('vw');
      const vh = document.getElementById('vh');
      const auto = document.getElementById('autoViewport');
      const crop = document.getElementById('crop');
      if (vw) vw.value = m[1];
      if (vh) vh.value = m[2];
      if (auto) auto.checked = false;
      if (crop && parseInt(m[1], 10) <= 900 && crop.value !== 'viewport') crop.value = 'viewport';
      const note = document.getElementById('autoNote');
      if (note) note.textContent = '';
    });
  }
  ['vw', 'vh', 'crop'].forEach(function (id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', function () {
      const auto = document.getElementById('autoViewport');
      if (auto) auto.checked = false;
    });
  });
  /* 还原模式：仅样式 / 样式 + 交互 */
  const modes = document.querySelectorAll('input[name="renderMode"]');
  Array.prototype.forEach.call(modes, function (r) {
    r.addEventListener('change', function () {
      if (!r.checked) return;
      const both = r.value === 'both';
      const set = function (id, v) {
        const el = document.getElementById(id);
        if (el) el.checked = !!v;
      };
      set('allowScripts', both);
      set('overlayStates', both);
    });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireViewportUi);
} else {
  wireViewportUi();
}
