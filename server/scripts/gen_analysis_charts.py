#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
事故対策室 AI分析レポート用 グラフ画像生成スクリプト
DBから実データを集計して4種類のグラフを matplotlib で描画 → /opt/cohub/uploads/ に保存
出力されたファイルパスのリストを最終行に JSON で出力する (呼び出し側がパース)

usage: python3 gen_analysis_charts.py <output_dir>
"""
import os, sys, json, sqlite3, time, random, string
from collections import Counter, defaultdict
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import rcParams

# 日本語フォント
rcParams['font.family'] = 'Noto Sans CJK JP'
rcParams['axes.unicode_minus'] = False

DB_PATH = '/opt/cohub/server/db/cohub.db'
OUT_DIR = sys.argv[1] if len(sys.argv) > 1 else '/opt/cohub/uploads'
os.makedirs(OUT_DIR, exist_ok=True)

def rand_id():
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))

def save_fig(fig, label):
    fname = f'chart_{int(time.time())}_{rand_id()}_{label}.png'
    fpath = os.path.join(OUT_DIR, fname)
    fig.savefig(fpath, dpi=130, bbox_inches='tight', facecolor='#0f172a')
    plt.close(fig)
    return '/uploads/' + fname

def style_axes(ax):
    ax.set_facecolor('#0f172a')
    ax.tick_params(colors='#cbd5e1', labelsize=11)
    for s in ax.spines.values():
        s.set_color('#475569')
    ax.title.set_color('#fde68a')
    ax.xaxis.label.set_color('#cbd5e1')
    ax.yaxis.label.set_color('#cbd5e1')

con = sqlite3.connect(DB_PATH)
cur = con.cursor()

charts = []
captions = []

# === Chart 1: 月別件数推移 (反省会記録 + 製品事故 + 車両事故 統合) ===
months = defaultdict(int)
for tbl, col in [('accident_archives', 'accident_date'),
                 ('kbc_accident_reports', 'accident_date'),
                 ('vehicle_accident_reports', 'accident_date')]:
    cur.execute(f"SELECT substr({col},1,7) AS m, COUNT(*) FROM {tbl} "
                f"WHERE {col} IS NOT NULL AND {col} != '' "
                + ("AND deleted_at IS NULL " if tbl == 'accident_archives' else "")
                + "GROUP BY m")
    for m, n in cur.fetchall():
        if m and len(m) == 7:
            months[m] += n
sorted_months = sorted(months.items())[-12:]
if sorted_months:
    fig, ax = plt.subplots(figsize=(10, 4.5))
    fig.patch.set_facecolor('#0f172a')
    xs = [m for m, _ in sorted_months]
    ys = [n for _, n in sorted_months]
    ax.bar(xs, ys, color='#dc2626', edgecolor='#fecaca', linewidth=1.2)
    ax.set_title('月別事故件数 (直近12ヶ月)', fontsize=15, weight='bold', pad=14)
    ax.set_ylabel('件数')
    plt.xticks(rotation=45, ha='right')
    style_axes(ax)
    plt.tight_layout()
    charts.append(save_fig(fig, 'monthly'))
    captions.append('📊 月別事故件数の推移 (直近12ヶ月)')

# === Chart 2: 製品事故 原因カテゴリ Top7 (横棒) ===
cur.execute("SELECT cause_category, COUNT(*) FROM kbc_accident_reports "
            "WHERE cause_category IS NOT NULL AND cause_category != '' "
            "GROUP BY cause_category ORDER BY COUNT(*) DESC LIMIT 7")
prod_causes = cur.fetchall()
if prod_causes:
    fig, ax = plt.subplots(figsize=(10, 4.5))
    fig.patch.set_facecolor('#0f172a')
    labels = [c[0][:20] for c in prod_causes][::-1]
    counts = [c[1] for c in prod_causes][::-1]
    ax.barh(labels, counts, color='#f59e0b', edgecolor='#fde68a', linewidth=1)
    ax.set_title('製品事故 原因カテゴリ Top7', fontsize=15, weight='bold', pad=14)
    ax.set_xlabel('件数')
    style_axes(ax)
    plt.tight_layout()
    charts.append(save_fig(fig, 'cause'))
    captions.append('📊 製品事故の原因カテゴリ別件数')

# === Chart 3: 車両事故 種別 Top5 (円グラフ) ===
cur.execute("SELECT accident_type, COUNT(*) FROM vehicle_accident_reports "
            "WHERE accident_type IS NOT NULL AND accident_type != '' "
            "GROUP BY accident_type ORDER BY COUNT(*) DESC LIMIT 5")
veh_types = cur.fetchall()
if veh_types:
    fig, ax = plt.subplots(figsize=(8, 6))
    fig.patch.set_facecolor('#0f172a')
    labels = [t[0] for t in veh_types]
    sizes = [t[1] for t in veh_types]
    colors = ['#dc2626', '#f59e0b', '#eab308', '#84cc16', '#06b6d4']
    wedges, texts, autotexts = ax.pie(sizes, labels=labels, autopct='%1.0f%%',
                                       colors=colors, startangle=90,
                                       textprops={'color': '#f8fafc', 'fontsize': 12, 'weight': 'bold'},
                                       wedgeprops={'edgecolor': '#0f172a', 'linewidth': 2})
    for at in autotexts:
        at.set_color('#0f172a'); at.set_fontsize(13); at.set_weight('bold')
    ax.set_title('車両事故 種別別の構成比', fontsize=15, weight='bold', pad=14, color='#fde68a')
    plt.tight_layout()
    charts.append(save_fig(fig, 'vehtype'))
    captions.append('📊 車両事故 種別の構成比')

# === Chart 4: 安全三箇条 違反パターン分析 (キーワードマッチ簡易判定) ===
# 反省会記録 + 報告書の cause/description から3カテゴリ推定
def classify_three(text):
    t = (text or '').lower()
    speed_kw = ['速度', '速い', 'スピード', '減速', '急ブレーキ', '制限速度', '法定速度']
    dist_kw = ['車間', '追突', '前方', '前車', '車間距離']
    back_kw = ['バック', '後退', '後方', '降りて', '誘導', '目視', '停止中']
    has_speed = any(k in t for k in speed_kw)
    has_dist = any(k in t for k in dist_kw)
    has_back = any(k in t for k in back_kw)
    return has_speed, has_dist, has_back

three_count = {'speed': 0, 'dist': 0, 'back': 0, 'other': 0, 'total': 0}
for tbl, fields in [
    ('accident_archives', ['full_text']),
    ('kbc_accident_reports', ['cause_detail', 'situation_detail', 'damage_description', 'reporter_reflection']),
    ('vehicle_accident_reports', ['cause_summary', 'description'])]:
    cols = ', '.join(fields)
    where = ''
    if tbl == 'accident_archives': where = "WHERE deleted_at IS NULL"
    cur.execute(f"SELECT {cols} FROM {tbl} {where}")
    for row in cur.fetchall():
        text = ' '.join(str(c or '') for c in row)
        s, d, b = classify_three(text)
        three_count['total'] += 1
        if s: three_count['speed'] += 1
        if d: three_count['dist'] += 1
        if b: three_count['back'] += 1
        if not (s or d or b): three_count['other'] += 1

if three_count['total'] > 0:
    fig, ax = plt.subplots(figsize=(10, 4.5))
    fig.patch.set_facecolor('#0f172a')
    cats = ['「速度」違反\n関係事故', '「車間距離」違反\n関係事故', '「バック走行時\n目視確認」違反', '三箇条以外']
    counts = [three_count['speed'], three_count['dist'], three_count['back'], three_count['other']]
    pct = [c / three_count['total'] * 100 for c in counts]
    bars = ax.bar(cats, counts, color=['#dc2626', '#f59e0b', '#eab308', '#64748b'],
                   edgecolor='#fecaca', linewidth=1.2)
    for bar, c, p in zip(bars, counts, pct):
        ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + max(counts)*0.01,
                f'{c}件\n({p:.0f}%)', ha='center', va='bottom',
                color='#f8fafc', fontsize=11, weight='bold')
    preventable = three_count['speed'] + three_count['dist'] + three_count['back'] - three_count['other']  # 単純加算は重複あり
    # 重複を考慮した防止可能件数: 三箇条のいずれかに該当 = total - other
    preventable_set = three_count['total'] - three_count['other']
    prev_pct = preventable_set / three_count['total'] * 100
    ax.set_title(f'安全三箇条 厳守で防げた可能性が高い事故: {preventable_set}件 / 全{three_count["total"]}件 ({prev_pct:.0f}%)',
                  fontsize=14, weight='bold', pad=16)
    ax.set_ylabel('件数')
    style_axes(ax)
    plt.tight_layout()
    charts.append(save_fig(fig, 'threerules'))
    captions.append(f'📊 安全三箇条で防げる事故: 全{three_count["total"]}件中{preventable_set}件 ({prev_pct:.0f}%)')

con.close()

# 結果を最終行に JSON で出力
print('===CHARTS===')
print(json.dumps({'charts': charts, 'captions': captions}, ensure_ascii=False))
