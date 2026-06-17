# -*- coding: utf-8 -*-
"""Воспроизводимый анализ топонимики Новосибирска.
Считает статистику и строит графики в analysis/figures/.
Используется и как самостоятельный скрипт, и как источник кода для analysis.ipynb.
"""
import json, re, os
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker

plt.rcParams["font.family"] = "DejaVu Sans"
plt.rcParams["axes.unicode_minus"] = False
plt.rcParams["figure.dpi"] = 120

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data", "novosibirsk_streets.json")
FIG  = os.path.join(HERE, "figures")
os.makedirs(FIG, exist_ok=True)

# единая спокойная палитра (согласована с дашбордом)
ACCENT = "#7e44ff"
MALE   = "#3b86db"
FEMALE = "#e0699f"
NEUTRAL= "#8a8fa3"
GRID   = "#d7d9e0"

df = pd.DataFrame(json.load(open(DATA, encoding="utf-8")))
named = df[df["named_after_person"] == True].copy()

# ---------- 0. Общие цифры ----------
total = len(df)
n_named = len(named)
with_wiki = named["wikipedia_url"].notna().sum()
with_wd   = named["wikidata_url"].notna().sum()
uniq_persons = named["person"].dropna().nunique()
print(f"Всего топонимов: {total}")
print(f"Именных (named_after_person): {n_named} ({n_named/total*100:.1f}%)")
print(f"Уникальных персон: {uniq_persons}")
print(f"Со ссылкой на Wikipedia: {with_wiki} ({with_wiki/n_named*100:.1f}%)")
print(f"Со ссылкой на Wikidata: {with_wd} ({with_wd/n_named*100:.1f}%)")

# ---------- 1. Гендер ----------
gender = named["gender"].fillna("Не определён").value_counts()
print("\nГендер:\n", gender)

fig, ax = plt.subplots(figsize=(6, 4))
order_g = [g for g in ["Мужской", "Женский", "Множественное", "Не определён"] if g in gender.index]
vals = [gender[g] for g in order_g]
colors = {"Мужской": MALE, "Женский": FEMALE, "Множественное": NEUTRAL, "Не определён": NEUTRAL}
bars = ax.bar(order_g, vals, color=[colors[g] for g in order_g])
for b, v in zip(bars, vals):
    ax.text(b.get_x()+b.get_width()/2, v+3, f"{v}\n{v/n_named*100:.1f}%", ha="center", va="bottom", fontsize=10)
ax.set_title("Гендерный состав именных улиц Новосибирска", fontsize=12, weight="bold")
ax.set_ylabel("Число топонимов")
ax.set_ylim(0, max(vals)*1.15)
ax.spines[["top","right"]].set_visible(False)
plt.tight_layout(); plt.savefig(os.path.join(FIG, "01_gender.png")); plt.close()

# ---------- 2. Профессии ----------
occ = named["occupation"].fillna("Другое").value_counts()
print("\nПрофессии:\n", occ)

fig, ax = plt.subplots(figsize=(8, 5))
occ_sorted = occ.sort_values()
ax.barh(occ_sorted.index, occ_sorted.values, color=ACCENT)
for i, v in enumerate(occ_sorted.values):
    ax.text(v+1, i, f"{v} ({v/n_named*100:.0f}%)", va="center", fontsize=9)
ax.set_title("Кто «герои города»: сферы деятельности", fontsize=12, weight="bold")
ax.set_xlabel("Число топонимов")
ax.set_xlim(0, occ_sorted.max()*1.18)
ax.spines[["top","right"]].set_visible(False)
plt.tight_layout(); plt.savefig(os.path.join(FIG, "02_occupation.png")); plt.close()

# ---------- 3. Эпохи ----------
ROMAN = {"I":1,"V":5,"X":10,"L":50,"C":100,"D":500,"M":1000}
def roman_to_int(s):
    s = s.strip().upper(); total_=0; prev=0
    for ch in reversed(s):
        if ch not in ROMAN: return None
        v = ROMAN[ch]; total_ += -v if v < prev else v; prev = max(prev, v)
    return total_
def epoch_key(label):
    if not label: return 9999
    if "Древн" in label: return -1
    m = re.match(r"\s*([IVXLCDM]+)", str(label))
    return roman_to_int(m.group(1)) if m else 9998
epoch = named["epoch"].fillna("Неизвестно").value_counts()
epoch = epoch.reindex(sorted(epoch.index, key=epoch_key))
print("\nЭпохи:\n", epoch)

fig, ax = plt.subplots(figsize=(9, 4.5))
ax.bar(epoch.index, epoch.values, color=ACCENT)
for i, v in enumerate(epoch.values):
    ax.text(i, v+2, str(v), ha="center", fontsize=8)
