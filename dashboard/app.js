// ================================
// Логика дашборда "Город как текст"
// ================================

// Проект охватывает только Новосибирск.
const CITY = {
    id: 'novosibirsk',
    name: 'Новосибирск',
    center: [55.0302, 82.9204],
    bbox: [54.78, 82.65, 55.20, 83.18],
    data_file: 'data/novosibirsk_streets.json'
};
let currentTab  = 'map';
let streetData  = [];          // все улицы города
let personData  = [];          // только улицы, названные в честь людей
let filteredPersonData = [];   // именные улицы после фильтров

let map          = null;
let baseLayer    = null;
let markersGroup = null;
let highlightGroup = null;
let network      = null;
let charts = { gender: null, occupation: null, epoch: null };

// Единый цвет всех подписей на графиках – берётся из общей палитры проекта (--text-secondary),
// чтобы текст везде выглядел спокойно и одинаково.
const CHART_TEXT = (getComputedStyle(document.documentElement).getPropertyValue('--text-secondary') || '').trim() || 'hsl(230, 15%, 65%)';
let currentMapStyle = 'memory';
let activeHighlightRequestId = 0;
const streetGeometryCache = new Map();

const activeFilters = {
    gender: 'all',
    occupation: 'all',
    epoch: 'all'
};

const MAP_STYLES = {
    memory: 'Память',
    bright: 'Светлая',
    soft: 'Мягкая'
};

const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.openstreetmap.ru/api/interpreter'
];

// Версия локальных данных (cache-busting). Меняйте эту строку после обновления JSON в data/,
// чтобы браузер подтянул свежий файл. Между обновлениями данные кэшируются обычным образом.
const DATA_VERSION = '2026-06-17-genitive';

function escapeHTML(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Хронологическая сортировка эпох вида "XIX век", "XIX–XX век"
function romanToInt(r) {
    const m = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    let n = 0, prev = 0;
    for (let i = r.length - 1; i >= 0; i--) {
        const v = m[r[i]] || 0;
        n += v < prev ? -v : v;
        prev = v;
    }
    return n;
}

function epochSortKey(label) {
    if (!label || label === 'Неизвестно') return 9999999;
    if (label === 'Постсоветский период') return 2200000;
    if (/древн/i.test(label)) return -100000;
    // Поддерживаем диапазоны вида "XIX–XX": сортируем по началу, затем по концу века,
    // чтобы "XIX век" шёл раньше "XIX–XX век".
    const parts = String(label).split(/[––-]/);
    const startRoman = parts[0].replace(/[^IVXLCM]/g, '');
    const endRoman = (parts[1] || parts[0]).replace(/[^IVXLCM]/g, '');
    const start = startRoman ? romanToInt(startRoman) : 90;
    const end = endRoman ? romanToInt(endRoman) : start;
    return start * 1000 + end;
}

function uniqueSortedEpochs(values) {
    return [...new Set(values)].sort((a, b) => epochSortKey(a) - epochSortKey(b));
}

// Палитра веков для диаграммы эпох.
// Светлый хроматический градиент (от прохладных тонов ранних веков к тёплым
// тонам новых веков), хорошо читаемый издалека – например, с дальних рядов
// во время доклада. Высокая светлота вместо прежнего тёмно-фиолетового цвета.
function epochBarColor(index, total, border = false) {
    const t = total > 1 ? index / (total - 1) : 0;
    const hue = Math.round(205 + t * 150); // голубой → пурпурно-тёплый
    const sat = border ? 78 : 70;
    const light = border ? 58 : 66;
    return `hsl(${hue}, ${sat}%, ${light}%)`;
}

function getMarkerColor(data) {
    if (data.named_after_person) {
        // marker_color уже выставлен annotate_streets.py по occupation;
        // OCCUPATION_COLORS_MAP – запасной вариант для старых данных
        return data.marker_color || OCCUPATION_COLORS_MAP[data.occupation] || COLORS.other_occ;
    }
    return data.marker_color || '#8e8e93';
}

function getMarkerIconClass(symbol) {
    const safeSymbol = String(symbol || 'circle').replace(/[^a-z0-9-]/gi, '') || 'circle';
    return `fa-solid fa-${safeSymbol}`;
}

function getMemoryLabel(data) {
    if (data.named_after_person) return data.occupation || data.marker_label || 'Именная улица';
    return data.marker_label || data.memory_type || 'Городской топоним';
}

function hasCoordinates(data) {
    return Number.isFinite(Number(data?.lat)) && Number.isFinite(Number(data?.lon));
}

function hasActivePersonFilters() {
    return activeFilters.gender !== 'all' || activeFilters.occupation !== 'all' || activeFilters.epoch !== 'all';
}

function matchesActivePersonFilters(data) {
    return (activeFilters.gender === 'all' || data.gender === activeFilters.gender) &&
        (activeFilters.occupation === 'all' || data.occupation === activeFilters.occupation) &&
        (activeFilters.epoch === 'all' || data.epoch === activeFilters.epoch);
}

// Палитра цветов
const COLORS = {
    male:         'hsl(210, 75%, 55%)',
    female:       'hsl(340, 75%, 60%)',
    other:        'hsl(150, 60%, 45%)',
    literature:   'hsl(38, 90%, 55%)',
    military:     'hsl(355, 75%, 50%)',
    politics:     'hsl(270, 70%, 60%)',
    science:      'hsl(180, 75%, 45%)',
    art:          'hsl(300, 70%, 55%)',
    cosmonautics: 'hsl(200, 85%, 50%)',
    travels:      'hsl(110, 60%, 50%)',
    religion:     'hsl(48, 70%, 55%)',
    other_occ:    'hsl(230, 15%, 55%)',
    gray:         'rgba(120, 120, 160, 0.35)'
};

const OCCUPATION_COLORS_MAP = {
    'Военное дело':              'hsl(355, 75%, 50%)',
    'Литература':               'hsl(38, 90%, 55%)',
    'Политика и государство':   'hsl(270, 70%, 60%)',
    'Наука':                    'hsl(180, 75%, 45%)',
    'Искусство':                'hsl(300, 70%, 55%)',
    'Промышленность и техника': 'hsl(22, 65%, 48%)',
    'Правопорядок и спасатели': 'hsl(220, 28%, 52%)',
    'Путешествия и география':  'hsl(110, 60%, 50%)',
    'Транспорт':                'hsl(85, 55%, 45%)',
    'Авиация и космонавтика': 'hsl(200, 85%, 50%)',
    'Медицина':                 'hsl(165, 50%, 48%)',
    'Спорт':                    'hsl(25, 85%, 55%)',
    'Другое':                   'hsl(230, 15%, 55%)'
};

const GENDER_COLORS_MAP = {
    'Мужской':  COLORS.male,
    'Женский':  COLORS.female,
    'Другое':   COLORS.other
};

// ─────────────────────────────────────────────────────────────
// Инициализация
// ─────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
    initMap();
    loadStreetData();
});

function initMap() {
    map = L.map('map-element', { zoomControl: false, attributionControl: false, preferCanvas: true })
            .setView(CITY.center, 11);

    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.control.attribution({ position: 'bottomright', prefix: false })
        .addAttribution('<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© участники открытой карты</a>')
        .addTo(map);

    baseLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        crossOrigin: true
    }).addTo(map);

    applyMapStyle(currentMapStyle);

    markersGroup   = L.layerGroup().addTo(map);  // все улицы города
    highlightGroup = L.layerGroup().addTo(map);  // подсветка полной геометрии улицы
}

function switchMapStyle(style) {
    if (!MAP_STYLES[style]) return;
    currentMapStyle = style;
    applyMapStyle(style);
}

function applyMapStyle(style) {
    const mapEl = document.getElementById('map-element');
    if (!mapEl) return;

    Object.keys(MAP_STYLES).forEach(name => {
        mapEl.classList.toggle(`map-style-${name}`, name === style);
        const btn = document.getElementById(`map-style-${name}`);
        if (btn) btn.classList.toggle('active', name === style);
    });
}

// ─────────────────────────────────────────────────────────────
// Загрузка данных
// ─────────────────────────────────────────────────────────────
let dataLoadPromise = null;
let dataLoaded = false;

function showLoadingIndicator() {
    const loader = document.getElementById('loading-indicator');
    if (loader) loader.classList.add('active');
}

function hideLoadingIndicator() {
    const loader = document.getElementById('loading-indicator');
    if (loader) loader.classList.remove('active');
}

function loadStreetData() {
    if (dataLoaded && personData.length > 0) {
        // Данные уже загружены – просто обновить представление
        resetFilters(false);
        populateFilters();
        updateDashboard();
        return;
    }
    if (dataLoadPromise) return;

    const filePath = `../${CITY.data_file}?v=${DATA_VERSION}`;

    showLoadingIndicator();
    dataLoadPromise = fetch(filePath)
        .then(r => {
            if (!r.ok) throw new Error(r.statusText);
            return r.json();
        })
        .then(data => {
            streetData = data;
            // Оптимизированная фильтрация – один проход
            const named = [];
            for (let i = 0; i < data.length; i++) {
                if (data[i].named_after_person === true) named.push(data[i]);
            }
            personData = named;
            filteredPersonData = personData;
            dataLoaded = true;
            resetFilters(false);
            populateFilters();
            updateDashboard();
            hideLoadingIndicator();
        })
        .catch(err => {
            console.error("Ошибка загрузки данных улиц:", err);
            hideLoadingIndicator();
            const statsEl = document.getElementById('map-title-stats');
            if (statsEl) statsEl.textContent = 'Не удалось загрузить данные улиц. Проверьте соединение и обновите страницу.';
        })
        .finally(() => {
            dataLoadPromise = null;
        });
}

// ─────────────────────────────────────────────────────────────
// Главное обновление
// ─────────────────────────────────────────────────────────────
function updateDashboard() {
    updateCityCard();
    updateMapTitle();
    updateFilterStatus();
    updateCharts();
    updateMap();
    if (currentTab === 'network') buildNetwork();
    else if (currentTab === 'gallery') buildGallery();
    resetDetailPanel();
}

function updateMapTitle() {
    const statsEl = document.getElementById('map-title-stats');
    if (!statsEl) return;

    const named = personData.length.toLocaleString('ru-RU');
    const total = streetData.length.toLocaleString('ru-RU');
    statsEl.textContent = `${named} именных улиц из ${total} в базе`;
}

