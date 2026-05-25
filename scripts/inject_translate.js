// 全HTMLに translate.js の <script> を </body> 直前に追加する一括スクリプト。
// 既に挿入済みのファイルはスキップ。/translate.js は public/ 直下なので
// /takara/*.html からは /translate.js (絶対パス) で参照可能。
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MARKER = 'src="/translate.js"';
const SCRIPT_TAG = '<script src="/translate.js" defer></script>';

function* walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'assets' || ent.name === 'node_modules') continue;
      yield* walk(p);
    } else if (ent.isFile() && ent.name.endsWith('.html')) {
      yield p;
    }
  }
}

let added = 0, skipped = 0, errors = 0;
for (const file of walk(PUBLIC_DIR)) {
  try {
    let html = fs.readFileSync(file, 'utf8');
    if (html.includes(MARKER)) { skipped++; continue; }
    // </body> 直前に挿入。複数ある場合は最後の </body>。
    const idx = html.lastIndexOf('</body>');
    let newHtml;
    if (idx >= 0) {
      newHtml = html.slice(0, idx) + '  ' + SCRIPT_TAG + '\n' + html.slice(idx);
    } else {
      // </body> 無いHTML (片面fragment等) は末尾に追加
      newHtml = html + '\n' + SCRIPT_TAG + '\n';
    }
    fs.writeFileSync(file, newHtml, 'utf8');
    added++;
    console.log('added:', path.relative(PUBLIC_DIR, file));
  } catch (e) {
    errors++;
    console.error('error:', file, e.message);
  }
}
console.log(`\nDone. added=${added} skipped=${skipped} errors=${errors}`);