ax.set_title("Хронотоп памяти: эпохи увековеченных личностей", fontsize=12, weight="bold")
ax.set_ylabel("Число топонимов")
plt.xticks(rotation=45, ha="right", fontsize=8)
ax.spines[["top","right"]].set_visible(False)
plt.tight_layout(); plt.savefig(os.path.join(FIG, "03_epoch.png")); plt.close()

# ---------- 4. Гендер × сфера (доля женщин) ----------
ct = pd.crosstab(named["occupation"].fillna("Другое"), named["gender"].fillna("Не опр."))
for col in ["Мужской", "Женский"]:
    if col not in ct.columns: ct[col] = 0
ct["всего"] = ct.sum(axis=1)
ct["доля женщин %"] = (ct["Женский"]/ct["всего"]*100).round(1)
ct = ct.sort_values("всего", ascending=True)
print("\nГендер × сфера:\n", ct[["Мужской","Женский","всего","доля женщин %"]])

fig, ax = plt.subplots(figsize=(8, 5))
ax.barh(ct.index, ct["Мужской"], color=MALE, label="Мужчины")
ax.barh(ct.index, ct["Женский"], left=ct["Мужской"], color=FEMALE, label="Женщины")
ax.set_title("Гендер по сферам деятельности", fontsize=12, weight="bold")
ax.set_xlabel("Число топонимов"); ax.legend()
ax.spines[["top","right"]].set_visible(False)
plt.tight_layout(); plt.savefig(os.path.join(FIG, "04_gender_occupation.png")); plt.close()

# ---------- 5. Годы смерти (пик 1941–1945) ----------
def year(v):
    m = re.search(r"(\d{3,4})", str(v)) if v else None
    return int(m.group(1)) if m else None
named["death_y"] = named["death_year"].map(year)
dy = named["death_y"].dropna()
dy = dy[(dy >= 1700) & (dy <= 2025)]
war = named[(named["death_y"] >= 1941) & (named["death_y"] <= 1945)]
print(f"\nПогибли в 1941–1945: {len(war)} из {named['death_y'].notna().sum()} с известной датой смерти")
mil = named[named["occupation"] == "Военное дело"]
mil_war = mil[(mil["death_y"] >= 1941) & (mil["death_y"] <= 1945)]
print(f"Из них военных, погибших в 1941–45: {len(mil_war)} из {len(mil)} военных")

fig, ax = plt.subplots(figsize=(9, 4))
bins = range(1700, 2030, 10)
ax.hist(dy, bins=bins, color=NEUTRAL, edgecolor="white")
ax.axvspan(1941, 1945, color="#e05a5a", alpha=0.35, label="1941–1945")
ax.set_title("Годы смерти увековеченных личностей", fontsize=12, weight="bold")
ax.set_xlabel("Год смерти"); ax.set_ylabel("Число персон"); ax.legend()
ax.spines[["top","right"]].set_visible(False)
plt.tight_layout(); plt.savefig(os.path.join(FIG, "05_death_years.png")); plt.close()

# ---------- 6. Сфера × эпоха (heatmap) ----------
import numpy as np
named["epoch_f"] = named["epoch"].fillna("Неизвестно")
top_occ = occ.index.tolist()
epoch_order = sorted(named["epoch_f"].unique(), key=epoch_key)
heat = pd.crosstab(named["occupation"].fillna("Другое"), named["epoch_f"]).reindex(index=top_occ, columns=epoch_order).fillna(0)
fig, ax = plt.subplots(figsize=(11, 6))
im = ax.imshow(heat.values, aspect="auto", cmap="BuPu")
ax.set_xticks(range(len(epoch_order))); ax.set_xticklabels(epoch_order, rotation=45, ha="right", fontsize=8)
ax.set_yticks(range(len(top_occ))); ax.set_yticklabels(top_occ, fontsize=9)
for i in range(len(top_occ)):
    for j in range(len(epoch_order)):
        val = int(heat.values[i, j])
        if val: ax.text(j, i, val, ha="center", va="center", fontsize=7, color="#222" if val < heat.values.max()*0.6 else "white")
ax.set_title("«Биография города»: сфера деятельности × эпоха", fontsize=12, weight="bold")
plt.colorbar(im, ax=ax, label="Число топонимов")
plt.tight_layout(); plt.savefig(os.path.join(FIG, "06_occupation_epoch.png")); plt.close()

# ---------- 7. Повторы (топонимы vs люди) ----------
rep = named["person"].value_counts()
rep = rep[rep > 1]
print(f"\nПерсон, увековеченных более 1 раза: {len(rep)}")
print(rep.head(8))

# ---------- 8. Источник атрибуции ----------
src = named["match_source"].fillna("нет").value_counts()
manual = src[src.index.str.contains("manual", case=False)].sum()
print(f"\nРучная верификация (manual_*): {manual} из {n_named} ({manual/n_named*100:.0f}%)")

print("\nСОХРАНЕНЫ ГРАФИКИ:", sorted(os.listdir(FIG)))
