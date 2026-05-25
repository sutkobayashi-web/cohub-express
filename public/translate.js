/* CoHub 多言語切替 (JA / EN / PT)
 * - 全ページ共通スクリプト。 <script src="/translate.js" defer></script> で読み込む。
 * - 右上に [🌐 JA|EN|PT] フローティングボタンを表示。
 * - クリック時 DOM 内日本語テキストノードを収集し /api/translate へバッチ送信。
 * - 結果は localStorage と DOM 属性 (data-i18n-orig) に保持。
 * - MutationObserver で後から追加された要素も自動翻訳。
 */
(function () {
  'use strict';
  if (window.__cohubTranslateLoaded) return;
  window.__cohubTranslateLoaded = true;

  const LANGS = [
    { code: 'ja', label: 'JA' },
    { code: 'en', label: 'EN' },
    { code: 'pt', label: 'PT' },
  ];
  const LS_KEY = 'cohub_lang';
  const CACHE_KEY = (lang) => 'cohub_tr_' + lang;
  const MAX_BATCH = 60;
  const HAS_JP = /[぀-ヿ㐀-鿿ｦ-ﾝ]/;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE']);

  let currentLang = (function () {
    try { return localStorage.getItem(LS_KEY) || 'ja'; } catch (e) { return 'ja'; }
  })();

  let cache = loadCache(currentLang);
  let translating = false;
  let pendingObserve = false;

  function loadCache(lang) {
    if (lang === 'ja') return {};
    try {
      const raw = localStorage.getItem(CACHE_KEY(lang));
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }
  function saveCache(lang) {
    if (lang === 'ja') return;
    try { localStorage.setItem(CACHE_KEY(lang), JSON.stringify(cache)); } catch (e) {}
  }

  // ===== UI =====
  function injectStyle() {
    if (document.getElementById('cohub-lang-style')) return;
    const css = `
.cohub-lang-switch{position:fixed;top:2px;right:8px;z-index:99998;display:flex;align-items:center;gap:2px;background:rgba(15,23,42,0.78);color:#fff;border-radius:18px;padding:3px 6px 3px 8px;font-family:system-ui,-apple-system,sans-serif;font-size:11px;font-weight:700;box-shadow:0 2px 8px rgba(0,0,0,0.25);backdrop-filter:blur(6px);user-select:none}
.cohub-lang-switch .cohub-lang-icon{margin-right:2px;font-size:12px;opacity:0.9}
.cohub-lang-switch button{background:transparent;color:#cbd5e1;border:none;padding:3px 6px;margin:0;border-radius:12px;font-size:11px;font-weight:700;cursor:pointer;line-height:1;font-family:inherit}
.cohub-lang-switch button:hover{background:rgba(255,255,255,0.12);color:#fff}
.cohub-lang-switch button.active{background:#0ea5e9;color:#fff}
.cohub-lang-switch.busy::after{content:'';width:8px;height:8px;border-radius:50%;border:2px solid rgba(255,255,255,0.3);border-top-color:#fff;animation:cohubLangSpin 0.8s linear infinite;margin-left:4px}
@keyframes cohubLangSpin{to{transform:rotate(360deg)}}
@media (max-width: 480px){.cohub-lang-switch{top:2px;right:4px;padding:2px 5px 2px 6px;font-size:10px}.cohub-lang-switch button{padding:2px 5px;font-size:10px}}
@media print{.cohub-lang-switch{display:none!important}}
`;
    const st = document.createElement('style');
    st.id = 'cohub-lang-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function injectButton() {
    if (document.getElementById('cohub-lang-switch')) return;
    const box = document.createElement('div');
    box.id = 'cohub-lang-switch';
    box.className = 'cohub-lang-switch';
    const icon = document.createElement('span');
    icon.className = 'cohub-lang-icon';
    icon.textContent = '🌐';
    box.appendChild(icon);
    LANGS.forEach(l => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = l.label;
      b.dataset.lang = l.code;
      if (l.code === currentLang) b.classList.add('active');
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        switchLang(l.code);
      });
      box.appendChild(b);
    });
    document.body.appendChild(box);
  }

  function updateButtonActive() {
    const box = document.getElementById('cohub-lang-switch');
    if (!box) return;
    box.querySelectorAll('button').forEach(b => {
      b.classList.toggle('active', b.dataset.lang === currentLang);
    });
  }
  function setBusy(busy) {
    const box = document.getElementById('cohub-lang-switch');
    if (box) box.classList.toggle('busy', !!busy);
  }

  // ===== テキスト収集 =====
  function shouldSkipNode(node) {
    let p = node.parentNode;
    while (p && p !== document.body) {
      if (p.nodeType === 1) {
        if (SKIP_TAGS.has(p.tagName)) return true;
        if (p.id === 'cohub-lang-switch') return true;
        if (p.hasAttribute && p.hasAttribute('data-no-translate')) return true;
        if (p.getAttribute && p.getAttribute('contenteditable') === 'true') return true;
      }
      p = p.parentNode;
    }
    return false;
  }

  function collectTextNodes(root) {
    const out = [];
    const walker = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
        if (!HAS_JP.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
        if (shouldSkipNode(n)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  function collectAttrTargets(root) {
    // placeholder / title / aria-label / value(button/submit)
    const targets = [];
    const scope = root || document.body;
    const els = scope.querySelectorAll('[placeholder],[title],[aria-label]');
    els.forEach(el => {
      if (el.closest && el.closest('#cohub-lang-switch')) return;
      if (el.hasAttribute('data-no-translate')) return;
      ['placeholder', 'title', 'aria-label'].forEach(attr => {
        const v = el.getAttribute(attr);
        if (v && HAS_JP.test(v)) targets.push({ el, attr });
      });
    });
    // input[type=button|submit].value
    scope.querySelectorAll('input[type="button"],input[type="submit"],input[type="reset"]').forEach(el => {
      if (el.hasAttribute('data-no-translate')) return;
      const v = el.value;
      if (v && HAS_JP.test(v)) targets.push({ el, attr: 'value' });
    });
    return targets;
  }

  // ===== 翻訳適用 =====
  function applyToTextNode(node, lang) {
    if (lang === 'ja') {
      const orig = node.__cohubOrig;
      if (orig != null) {
        node.nodeValue = orig;
        node.__cohubOrig = undefined;
      }
      return;
    }
    const src = node.__cohubOrig != null ? node.__cohubOrig : node.nodeValue;
    if (node.__cohubOrig == null) node.__cohubOrig = src;
    const trimmed = src.trim();
    if (!trimmed) return;
    const t = cache[trimmed];
    if (t) {
      // 前後の空白を保持
      const lead = src.match(/^\s*/)[0];
      const tail = src.match(/\s*$/)[0];
      node.nodeValue = lead + t + tail;
    }
  }
  function applyToAttr(target, lang) {
    const { el, attr } = target;
    const dataKey = '__cohubAttrOrig_' + attr;
    if (lang === 'ja') {
      if (el[dataKey] != null) {
        el.setAttribute(attr, el[dataKey]);
        if (attr === 'value' && 'value' in el) el.value = el[dataKey];
        el[dataKey] = undefined;
      }
      return;
    }
    const src = el[dataKey] != null ? el[dataKey] : el.getAttribute(attr);
    if (el[dataKey] == null) el[dataKey] = src;
    const trimmed = (src || '').trim();
    if (!trimmed) return;
    const t = cache[trimmed];
    if (t) {
      el.setAttribute(attr, t);
      if (attr === 'value' && 'value' in el) el.value = t;
    }
  }

  async function fetchTranslations(missing, lang) {
    if (!missing.length) return {};
    const chunks = [];
    for (let i = 0; i < missing.length; i += MAX_BATCH) {
      chunks.push(missing.slice(i, i + MAX_BATCH));
    }
    const merged = {};
    for (const chunk of chunks) {
      try {
        const resp = await fetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ lang, texts: chunk }),
        });
        if (!resp.ok) {
          console.warn('[translate] HTTP', resp.status);
          continue;
        }
        const data = await resp.json();
        if (data && data.translations) Object.assign(merged, data.translations);
      } catch (e) {
        console.warn('[translate] fetch failed', e);
      }
    }
    return merged;
  }

  async function translatePage(root) {
    if (currentLang === 'ja') return;
    const nodes = collectTextNodes(root);
    const attrs = collectAttrTargets(root);
    if (!nodes.length && !attrs.length) return;

    // 未訳テキスト抽出
    const unique = new Set();
    nodes.forEach(n => {
      const t = (n.__cohubOrig != null ? n.__cohubOrig : n.nodeValue).trim();
      if (t && !cache[t]) unique.add(t);
    });
    attrs.forEach(a => {
      const key = '__cohubAttrOrig_' + a.attr;
      const src = a.el[key] != null ? a.el[key] : a.el.getAttribute(a.attr);
      const t = (src || '').trim();
      if (t && !cache[t]) unique.add(t);
    });

    if (unique.size) {
      setBusy(true);
      const fresh = await fetchTranslations([...unique], currentLang);
      Object.assign(cache, fresh);
      saveCache(currentLang);
      setBusy(false);
    }

    nodes.forEach(n => applyToTextNode(n, currentLang));
    attrs.forEach(a => applyToAttr(a, currentLang));
  }

  function revertPage() {
    // すべての記録済みノードを元に戻す
    const all = document.body ? document.body.getElementsByTagName('*') : [];
    // textノードはwalker再走で
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      if (n.__cohubOrig != null) {
        n.nodeValue = n.__cohubOrig;
      }
    }
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      ['placeholder', 'title', 'aria-label', 'value'].forEach(attr => {
        const key = '__cohubAttrOrig_' + attr;
        if (el[key] != null) {
          el.setAttribute(attr, el[key]);
          if (attr === 'value' && 'value' in el) el.value = el[key];
        }
      });
    }
  }

  async function switchLang(lang) {
    if (translating) return;
    if (!LANGS.find(l => l.code === lang)) return;
    if (lang === currentLang) return;
    translating = true;
    try {
      try { localStorage.setItem(LS_KEY, lang); } catch (e) {}
      const prev = currentLang;
      currentLang = lang;
      cache = loadCache(lang);
      updateButtonActive();
      if (lang === 'ja') {
        revertPage();
      } else {
        if (prev !== 'ja') revertPage();
        await translatePage(document.body);
      }
    } finally {
      translating = false;
    }
  }

  // ===== Mutation Observer =====
  let observer = null;
  let mutQueue = [];
  let mutTimer = null;
  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(muts => {
      if (currentLang === 'ja') return;
      for (const m of muts) {
        if (m.type === 'childList') {
          m.addedNodes.forEach(n => {
            if (n.nodeType === 1) mutQueue.push(n);
            else if (n.nodeType === 3 && HAS_JP.test(n.nodeValue || '')) {
              if (n.parentNode) mutQueue.push(n.parentNode);
            }
          });
        } else if (m.type === 'characterData') {
          if (m.target && m.target.parentNode) mutQueue.push(m.target.parentNode);
        }
      }
      if (mutTimer) return;
      mutTimer = setTimeout(async () => {
        const batch = mutQueue;
        mutQueue = [];
        mutTimer = null;
        if (currentLang === 'ja') return;
        // 重複削除 (祖先関係)
        const set = new Set(batch);
        const roots = [...set].filter(n => {
          for (const other of set) {
            if (other !== n && other.contains && other.contains(n)) return false;
          }
          return true;
        });
        for (const r of roots) {
          try { await translatePage(r); } catch (e) {}
        }
      }, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function init() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', init, { once: true });
      return;
    }
    injectStyle();
    injectButton();
    startObserver();
    if (currentLang !== 'ja') {
      // 初回ロード時は少し待ってから (動的描画と競合させない)
      setTimeout(() => translatePage(document.body).catch(() => {}), 300);
    }
  }
  init();
})();
