// 健康点検(点呼/朝礼/自己チェック)で本人が答えた内容を、表示用の行に変換する。
//  ⚠️設問と選択肢の正は public/self-check.html の HC_ITEMS。ここは「表示するためだけ」の写しなので、
//    設問を増減したらこちらも合わせること(判定には使わない)。
//  ⚠️「強い痛み」のときの追加2問(pain_site/pain_drive)はここに入れない。
//    あれは点呼管理の画面だけで見る情報で、現場の声(wellness_posts)には元から保存されていない。
//  ⚠️memo(要約文)から作り直さないこと。判定と同じ structured_json をそのまま読む。

// weight: 'sev' = 緊急度を押し上げる回答 / 'ref' = 判定には足さないが状況として添える回答
const ITEMS = [
  { key: 'duty_intent', label: '🚚 今日の仕事',
    v: { ok: 'いつもどおり働けます', consult: '相談したいことがある', stop: '今日は難しい' },
    sev: ['consult', 'stop'] },
  { key: 'hydration', label: '💧 こまめに水分補給', v: { yes: 'はい', no: 'いいえ' }, ref: ['no'] },
  { key: 'breakfast', label: '🍚 朝食を食べた', v: { yes: 'はい', no: 'いいえ' }, ref: ['no'] },
  { key: 'three_meals', label: '🍽️ 3食きちんと食べた', v: { yes: 'はい', no: 'いいえ' }, ref: ['no'] },
  { key: 'sleep6h', label: '🛌 6時間以上寝た', v: { yes: 'はい', no: 'いいえ' }, ref: ['no'] },
  { key: 'wakeup', label: '🌅 朝の目覚めスッキリ', v: { yes: 'はい', no: 'いいえ' }, ref: ['no'] },
  { key: 'facial_color', label: '🌡️ 顔色',
    v: { normal: '普通', tired: '疲れ気味', red: '赤い', pale: '青白い', unknown: '不明' },
    sev: ['tired', 'red', 'pale'] },
  { key: 'pain', label: '🦴 体の痛み',
    v: { no: 'なし', low_back: '腰', shoulder: '肩・首', joint: '関節', severe: '強い痛み' },
    sev: ['low_back', 'shoulder', 'joint', 'severe'] },
  { key: 'concern', label: '💭 気になる',
    v: { no: 'なし', health: '体調', family: '家族', work: '職場', money: 'お金', other: 'その他' },
    ref: ['health', 'family', 'work', 'money', 'other'] },
];

const CONDITION = { good: '良い', normal: 'ふつう', bad: '悪い' };

// structured_json(文字列 or オブジェクト) → [{ label, value, level }]
//  level: 'sev'(要注意) / 'ref'(参考) / ''(通常)
function answerRows(structured) {
  let d = structured;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return []; } }
  if (!d || typeof d !== 'object') return [];
  const h = d.health || {};
  const rows = [];

  if (d.condition != null && d.condition !== '') {
    rows.push({ label: '🙂 体調', value: CONDITION[d.condition] || String(d.condition),
      level: d.condition === 'bad' ? 'sev' : '' });
  }
  for (const it of ITEMS) {
    const raw = h[it.key];
    if (raw == null || raw === '') continue;   // 答えていない設問は出さない
    const level = (it.sev || []).indexOf(raw) >= 0 ? 'sev'
      : ((it.ref || []).indexOf(raw) >= 0 ? 'ref' : '');
    rows.push({ label: it.label, value: it.v[raw] || String(raw), level });
  }
  const bp = d.bp || {};
  if (bp.sys && bp.dia) {
    // 判定と同じ閾値 (160/100以上=高, 140/90以上=中)
    const level = (bp.sys >= 160 || bp.dia >= 100) ? 'sev' : ((bp.sys >= 140 || bp.dia >= 90) ? 'ref' : '');
    rows.push({ label: '🩸 血圧', value: bp.sys + '/' + bp.dia + (bp.pulse ? '　脈' + bp.pulse : ''), level });
  }
  return rows;
}

// チャット本文(プレーンテキスト)用。1行1問。緊急度を押し上げた回答にだけ ⚠️ を付ける。
//  ⚠️現場の声グループに流れる本文なので、載せるのは健康点検の回答まで。
//    痛みの部位など点呼管理限定の情報はここに入れない(answerRowsに元から無い)。
function answerText(structured) {
  const rows = answerRows(structured);
  if (rows.length < 2) return '';   // 血圧だけ等、点検の回答が無いものは出さない
  return rows.map(r => r.label + ': ' + r.value + (r.level === 'sev' ? ' ⚠️' : '')).join('\n');
}

module.exports = { ITEMS, answerRows, answerText };