// ─────────────────────────────────────────────────────────────
// Фильтры
// ─────────────────────────────────────────────────────────────
function populateFilters() {
    fillSelect("filter-gender", uniqueSorted(personData.map(d => d.gender).filter(Boolean)), activeFilters.gender);
    fillSelect("filter-occupation", uniqueSorted(personData.map(d => d.occupation).filter(Boolean)), activeFilters.occupation);
    fillSelect("filter-epoch", uniqueSortedEpochs(personData.map(d => d.epoch).filter(Boolean)), activeFilters.epoch);
}

function fillSelect(selectId, values, selectedValue) {
    const select = document.getElementById(selectId);
    if (!select) return;

    select.innerHTML = "";
    const allOption = document.createElement("option");
    allOption.value = "all";
    allOption.textContent = "Все";
    select.appendChild(allOption);

    const normFn = (v) => v ? String(v).normalize('NFC').trim().toLowerCase() : '';
    const normSelected = normFn(selectedValue);
    const normalizedValues = values.map(v => ({ original: v, norm: normFn(v) }));

    normalizedValues.forEach(({ original }) => {
        const option = document.createElement("option");
        option.value = original;
        option.textContent = original;
        select.appendChild(option);
    });

    // Find matching option (case-insensitive with NFC normalization)
    const matched = normalizedValues.find(v => v.norm === normSelected);
    select.value = matched ? matched.original : "all";
}

function uniqueSorted(values) {
    return [...new Set(values)].sort((a, b) => a.localeCompare(b, 'ru'));
}

function handleFilterChange() {
    activeFilters.gender = (document.getElementById("filter-gender")?.value || "all").normalize('NFC').trim();
    activeFilters.occupation = (document.getElementById("filter-occupation")?.value || "all").normalize('NFC').trim();
    activeFilters.epoch = (document.getElementById("filter-epoch")?.value || "all").normalize('NFC').trim();
    applyFilters();
    _personIndex = { filtersKey: null, entries: [] };
    updateDashboard();
}

function resetFilters(shouldUpdate = true) {
    activeFilters.gender = "all";
    activeFilters.occupation = "all";
    activeFilters.epoch = "all";
    applyFilters();
    _personIndex = { filtersKey: null, entries: [] };

    ["filter-gender", "filter-occupation", "filter-epoch"].forEach(id => {
        const select = document.getElementById(id);
        if (select) select.value = "all";
    });

    if (shouldUpdate) updateDashboard();
}

function applyFilters() {
    const norm = (v) => v ? String(v).normalize('NFC').trim().toLowerCase() : '';
    const filterGender = activeFilters.gender === "all" ? null : norm(activeFilters.gender);
    const filterOcc = activeFilters.occupation === "all" ? null : norm(activeFilters.occupation);
    const filterEpoch = activeFilters.epoch === "all" ? null : norm(activeFilters.epoch);

    filteredPersonData = personData.filter(d => {
        if (filterGender && norm(d.gender) !== filterGender) return false;
        if (filterOcc && norm(d.occupation) !== filterOcc) return false;
        if (filterEpoch && norm(d.epoch) !== filterEpoch) return false;
        return true;
    });
}

function updateFilterStatus() {
    const status = document.getElementById("filter-status");
    if (!status) return;

    const activeParts = [];
    if (activeFilters.gender !== "all") activeParts.push(activeFilters.gender);
    if (activeFilters.occupation !== "all") activeParts.push(activeFilters.occupation);
    if (activeFilters.epoch !== "all") activeParts.push(activeFilters.epoch);

    const count = filteredPersonData.length.toLocaleString('ru-RU');
    const total = personData.length.toLocaleString('ru-RU');
    status.textContent = activeParts.length > 0
        ? `Фильтр: ${activeParts.join(" + ")} · показано ${count} из ${total} именных улиц`
        : `На карте ${total} именных улиц`;
}

// ─────────────────────────────────────────────────────────────
// Карточка города
// ─────────────────────────────────────────────────────────────
function updateCityCard() {
    const totalEl   = document.getElementById("stat-total-streets");
    const femaleEl  = document.getElementById("stat-female-percent");
    const titleEl   = document.getElementById("city-title");
    const descEl    = document.getElementById("city-description");

    // Полное число улиц
    totalEl.textContent = streetData.length.toLocaleString('ru-RU');

    // Доля женских улиц (от именных)
    const females = filteredPersonData.filter(d => d.gender === 'Женский').length;
    const pct = filteredPersonData.length > 0 ? Math.round(females / filteredPersonData.length * 100) : 0;
    femaleEl.textContent = `${pct}%`;

    // Дополнительные счётчики
    const namedEl = document.getElementById("stat-named-streets");
    if (namedEl) namedEl.textContent = filteredPersonData.length.toLocaleString('ru-RU');

    // Пояснение к разночтению «улиц vs личности»: одна улица = одна запись,
    // но один человек может быть увековечен в нескольких улицах,
    // поэтому уникальных личностей меньше, чем именных улиц.
    const noteEl = document.getElementById("stat-note");
    if (noteEl) {
        const uniquePersons = new Set(
            filteredPersonData.filter(d => d.person).map(d => personKey(d))
        ).size;
        const streetsNamed = filteredPersonData.length;
        if (uniquePersons > 0 && streetsNamed > 0) {
            const multi = streetsNamed - uniquePersons;
            noteEl.textContent = multi > 0
                ? `${streetsNamed.toLocaleString('ru-RU')} улиц → ${uniquePersons.toLocaleString('ru-RU')} личностей: часть людей увековечена в нескольких улицах.`
                : `${streetsNamed.toLocaleString('ru-RU')} улиц → ${uniquePersons.toLocaleString('ru-RU')} личностей.`;
            noteEl.style.display = '';
        } else {
            noteEl.textContent = '';
            noteEl.style.display = 'none';
        }
    }

    titleEl.textContent = CITY.name;
    descEl.textContent = 'Топонимическая память города в открытых данных: кого и за что увековечили в названиях улиц.';
}

