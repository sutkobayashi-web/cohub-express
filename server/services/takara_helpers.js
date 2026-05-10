// タカラ提案デモ用の共通ヘルパー
// 号車番号→業者分類など

// 号車番号→{業者, 配送日種別}を返す
// スタ運の番号レンジは複数あり、用途で分類:
//   200-390 / 400-590 = 平日配送(金曜積込→月曜配送等)
//   600-799 / 800-899 = 土曜配送 (金曜積込→土曜配送)
function classifyVehicle(vehNo) {
  if (!vehNo) return { company: 'その他', delivery_day: null };
  const s = String(vehNo).trim();
  if (/^[AB][0-9]/.test(s)) return { company: 'ｶｰﾚﾝﾄ', delivery_day: '平日' };
  const n = parseInt(s, 10);
  if (isNaN(n)) return { company: 'その他', delivery_day: null };
  if ((n >= 200 && n <= 390) || (n >= 400 && n <= 590)) return { company: 'スタ運', delivery_day: '平日' };
  if (n >= 600 && n <= 899) return { company: 'スタ運', delivery_day: '土曜' };
  if (n >= 961 && n <= 969) return { company: '昭栄', delivery_day: '平日' };
  if (n >= 981 && n <= 989) return { company: '昭栄', delivery_day: '平日' };
  if (n >= 950 && n <= 959) return { company: '施工引取', delivery_day: null };
  if (n >= 971 && n <= 979) return { company: '施工引取', delivery_day: null };
  return { company: 'その他', delivery_day: null };
}

const COMPANY_COLORS = {
  'スタ運':    { bg: '#1e40af', light: '#dbeafe', label: 'スタ運' },
  '昭栄':       { bg: '#ea580c', light: '#fed7aa', label: '昭栄サービス' },
  'ｶｰﾚﾝﾄ':    { bg: '#dc2626', light: '#fecaca', label: 'ｶｰﾚﾝﾄ' },
  '施工引取':    { bg: '#7c3aed', light: '#e9d5ff', label: '施工引取' },
  'その他':     { bg: '#64748b', light: '#e2e8f0', label: 'その他' },
};

module.exports = { classifyVehicle, COMPANY_COLORS };
