// ==UserScript==
// @name         网页加速器 (v4)
// @namespace    local.instantpage.v4
// @version      4.0.0
// @description  用 Speculation Rules 预取你正要点的链接，让页面跳转几乎瞬间完成
// @author       大肥鱼 (DeepSeek)
// @match        *://*/*
// @noframes
// @homepageURL   https://github.com/Avenger233/instant-page-accelerator
// @supportURL    https://github.com/Avenger233/instant-page-accelerator/issues
// @updateURL     https://jb.tsgz.xyz/web-accelerator.user.js
// @downloadURL   https://jb.tsgz.xyz/web-accelerator.user.js
// @run-at       document-end
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

/*
 * ── 相对 v3.2.2 改了什么 ──────────────────────────────────────────────
 * 1. 不再「每个 URL 建一个 <script type=speculationrules>」+LRU 删建。
 *    改成一条 document 规则，由浏览器自己判断悬停意图（eagerness）。
 *    原来那套 hinted / tokens / scripts 队列整段消失。
 * 2. 加了 @noframes。speculation rules 在子框架里本来就不生效，
 *    以前每个 iframe 都白跑一遍初始化。
 * 3. 删掉「商店镜像」。原版把 URL 换成 crxsoso 后只拿去预取，
 *    却从不改 <a href>，点击还是走原站 —— 白预取一次，还把
 *    「你想看哪个扩展」泄露给第三方。纯负收益，直接砍。
 * 4. 去掉 sweetalert2 的 @require/@resource。以前每个页面都要从
 *    CDN 拉 60KB 第三方代码并执行，只为弹一个设置框。改用原生 <dialog>。
 * 5. 去掉 mousedown 预取。那时导航已经开始，预取必然来不及，
 *    还可能跟真实导航抢带宽。
 * 6. 兼容模式（link rel=prefetch）作为兜底：严格 CSP 站点会拦掉
 *    内联 speculation rules（需要 script-src 'inline-speculation-rules'）。
 * 7. 所有 HTML 只用 createElement / textContent 拼，不再把设置项
 *    原样塞进 innerHTML。
 * ────────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  var NS = 'iap4.';

  var DEFAULTS = {
    enabled: true,
    external: false,
    eagerness: 'moderate',
    compat: false,
    hosts: '',
    words: 'logout\nsignout\nlogin\nregister\npay\nreset\ndelete\nexit'
  };

  /* ── 存储 ─────────────────────────────────────────────── */

  function get(k) {
    var v = GM_getValue(NS + k);
    return v === undefined ? DEFAULTS[k] : v;
  }
  function set(k, v) {
    GM_setValue(NS + k, v);
  }

  function lines(s) {
    return String(s || '').split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
  }

  /* URLPattern 里 ? ( ) : { } * 都是语法字符，只放行安全字符 */
  function safe(s) {
    return s.replace(/[^A-Za-z0-9_\-\/\u4e00-\u9fa5]/g, '');
  }

  function bareHost(s) {
    return s.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
  }

  var SR = typeof HTMLScriptElement !== 'undefined' &&
           typeof HTMLScriptElement.supports === 'function' &&
           HTMLScriptElement.supports('speculationrules');

  /* ── 规则 ─────────────────────────────────────────────── */

  function rules() {
    var eg = get('eagerness');

    if (eg !== 'conservative' && eg !== 'moderate' && eg !== 'eager') eg = 'moderate';

    var words = lines(get('words')).map(safe).filter(Boolean).slice(0, 40);

    function nots(prefix) {
      return words.map(function (w) {
        return { not: { href_matches: prefix + w + '*' } };
      });
    }

    // '/*' 是相对模式，自动解析成「当前站点」，所以这条只管站内
    var list = [{
      source: 'document',
      where: { and: [{ href_matches: '/*' }].concat(nots('/*')) },
      eagerness: eg
    }];

    // 跨站预取：Chrome 只在目标站没有 cookie 时才会真的发出去，
    // 并且要求浏览器能匿名化客户端 IP
    if (get('external')) {
      ['https', 'http'].forEach(function (scheme) {
        var base = scheme + '://*/*';
        list.push({
          source: 'document',
          where: { and: [{ href_matches: base }].concat(nots(base)) },
          eagerness: eg,
          requires: ['anonymous-client-ip-when-cross-origin']
        });
      });
    }

    return list;
  }

  function inject() {
    var s = document.createElement('script');
    s.type = 'speculationrules';
    s.textContent = JSON.stringify({ prefetch: rules() });
    (document.head || document.documentElement).appendChild(s);
  }

  /* ── 兼容模式：link rel=prefetch ───────────────────────── */

  function compatMode() {
    var DELAY = 65;
    var MAX = 40;
    var seen = Object.create(null);
    var count = 0;
    var timer = 0;
    var hovered = null;

    var words = lines(get('words')).map(function (x) { return x.toLowerCase(); });

    function eligible(a) {
      if (!a || !a.href) return false;
      if (a.hasAttribute('download')) return false;
      if (a.target && a.target !== '_self') return false;
      if (a.protocol !== 'http:' && a.protocol !== 'https:') return false;
      return true;
    }

    function hop(a) {
      var u;
      try { u = new URL(a.href); } catch (e) { return; }
      u.hash = '';

      var path = (u.pathname + u.search).toLowerCase();
      for (var i = 0; i < words.length; i++) {
        if (words[i] && path.indexOf(words[i]) > -1) return;
      }

      if (!get('external') && u.origin !== location.origin) return;
      if (u.origin === location.origin &&
          u.pathname === location.pathname &&
          u.search === location.search) return;

      var key = u.href;
      if (seen[key] || count >= MAX) return;
      seen[key] = 1;
      count++;

      var l = document.createElement('link');
      l.rel = 'prefetch';
      l.href = key;
      document.head.appendChild(l);
    }

    function anchorOf(e) {
      var t = e.target;
      return (t && t.closest) ? t.closest('a') : null;
    }

    // 每个链接独立记时，不再共用一个 timer
    document.addEventListener('mouseover', function (e) {
      var a = anchorOf(e);
      if (!eligible(a)) { hovered = null; clearTimeout(timer); return; }
      if (hovered === a) return;
      hovered = a;
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (hovered === a) hop(a);
      }, DELAY);
    }, { passive: true });

    document.addEventListener('mouseout', function (e) {
      var a = anchorOf(e);
      if (a && a === hovered) {
        clearTimeout(timer);
        hovered = null;
      }
    }, { passive: true });

    document.addEventListener('touchstart', function (e) {
      var a = anchorOf(e);
      if (eligible(a)) hop(a);
    }, { passive: true, capture: true });
  }

  /* ── 设置面板（原生 <dialog>，零外部依赖） ─────────────── */

  var CSS = [
    '#iap4-dlg{width:360px;max-width:92vw;padding:0;border:0;border-radius:12px;',
    'background:#fff;color:#1f2328;box-shadow:0 14px 44px rgba(0,0,0,.28);',
    'font:13px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}',
    '#iap4-dlg::backdrop{background:rgba(0,0,0,.35)}',
    '#iap4-dlg form{margin:0;padding:16px 18px 0}',
    '#iap4-dlg h3{margin:0 0 2px;font-size:15px}',
    '#iap4-dlg small{color:#8a8f98;font-weight:400}',
    '.iap4-note{margin:0 0 10px;font-size:12px;color:#8a8f98}',
    '.iap4-row{display:flex;align-items:center;justify-content:space-between;padding:6px 0}',
    '.iap4-row input[type=checkbox]{width:16px;height:16px;cursor:pointer}',
    '.iap4-col{display:flex;flex-direction:column;gap:4px;padding:6px 0}',
    '.iap4-col textarea{width:100%;height:54px;resize:vertical;box-sizing:border-box;',
    'padding:6px;border:1px solid #d0d7de;border-radius:6px;',
    'font:12px/1.5 ui-monospace,Consolas,monospace}',
    '.iap4-col select{padding:6px;border:1px solid #d0d7de;border-radius:6px;',
    'background:#fff;color:inherit;font:inherit}',
    '.iap4-bar{display:flex;gap:8px;justify-content:flex-end;margin-top:8px;',
    'padding:12px 0 14px;border-top:1px solid #eaeef2}',
    '.iap4-bar button{padding:6px 14px;border:1px solid #d0d7de;border-radius:6px;',
    'background:#f6f8fa;color:inherit;cursor:pointer;font:inherit}',
    '.iap4-bar button.primary{background:#1f6feb;border-color:#1f6feb;color:#fff}',
    '@media (prefers-color-scheme:dark){',
    '#iap4-dlg{background:#1c2128;color:#e6edf3;box-shadow:0 14px 44px rgba(0,0,0,.6)}',
    '.iap4-col textarea,.iap4-col select{background:#22272e;border-color:#444c56;color:#e6edf3}',
    '.iap4-bar{border-top-color:#30363d}',
    '.iap4-bar button{background:#30363d;border-color:#444c56}',
    '.iap4-bar button.primary{background:#1f6feb;border-color:#1f6feb}}'
  ].join('');

  function ensureStyle() {
    if (document.getElementById('iap4-style')) return;
    var st = document.createElement('style');
    st.id = 'iap4-style';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function blockedHere() {
    var host = location.host.toLowerCase();
    return lines(get('hosts')).some(function (d) {
      d = bareHost(d);
      return d && (host === d || host.endsWith('.' + d));
    });
  }

  function openUI() {
    ensureStyle();

    var old = document.getElementById('iap4-dlg');
    if (old) old.remove();

    var dlg = document.createElement('dialog');
    dlg.id = 'iap4-dlg';

    var form = document.createElement('form');
    form.method = 'dialog';

    var h = document.createElement('h3');
    h.textContent = '🚀 网页加速器 ';
    var ver = document.createElement('small');
    ver.textContent = 'v4.0.0';
    h.appendChild(ver);

    var note = document.createElement('p');
    note.className = 'iap4-note';
    note.textContent = SR
      ? (get('compat') ? '当前：兼容模式（link rel=prefetch）' : '当前：Speculation Rules（推荐）')
      : '此浏览器不支持 Speculation Rules，只能走兼容模式';

    function row(label, input) {
      var w = document.createElement('label');
      w.className = 'iap4-row';
      var s = document.createElement('span');
      s.textContent = label;
      w.appendChild(s);
      w.appendChild(input);
      return w;
    }

    function colWrap(label, input, hint) {
      var w = document.createElement('label');
      w.className = 'iap4-col';
      var s = document.createElement('span');
      s.textContent = label;
      w.appendChild(s);
      w.appendChild(input);
      if (hint) {
        var p = document.createElement('span');
        p.className = 'iap4-note';
        p.textContent = hint;
        w.appendChild(p);
      }
      return w;
    }

    var cbEnabled = document.createElement('input');
    cbEnabled.type = 'checkbox';
    cbEnabled.checked = !!get('enabled');

    var cbExternal = document.createElement('input');
    cbExternal.type = 'checkbox';
    cbExternal.checked = !!get('external');

    var cbCompat = document.createElement('input');
    cbCompat.type = 'checkbox';
    cbCompat.checked = !!get('compat');

    var selEg = document.createElement('select');
    [['conservative', '保守（指针按下才预取）'],
     ['moderate', '标准（悬停约 200ms，推荐）'],
     ['eager', '激进（指针靠近就预取）']].forEach(function (o) {
      var op = document.createElement('option');
      op.value = o[0];
      op.textContent = o[1];
      if (get('eagerness') === o[0]) op.selected = true;
      selEg.appendChild(op);
    });

    var taHosts = document.createElement('textarea');
    taHosts.value = get('hosts');
    taHosts.placeholder = '一行一个，例如 example.com（含子域）';

    var taWords = document.createElement('textarea');
    taWords.value = get('words');
    taWords.placeholder = '链接路径含这些词就不预取';

    var bar = document.createElement('div');
    bar.className = 'iap4-bar';

    var btnCancel = document.createElement('button');
    btnCancel.value = 'cancel';
    btnCancel.textContent = '取消';

    var btnSave = document.createElement('button');
    btnSave.value = 'save';
    btnSave.className = 'primary';
    btnSave.textContent = '保存并刷新';

    bar.appendChild(btnCancel);
    bar.appendChild(btnSave);

    form.appendChild(h);
    form.appendChild(note);
    form.appendChild(row('启用加速', cbEnabled));
    form.appendChild(row('允许跨站预取', cbExternal));
    form.appendChild(colWrap('预取激进度', selEg, '由浏览器自己判断"你是不是要点"，比手写延迟更准'));
    form.appendChild(row('兼容模式（rel=prefetch）', cbCompat));
    form.appendChild(colWrap('排除域名', taHosts));
    form.appendChild(colWrap('排除关键词', taWords, '只匹配路径和查询串，不会误伤域名'));
    form.appendChild(bar);

    dlg.appendChild(form);

    dlg.addEventListener('click', function (e) {
      if (e.target === dlg) dlg.close('cancel');
    });

    dlg.addEventListener('close', function () {
      if (dlg.returnValue === 'save') {
        set('enabled', cbEnabled.checked);
        set('external', cbExternal.checked);
        set('compat', cbCompat.checked);
        set('eagerness', selEg.value);
        set('hosts', taHosts.value);
        set('words', taWords.value);
        location.reload();
        return;
      }
      dlg.remove();
    });

    document.body.appendChild(dlg);
    dlg.showModal();
  }

  /* ── 启动 ─────────────────────────────────────────────── */

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('⚙️ 网页加速器设置', openUI);
  }

  if (!get('enabled')) return;
  if (blockedHere()) return;

  if (SR && !get('compat')) {
    try {
      inject();
    } catch (e) {
      compatMode();          // 规则写法出问题就退回兼容模式，别整个摆烂
    }
  } else {
    compatMode();
  }
})();