// ─────────────────────────────────────────────────────────────
// Графики (только по именным улицам)
// ─────────────────────────────────────────────────────────────
function updateCharts() {
    // 1. Гендер
    const genderCounts = { 'Мужской': 0, 'Женский': 0, 'Другое': 0 };
    filteredPersonData.forEach(d => {
        const g = d.gender || 'Другое';
        if (g in genderCounts) genderCounts[g]++;
        else genderCounts['Другое']++;
    });

    // 2. Профессии
    const occupationCounts = {};
    filteredPersonData.forEach(d => {
        const occ = d.occupation || 'Другое';
        occupationCounts[occ] = (occupationCounts[occ] || 0) + 1;
    });

    // 3. Эпохи (динамически, по векам)
    const epochCounts = {};
    filteredPersonData.forEach(d => {
        const ep = d.epoch || 'Неизвестно';
        epochCounts[ep] = (epochCounts[ep] || 0) + 1;
    });

    if (charts.gender)     charts.gender.destroy();
    if (charts.occupation) charts.occupation.destroy();
    if (charts.epoch)      charts.epoch.destroy();

    // Гендер (donut)
    const ctxG = document.getElementById('genderChart').getContext('2d');
    charts.gender = new Chart(ctxG, {
        type: 'doughnut',
        data: {
            labels: ['Мужской', 'Женский', 'Другое'],
            datasets: [{
                data: [genderCounts['Мужской'], genderCounts['Женский'], genderCounts['Другое']],
                backgroundColor: [COLORS.male, COLORS.female, COLORS.other],
                borderWidth: 1,
                borderColor: '#1a1a24'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'right', labels: { color: CHART_TEXT, font: { family: 'Outfit', size: 10 } } }
            },
            cutout: '65%'
        }
    });

    // Профессии (горизонтальный бар)
    const sortedOcc = Object.entries(occupationCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
    const ctxO = document.getElementById('occupationChart').getContext('2d');
    charts.occupation = new Chart(ctxO, {
        type: 'bar',
        data: {
            labels: sortedOcc.map(x => x[0]),
            datasets: [{
                data: sortedOcc.map(x => x[1]),
                backgroundColor: sortedOcc.map(x => OCCUPATION_COLORS_MAP[x[0]] || COLORS.other_occ),
                borderWidth: 0,
                borderRadius: 4
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { beginAtZero: true, grid: { display: false }, ticks: { color: CHART_TEXT, font: { family: 'Outfit', size: 9 }, precision: 0 } },
                y: { grid: { display: false }, ticks: { color: CHART_TEXT, autoSkip: false, font: { family: 'Outfit', size: 10 } } }
            }
        }
    });

    // Эпохи (вертикальный бар, динамически по векам)
    const sortedEpoch = Object.entries(epochCounts).sort((a, b) => epochSortKey(a[0]) - epochSortKey(b[0]));
    const ctxE = document.getElementById('epochChart').getContext('2d');
    charts.epoch = new Chart(ctxE, {
        type: 'bar',
        data: {
            labels: sortedEpoch.map(x => x[0]),
            datasets: [{
                data: sortedEpoch.map(x => x[1]),
                backgroundColor: sortedEpoch.map((_, i) => epochBarColor(i, sortedEpoch.length)),
                borderColor: sortedEpoch.map((_, i) => epochBarColor(i, sortedEpoch.length, true)),
                borderWidth: 1,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: {
                        color: CHART_TEXT,
                        font: { family: 'Outfit', size: 11, weight: '500' },
                        autoSkip: false,
                        maxRotation: 60,
                        minRotation: 45
                    }
                },
                y: {
                    beginAtZero: true,
                    grid: { display: false },
                    ticks: { color: CHART_TEXT, font: { family: 'Outfit', size: 10 }, precision: 0 }
                }
            }
        }
    });
}

// ─────────────────────────────────────────────────────────────
// Карта
// ─────────────────────────────────────────────────────────────
let lastMapViewKey = null;

// 🥚 Пасхалка автора: родное село (ул. М. Зибарева, 14, с. Прокудское).
// Это не часть датасета и не входит ни в одну статистику –
// просто личный маркер на карте.
const HOME_EASTER_EGG = {
    lat: 55.00874,
    lon: 82.45790,
    addr: 'ул. М. Зибарева, 14 · с. Прокудское',
    text: 'Отсюда я родом, здесь прошло моё детство.'
};

function addHomeEasterEgg() {
    if (typeof L === 'undefined' || !markersGroup) return;
    const icon = L.divIcon({
        className: 'home-egg-marker',
        html: '<span class="home-egg-pin">\uD83C\uDFE1</span>',
        iconSize: [36, 36],
        iconAnchor: [18, 18],
        popupAnchor: [0, -16]
    });
    const marker = L.marker([HOME_EASTER_EGG.lat, HOME_EASTER_EGG.lon], {
        icon,
        zIndexOffset: 1000,
        keyboard: false
    });
    marker.bindPopup(
        '<div class="home-egg-popup">' +
            '<p class="home-egg-quote">«' + escapeHTML(HOME_EASTER_EGG.text) + '»</p>' +
            '<p class="home-egg-addr">' + escapeHTML(HOME_EASTER_EGG.addr) + '</p>' +
        '</div>',
        { className: 'home-egg-popup-wrap', closeButton: true }
    );
    markersGroup.addLayer(marker);
}

function updateMap() {
    const viewKey = `${CITY.id}_${CITY.center[0]}_${CITY.center[1]}`;
    markersGroup.clearLayers();
    highlightGroup.clearLayers();

    if (lastMapViewKey !== viewKey) {
        map.setView(CITY.center, 11);
        lastMapViewKey = viewKey;
    }

    // 🥚 Пасхалка – родное село автора (всегда на карте, вне фильтров и статистики)
    addHomeEasterEgg();

    // На карте отображаются только именные улицы (named_after_person: true)
    // после применения фильтров по полу, профессии и эпохе.
    // Оптимизация: батчинг через requestAnimationFrame
    const items = filteredPersonData.filter(hasCoordinates);
    const BATCH = 100;

    let i = 0;
    function addBatch() {
        const end = Math.min(i + BATCH, items.length);
        for (; i < end; i++) {
            const d = items[i];
            const markerColor = getMarkerColor(d);
            const genderColor = GENDER_COLORS_MAP[d.gender] || COLORS.other;

            const marker = L.circleMarker([d.lat, d.lon], {
                radius: 7,
                fillColor: markerColor,
                color: genderColor,
                weight: 2,
                opacity: 1,
                fillOpacity: 0.88
            });

            const popupContent = `
                <div>
                    <h4 style="margin:0 0 5px">${escapeHTML(d.street)}</h4>
                    <p style="margin:2px 0"><b>Статус:</b> ${escapeHTML(d.memory_type || getMemoryLabel(d))}</p>
                    <p style="margin:2px 0"><b>В честь:</b> ${escapeHTML(d.person || '–')}</p>
                    <p style="margin:2px 0"><b>Категория:</b> ${escapeHTML(getMemoryLabel(d))}</p>
                    <p style="margin:2px 0"><b>Пол:</b> ${escapeHTML(d.gender || '–')}</p>
                    <p style="margin:2px 0"><b>Тип:</b> ${escapeHTML(d.street_type || 'улица')}</p>
                </div>
            `;
            marker.bindPopup(popupContent);

            marker.on('click', () => {
                showDetails(d);
                highlightStreetGeometry(d);
                map.panTo([d.lat, d.lon]);
            });
            marker.on('mouseover', function () {
                this.setRadius(10);
                this.setStyle({ fillOpacity: 1 });
            });
            marker.on('mouseout', function () {
                this.setRadius(7);
                this.setStyle({ fillOpacity: 0.88 });
            });

            markersGroup.addLayer(marker);
        }
        if (i < items.length) {
            requestAnimationFrame(addBatch);
        }
    }
    if (items.length > 0) {
        requestAnimationFrame(addBatch);
    }
}

// ─────────────────────────────────────────────────────────────
// Подсветка полной улицы
// ─────────────────────────────────────────────────────────────
async function highlightStreetGeometry(data) {
    if (!data?.street || !data.lat || !data.lon || !highlightGroup) return;

    const requestId = ++activeHighlightRequestId;
    highlightGroup.clearLayers();
    updateStreetHighlightStatus(`Ищу полную геометрию: ${data.street}`);
    drawStreetPointFallback(data, true);

    try {
        const lines = await fetchStreetGeometry(data);
        if (requestId !== activeHighlightRequestId) return;
        highlightGroup.clearLayers();

        if (!lines.length) {
            drawStreetPointFallback(data, false);
            updateStreetHighlightStatus(`Геометрия улицы не найдена, показана точка: ${data.street}`);
            return;
        }

        const color = getMarkerColor(data);
        const bounds = [];

        lines.forEach(line => {
            const shadow = L.polyline(line, {
                color: 'rgba(0,0,0,0.72)',
                weight: 11,
                opacity: 0.85,
                lineCap: 'round',
                lineJoin: 'round',
                interactive: false
            });
            const glow = L.polyline(line, {
                color,
                weight: 8,
                opacity: 0.34,
                lineCap: 'round',
                lineJoin: 'round',
                interactive: false
            });
            const main = L.polyline(line, {
                color,
                weight: 4,
                opacity: 1,
                lineCap: 'round',
                lineJoin: 'round',
                interactive: false
            });

            shadow.addTo(highlightGroup);
            glow.addTo(highlightGroup);
            main.addTo(highlightGroup);
            shadow.bringToFront();
            glow.bringToFront();
            main.bringToFront();
            line.forEach(point => bounds.push(point));
        });

        L.circleMarker([data.lat, data.lon], {
            radius: 7,
            fillColor: '#ffffff',
            color,
            weight: 3,
            opacity: 1,
            fillOpacity: 0.96,
            interactive: false
        }).addTo(highlightGroup);

        if (bounds.length > 1) {
            map.fitBounds(L.latLngBounds(bounds), { padding: [42, 42], maxZoom: 16 });
        }
        updateStreetHighlightStatus(`Подсвечена вся улица: ${data.street}`);
    } catch (error) {
        if (requestId !== activeHighlightRequestId) return;
        console.warn('Не удалось загрузить геометрию улицы:', error);
        highlightGroup.clearLayers();
        drawStreetPointFallback(data, false);
        updateStreetHighlightStatus(`Геометрия временно недоступна, показана точка: ${data.street}`);
    }
}

function updateStreetHighlightStatus(text) {
    const status = document.getElementById('street-highlight-status');
    if (status) status.textContent = text;
}

function drawStreetPointFallback(data, loading) {
    const color = getMarkerColor(data);
    L.circleMarker([data.lat, data.lon], {
        radius: loading ? 12 : 10,
        fillColor: color,
        color: '#ffffff',
        weight: 3,
        opacity: 1,
        fillOpacity: loading ? 0.28 : 0.42,
        dashArray: loading ? '4 6' : null,
        interactive: false
    }).addTo(highlightGroup);
}

async function fetchStreetGeometry(input) {
    // Принимаем либо объект улицы (с lat/lon), либо пр��сто имя – для совместимости.
    const streetName = typeof input === 'string' ? input : (input && input.street);
    const lat = (input && typeof input === 'object') ? input.lat : null;
    const lon = (input && typeof input === 'object') ? input.lon : null;
    if (!streetName) return [];

    const cacheKey = `${CITY.id}:${streetName}`;
    if (streetGeometryCache.has(cacheKey)) {
        return streetGeometryCache.get(cacheKey);
    }

    const [south, west, north, east] = CITY.bbox;
    const cityBox = `${south},${west},${north},${east}`;
    const safe = escapeOverpassString(streetName);
    const rx = escapeOverpassRegex(streetName);
    // Улицы в OSM могут быть подписаны разными тегами имени.
    const NAME_KEYS = ['name', 'name:ru', 'alt_name', 'official_name', 'loc_name', 'old_name', 'short_name'];

    const dedupe = (elements) => {
        const seen = new Set();
        const out = [];
        for (const el of elements) {
            if (el.id != null && seen.has(el.id)) continue;
            if (el.id != null) seen.add(el.id);
            out.push(el);
        }
        return out;
    };

    // 1) Точное совпадение по любому из именных тегов.
    let elements = await runOverpassGeometryQuery(`
[out:json][timeout:25];
(
${NAME_KEYS.map(k => `  way["highway"]["${k}"="${safe}"](${cityBox});`).join('\n')}
);
out tags geom;
`);

    // 2) Регистронезависимое совпадение целиком по любому из именных тегов.
    if (!elements.length) {
        elements = await runOverpassGeometryQuery(`
[out:json][timeout:25];
(
${NAME_KEYS.map(k => `  way["highway"]["${k}"~"^${rx}$",i](${cityBox});`).join('\n')}
);
out tags geom;
`);
    }

    // 3) Запасной вариант: берём все именованные улицы в небольшой окрестности
    //    маркера и сопоставляем названия с нормализацией (префиксы, ё/е, регистр,
    //    сокращения). Тёсный bbox защищает от ложных совпадений с одноимёнными улицами.
    if (!elements.length && typeof lat === 'number' && typeof lon === 'number') {
        const dLat = 0.016, dLon = 0.028; // ≈ 1.7 км
        const localBox = `${(lat - dLat).toFixed(5)},${(lon - dLon).toFixed(5)},${(lat + dLat).toFixed(5)},${(lon + dLon).toFixed(5)}`;
        const nearby = await runOverpassGeometryQuery(`
[out:json][timeout:25];
way["highway"]["name"](${localBox});
out tags geom;
`);
        const target = normStreetName(streetName);
        elements = nearby.filter(el => {
            const n = normStreetName(el.name);
            return n && target && (n === target || n.includes(target) || target.includes(n));
        });
    }

    const lines = dedupe(elements).map(el => el.line);
    streetGeometryCache.set(cacheKey, lines);
    return lines;
}

async function runOverpassGeometryQuery(query) {
    let lastError = null;

    for (const endpoint of OVERPASS_ENDPOINTS) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 18000);

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                body: new URLSearchParams({ data: query }),
                signal: controller.signal
            });

            if (!response.ok) throw new Error(`Overpass ${response.status}`);
            const payload = await response.json();
            return (payload.elements || [])
                .filter(element => Array.isArray(element.geometry) && element.geometry.length > 1)
                .map(element => ({
                    id: element.id,
                    name: (element.tags && (element.tags.name || element.tags['name:ru'] || element.tags.alt_name || element.tags.official_name || element.tags.loc_name || element.tags.old_name)) || '',
                    line: element.geometry.map(point => [point.lat, point.lon])
                }));
        } catch (error) {
            lastError = error;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    throw lastError || new Error('Геометрия улицы недоступна');
}

