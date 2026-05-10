// タカラ提案デモ用の共通ヘルパー
// 号車番号→業者分類など

function classifyVehicle(vehNo) {
  if (!vehNo) return 'その他';
  const s = String(vehNo).trim();
  if (/^[AB][0-9]/.test(s)) return 'ｶｰﾚﾝﾄ';
  const n = parseInt(s, 10);
  if (isNaN(n)) return 'その他';
  if ((n >= 200 && n <= 390) || (n >= 400 && n <= 590)) return 'スタ運';
  if (n >= 961 && n <= 969) return '昭栄';
  if (n >= 981 && n <= 989) return '昭栄';
  if (n >= 950 && n <= 959) return '施工引取';
  if (n >= 971 && n <= 979) return '施工引取';
  return 'その他';
}

const COMPANY_COLORS = {
  'スタ運':    { bg: '#1e40af', light: '#dbeafe', label: 'スタ運' },
  '昭栄':       { bg: '#ea580c', light: '#fed7aa', label: '昭栄サービス' },
  'ｶｰﾚﾝﾄ':    { bg: '#dc2626', light: '#fecaca', label: 'ｶｰﾚﾝﾄ' },
  '施工引取':    { bg: '#7c3aed', light: '#e9d5ff', label: '施工引取' },
  'その他':     { bg: '#64748b', light: '#e2e8f0', label: 'その他' },
};

module.exports = { classifyVehicle, COMPANY_COLORS };
