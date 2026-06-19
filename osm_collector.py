#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
osm_collector.py
Прозрачный сбор ВСЕХ улиц Новосибирска из OpenStreetMap через Overpass API.
"""

import json
import os
import time
import requests
from collections import Counter


with open("data/city_registry.json", encoding="utf-8") as f:
    CITY = json.load(f)[0]

SOUTH, WEST, NORTH, EAST = CITY["bbox"]   
print(f"Город: {CITY['name']} | bbox = {CITY['bbox']}")


OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.ru/api/interpreter",
]

HEADERS = {"User-Agent": "city-memory-project/1.0 (educational DH research)"}


QUERY = f"""
[out:json][timeout:180];
way["highway"]["name"]({SOUTH},{WEST},{NORTH},{EAST});
out tags center;
"""


HIGHWAY_RU = {
    "residential": "жилая улица",
    "living_street": "жилая зона",
    "unclassified": "улица",
    "service": "проезд",
    "tertiary": "ул. районного значения",
    "tertiary_link": "ул. районного значения",
    "secondary": "ул. общегородского значения",
    "secondary_link": "ул. общегородского значения",
    "primary": "главная улица",
    "primary_link": "главная улица",
    "trunk": "магистраль",
    "trunk_link": "магистраль",
    "path": "тропа",
    "footway": "пешеходная дорожка",
    "pedestrian": "пешеходная улица",
    "track": "грунтовая дорога",
    "cycleway": "велосипедная дорожка",
    "construction": "строящаяся улица",
}


def fetch_overpass(query):
    """Отправляем запрос; если сервер не ответил — пробуем следующий."""
    last_error = None
    for endpoint in OVERPASS_ENDPOINTS:
        try:
            print(f"  -> запрашиваю {endpoint} ...")
            r = requests.post(endpoint, data={"data": query}, headers=HEADERS, timeout=120)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            print(f"     сервер не ответил ({e}), пробую следующий")
            last_error = e
            time.sleep(2)
    raise RuntimeError(f"Все серверы Overpass недоступны: {last_error}")


def collect_streets():
    data = fetch_overpass(QUERY)
    elements = data.get("elements", [])
    print(f"Получено сырых объектов (сегментов дорог): {len(elements)}")


    streets = {}
    for el in elements:
        tags = el.get("tags", {})
        name = tags.get("name") or tags.get("name:ru")
        if not name:
            continue
        center = el.get("center", {})
        lat, lon = center.get("lat"), center.get("lon")
        if lat is None or lon is None:
            continue
        highway = tags.get("highway", "")
        rec = streets.setdefault(name, {
            "street": name,
            "_lats": [],
            "_lons": [],
            "street_type": HIGHWAY_RU.get(highway, highway or "улица"),
        })
        rec["_lats"].append(lat)
        rec["_lons"].append(lon)

    result = []
    for rec in streets.values():
        result.append({
            "street": rec["street"],
            "lat": round(sum(rec["_lats"]) / len(rec["_lats"]), 7),
            "lon": round(sum(rec["_lons"]) / len(rec["_lons"]), 7),
            "street_type": rec["street_type"],
        })
    result.sort(key=lambda r: r["street"])
    return result


if __name__ == "__main__":
    try:
        streets = collect_streets()
    except Exception as e:
        print(f"Не удалось собрать данные: {e}")
        print("Overpass часто перегружен — подождите минуту и запустите снова.")
        raise SystemExit(1)

    os.makedirs("data/raw", exist_ok=True)
    out_path = "data/raw/novosibirsk_osm_all_auto.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(streets, f, ensure_ascii=False, indent=2)

    print(f"\nУникальных улиц собрано: {len(streets)}")
    print(f"Сохранено в: {out_path}")

    dist = Counter(s["street_type"] for s in streets)
    print("\nРаспределение по типам (street_type):")
    for t, n in dist.most_common():
        print(f"  {n:5d}  {t}")