function escapeOverpassString(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeOverpassRegex(value) {
    return escapeOverpassString(String(value || '').replace(/[.*+?^${}()|\[\]\\]/g, '\\$&'));
}

// Нормализация названия улицы для устойчивого сопоставления:
// нижний регистр, ё→е, отбрасывание пунктуации и лишних пробелов.
function normStreetName(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/\u0451/g, '\u0435')
        .replace(/[^0-9a-z\u0430-\u044f]+/g, ' ')
        .trim();
}

// ─────────────────────────────────────────────────────────────
// Граф связей (Vis.js) – все именные улицы
// ─────────────────────────────────────────────────────────────
function buildNetwork() {
    const container = document.getElementById('network-element');

    const nodes = [];
    const edges = [];

    const cityNodeId = 'city_root';
    nodes.push({
        id: cityNodeId,
        label: CITY.name,
        title: 'Исследуемый город',
        color: { background: COLORS.literature, border: '#ffffff' },
        size: 40,
        shape: 'dot',
        font: { size: 18, color: '#ffffff', face: 'Outfit', strokeWidth: 4, strokeColor: '#12121c' }
    });

    // Категории-профессии
    const occupations = [...new Set(filteredPersonData.map(d => d.occupation))].filter(Boolean);
    occupations.forEach(occ => {
        const occNodeId = `occ_${occ}`;
        const cnt = filteredPersonData.filter(d => d.occupation === occ).length;
        nodes.push({
            id: occNodeId,
            label: `${occ} (${cnt})`,
            shape: 'dot',
            size: 22 + Math.min(cnt / 5, 18),
            color: OCCUPATION_COLORS_MAP[occ] || COLORS.other_occ,
            font: { size: 13, color: '#e0e0e0', face: 'Outfit', strokeWidth: 2, strokeColor: '#12121c' }
        });
        edges.push({ from: cityNodeId, to: occNodeId, color: { color: 'rgba(255,255,255,0.18)' }, width: 2 });
    });

    // Эпохи
    const epochs = [...new Set(filteredPersonData.map(d => d.epoch))].filter(e => e && e !== 'Не��звестно');
    epochs.forEach(ep => {
        const epochNodeId = `epoch_${ep}`;
        nodes.push({
            id: epochNodeId,
            label: ep.replace(" (Российская Империя)", "").replace(" (до XVIII века)", ""),
            shape: 'square',
            size: 16,
            color: '#7e44ff',
            font: { size: 11, color: '#b3b3c6', face: 'Outfit' }
        });
        edges.push({ from: cityNodeId, to: epochNodeId, color: { color: 'rgba(126, 68, 255, 0.1)' }, width: 1, dashes: true });
    });

    // ВСЕ персоналии (без ограничения 50)
    const seenPersons = new Set();
    const allPersons = [];
    filteredPersonData.forEach(d => {
        if (d.person && !seenPersons.has(d.person)) {
            seenPersons.add(d.person);
            allPersons.push(d);
        }
    });

    allPersons.forEach(p => {
        const personNodeId = `person_${p.person.replace(/[^а-яА-ЯёЁa-zA-Z0-9]/g, '_')}_${p.birth_year || 'x'}`;
        const gColor = GENDER_COLORS_MAP[p.gender] || COLORS.other;
        const occColor = OCCUPATION_COLORS_MAP[p.occupation] || COLORS.other_occ;
        const tooltipTitle = `<b>${escapeHTML(p.street)}</b><br>Персона: ${escapeHTML(p.person)}<br>Сфера: ${escapeHTML(p.original_occupations || p.occupation)}<br>${p.birth_year || '?'}–${p.death_year || '?'}`;
        nodes.push({
            id: personNodeId,
            label: p.person.split(' ').slice(-1)[0], // Только фамилия для компактности
            fullName: p.person,
            shape: 'dot',
            size: 7,
            color: { background: gColor, border: occColor, highlight: { background: gColor, border: '#ffffff' } },
            borderWidth: 2,
            title: tooltipTitle,
            font: { size: 9, color: '#d0d0d0', face: 'Outfit', strokeWidth: 2, strokeColor: '#12121c' }
        });
        const occNodeId = `occ_${p.occupation}`;
        edges.push({ from: occNodeId, to: personNodeId, color: { color: 'rgba(255,255,255,0.12)' }, width: 1 });
        if (p.epoch && p.epoch !== 'Неизвестно') {
            const epochNodeId = `epoch_${p.epoch}`;
            edges.push({ from: epochNodeId, to: personNodeId, color: { color: 'rgba(126, 68, 255, 0.08)' }, width: 1 });
        }
    });

    const graphData = { nodes, edges };
    const options = {
        physics: {
            enabled: true,
            barnesHut: {
                gravitationalConstant: -5200,
                centralGravity: 0.12,
                springLength: 150,
                springConstant: 0.022,
                damping: 0.3,
                avoidOverlap: 0.08
            },
            stabilization: { iterations: 200, fit: true }
        },
        interaction: {
            hover: true,
            tooltipDelay: 200,
            navigationButtons: true,
            keyboard: true
        },
        edges: {
            smooth: { enabled: true, type: 'continuous', roundness: 0.45 },
            color: { inherit: false }
        },
        nodes: {
            borderWidth: 2,
            shadow: { enabled: true, color: 'rgba(0,0,0,0.3)', size: 4, x: 0, y: 0 }
        }
    };

    if (network) {
        network.destroy();
    }

    network = new vis.Network(container, graphData, options);

    // Обновить статистику сети
    const statsEl = document.getElementById('network-stats');
    if (statsEl) {
        statsEl.textContent = `· Всего: ${allPersons.length} персон, ${occupations.length} сфер, ${epochs.length} эпох`;
    }
    network.on("click", function (params) {
        if (params.nodes.length > 0) {
            const nodeId = params.nodes[0];
            if (nodeId.startsWith('person_')) {
                const clickedNode = nodes.find(n => n.id === nodeId);
                if (clickedNode && clickedNode.fullName) {
                    const found = filteredPersonData.find(d => d.person === clickedNode.fullName);
                    if (found) showDetails(found);
                }
            }
        }
    });
}

// ─────────────────────────────────────────────────────────────
// Детальная панель
// ─────────────────────────────────────────────────────────────
function showDetails(data) {
    document.getElementById("detail-placeholder").classList.add("hidden");
    const content = document.getElementById("detail-content");
    content.classList.remove("hidden");

    updateDetailPortrait(data);

    document.getElementById("detail-street-name").textContent   = data.street;
    document.getElementById("detail-person-name").textContent   = data.person || '–';
    document.getElementById("detail-street-type").textContent = data.street_type || 'топоним';
    document.getElementById("detail-memory-type").textContent = data.memory_type || (data.named_after_person ? 'Именная мемориальная улица' : 'Обычный городской топоним');
    document.getElementById("detail-annotation").textContent = data.annotation || 'Семантическое обозначение пока не задано.';

    const markerIcon = document.getElementById("detail-marker-icon");
    markerIcon.style.background = getMarkerColor(data);
    markerIcon.innerHTML = "";
    const iconEl = document.createElement("i");
    iconEl.className = getMarkerIconClass(data.marker_symbol);
    markerIcon.appendChild(iconEl);

    const yearsStr = (data.birth_year && data.death_year)
        ? `${data.birth_year} – ${data.death_year} гг.`
        : (data.birth_year ? `р. ${data.birth_year} г.` : "Годы жизни неизвестны");
    document.getElementById("detail-person-years").textContent = yearsStr;

    document.getElementById("detail-person-gender").textContent      = data.gender || '–';
    document.getElementById("detail-person-occupations").textContent = data.original_occupations || data.occupation || '–';
    document.getElementById("detail-person-epoch").textContent       = data.epoch || '–';

    const badge = document.getElementById("detail-badge");
    badge.textContent  = getMemoryLabel(data);
    badge.className    = "category-badge";

    switch (data.occupation) {
        case 'Литература':             badge.classList.add('badge-lit');   break;
        case 'Военное дело':           badge.classList.add('badge-mil');   break;
        case 'Политика и государство': badge.classList.add('badge-pol');   break;
        case 'Наука':                  badge.classList.add('badge-sci');   break;
        case 'Искусство':              badge.classList.add('badge-art');   break;
        case 'Космонавтика':           badge.classList.add('badge-cosm');  break;
        case 'Путешествия':            badge.classList.add('badge-trav');  break;
        case 'Спорт':                  badge.classList.add('badge-sport'); break;
        case 'Религия':                badge.classList.add('badge-rel');   break;
        default:
            badge.classList.add(data.named_after_person ? 'badge-other' : 'badge-toponym');
    }

    updateExternalLinks(data);
    updateExternalLink("detail-source-url", data.source_url);

    // Кнопка «Показать на карте» – только если есть координаты
    const showMapBtn = document.getElementById('detail-show-on-map');
    if (showMapBtn) {
        const hasCoords = hasCoordinates(data);
        showMapBtn.classList.toggle('hidden', !hasCoords);
        showMapBtn._lastData = data;
    }

    const analysisEl = document.getElementById("detail-dh-notes");
    if (data.review_note) {
        analysisEl.textContent = data.review_note;
    } else if (data.named_after_person) {
        analysisEl.textContent = generateDHCommentary(data);
    } else {
        analysisEl.textContent = `«${data.street}» – ${data.memory_type ? data.memory_type.toLowerCase() : 'топонимическое название'}, не связанное с конкретной исторической личностью. ${data.annotation || 'Такие названия помогают увидеть не только персональ��ую, но и пространственную, пр��родную, административную и идеологическую семантику городской сети.'}`;
    }
}

function normalizeExternalLinks(singleUrl, urls, labels, fallbackLabel) {
    const result = [];
    if (Array.isArray(urls)) {
        urls.forEach((url, index) => {
            if (url) {
                result.push({
                    url,
                    label: Array.isArray(labels) && labels[index] ? labels[index] : fallbackLabel,
                });
            }
        });
    } else if (singleUrl) {
        result.push({ url: singleUrl, label: fallbackLabel });
    }
    return result;
}

