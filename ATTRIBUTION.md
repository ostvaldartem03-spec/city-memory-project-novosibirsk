# Атрибуция и лицензии данных

Проект использует данные и библиотеки из нескольких внешних источников. Ниже – их лицензии и условия атрибуции.

## Данные

### OpenStreetMap
- **Что:** названия улиц, типы, географические координаты и геометрия (через Overpass API).
- **Лицензия:** Open Database License (ODbL) 1.0.
- **Атрибуция:** © участники OpenStreetMap. Данные доступны по лицензии ODbL.
- **Ссылка:** https://www.openstreetmap.org/copyright

### Wikidata
- **Что:** структурированная биография личностей (пол P21, род деятельности P106, даты P569/P570, связи P138).
- **Лицензия:** Creative Commons CC0 1.0 (общественное достояние).
- **Ссылка:** https://www.wikidata.org/wiki/Wikidata:Licensing

### Wikipedia
- **Что:** описания/аннотации и ссылки на статьи.
- **Лицензия:** текст – Creative Commons CC BY-SA 4.0.
- **Ссылка:** https://ru.wikipedia.org/wiki/Википедия:Текст_лицензии_Creative_Commons_Attribution-ShareAlike_4.0

## Изображения (портреты)

Портреты в `dashboard/photos/` имеют разные источники и лицензии и могут быть несвободными.
См. отдельный файл `dashboard/photos/PHOTO_CREDITS.md` и обязательно проверьте права перед публикацией.

## Картография и библиотеки (подключаются онлайн)

| Компонент | Лицензия |
|---|---|
| Leaflet | BSD-2-Clause |
| Chart.js | MIT |
| vis-network | MIT / Apache-2.0 |
| Font Awesome (Free) | CC BY 4.0 (иконки), SIL OFL 1.1 (шрифт), MIT (код) |
| Шрифты Google (Outfit, Playfair Display) | SIL Open Font License 1.1 |
| Тайлы карты | © участники OpenStreetMap (ODbL) |

## Код проекта

Исходный код (dashboard/, data_collector.ipynb) – под лицензией MIT, см. `LICENSE`.
