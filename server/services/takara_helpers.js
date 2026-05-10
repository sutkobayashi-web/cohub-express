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

// 拠点マスタ (業者別の積替倉庫)
//   スタ運/昭栄 → 座間積替倉庫
//   ｶｰﾚﾝﾄ → 東扇島ESR DC1 (自社倉庫)
const DEPOTS = {
  '座間': {
    key: '座間',
    name: '座間積替倉庫',
    address: '神奈川県座間市',
    lat: 35.4869, lng: 139.4061,
    icon: '🏢',
  },
  '東扇島': {
    key: '東扇島',
    name: 'ESR東扇島DC1 (ｶｰﾚﾝﾄ自社倉庫)',
    address: '神奈川県川崎市川崎区東扇島',
    lat: 35.5021, lng: 139.7742,
    icon: '🏭',
  },
};

const COMPANY_DEPOT = {
  'スタ運':  '座間',
  '昭栄':   '座間',
  'ｶｰﾚﾝﾄ':  '東扇島',
  '施工引取': '座間',
  'その他':  '座間',
};

function depotForCompany(company) {
  return DEPOTS[COMPANY_DEPOT[company] || '座間'];
}

module.exports = { classifyVehicle, COMPANY_COLORS, DEPOTS, COMPANY_DEPOT, depotForCompany };