function updateExternalLinks(data) {
    const extraLinks = document.getElementById("detail-extra-links");
    extraLinks.innerHTML = "";

    const wikidataLinks = normalizeExternalLinks(data.wikidata_url, data.wikidata_urls, data.wikidata_labels, "Wikidata");
    const wikipediaLinks = normalizeExternalLinks(data.wikipedia_url, data.wikipedia_urls, data.wikipedia_labels, "Wikipedia");

    updateExternalLink("detail-wikidata-url", wikidataLinks.length > 1 ? null : wikidataLinks[0]?.url);
    updateExternalLink("detail-wikipedia-url", wikipediaLinks.length > 1 ? null : wikipediaLinks[0]?.url);

    if (wikidataLinks.length > 1) {
        wikidataLinks.forEach(linkData => addExternalLink(extraLinks, linkData.url, linkData.label, "fa-solid fa-database"));
    }
    if (wikipediaLinks.length > 1) {
        wikipediaLinks.forEach(linkData => addExternalLink(extraLinks, linkData.url, linkData.label, "fa-brands fa-wikipedia-w"));
    }
}

function addExternalLink(container, url, label, iconClass) {
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.className = "wikidata-link";

    const icon = document.createElement("i");
    icon.className = iconClass;
    link.appendChild(icon);
    link.appendChild(document.createTextNode(` ${label}`));
    container.appendChild(link);
}

function updateExternalLink(elementId, url) {
    const link = document.getElementById(elementId);
    if (!link) return;
    if (url) {
        link.href = url;
        link.classList.remove("hidden");
    } else {
        link.href = "#";
        link.classList.add("hidden");
    }
}

// Достаёт форму имени в РОДИТЕЛЬНОМ падеже из готовой аннотации
// (например, «…в честь Игоря Курчатова – …» → «Игоря Курчатова»).
// Аннотации уже содержат корректно просклонённое имя, поэтому это
// надёжнее ручного склонения и исключает ошибки в падежах.
function getGenitiveName(data) {
    // 1) Готовое поле родительного падежа (построено для каждой именной улицы).
    if (data.person_genitive && data.person_genitive.toString().trim()) {
        return data.person_genitive.toString().trim();
    }
    // 2) Запасной вариант – извлечь из аннотации «в честь X».
    const ann = (data.annotation || '').toString();
    const m = ann.match(/в честь\s+(.+?)\s*(?:[––-]|;|\.|$)/i);
    if (m && m[1]) return m[1].trim();
    return data.person || 'этого деятеля';
}

function generateDHCommentary(data) {
    const nameGen    = getGenitiveName(data);
    const nameNom    = (data.person || '').toString().trim();
    const cat        = data.occupation || '';
    const epoch      = data.epoch || '';
    const epochRaw   = data.epoch_raw || '';
    const streetType = (data.street_type || 'улица').toString().toLowerCase();
    const occText    = (data.original_occupations || '').toString().trim();
    const epochKey   = `${epochRaw} ${epoch}`;

    const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
    const parts = [];

    // 1. Вводное предложение – имя в родительном падеже.
    parts.push(`${cap(streetType)} имени ${nameGen} – один из устойчивых маркеров исторической памяти города.`);

    // 2. Хронологический пласт памяти.
    if (/Советск|Революци|Гражданск/i.test(epochKey)) {
        parts.push('Название закрепилось в советскую эпоху, когда городская топонимика активно перестраивалась: дореволюционные имена уступали место новому пантеону героев.');
    } else if (/Импери|Российская империя/i.test(epochKey)) {
        parts.push('Имя принадлежит дореволюционному, имперскому пласту памяти, а его сохранение в советские десятилетия говорит о культурной ценности фигуры, перешагнувшей идеологические границы.');
    } else if (/Постсоветск|Современн/i.test(epochKey)) {
        parts.push('Название относится к постсоветскому периоду переосмысления памяти, когда город заново определял, кого и как увековечивать.');
    } else if (epoch) {
        parts.push(`Хронологически фигура относится к периоду «${epoch}».`);
    }

    // 3. Биографическая справка (именительный падеж – без ошибок в склонении).
    if (nameNom) {
        const years = (data.birth_year && data.death_year)
            ? ` (${data.birth_year}–${data.death_year})`
            : (data.birth_year ? ` (р. ${data.birth_year})` : '');
        const verb = data.gender === 'Женский' ? 'увековечена' : 'увековечен';
        parts.push(occText
            ? `${nameNom}${years} – ${occText}.`
            : `${nameNom}${years} ${verb} в городской топонимике Новосибирска.`);
    }

    // 4. Категориальный анализ сферы памяти.
    const byCat = {
        'Литература': 'Литература традиционно занимает одно из центральных мест в российском «пантеоне памяти»: улицы в честь писателей и поэтов работали как символические центры просвещения и формирования общенациональной идентичности.',
        'Военное дело': 'Милитаризация памяти служила государству инструментом легитимации силы и героизации прошлого, а улицы в честь военачальников и героев войн становились частью патриотического воспитания.',
        'Политика и государство': 'Названия в честь политических деятелей сильнее прочих подвергались переименованиям при смене режимов – это прямые следы государственной идеологии в ткани города.',
        'Наука': 'Мемориализация учёных подчёркивает культ научно-технического прогресса и интеллектуального суверенитета, формируя технократический образ города – особенно значимый для Новосибирска с его Академгородком.',
        'Искусство': 'Имена композиторов, художников и артистов создают эстетический каркас городской памяти, подчёркивая ценность культурного наследия.',
        'Промышленность и техника': 'Имена инженеров, конструкторов и организаторов производст��а отражают индустриальную идентичность города и культ труда, характерный для советской урбанонимики.',
        'Правопорядок и спасатели': 'Увековечение представителей правопорядка и спасательных служб закрепляет в городском пространстве идею гражданского долга и самопожертвования.',
        'Путешествия и география': 'Имена путешественников и исследователей вписывают город в географию открытий и расширяют его символические горизонты.',
        'Транспорт': 'Имена деятелей транспорта подчёркивают роль путей сообщения в освоении Сибири и в самосознании города как крупного транспортного узла.',
        'Авиация и космонавтика': 'Авиация и космонавтика – яркие маркеры триумфа советской науки и техники; такие названия символизируют устремлённость в будущее и технологический прорыв середины XX века.',
        'Медицина': 'Имена врачей и учёных-медиков увековечивают идею служения и заботы о жизни, придавая городской памяти гуманистическое измерение.',
        'Спорт': 'Имена спортсменов отражают сравнительно новый пласт памяти, связанный с культурой здоровья, достижений и массового спорта.',
        'Религия': 'Религиозные фигуры в топонимике показывают, как духовные авторитеты и церковная история становятся частью публичной памяти города.'
    };
    parts.push(byCat[cat] || 'Канонизация этой фигуры отражает многообразие исторических смыслов, заложенных в названиях городских улиц.');

    // 5. Гендерный акцент (важен для гендерного среза проекта).
    if (data.gender === 'Женский') {
        parts.push('Женские имена в городской топонимике встречаются редко, поэтому это название особенно ценно для гендерного анализа памяти.');
    }

    // 6. Обобщающий вывод.
    parts.push('Подобные годонимы превращают уличную сеть в текст, по которому можно читать ценности, иерархии и приоритеты своей эпохи.');

    return parts.join(' ');
}

function resetDetailPanel() {
    document.getElementById("detail-placeholder").classList.remove("hidden");
    document.getElementById("detail-content").classList.add("hidden");
}

// ─────────────────────────────────────────────────────────────
// Вкладки
// ─────────────────────────────────────────────────────────────
function switchTab(tab) {
    if (currentTab === tab) return;
    currentTab = tab;

    document.getElementById("tab-map").classList.toggle("active",      tab === 'map');
    document.getElementById("tab-network").classList.toggle("active",  tab === 'network');
    document.getElementById("tab-gallery").classList.toggle("active",  tab === 'gallery');
    document.getElementById("map-view").classList.toggle("active",     tab === 'map');
    document.getElementById("network-view").classList.toggle("active", tab === 'network');
    document.getElementById("gallery-view").classList.toggle("active", tab === 'gallery');

    if (tab === 'map') {
        setTimeout(() => { map.invalidateSize(); }, 200);
    } else if (tab === 'network') {
        buildNetwork();
    } else if (tab === 'gallery') {
        buildGallery();
    }
}

// ─────────────────────────────────────────────────────────────
// Поиск: улица, персона, синонимы
// ─────────────────────────────────────────────��───────────────
function searchNorm(s) {
    return (s || '').toString().toLowerCase().replace(/ё/g, 'е').trim();
}

function positionSearchDropdown() {
    const input = document.getElementById('street-search');
    const dd = document.getElementById('search-suggestions');
    if (!input || !dd || dd.style.display !== 'block') return;

    const r = input.getBoundingClientRect();
    const width = Math.max(r.width, 280);
    const top = r.bottom + 5;
    const maxHeight = Math.min(420, window.innerHeight - top - 12);
    dd.style.left   = r.left + 'px';
    dd.style.top    = top + 'px';
    dd.style.width  = width + 'px';
    dd.style.maxHeight = maxHeight + 'px';
}

// Разбирае�� строку персоны в набор «поисковых токенов»:
// «Пушкин, Александр Сергеевич» → ["пушкин александр сергеевич", "пушкин", "александр сергеевич"]
// Учитывает обратный порядок «Сергеевич Александр Пушкин» → "пушкин александр серг��евич"
function buildPersonIndex(personStr) {
    const norm = searchNorm(personStr).replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    if (!norm) return { norm: '', tokens: [] };
    const parts = norm.split(' ').filter(Boolean);
    if (parts.length <= 1) return { norm, tokens: [norm] };

    // Эвристика «фамилия»: обычно это самая длинная часть или последняя в «Имя Фамилия»;
    // в наших данных фамилия чаще всего стоит последней ("Пушкин, Александр Сергеевич"
    // после замены запятой → "пушкин александр сергеевич", фамилия = parts[0]).
    const surname = parts[0];
    const given = parts.slice(1);
    const variants = new Set([norm, surname, given.join(' ')]);
    // Перестановки: для «александр сергеевич пушкин» → «пушкин александр сергеевич»
    if (parts.length === 3) {
        variants.add(`${parts[2]} ${parts[0]} ${parts[1]}`); // пушкин александр сергеевич
        variants.add(`${parts[2]} ${parts[0]}`);
        variants.add(`${parts[1]} ${parts[0]}`);
    }
    return { norm, tokens: [...variants] };
}

// Кеш индекса персон: перестраивается при смене фильтров
let _personIndex = { filtersKey: null, entries: [] };

function buildPersonIndexForSearch() {
    const filtersKey = JSON.stringify({
        g: activeFilters.gender, o: activeFilters.occupation, e: activeFilters.epoch
    });

    if (_personIndex.filtersKey === filtersKey) {
        return _personIndex.entries;
    }

    // Группируем улицы по персоне, оставляя только записи,
    // согласованные с активными фильтрами (filteredPersonData).
    const byKey = new Map();
    filteredPersonData.forEach(d => {
        if (!d.person) return;
        const key = d.person_canonical || d.person;
        if (!byKey.has(key)) {
            byKey.set(key, {
                person: d.person,
                person_canonical: d.person_canonical || d.person,
                occupation: d.occupation,
                gender: d.gender,
                epoch: d.epoch,
                birth_year: d.birth_year,
                death_year: d.death_year,
                original_occupations: d.original_occupations,
                streets: []
            });
        }
        byKey.get(key).streets.push(d);
    });

    const entries = [...byKey.values()].map(p => {
        const idx = buildPersonIndex(p.person);
        // Выбираем «главную» улицу: предпочитаем с координатами; иначе первую.
        const withCoords = p.streets.find(s => hasCoordinates(s)) || p.streets[0];
        return {
            ...p,
            _searchNorm: idx.norm,
            _searchTokens: idx.tokens,
            _representative: withCoords
        };
    });

    _personIndex = { filtersKey, entries };
    return entries;
}

function getStreetsForSearch() {
    // Улицы показываем тоже, но только релевантные активным фильтрам:
    // Именные берём из filteredPersonData, неименные – из streetData.
    const allowedStreets = new Set();
    filteredPersonData.forEach(d => d.street && allowedStreets.add(d.street));
    return (streetData || []).filter(d => {
        if (d.named_after_person) return filteredPersonData.includes(d);
        return true; // неименные всегда видны
    });
}

// Оценка релевантности: меньше = лучше. null = нет совпадения.
function scoreMatch(query, candidateNorm, tokens) {
    if (!candidateNorm) return null;
    if (candidateNorm === query) return 0;                    // точное совпадение
    if (candidateNorm.startsWith(query)) return 1;            // префикс
    for (const t of tokens) {
        if (t === query) return 0;
        if (t.startsWith(query)) return 1;
        if (t.includes(query)) return 2;
    }
    if (candidateNorm.includes(query)) return 3;               // подстрока в полной строке
    return null;
}

function highlightMatch(text, query) {
    if (!text) return '';
    const normText = searchNorm(text);
    const idx = normText.indexOf(query);
    if (idx < 0) return escapeHTML(text);
    // Подсветка в оригинальной строке: оригинал и нормализованный могут различаться по регистру
    // и по ё/е, поэтому ищем по нормализованному и подсвечиваем соответствующий кусок оригинала.
    const before = text.slice(0, idx);
    const match  = text.slice(idx, idx + query.length);
    const after  = text.slice(idx + query.length);
    return escapeHTML(before) + '<mark class="search-hl">' + escapeHTML(match) + '</mark>' + escapeHTML(after);
}

function handleSearch() {
    const queryRaw = document.getElementById("street-search").value;
    const query    = searchNorm(queryRaw);
    const dropdown = document.getElementById("search-suggestions");

    if (query.length < 2) {
        dropdown.style.display = 'none';
        document.getElementById("street-search").setAttribute('aria-expanded', 'false');
        return;
    }

    const personEntries = buildPersonIndexForSearch();
    const streets = getStreetsForSearch();

    // ── Поиск по персонам ─────────────────────────────────────
    const personHits = [];
    for (const p of personEntries) {
        const score = scoreMatch(query, p._searchNorm, p._searchTokens);
        if (score !== null) {
            personHits.push({ p, score });
        }
    }
    personHits.sort((a, b) => {
        if (a.score !== b.score) return a.score - b.score;
        // При равной релевантности – сортировка по фамилии
        return a.p._searchNorm.localeCompare(b.p._searchNorm, 'ru');
    });

    // ── Поиск по улицам ───────────────────────────────────────
    const streetHits = [];
    for (const s of streets) {
        if (!s.street) continue;
        const sn = searchNorm(s.street);
        let score = null;
        if (sn === query) score = 0;
        else if (sn.startsWith(query)) score = 1;
        else if (sn.includes(query)) score = 3;
        if (score !== null) streetHits.push({ s, score });
    }
    streetHits.sort((a, b) => {
        if (a.score !== b.score) return a.score - b.score;
        return searchNorm(a.s.street).localeCompare(searchNorm(b.s.street), 'ru');
    });

    const totalPerson = personHits.length;
    const totalStreet = streetHits.length;

    if (totalPerson === 0 && totalStreet === 0) {
        dropdown.innerHTML = `<div class="suggestion-empty">По запросу «${escapeHTML(queryRaw)}» ничего не найдено</div>`;
        dropdown.style.display = 'block';
        document.getElementById("street-search").setAttribute('aria-expanded', 'true');
        return;
    }

    dropdown.innerHTML = "";
    document.getElementById("street-search").setAttribute('aria-expanded', 'true');

    // Лимит на выдачу
    const LIMIT = 30;
    const personLimit = Math.min(totalPerson, 12);
    const streetLimit = Math.min(totalStreet, Math.max(0, LIMIT - personLimit));

    // Заголовок секции персон
    if (personLimit > 0) {
        const header = document.createElement('div');
        header.className = 'suggestion-header';
        header.textContent = `Персоны (${totalPerson})`;
        dropdown.appendChild(header);

        personHits.slice(0, personLimit).forEach(({ p }) => {
            const div = document.createElement('div');
            div.className = 'suggestion-item suggestion-item-person';
            const title = document.createElement('div');
            title.className = 'suggestion-title';
            title.innerHTML = highlightMatch(p.person, query);
            const sub = document.createElement('span');
            sub.className = 'suggestion-sub';
            const occColor = OCCUPATION_COLORS_MAP[p.occupation] || COLORS.other_occ;
            const streetList = [...new Set(p.streets.map(s => s.street))];
            const years = (p.birth_year && p.death_year) ? `${p.birth_year}–${p.death_year}`
                : (p.birth_year ? `р. ${p.birth_year}` : '');
            const streetsLabel = streetList.length === 1
                ? `ул. ${streetList[0]}`
                : `${streetList.length} улиц: ${streetList.slice(0, 2).join(', ')}${streetList.length > 2 ? '…' : ''}`;
            sub.innerHTML =
                `<span class="person-dot" style="background:${occColor}"></span>` +
                escapeHTML(p.occupation || '–') +
                (years ? ` · ${escapeHTML(years)}` : '') +
                ` · ${escapeHTML(streetsLabel)}`;
            div.appendChild(title);
            div.appendChild(sub);
            div.onclick = () => selectSearchResult(p._representative, p);
            dropdown.appendChild(div);
        });
    }

    // Заголовок секции улиц
    if (streetLimit > 0) {
        const header = document.createElement('div');
        header.className = 'suggestion-header';
        header.textContent = `Улицы (${totalStreet})`;
        dropdown.appendChild(header);

        streetHits.slice(0, streetLimit).forEach(({ s }) => {
            const div = document.createElement('div');
            div.className = 'suggestion-item';
            const title = document.createElement('div');
            title.className = 'suggestion-title';
            title.innerHTML = highlightMatch(s.street, query);
            const sub = document.createElement('span');
            sub.className = 'suggestion-sub';
            sub.textContent = s.named_after_person
                ? `в честь: ${s.person || '–'} (${s.occupation || '–'})`
                : getMemoryLabel(s);
            div.appendChild(title);
            div.appendChild(sub);
            div.onclick = () => selectSearchResult(s);
            dropdown.appendChild(div);
        });
    }

    // Если что-то не влезло в лимит
    const shown = Math.min(personLimit, totalPerson) + Math.min(streetLimit, totalStreet);
    if (totalPerson + totalStreet > shown) {
        const more = document.createElement('div');
        more.className = 'suggestion-more';
        more.textContent = `Показано ${shown} из ${totalPerson + totalStreet} совпадений – уточните запрос`;
        dropdown.appendChild(more);
    }

    dropdown.style.display = 'block';
    positionSearchDropdown();
}

function selectSearchResult(item, personEntry) {
    document.getElementById("street-search").value    = item.street;
    document.getElementById("search-suggestions").style.display = 'none';
    document.getElementById("street-search").setAttribute('aria-expanded', 'false');

    // Показываем карточку с деталями и прокручиваем к ней.
    // НЕ переключаем вкладку автоматически – пользователь сам решает,
    // хочет ли он перейти к карте.
    showDetails(item);
    scrollToDetailPanel();

    // Если у персоны несколько улиц – подсветим их на карте в фоне,
    // но не центрируем и не переключаем вкладку.
    if (personEntry && personEntry.streets && personEntry.streets.length > 1) {
        if (highlightGroup) highlightGroup.clearLayers();
        personEntry.streets.forEach(s => {
            if (hasCoordinates(s)) {
                const m = L.circleMarker([s.lat, s.lon], {
                    radius: 9,
                    fillColor: '#ffffff',
                    color: getMarkerColor(s),
                    weight: 3,
                    opacity: 1,
                    fillOpacity: 0.4,
                    interactive: false
                });
                m.addTo(highlightGroup);
            }
        });
    } else if (hasCoordinates(item)) {
        // Одиночная улица �� подсветить точку без переключения вкладки
        if (highlightGroup) highlightGroup.clearLayers();
        const m = L.circleMarker([item.lat, item.lon], {
            radius: 10,
            fillColor: getMarkerColor(item),
            color: '#ffffff',
            weight: 3,
            opacity: 1,
            fillOpacity: 0.5,
            interactive: false
        });
        m.addTo(highlightGroup);
    }
}

function scrollToDetailPanel() {
    const panel = document.getElementById('detail-panel');
    if (!panel) return;
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Явный переход к карте из карточки деталей
function focusOnMapForDetail() {
    const btn = document.getElementById('detail-show-on-map');
    const data = btn && btn._lastData;
    if (!data) return;

    if (currentTab !== 'map') switchTab('map');

    if (hasCoordinates(data)) {
        if (data.named_after_person) {
            highlightStreetGeometry(data);
        }
        map.setView([data.lat, data.lon], 15);
        setTimeout(() => {
            if (map && typeof map.invalidateSize === 'function') map.invalidateSize();
        }, 250);

        // Открыть попап точного маркера, если он есть
        markersGroup.eachLayer(layer => {
            const ll = layer.getLatLng();
            if (Math.abs(ll.lat - data.lat) < 0.0002 && Math.abs(ll.lng - data.lon) < 0.0002) {
                layer.openPopup();
            }
        });
    }
}

// Закрытие дропдауна при клике мимо
document.addEventListener("click", e => {
    if (!e.target.closest(".search-box") && !e.target.closest("#search-suggestions")) {
        const dd = document.getElementById("search-suggestions");
        if (dd) dd.style.display = 'none';
        const inp = document.getElementById("street-search");
        if (inp) inp.setAttribute('aria-expanded', 'false');
    }
});

// Переносим дропдаун с результатами в <body>: у .workspace-header есть
// backdrop-filter (blur), который делает её containing block для position:fixed
// и запирает выдачу в своём stacking context – из-за этого она уходила «на фон»
// под карту/контент. В <body> position:fixed + z-index работают глобально.
(function relocateSearchDropdown() {
    const dd = document.getElementById('search-suggestions');
    if (dd && dd.parentElement !== document.body) document.body.appendChild(dd);
})();

// Следим за ресайзом/скроллом, чтобы дропдаун следовал за полем ввода
window.addEventListener('resize', positionSearchDropdown);
window.addEventListener('scroll', positionSearchDropdown, true);

// Клавиатурная навигация по поиску
document.addEventListener("keydown", (e) => {
    const input = document.getElementById("street-search");
    if (!input) return;
    const dropdown = document.getElementById("search-suggestions");
    if (!dropdown) return;
    const isOpen = dropdown.style.display === 'block';

    // Esc – закрыть выдачу, очистить
    if (e.key === 'Escape' && document.activeElement === input) {
        if (isOpen) {
            dropdown.style.display = 'none';
            input.setAttribute('aria-expanded', 'false');
            e.preventDefault();
        } else if (input.value) {
            input.value = '';
            e.preventDefault();
        }
        return;
    }

    if (!isOpen || document.activeElement !== input) return;

    const items = [...dropdown.querySelectorAll('.suggestion-item')];
    if (items.length === 0) return;
    const activeIdx = items.findIndex(el => el.classList.contains('kbd-active'));

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = (activeIdx + 1) % items.length;
        items.forEach(el => el.classList.remove('kbd-active'));
        items[next].classList.add('kbd-active');
        items[next].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = (activeIdx - 1 + items.length) % items.length;
        items.forEach(el => el.classList.remove('kbd-active'));
        items[prev].classList.add('kbd-active');
        items[prev].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
        e.preventDefault();
        const target = activeIdx >= 0 ? items[activeIdx] : items[0];
        target.click();
    }
});

// ────────��────────────────────────────────────────────────────
// Ошибка загрузки
// ─────────────────────────────────���─────────────���─────────────
function showErrorMessage() {
    document.getElementById("detail-panel").innerHTML = `
        <div style="padding: 20px; text-align: center; color: #ff5252;">
            <i class="fa-solid fa-triangle-exclamation" style="font-size: 3rem; margin-bottom: 15px;"></i>
            <h4>Ошибка загрузки данных</h4>
            <p style="font-size: 0.85rem; margin-top: 10px; line-height: 1.5; color: var(--text-secondary);">
                Пожалуйста, откройте дашборд через локальный сервер.<br>
                Выполните в терминале:<br>
                <code style="background: rgba(255,255,255,0.1); padding: 4px 8px; border-radius: 4px; display: inline-block; margin-top: 5px;">
                    py -m http.server 8080
                </code><br>
                Команду нужно выполнить из корня проекта. Затем откройте: <a href="http://localhost:8080/dashboard/" style="color: #7e44ff;">http://localhost:8080/dashboard/</a>
            </p>
        </div>
    `;
}


// ─────────────────────────────────────────────────────────────
// Стена памяти (галерея портретов) – фото из Wikipedia / Wikidata
// Фотографии загружаются в браузере пользователя (CORS-friendly API).
// ─────────────────────────────────────────────────────────────
const portraitCache = new Map();   // ключ персоны -> {thumb, full, source} | null
let galleryObserver = null;
let _lightboxPerson = null;

// ── Офлайн-хранилище фотографий (IndexedDB) ──────────────
// Фото один раз скачивается и сохраняется в браузере: дальше грузится
// мгновенно и работает офлайн. Сюда же кладутся фото, загруженные вручную.
const PORTRAIT_DB = 'cityMemoryPortraits';
const PORTRAIT_STORE = 'photos';
let _portraitDbPromise = null;
function portraitDb() {
    if (_portraitDbPromise) return _portraitDbPromise;
    _portraitDbPromise = new Promise((resolve, reject) => {
        try {
            const req = indexedDB.open(PORTRAIT_DB, 1);
            req.onupgradeneeded = () => req.result.createObjectStore(PORTRAIT_STORE);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        } catch (e) { reject(e); }
    });
    return _portraitDbPromise;
}
async function idbGetPhoto(key) {
    try {
        const db = await portraitDb();
        return await new Promise((res, rej) => {
            const r = db.transaction(PORTRAIT_STORE, 'readonly').objectStore(PORTRAIT_STORE).get(key);
            r.onsuccess = () => res(r.result || null);
            r.onerror = () => rej(r.error);
        });
    } catch (e) { return null; }
}
async function idbPutPhoto(key, value) {
    try {
        const db = await portraitDb();
        return await new Promise((res, rej) => {
            const r = db.transaction(PORTRAIT_STORE, 'readwrite').objectStore(PORTRAIT_STORE).put(value, key);
            r.onsuccess = () => res(true);
            r.onerror = () => rej(r.error);
        });
    } catch (e) { return false; }
}
async function idbDeletePhoto(key) {
    try {
        const db = await portraitDb();
        db.transaction(PORTRAIT_STORE, 'readwrite').objectStore(PORTRAIT_STORE).delete(key);
    } catch (e) { /* ignore */ }
}

// Скачивает изображение и кладёт в IndexedDB (для офлайна). Best-effort.
async function persistPortraitBlob(key, imageUrl, source) {
    try {
        const existing = await idbGetPhoto(key);
        if (existing && existing.blob) return;
        const resp = await fetch(imageUrl, { mode: 'cors' });
        if (!resp.ok) return;
        const blob = await resp.blob();
        if (blob && blob.size > 0) await idbPutPhoto(key, { blob, source: source || null, uploaded: false });
    } catch (e) { /* CORS/сеть – фото останется онлайновым */ }
}
function personKey(d) {
    return d.person_canonical || d.person || d.street;
}

function uniquePersonsForGallery() {
    const seen = new Map();
    filteredPersonData.forEach(d => {
        if (!d.person) return;
        const key = personKey(d);
        if (!seen.has(key)) {
            seen.set(key, Object.assign({}, d, { _streets: [d.street] }));
        } else {
            seen.get(key)._streets.push(d.street);
        }
    });
    return [...seen.values()].sort((a, b) => {
        const la = (a.person || '').replace(',', '').split(' ').slice(-1)[0] || '';
        const lb = (b.person || '').replace(',', '').split(' ').slice(-1)[0] || '';
        return la.localeCompare(lb, 'ru');
    });
}

function qidFromWikidataUrl(url) {
    const m = /\/(Q\d+)/.exec(url || '');
    return m ? m[1] : null;
}

function titleFromWikipediaUrl(url) {
    if (!url) return null;
    try {
        const seg = url.split('/wiki/')[1];
        return seg ? decodeURIComponent(seg) : null;
    } catch (e) { return null; }
}

// Возвращает {thumb, full, source} или null. Кеширует результат.
// Локальный архив фото: photos/manifest.json (ключ персоны -> имя файла)
let __localPortraitsPromise = null;
function loadLocalPortraits() {
    if (__localPortraitsPromise) return __localPortraitsPromise;
    __localPortraitsPromise = fetch('photos/manifest.json')
        .then(r => r.ok ? r.json() : {})
        .catch(() => ({}));
    return __localPortraitsPromise;
}

async function fetchPortrait(d) {
    const key = personKey(d);
    if (portraitCache.has(key)) return portraitCache.get(key);

    // 0) Офлайн-хранилище: загруженные вручную или ранее скачанные фото
    const stored = await idbGetPhoto(key);
    if (stored && stored.blob) {
        const url = URL.createObjectURL(stored.blob);
        const offlineResult = {
            thumb: url, full: url,
            source: stored.source || d.wikipedia_url || d.wikidata_url || null,
            offline: true, uploaded: !!stored.uploaded
        };
        portraitCache.set(key, offlineResult);
        return offlineResult;
    }

    // 0.5) Локальный архив фото (addphotos -> photos/manifest.json): заполняет пустые плейсхолдеры
    const localMap = await loadLocalPortraits();
    const localFile = localMap && localMap[key];
    if (localFile) {
        const localUrl = 'photos/' + encodeURIComponent(localFile);
        const localResult = { thumb: localUrl, full: localUrl, source: 'Локальный архив фото', local: true };
        portraitCache.set(key, localResult);
        return localResult;
    }

    let result = null;

    // 1) Wikipedia REST summary: есть thumbnail (для сетки) и originalimage (полный размер)
    const title = titleFromWikipediaUrl(d.wikipedia_url);
    const lang = (d.wikipedia_url && d.wikipedia_url.includes('en.wikipedia')) ? 'en' : 'ru';
    if (title) {
        try {
            const r = await fetch('https://' + lang + '.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title));
            if (r.ok) {
                const j = await r.json();
                if (j.thumbnail && j.thumbnail.source) {
                    result = {
                        thumb: j.thumbnail.source,
                        full: (j.originalimage && j.originalimage.source) || j.thumbnail.source,
                        source: (j.content_urls && j.content_urls.desktop && j.content_urls.desktop.page) || d.wikipedia_url
                    };
                }
            }
        } catch (e) { /* сеть/CORS – пробуем Wikidata */ }
    }

    // 2) Wikidata P18 → Викисклад Special:FilePath
    if (!result) {
        const qid = qidFromWikidataUrl(d.wikidata_url);
        if (qid) {
            try {
                const r = await fetch('https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=' + qid + '&property=P18&format=json&origin=*');
                if (r.ok) {
                    const j = await r.json();
                    const claim = j.claims && j.claims.P18 && j.claims.P18[0];
                    const file = claim && claim.mainsnak && claim.mainsnak.datavalue && claim.mainsnak.datavalue.value;
                    if (file) {
                        const enc = encodeURIComponent(String(file).replace(/ /g, '_'));
                        result = {
                            thumb: 'https://commons.wikimedia.org/wiki/Special:FilePath/' + enc + '?width=400',
                            full:  'https://commons.wikimedia.org/wiki/Special:FilePath/' + enc + '?width=1000',
                            source: d.wikidata_url
                        };
                    }
                }
            } catch (e) { /* нет фото */ }
        }
    }

    // 3) Best-effort: скачиваем картинку и сохраняем в офлайн-хранилище
    if (result && result.full) {
        persistPortraitBlob(key, result.full, result.source).catch(() => {});
    }

    portraitCache.set(key, result);
    return result;
}

function personInitials(name) {
    if (!name) return '?';
    const parts = String(name).replace(',', '').split(' ').filter(Boolean);
    const last = parts.slice(-1)[0] || '';
    const first = parts[0] || '';
    return ((last[0] || '') + (first[0] || '')).toUpperCase();
}

// Поиск персоналий внутри «Стены памяти»
let galleryQuery = '';

function handleGallerySearch() {
    const input = document.getElementById('gallery-search-input');
    galleryQuery = input ? input.value : '';
    const clearBtn = document.getElementById('gallery-search-clear');
    if (clearBtn) clearBtn.classList.toggle('hidden', !galleryQuery.trim());
    buildGallery();
}

function clearGallerySearch() {
    const input = document.getElementById('gallery-search-input');
    if (input) input.value = '';
    galleryQuery = '';
    const clearBtn = document.getElementById('gallery-search-clear');
    if (clearBtn) clearBtn.classList.add('hidden');
    buildGallery();
}

function filterGalleryPersons(persons, query) {
    const q = searchNorm(query);
    if (q.length < 1) return persons;
    return persons.filter(d => {
        const idx = buildPersonIndex(d.person);
        if (scoreMatch(q, idx.norm, idx.tokens) !== null) return true;
        if (searchNorm(d.occupation || '').includes(q)) return true;
        if (searchNorm(d.original_occupations || '').includes(q)) return true;
        return false;
    });
}

function buildGallery() {
    const grid = document.getElementById('gallery-grid');
    const countEl = document.getElementById('gallery-count');
    if (!grid) return;

    const allPersons = uniquePersonsForGallery();
    const persons = filterGalleryPersons(allPersons, galleryQuery);
    grid.innerHTML = '';
    const hasQuery = searchNorm(galleryQuery).length >= 1;
    if (countEl) countEl.textContent = hasQuery
        ? '· ' + persons.length + ' из ' + allPersons.length
        : '· ' + allPersons.length + ' персон';

    if (persons.length === 0) {
        grid.innerHTML = '<div class="gallery-empty">По запросу «' + escapeHTML(galleryQuery.trim()) + '» никого не найдено</div>';
        return;
    }

    if (galleryObserver) galleryObserver.disconnect();
    galleryObserver = new IntersectionObserver((entries, obs) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                loadPortraitIntoCard(entry.target);
                obs.unobserve(entry.target);
            }
        });
    }, { rootMargin: '300px' });

    persons.forEach(d => {
        const occColor = OCCUPATION_COLORS_MAP[d.occupation] || COLORS.other_occ;
        const card = document.createElement('button');
        card.className = 'portrait-card';
        card.type = 'button';
        card.style.setProperty('--occ-color', occColor);

        const years = (d.birth_year && d.death_year) ? (d.birth_year + '–' + d.death_year)
            : (d.birth_year ? ('р. ' + d.birth_year) : '');

        card.innerHTML =
            '<div class="portrait-photo">' +
                '<div class="portrait-initials">' + escapeHTML(personInitials(d.person)) + '</div>' +
            '</div>' +
            '<div class="portrait-meta">' +
                '<strong>' + escapeHTML(d.person || '–') + '</strong>' +
                '<span class="portrait-years">' + escapeHTML(years) + '</span>' +
                '<span class="portrait-occ">' + escapeHTML(d.occupation || '') + '</span>' +
            '</div>';
        card._person = d;
        card.addEventListener('click', () => openPortraitLightbox(d));
        grid.appendChild(card);
        galleryObserver.observe(card);
    });
}

async function loadPortraitIntoCard(card) {
    const d = card._person;
    const photoBox = card.querySelector('.portrait-photo');
    if (!d || !photoBox) return;
    const portrait = await fetchPortrait(d);
    if (portrait && portrait.thumb) {
        const img = new Image();
        img.onload = () => {
            photoBox.classList.add('has-photo');
            photoBox.style.backgroundImage = 'url("' + portrait.thumb + '")';
        };
        img.onerror = () => card.classList.add('no-photo');
        img.src = portrait.thumb;
    } else {
        card.classList.add('no-photo');
    }
}

// Фото личности в правой панели деталей (в самом начале карточки)
let _detailPortraitToken = 0;
async function updateDetailPortrait(data) {
    const wrap = document.getElementById('detail-portrait');
    const imgBox = document.getElementById('detail-portrait-img');
    const initialsEl = document.getElementById('detail-portrait-initials');
    if (!wrap || !imgBox) return;

    const token = ++_detailPortraitToken;
    imgBox.style.backgroundImage = '';
    imgBox.classList.remove('has-photo', 'is-loading', 'no-photo');

    if (!data || !data.named_after_person || !data.person) {
        wrap.classList.add('hidden');
        return;
    }

    wrap.classList.remove('hidden');
    if (initialsEl) initialsEl.textContent = personInitials(data.person);
    imgBox.classList.add('is-loading');

    try {
        const portrait = await fetchPortrait(data);
        if (token !== _detailPortraitToken) return;
        const src = portrait && (portrait.full || portrait.thumb);
        if (src) {
            const img = new Image();
            img.onload = () => {
                if (token !== _detailPortraitToken) return;
                imgBox.style.backgroundImage = 'url("' + src + '")';
                imgBox.classList.add('has-photo');
                imgBox.classList.remove('is-loading');
            };
            img.onerror = () => {
                if (token !== _detailPortraitToken) return;
                imgBox.classList.remove('is-loading');
                imgBox.classList.add('no-photo');
            };
            img.src = src;
        } else {
            imgBox.classList.remove('is-loading');
            imgBox.classList.add('no-photo');
        }
    } catch (e) {
        if (token !== _detailPortraitToken) return;
        imgBox.classList.remove('is-loading');
        imgBox.classList.add('no-photo');
    }
}

async function openPortraitLightbox(d) {
    const lb = document.getElementById('portrait-lightbox');
    if (!lb) return;
    _lightboxPerson = d;
    const imgWrap = document.getElementById('lightbox-image');
    const nameEl = document.getElementById('lightbox-name');
    const subEl = document.getElementById('lightbox-sub');
    const bioEl = document.getElementById('lightbox-bio');
    const srcEl = document.getElementById('lightbox-source');
    const noteEl = document.getElementById('lightbox-photo-note');

    nameEl.textContent = d.person || '–';
    const years = (d.birth_year && d.death_year) ? (d.birth_year + ' – ' + d.death_year + ' гг.')
        : (d.birth_year ? ('р. ' + d.birth_year + ' г.') : 'Годы жизни неизвестны');
    subEl.textContent = (d.occupation || '') + (d.occupation ? ' · ' : '') + years;
    const streets = (d._streets && d._streets.length) ? [...new Set(d._streets)] : [d.street];
    bioEl.innerHTML =
        '<span class="lb-label">Улицы:</span> ' + escapeHTML(streets.join(', ')) + '<br>' +
        '<span class="lb-label">Эпоха:</span> ' + escapeHTML(d.epoch || '–') + '<br>' +
        '<span class="lb-label">Сфера:</span> ' + escapeHTML(d.original_occupations || d.occupation || '–');

    imgWrap.style.backgroundImage = '';
    imgWrap.classList.remove('has-photo');
    imgWrap.innerHTML = '<div class="lightbox-initials">' + escapeHTML(personInitials(d.person)) + '</div><div class="lightbox-loading">Загружаем фото…</div>';
    if (noteEl) noteEl.textContent = '';
    lb.classList.add('open');
    document.body.style.overflow = 'hidden';

    const portrait = await fetchPortrait(d);
    if (portrait && portrait.full) {
        const img = new Image();
        img.onload = () => {
            imgWrap.innerHTML = '';
            imgWrap.style.backgroundImage = 'url("' + portrait.full + '")';
            imgWrap.classList.add('has-photo');
        };
        img.onerror = () => {
            const l = imgWrap.querySelector('.lightbox-loading');
            if (l) l.textContent = 'Фото недоступно';
        };
        img.src = portrait.full;
        if (srcEl) {
            if (portrait.uploaded) {
                srcEl.classList.add('hidden');
            } else {
                srcEl.href = portrait.source || d.wikipedia_url || d.wikidata_url || '#';
                srcEl.classList.remove('hidden');
            }
        }
        if (noteEl) noteEl.textContent = portrait.uploaded
            ? 'Фото загружено вручную · хранится офлайн'
            : (portrait.offline ? 'Сохранено офлайн (доступно без интернета)'
                                : 'Источник: Викисклад / Википедия · сохраняется офлайн');
    } else {
        const l = imgWrap.querySelector('.lightbox-loading');
        if (l) l.textContent = 'Фотография не найдена';
        if (srcEl) {
            const link = d.wikipedia_url || d.wikidata_url;
            if (link) { srcEl.href = link; srcEl.classList.remove('hidden'); }
            else srcEl.classList.add('hidden');
        }
    }
}

function closePortraitLightbox() {
    const lb = document.getElementById('portrait-lightbox');
    if (!lb) return;
    lb.classList.remove('open');
    document.body.style.overflow = '';
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePortraitLightbox();
});
