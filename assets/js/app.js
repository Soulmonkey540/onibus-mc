/**
 * Ônibus Montes Claros — Frontend Minimalista
 */
(function () {
    'use strict';

    const CONFIG = window.ONIBUS_MC_CONFIG || { baseUrl: '/', initialLines: [] };
    const API_BASE = CONFIG.baseUrl.replace(/\/?$/, '/');

    const state = {
        lines: CONFIG.initialLines || [],
        favorites: JSON.parse(localStorage.getItem('onibus_mc_favs') || '["5801", "5801-IBITURUNA", "1501", "2601"]'),
        googleApiKey: localStorage.getItem('onibus_mc_gkey') || '',
        darkMode: localStorage.getItem('onibus_mc_dark') === '1',
        onlyFavs: false,
        searchQuery: '',
        activeCode: '5801',
        activeDir: 'ida',
        lineCache: {},
        activeVehicles: [],
        selectedStop: null,
        alerts: JSON.parse(localStorage.getItem('onibus_mc_alerts') || '[]'),
        autoAlight: JSON.parse(localStorage.getItem('onibus_mc_auto_alight') || 'null'),
        walkingGuide: null,
        nearbyStopsCache: [],
        firedAlertKeys: {},
        scheduleDay: 'weekdays',
        timeContext: null,
        planner: {
            origin: null,
            dest: null,
            mapPickMode: null,
            timeMode: 'now',
            customDate: '',
            customTime: ''
        },
        userLocation: null,
        gpsWatchId: null,
        pollTimer: null
    };

    let map = null;
    let baseTileLayer = null;
    let layerPolyIda = null;
    let layerPolyVolta = null;
    let layerStops = null;
    let layerBuses = null;
    let layerPlanner = null;
    let layerWalkingGuide = null;
    let userMarker = null;
    let alightTargetMarker = null;
    let busMarkersMap = {};

    const TILE_STYLES = {
        gmaps: {
            url: 'https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}&hl=pt-BR',
            attr: 'Mapas &copy; Google'
        },
        gsat: {
            url: 'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}&hl=pt-BR',
            attr: 'Imagens &copy; Google'
        }
    };

    document.addEventListener('DOMContentLoaded', () => {
        initDarkMode();
        initMap();
        initTabs();
        initMontesClarosClock();
        initCatalogEvents();
        initPlannerEvents();
        initNearbyEvents();
        initAlertEvents();
        initScheduleEvents();
        initApiKeyModal();
        initServiceWorkerAndPwa();

        renderLinesList();
        renderAlertsList();
        updateAutoAlightUI();
        selectLine(state.activeCode, 'ida', true);

        if (state.autoAlight && state.autoAlight.active) {
            ensureGpsWatch();
        }

        state.pollTimer = setInterval(() => {
            if (!document.hidden) {
                fetchVehiclesForActiveLine();
            }
        }, 10000);
    });

    /* =========================================================================
       0. MODO ESCURO E RELÓGIO OFICIAL DE MONTES CLAROS
       ========================================================================= */
    function initDarkMode() {
        const btn = document.getElementById('btnToggleDarkMode');
        const applyDark = (isDark) => {
            document.body.classList.toggle('dark-mode', isDark);
            if (btn) {
                btn.textContent = isDark ? 'Modo claro' : 'Modo escuro';
            }
        };
        applyDark(state.darkMode);
        if (btn) {
            btn.addEventListener('click', () => {
                state.darkMode = !state.darkMode;
                localStorage.setItem('onibus_mc_dark', state.darkMode ? '1' : '0');
                applyDark(state.darkMode);
            });
        }
    }

    function getLineDisplayCode(code) {
        if (!code) return '';
        const cached = state.lineCache[code]?.line?.display_code;
        if (cached) return cached;
        const found = state.lines.find((l) => String(l.code) === String(code));
        return found?.display_code || String(code);
    }
    async function initMontesClarosClock() {
        await syncOfficialTimeContext();
        setInterval(() => {
            if (state.planner.timeMode === 'now') {
                updateLocalMontesClarosClockTick();
            }
        }, 15000);
    }

    async function syncOfficialTimeContext(customDate = '', customTime = '') {
        try {
            const params = new URLSearchParams();
            if (customDate) params.set('date', customDate);
            if (customTime) params.set('time', customTime);
            const qs = params.toString() ? `?${params.toString()}` : '';
            const res = await fetch(`${API_BASE}api/time-context${qs}`);
            const json = await res.json();
            if (json && json.ok && json.time_context) {
                const ctx = json.time_context;
                if (!customDate && !customTime) {
                    state.timeContext = ctx;
                    // Ajusta automaticamente a aba de Horários para o dia operacional atual de Montes Claros
                    state.scheduleDay = ctx.day_type || 'weekdays';
                    document.querySelectorAll('#subtab-times .day-pill').forEach((b) => {
                        b.classList.toggle('active', b.dataset.day === state.scheduleDay);
                    });
                    renderLinesList();
                    renderScheduleTab();
                }
                updateTimeContextUI(ctx);
                return ctx;
            }
        } catch (e) {}
        return null;
    }

    function updateLocalMontesClarosClockTick() {
        try {
            const now = new Date();
            const hhmm = new Intl.DateTimeFormat('pt-BR', {
                timeZone: 'America/Sao_Paulo',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            }).format(now);
            if (state.timeContext) {
                state.timeContext.time = hhmm;
                const [hh, mm] = hhmm.split(':').map(Number);
                state.timeContext.minutes_of_day = hh * 60 + mm;
                updateTimeContextUI(state.timeContext);
            }
        } catch (e) {}
    }

    function updateTimeContextUI(ctx) {
        if (!ctx) return;
        const clockPill = document.getElementById('mcClockPill');
        if (clockPill && !ctx.is_custom) {
            clockPill.textContent = `${ctx.time} · ${ctx.day_type_short}`;
        }

        const nowText = document.getElementById('plannerTimeNowText');
        const calInfo = document.getElementById('plannerCalendarInfo');
        if (nowText && !ctx.is_custom) {
            nowText.textContent = `Montes Claros: ${ctx.time} · ${ctx.day_label}`;
        }
        if (calInfo) {
            calInfo.textContent = ctx.is_custom
                ? `Consulta para ${ctx.date_br} às ${ctx.time} — ${ctx.day_label}`
                : `Calendário ativo: ${ctx.date_br} · ${ctx.day_label}`;
        }
    }

    /* =========================================================================
       1. MAPA E CAMADAS (GOOGLE MAPS STREETS / SATÉLITE / LIMPO)
       ========================================================================= */
    function initMap() {
        map = L.map('map', {
            preferCanvas: true,
            zoomControl: true
        }).setView([-16.7245, -43.8645], 13);

        setMapTileStyle('gmaps');

        layerStops = L.layerGroup().addTo(map);
        layerBuses = L.layerGroup().addTo(map);
        layerPlanner = L.layerGroup().addTo(map);
        layerWalkingGuide = L.layerGroup().addTo(map);

        document.querySelectorAll('.style-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.style-btn').forEach((b) => b.classList.remove('active'));
                btn.classList.add('active');
                setMapTileStyle(btn.dataset.style);
            });
        });

        map.on('click', (e) => {
            if (!state.planner.mapPickMode) return;
            const lat = Number(e.latlng.lat.toFixed(6));
            const lng = Number(e.latlng.lng.toFixed(6));
            const mode = state.planner.mapPickMode;
            setMapPickMode(null);

            const label = `Ponto selecionado (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
            setPlannerPoint(mode, { label, lat, lng });
            showToast(`Local de ${mode === 'origin' ? 'partida' : 'destino'} definido no mapa.`);
        });

        document.getElementById('btnMyLocation').addEventListener('click', () => {
            locateUserOnMap(true);
            ensureGpsWatch();
        });
    }

    function setMapTileStyle(styleKey) {
        const cfg = TILE_STYLES[styleKey] || TILE_STYLES.gmaps;
        if (baseTileLayer) {
            map.removeLayer(baseTileLayer);
        }
        baseTileLayer = L.tileLayer(cfg.url, {
            attribution: cfg.attr,
            maxZoom: 20
        }).addTo(map);
    }

    function updateUserLocationMarker(lat, lng, centerMap = false) {
        state.userLocation = { lat, lng };
        if (!userMarker) {
            const icon = L.divIcon({
                className: '',
                html: `<div style="width:14px;height:14px;background:#2563eb;border:2.5px solid #fff;border-radius:50%;box-shadow:0 0 0 5px rgba(37,99,235,0.22);"></div>`,
                iconSize: [14, 14],
                iconAnchor: [7, 7]
            });
            userMarker = L.marker([lat, lng], { icon }).addTo(map).bindPopup('<b>Sua localização atual (GPS)</b>');
        } else {
            userMarker.setLatLng([lat, lng]);
        }

        if (centerMap) {
            map.setView([lat, lng], 15);
            userMarker.openPopup();
        }

        updateWalkingGuideProgress();
        evaluateAutoAlightingAlert();
    }

    function ensureGpsWatch() {
        if (!navigator.geolocation || state.gpsWatchId !== null) return;
        try {
            state.gpsWatchId = navigator.geolocation.watchPosition(
                (pos) => {
                    const lat = Number(pos.coords.latitude.toFixed(6));
                    const lng = Number(pos.coords.longitude.toFixed(6));
                    updateUserLocationMarker(lat, lng, false);
                },
                () => {},
                { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
            );
        } catch (e) {}
    }

    function locateUserOnMap(centerMap = true, callback = null, fallbackToCenter = false) {
        if (!navigator.geolocation) {
            if (fallbackToCenter) {
                const c = map.getCenter();
                const lat = Number(c.lat.toFixed(6));
                const lng = Number(c.lng.toFixed(6));
                updateUserLocationMarker(lat, lng, centerMap);
                if (typeof callback === 'function') callback({ lat, lng, fallback: true });
                return;
            }
            showToast('Geolocalização não suportada pelo navegador.');
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const lat = Number(pos.coords.latitude.toFixed(6));
                const lng = Number(pos.coords.longitude.toFixed(6));
                updateUserLocationMarker(lat, lng, centerMap);
                ensureGpsWatch();
                if (typeof callback === 'function') {
                    callback({ lat, lng, fallback: false });
                }
            },
            () => {
                if (fallbackToCenter) {
                    const c = map.getCenter();
                    const lat = Number(c.lat.toFixed(6));
                    const lng = Number(c.lng.toFixed(6));
                    updateUserLocationMarker(lat, lng, false);
                    showToast('Permissão de GPS indisponível; usando posição central do mapa.');
                    if (typeof callback === 'function') callback({ lat, lng, fallback: true });
                    return;
                }
                showToast('Não foi possível acessar o GPS. Verifique as permissões do navegador.');
            },
            { enableHighAccuracy: true, timeout: 8000 }
        );
    }

    /* =========================================================================
       2. ABAS E CATÁLOGO DE LINHAS
       ========================================================================= */
    function initTabs() {
        document.querySelectorAll('.tab-link').forEach((btn) => {
            btn.addEventListener('click', () => {
                switchTab(btn.dataset.tab);
            });
        });
    }

    function switchTab(tabName) {
        document.querySelectorAll('.tab-link').forEach((b) => {
            const active = b.dataset.tab === tabName;
            b.classList.toggle('active', active);
            b.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        document.querySelectorAll('.tab-panel').forEach((pane) => {
            pane.classList.toggle('active', pane.id === `tab-${tabName}`);
        });
    }

    function initCatalogEvents() {
        document.getElementById('lineSearchInput').addEventListener('input', (e) => {
            state.searchQuery = e.target.value.trim().toLowerCase();
            renderLinesList();
        });

        const btnFilterFavs = document.getElementById('btnFilterFavs');
        btnFilterFavs.addEventListener('click', () => {
            state.onlyFavs = !state.onlyFavs;
            btnFilterFavs.classList.toggle('active', state.onlyFavs);
            renderLinesList();
        });

        document.getElementById('btnToggleFavCurrent').addEventListener('click', () => {
            toggleFavorite(state.activeCode);
        });

        ['btnDirIda', 'btnDirVolta', 'btnDirAmbos'].forEach((id) => {
            document.getElementById(id).addEventListener('click', (e) => {
                setDirection(e.currentTarget.dataset.dir);
            });
        });

        const toggleRouteBoth = document.getElementById('toggleRouteBoth');
        if (toggleRouteBoth) {
            toggleRouteBoth.addEventListener('change', (e) => {
                const newDir = e.target.checked ? 'ambos' : 'ida';
                setDirection(newDir);
                showToast(
                    e.target.checked
                        ? 'Visualizando rota completa (Ida e Volta) no mapa.'
                        : 'Visualizando apenas o sentido de Ida.'
                );
            });
        }

        document.getElementById('btnQuickCreateAlert').addEventListener('click', () => {
            switchTab('alerts');
            if (state.selectedStop) {
                const sel = document.getElementById('alertSelectStop');
                if (sel) sel.value = state.selectedStop.stop_id;
            }
        });

        document.getElementById('btnClearStop').addEventListener('click', () => {
            state.selectedStop = null;
            document.getElementById('selectedStopBanner').style.display = 'none';
            renderStopsOnMap();
        });
    }

    function toggleFavorite(code) {
        const idx = state.favorites.indexOf(code);
        if (idx >= 0) {
            state.favorites.splice(idx, 1);
        } else {
            state.favorites.push(code);
        }
        localStorage.setItem('onibus_mc_favs', JSON.stringify(state.favorites));
        updateFavButton();
        renderLinesList();
    }

    function updateFavButton() {
        const isFav = state.favorites.includes(state.activeCode);
        const btn = document.getElementById('btnToggleFavCurrent');
        btn.textContent = isFav ? 'Salva' : 'Favoritar';
        btn.classList.toggle('saved', isFav);
    }

    function renderLinesList() {
        const container = document.getElementById('linesListContainer');
        const q = state.searchQuery;

        const filtered = state.lines.filter((item) => {
            if (state.onlyFavs && !state.favorites.includes(item.code)) {
                return false;
            }
            if (!q) return true;
            const hay = `${item.code} ${item.display_code || ''} ${item.name} ${(item.neighborhoods || []).join(' ')}`.toLowerCase();
            return hay.includes(q);
        });

        document.getElementById('linesCountLabel').textContent = filtered.length;

        if (filtered.length === 0) {
            container.innerHTML = `<div style="padding:16px;text-align:center;color:#6b7280;font-size:12.5px;">Nenhuma linha encontrada.</div>`;
            return;
        }

        const dayType = state.timeContext?.day_type || 'weekdays';
        container.innerHTML = filtered
            .map((item) => {
                const isFav = state.favorites.includes(item.code);
                const isActive = item.code === state.activeCode;
                const displayCode = item.display_code || item.code;
                const bairrosPreview = (item.neighborhoods || []).slice(0, 4).join(', ');
                const operatesToday = item.operates_days ? item.operates_days[dayType] !== false : true;
                return `
                <div class="line-row ${isActive ? 'active' : ''}" data-code="${escapeHtml(item.code)}">
                    <div class="line-row__left">
                        <span class="line-row__code">${escapeHtml(displayCode)}</span>
                        <div style="min-width:0;">
                            <div class="line-row__name">${escapeHtml(formatTitleCase(item.name))}</div>
                            <div class="line-row__sub">
                                ${!operatesToday ? '<span style="color:#b91c1c;font-weight:500;">Não opera hoje</span> · ' : ''}
                                ${bairrosPreview ? escapeHtml(bairrosPreview) : 'Ida e volta'}
                            </div>
                        </div>
                    </div>
                    ${isFav ? `<span class="fav-indicator">Salva</span>` : ''}
                </div>`;
            })
            .join('');

        container.querySelectorAll('.line-row').forEach((row) => {
            row.addEventListener('click', () => {
                selectLine(row.dataset.code, state.activeDir === 'volta' ? 'volta' : (state.activeDir === 'ambos' ? 'ambos' : 'ida'), true);
            });
        });
    }

    /* =========================================================================
       3. LINHA ATIVA, TRAÇADOS E PARADAS
       ========================================================================= */
    async function selectLine(code, dir = 'ida', fitBounds = true) {
        state.activeCode = String(code);
        state.activeDir = dir;

        document.getElementById('activeLineCode').textContent = getLineDisplayCode(state.activeCode);
        const schedSelect = document.getElementById('schedLineSelect');
        if (schedSelect) {
            schedSelect.value = state.activeCode;
        }
        updateFavButton();
        renderLinesList();
        updateDirectionButtonsUI();

        try {
            let bundle = state.lineCache[state.activeCode];
            if (!bundle) {
                const res = await fetch(`${API_BASE}api/line/${encodeURIComponent(state.activeCode)}`);
                const json = await res.json();
                if (!json.ok) throw new Error(json.error || 'Erro ao carregar linha');
                bundle = { line: json.line, shapes: json.shapes };
                state.lineCache[state.activeCode] = bundle;
            }

            const line = bundle.line;
            document.getElementById('activeLineCode').textContent = line.display_code || getLineDisplayCode(state.activeCode);
            const cleanName = formatTitleCase(line.name);
            document.getElementById('activeLineName').textContent = cleanName;
            const idaShort = (line.ida_label || 'Ida').replace(/^Sentido\s+/i, '');
            const voltaShort = (line.volta_label || 'Volta').replace(/^Sentido\s+/i, '');
            document.getElementById('labelDirIda').textContent = idaShort;
            document.getElementById('labelDirVolta').textContent = voltaShort;

            const btnStopsIda = document.getElementById('schedBtnStopsIda');
            const btnStopsVolta = document.getElementById('schedBtnStopsVolta');
            if (btnStopsIda) btnStopsIda.textContent = `Ida (${idaShort})`;
            if (btnStopsVolta) btnStopsVolta.textContent = `Volta (${voltaShort})`;

            renderRouteShapesOnMap(fitBounds);
            renderStopsOnMap();
            populateAlertStopsSelect();
            renderScheduleTab();

            if (state.userLocation) {
                fetchAndRenderNearbyStops(state.userLocation.lat, state.userLocation.lng, false);
            }

            await fetchVehiclesForActiveLine();
        } catch (err) {
            showToast('Não foi possível carregar os dados da linha ' + getLineDisplayCode(state.activeCode));
        }
    }

    function setDirection(dir) {
        state.activeDir = dir;
        updateDirectionButtonsUI();
        renderRouteShapesOnMap(false);
        renderStopsOnMap();
        populateAlertStopsSelect();
        renderScheduleTab();
        if (state.userLocation) {
            fetchAndRenderNearbyStops(state.userLocation.lat, state.userLocation.lng, false);
        }
        fetchVehiclesForActiveLine();
    }

    function updateDirectionButtonsUI() {
        document.querySelectorAll('#activeLineCard .seg-btn').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.dir === state.activeDir);
        });
        const stopDir = state.activeDir === 'volta' ? 'volta' : 'ida';
        document.querySelectorAll('.sched-dir-pill').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.dir === stopDir);
        });
        const toggleRouteBoth = document.getElementById('toggleRouteBoth');
        if (toggleRouteBoth) {
            toggleRouteBoth.checked = state.activeDir === 'ambos';
        }
    }

    function renderRouteShapesOnMap(fitBounds = true) {
        if (layerPolyIda) { map.removeLayer(layerPolyIda); layerPolyIda = null; }
        if (layerPolyVolta) { map.removeLayer(layerPolyVolta); layerPolyVolta = null; }

        const bundle = state.lineCache[state.activeCode];
        if (!bundle) return;

        const coordsIda = bundle.shapes?.ida?.coordinates || [];
        const coordsVolta = bundle.shapes?.volta?.coordinates || [];
        let totalDistM = 0;

        if ((state.activeDir === 'ida' || state.activeDir === 'ambos') && coordsIda.length > 1) {
            layerPolyIda = L.polyline(coordsIda, {
                color: '#2563eb',
                weight: 4.5,
                opacity: 0.85
            }).addTo(map);
            totalDistM += Number(bundle.shapes.ida.total_distance_m || 0);
        }

        if ((state.activeDir === 'volta' || state.activeDir === 'ambos') && coordsVolta.length > 1) {
            layerPolyVolta = L.polyline(coordsVolta, {
                color: '#d97706',
                weight: 4.5,
                opacity: 0.85,
                dashArray: state.activeDir === 'ambos' ? '7, 5' : null
            }).addTo(map);
            totalDistM += Number(bundle.shapes.volta.total_distance_m || 0);
        }

        document.getElementById('telRouteDist').textContent =
            totalDistM > 0 ? `${(totalDistM / 1000).toFixed(1)} km` : '-- km';

        if (fitBounds) {
            const targetLayer = layerPolyIda || layerPolyVolta;
            if (targetLayer) {
                map.fitBounds(targetLayer.getBounds(), { padding: [24, 24] });
            }
        }
    }

    function renderStopsOnMap() {
        layerStops.clearLayers();
        const bundle = state.lineCache[state.activeCode];
        if (!bundle) return;

        const dirKey = state.activeDir === 'volta' ? 'volta' : 'ida';
        const stops = bundle.line?.stops?.[dirKey] || [];
        const color = dirKey === 'volta' ? '#d97706' : '#2563eb';

        stops.forEach((st) => {
            const isSelected = state.selectedStop && state.selectedStop.stop_id === st.stop_id;
            const isAlight = state.autoAlight && state.autoAlight.active && String(state.autoAlight.stop_id) === String(st.stop_id);
            const marker = L.circleMarker([st.lat, st.lng], {
                radius: isSelected || isAlight ? 8 : 5,
                color: isAlight ? '#b91c1c' : (isSelected ? '#15803d' : color),
                weight: isSelected || isAlight ? 2.5 : 2,
                fillColor: isAlight ? '#dc2626' : (isSelected ? '#16a34a' : '#ffffff'),
                fillOpacity: 1
            }).addTo(layerStops);

            const otherLines = (st.lines || []).join(', ');
            const popupHtml = `
                <div style="font-family:Inter,sans-serif;min-width:210px;line-height:1.4;">
                    <div style="font-size:11px;font-weight:600;color:#6b7280;">
                        Parada ${st.seq} · ${dirKey === 'volta' ? 'Volta' : 'Ida'}
                    </div>
                    <div style="font-size:13px;font-weight:600;margin:3px 0;color:#1f2937;">
                        ${escapeHtml(st.address)}
                    </div>
                    <div style="font-size:11.5px;color:#4b5563;margin-bottom:8px;">
                        Bairro: ${escapeHtml(st.neighborhood)}<br>
                        Linhas: ${escapeHtml(otherLines)}
                    </div>
                    <div style="display:flex;flex-direction:column;gap:5px;">
                        <button type="button" onclick="window.__selectBoardingStop('${st.stop_id}', '${dirKey}')"
                            style="width:100%;background:#2563eb;color:#fff;border:none;padding:6px 10px;border-radius:6px;font-weight:500;font-size:11.5px;cursor:pointer;">
                            Selecionar embarque
                        </button>
                        <button type="button" onclick="window.__guideToStopById('${st.stop_id}', '${dirKey}')"
                            style="width:100%;background:#16a34a;color:#fff;border:none;padding:6px 10px;border-radius:6px;font-weight:500;font-size:11.5px;cursor:pointer;">
                            Guiar a pé até aqui (GPS)
                        </button>
                        <button type="button" onclick="window.__setAlightingStop('${st.stop_id}', '${dirKey}')"
                            style="width:100%;background:#f3f4f6;color:#1f2937;border:1px solid #d1d5db;padding:5px 10px;border-radius:6px;font-weight:500;font-size:11.5px;cursor:pointer;">
                            Avisar meu desembarque aqui
                        </button>
                    </div>
                </div>
            `;
            marker.bindPopup(popupHtml);
        });
    }

    window.__selectBoardingStop = function (stopId, dirKey) {
        const bundle = state.lineCache[state.activeCode];
        if (!bundle) return;
        const stops = bundle.line?.stops?.[dirKey] || [];
        const found = stops.find((s) => String(s.stop_id) === String(stopId));
        if (!found) return;

        state.selectedStop = { ...found, dir: dirKey };
        document.getElementById('selectedStopBanner').style.display = 'flex';
        document.getElementById('selectedStopName').textContent = `Parada ${found.seq} — ${found.address}`;
        renderStopsOnMap();
        updateSelectedStopEta();
        map.setView([found.lat, found.lng], 15);
    };

    async function fetchVehiclesForActiveLine() {
        const code = state.activeCode;
        const dirsToFetch = state.activeDir === 'ambos' ? ['ida', 'volta'] : [state.activeDir];

        try {
            const requests = dirsToFetch.map((d) =>
                fetch(`${API_BASE}api/vehicles/${encodeURIComponent(code)}/${d}`).then((r) => r.json())
            );
            const responses = await Promise.all(requests);

            let allVehicles = [];
            let isFallbackSimulated = false;

            responses.forEach((res) => {
                if (res && res.ok && Array.isArray(res.vehicles)) {
                    if (res.source === 'fallback_simulated' || res.source === 'simulated') {
                        isFallbackSimulated = true;
                    }
                    res.vehicles.forEach((v) => {
                        allVehicles.push({ ...v, direction: res.direction });
                    });
                }
            });

            state.activeVehicles = allVehicles;
            updateVehiclesOnMap(allVehicles);
            updateTelemetryUI(allVehicles, isFallbackSimulated);
            updateSelectedStopEta();
            evaluateActiveAlerts(allVehicles);
            evaluateAutoAlightingAlert();
        } catch (err) {}
    }

    function updateVehiclesOnMap(vehicles) {
        const activeIds = new Set();
        const displayCode = getLineDisplayCode(state.activeCode);

        vehicles.forEach((v) => {
            const id = `${v.id}_${v.direction}`;
            activeIds.add(id);

            const pos = [v.latitude, v.longitude];
            const isVolta = v.direction === 'volta';
            const pinClass = isVolta ? 'bus-pin--volta' : 'bus-pin--ida';

            const iconHtml = `
                <div class="bus-pin ${pinClass}">
                    <span>${escapeHtml(v.label)}</span>
                    <span style="opacity:0.85;font-weight:400;">· ${v.speedKmh} km/h</span>
                </div>
            `;

            const popupHtml = `
                <div style="font-family:Inter,sans-serif;min-width:175px;line-height:1.45;">
                    <div style="font-weight:600;font-size:13px;color:#1f2937;">
                        Veículo ${escapeHtml(v.label)} ${v.simulated ? '(GPS estimado)' : ''}
                    </div>
                    <div style="font-size:12px;color:#4b5563;margin-top:4px;">
                        Linha ${escapeHtml(displayCode)} (${v.direction === 'volta' ? 'Volta' : 'Ida'})<br>
                        Velocidade: ${v.speedKmh} km/h<br>
                        Atualizado há ${v.ageSeconds}s
                    </div>
                </div>
            `;

            if (busMarkersMap[id]) {
                busMarkersMap[id].setLatLng(pos);
                busMarkersMap[id].setPopupContent(popupHtml);
            } else {
                const icon = L.divIcon({
                    className: '',
                    html: iconHtml,
                    iconSize: [96, 26],
                    iconAnchor: [48, 13]
                });
                busMarkersMap[id] = L.marker(pos, { icon, zIndexOffset: 800 })
                    .addTo(layerBuses)
                    .bindPopup(popupHtml);
            }
        });

        Object.keys(busMarkersMap).forEach((id) => {
            if (!activeIds.has(id)) {
                layerBuses.removeLayer(busMarkersMap[id]);
                delete busMarkersMap[id];
            }
        });
    }

    function updateTelemetryUI(vehicles, isFallbackSimulated) {
        const badge = document.getElementById('gpsStatusBadge');
        document.getElementById('telBusCount').textContent = vehicles.length;
        document.getElementById('telLastUpdate').textContent = new Date().toLocaleTimeString('pt-BR', {
            hour: '2-digit',
            minute: '2-digit'
        });

        if (isFallbackSimulated && vehicles.length > 0) {
            badge.className = 'status-pill status-pill--sim';
            badge.textContent = `GPS estimado (${vehicles.length})`;
            badge.title = 'API de GPS ao vivo sem resposta; exibindo posição estimada como fallback automático.';
        } else if (vehicles.length > 0) {
            badge.className = 'status-pill status-pill--live';
            badge.textContent = `${vehicles.length} em operação`;
            badge.title = 'Posição em tempo real via GPS dos veículos.';
        } else {
            badge.className = 'status-pill';
            badge.textContent = 'Sem sinal no momento';
            badge.title = '';
        }
    }

    /* =========================================================================
       4. CÁLCULO DE APROXIMAÇÃO NA ROTA (TURF.JS)
       ========================================================================= */
    function computeBusApproachToStop(bus, stop, shapeCoords) {
        if (!shapeCoords || shapeCoords.length < 2 || typeof turf === 'undefined') {
            return null;
        }
        try {
            const lineGeoJson = turf.lineString(shapeCoords.map((c) => [c[1], c[0]]));
            const busPt = turf.point([bus.longitude, bus.latitude]);
            const stopPt = turf.point([stop.lng, stop.lat]);

            const snappedBus = turf.nearestPointOnLine(lineGeoJson, busPt, { units: 'kilometers' });
            const snappedStop = turf.nearestPointOnLine(lineGeoJson, stopPt, { units: 'kilometers' });

            const busDistM = (snappedBus.properties.location || 0) * 1000;
            const stopDistM = (snappedStop.properties.location || 0) * 1000;
            const remainingM = Math.round(stopDistM - busDistM);

            if (remainingM < -50) {
                return { passed: true, remainingM };
            }

            const distPos = Math.max(0, remainingM);
            const effSpeedKmh = bus.speedKmh > 3 ? Math.min(35, Math.max(15, bus.speedKmh)) : 18;
            const speedMPerMin = (effSpeedKmh * 1000) / 60;
            const rawMinutes = distPos / speedMPerMin;

            const minEta = Math.max(1, Math.floor(rawMinutes * 0.85));
            const maxEta = Math.max(minEta + 1, Math.ceil(rawMinutes * 1.25));

            return {
                passed: false,
                remainingM: distPos,
                minEta,
                maxEta
            };
        } catch (e) {
            return null;
        }
    }

    function updateSelectedStopEta() {
        const box = document.getElementById('selectedStopEtaBox');
        if (!state.selectedStop || !box) return;

        const bundle = state.lineCache[state.activeCode];
        const dir = state.selectedStop.dir || 'ida';
        const coords = bundle?.shapes?.[dir]?.coordinates || [];

        const candidates = [];
        state.activeVehicles
            .filter((v) => v.direction === dir)
            .forEach((v) => {
                const app = computeBusApproachToStop(v, state.selectedStop, coords);
                if (app && !app.passed) {
                    candidates.push({ bus: v, ...app });
                }
            });

        candidates.sort((a, b) => a.remainingM - b.remainingM);

        if (candidates.length === 0) {
            box.textContent = state.activeVehicles.length === 0
                ? 'Sem veículos em trânsito neste sentido agora.'
                : 'Os veículos deste sentido já passaram por este ponto.';
            return;
        }

        const best = candidates[0];
        const distLabel = best.remainingM >= 1000
            ? `${(best.remainingM / 1000).toFixed(2)} km`
            : `${best.remainingM} m`;

        box.textContent = `Próximo veículo (${best.bus.label}) a ${distLabel} · chegada em ${best.minEta} a ${best.maxEta} min`;
    }

    /* =========================================================================
       5. PLANEJADOR DE ROTAS E BUSCA POR ESCOLAS / COMÉRCIOS / GOOGLE MAPS
       ========================================================================= */
    function initPlannerEvents() {
        setupAddressAutocomplete('inputOrigin', 'originSuggestions', 'origin');
        setupAddressAutocomplete('inputDest', 'destSuggestions', 'dest');

        document.getElementById('btnOriginGps').addEventListener('click', () => {
            locateUserOnMap(false, (coords) => {
                setPlannerPoint('origin', {
                    label: 'Minha localização atual',
                    lat: coords.lat,
                    lng: coords.lng
                });
            });
        });

        document.getElementById('btnPickOriginMap').addEventListener('click', () => setMapPickMode('origin'));
        document.getElementById('btnPickDestMap').addEventListener('click', () => setMapPickMode('dest'));
        document.getElementById('btnCancelMapPick').addEventListener('click', () => setMapPickMode(null));

        document.getElementById('btnSwapOriginDest').addEventListener('click', () => {
            const tmp = state.planner.origin;
            setPlannerPoint('origin', state.planner.dest);
            setPlannerPoint('dest', tmp);
        });

        const btnModeNow = document.getElementById('btnTimeModeNow');
        const btnModeCustom = document.getElementById('btnTimeModeCustom');
        const nowBar = document.getElementById('plannerTimeNowBar');
        const customRow = document.getElementById('plannerTimeCustomRow');
        const inputDate = document.getElementById('inputPlanDate');
        const inputTime = document.getElementById('inputPlanTime');

        if (btnModeNow && btnModeCustom) {
            btnModeNow.addEventListener('click', async () => {
                state.planner.timeMode = 'now';
                btnModeNow.classList.add('active-mode');
                btnModeCustom.classList.remove('active-mode');
                nowBar.style.display = 'flex';
                customRow.style.display = 'none';
                await syncOfficialTimeContext();
                if (state.planner.origin && state.planner.dest) {
                    executeRouteCalculation();
                }
            });

            btnModeCustom.addEventListener('click', async () => {
                state.planner.timeMode = 'custom';
                btnModeCustom.classList.add('active-mode');
                btnModeNow.classList.remove('active-mode');
                nowBar.style.display = 'none';
                customRow.style.display = 'grid';

                if (!inputDate.value) {
                    inputDate.value = state.timeContext?.official_date || new Date().toISOString().slice(0, 10);
                }
                if (!inputTime.value) {
                    inputTime.value = state.timeContext?.official_now || '07:00';
                }
                state.planner.customDate = inputDate.value;
                state.planner.customTime = inputTime.value;
                await syncOfficialTimeContext(state.planner.customDate, state.planner.customTime);
                if (state.planner.origin && state.planner.dest) {
                    executeRouteCalculation();
                }
            });

            const onCustomDateTimeChange = async () => {
                state.planner.customDate = inputDate.value;
                state.planner.customTime = inputTime.value;
                await syncOfficialTimeContext(state.planner.customDate, state.planner.customTime);
                if (state.planner.origin && state.planner.dest) {
                    executeRouteCalculation();
                }
            };
            inputDate.addEventListener('change', onCustomDateTimeChange);
            inputTime.addEventListener('change', onCustomDateTimeChange);
        }

        document.querySelectorAll('.preset-chip').forEach((chip) => {
            chip.addEventListener('click', () => {
                setPlannerPoint('origin', {
                    label: chip.dataset.origName,
                    lat: parseFloat(chip.dataset.origLat),
                    lng: parseFloat(chip.dataset.origLng)
                });
                setPlannerPoint('dest', {
                    label: chip.dataset.destName,
                    lat: parseFloat(chip.dataset.destLat),
                    lng: parseFloat(chip.dataset.destLng)
                });
                executeRouteCalculation();
            });
        });

        document.getElementById('btnCalculateRoute').addEventListener('click', executeRouteCalculation);
    }

    function setMapPickMode(mode) {
        state.planner.mapPickMode = mode;
        const banner = document.getElementById('mapModeBanner');
        const text = document.getElementById('mapModeText');
        if (!mode) {
            banner.style.display = 'none';
            map.getContainer().style.cursor = '';
        } else {
            banner.style.display = 'flex';
            text.textContent = mode === 'origin'
                ? 'Clique no mapa para definir o ponto de partida'
                : 'Clique no mapa para definir o destino';
            map.getContainer().style.cursor = 'crosshair';
        }
    }

    function setPlannerPoint(which, pt) {
        state.planner[which] = pt || null;
        const input = document.getElementById(which === 'origin' ? 'inputOrigin' : 'inputDest');
        const info = document.getElementById(which === 'origin' ? 'originCoordsInfo' : 'destCoordsInfo');

        if (pt) {
            input.value = pt.label;
            info.textContent = `Local selecionado (${pt.lat.toFixed(4)}, ${pt.lng.toFixed(4)})`;
        } else {
            input.value = '';
            info.textContent = 'Nenhum local selecionado';
        }
        renderPlannerPinsOnMap();
    }

    function renderPlannerPinsOnMap() {
        layerPlanner.clearLayers();
        const { origin, dest } = state.planner;

        if (origin) {
            const origIcon = L.divIcon({
                className: '',
                html: `<div style="background:#15803d;color:#fff;padding:3px 8px;border-radius:99px;font-weight:600;font-size:11px;border:2px solid #fff;box-shadow:0 2px 5px rgba(0,0,0,0.25);">Partida</div>`,
                iconSize: [58, 22],
                iconAnchor: [29, 11]
            });
            L.marker([origin.lat, origin.lng], { icon: origIcon })
                .addTo(layerPlanner)
                .bindPopup(`<b>Partida:</b><br>${escapeHtml(origin.label)}`);
        }

        if (dest) {
            const destIcon = L.divIcon({
                className: '',
                html: `<div style="background:#b91c1c;color:#fff;padding:3px 8px;border-radius:99px;font-weight:600;font-size:11px;border:2px solid #fff;box-shadow:0 2px 5px rgba(0,0,0,0.25);">Destino</div>`,
                iconSize: [58, 22],
                iconAnchor: [29, 11]
            });
            L.marker([dest.lat, dest.lng], { icon: destIcon })
                .addTo(layerPlanner)
                .bindPopup(`<b>Destino:</b><br>${escapeHtml(dest.label)}`);
        }
    }

    const geocodeCache = new Map();

    function setupAddressAutocomplete(inputId, dropdownId, which) {
        const input = document.getElementById(inputId);
        const dropdown = document.getElementById(dropdownId);
        const info = document.getElementById(which === 'origin' ? 'originCoordsInfo' : 'destCoordsInfo');
        let debounceTimer = null;
        let activeAbortCtrl = null;
        let reqSeq = 0;

        function renderSuggestions(results) {
            if (!results || results.length === 0) {
                dropdown.style.display = 'none';
                info.textContent = 'Nenhum local encontrado com esse termo';
                return;
            }
            info.textContent = `${results.length} opções encontradas (escolha abaixo ou pressione Enter)`;
            dropdown.innerHTML = results
                .map(
                    (r, idx) => `
                    <div class="dropdown-item" data-idx="${idx}">
                        <strong>${escapeHtml(r.label)}</strong>
                        <small>${escapeHtml(r.sub)}</small>
                    </div>`
                )
                .join('');
            dropdown.style.display = 'block';

            dropdown.querySelectorAll('.dropdown-item').forEach((el) => {
                el.addEventListener('click', () => {
                    const picked = results[Number(el.dataset.idx)];
                    setPlannerPoint(which, {
                        label: picked.label,
                        lat: picked.lat,
                        lng: picked.lng
                    });
                    dropdown.style.display = 'none';
                });
            });
        }

        input.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            if (activeAbortCtrl) {
                activeAbortCtrl.abort();
                activeAbortCtrl = null;
            }

            const q = input.value.trim();

            if (state.planner[which] && state.planner[which].label !== q) {
                state.planner[which] = null;
            }

            if (q.length < 2) {
                dropdown.style.display = 'none';
                info.textContent = 'Digite um local, escola, endereço ou coordenada';
                return;
            }

            const cacheKey = q.toLowerCase();
            if (geocodeCache.has(cacheKey)) {
                renderSuggestions(geocodeCache.get(cacheKey));
                return;
            }

            info.textContent = 'Buscando...';
            const mySeq = ++reqSeq;

            debounceTimer = setTimeout(async () => {
                activeAbortCtrl = new AbortController();
                try {
                    const gkeyParam = state.googleApiKey ? `&gkey=${encodeURIComponent(state.googleApiKey)}` : '';
                    const res = await fetch(`${API_BASE}api/geocode?q=${encodeURIComponent(q)}${gkeyParam}`, {
                        signal: activeAbortCtrl.signal
                    });
                    const json = await res.json();

                    // Ignora se o usuário já digitou mais letras depois desta requisição
                    if (mySeq !== reqSeq || input.value.trim() !== q) {
                        return;
                    }

                    const list = (json.ok && Array.isArray(json.results)) ? json.results : [];
                    geocodeCache.set(cacheKey, list);
                    renderSuggestions(list);
                } catch (e) {
                    if (e.name !== 'AbortError' && mySeq === reqSeq) {
                        dropdown.style.display = 'none';
                    }
                }
            }, 120);
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                clearTimeout(debounceTimer);
                if (activeAbortCtrl) {
                    activeAbortCtrl.abort();
                    activeAbortCtrl = null;
                }
                dropdown.style.display = 'none';
                executeRouteCalculation();
            }
        });

        document.addEventListener('click', (e) => {
            if (!input.contains(e.target) && !dropdown.contains(e.target)) {
                dropdown.style.display = 'none';
            }
        });
    }

    async function resolvePointIfNeeded(which, inputId) {
        if (state.planner[which]) return state.planner[which];
        const rawText = document.getElementById(inputId).value.trim();
        if (rawText.length < 2) return null;

        const cacheKey = rawText.toLowerCase();
        if (geocodeCache.has(cacheKey) && geocodeCache.get(cacheKey).length > 0) {
            const top = geocodeCache.get(cacheKey)[0];
            const pt = { label: top.label, lat: top.lat, lng: top.lng };
            setPlannerPoint(which, pt);
            return pt;
        }

        const gkeyParam = state.googleApiKey ? `&gkey=${encodeURIComponent(state.googleApiKey)}` : '';
        const res = await fetch(`${API_BASE}api/geocode?q=${encodeURIComponent(rawText)}${gkeyParam}`);
        const json = await res.json();
        if (json.ok && Array.isArray(json.results) && json.results.length > 0) {
            geocodeCache.set(cacheKey, json.results);
            const top = json.results[0];
            const pt = { label: top.label, lat: top.lat, lng: top.lng };
            setPlannerPoint(which, pt);
            return pt;
        }
        return null;
    }

    async function executeRouteCalculation() {
        const container = document.getElementById('routePlanResults');
        document.getElementById('originSuggestions').style.display = 'none';
        document.getElementById('destSuggestions').style.display = 'none';

        container.innerHTML = `<div style="padding:14px;text-align:center;color:#6b7280;font-size:12.5px;">Localizando endereços no Google Maps e calculando linhas...</div>`;

        const origin = await resolvePointIfNeeded('origin', 'inputOrigin');
        const dest = await resolvePointIfNeeded('dest', 'inputDest');

        if (!origin || !dest) {
            container.innerHTML = '';
            showToast('Informe o ponto de partida e o destino.');
            return;
        }

        try {
            const params = new URLSearchParams({
                orig_lat: origin.lat,
                orig_lng: origin.lng,
                dest_lat: dest.lat,
                dest_lng: dest.lng,
                orig_label: origin.label || '',
                dest_label: dest.label || ''
            });
            if (state.planner.timeMode === 'custom') {
                if (state.planner.customDate) params.set('query_date', state.planner.customDate);
                if (state.planner.customTime) params.set('query_time', state.planner.customTime);
            }

            const res = await fetch(`${API_BASE}api/route-plan?${params.toString()}`);
            const json = await res.json();

            if (json.time_context) {
                updateTimeContextUI(json.time_context);
            }

            if (!json.ok || !json.recommendations || json.recommendations.length === 0) {
                container.innerHTML = `<div style="padding:12px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;font-size:12.5px;color:#4b5563;">Nenhuma linha encontrada próxima aos locais informados.</div>`;
                return;
            }

            const tCtx = json.time_context || state.timeContext;
            const contextHeaderHtml = tCtx
                ? `<div style="font-size:11.5px;color:#4b5563;padding:2px 2px 0;">
                    Cálculo para <strong>${escapeHtml(tCtx.time)}</strong> (${escapeHtml(tCtx.date_br)}) · ${escapeHtml(tCtx.day_label)}
                   </div>`
                : '';

            container.innerHTML =
                contextHeaderHtml +
                json.recommendations
                    .map((rec, idx) => {
                        const isDirect = rec.type === 'direct';
                        const tagClass = isDirect ? 'tag--direct' : 'tag--transfer';
                        const tagText = isDirect ? 'Linha direta' : 'Conexão (1 troca)';
                        const isInactive = !rec.operates_today || rec.service_ended_today;

                        const legsHtml = rec.legs
                            .map((leg) => {
                                const se = leg.schedule_eval || {};
                                let badgeClass = 'op-badge--ok';
                                if (!se.operates_today || se.service_ended_today || se.status_code === 'variant_unavailable_now') {
                                    badgeClass = 'op-badge--off';
                                } else if (se.status_code === 'active_wait_variant') {
                                    badgeClass = 'op-badge--warn';
                                }

                                const upcomingList = Array.isArray(se.upcoming_trips) ? se.upcoming_trips : [];
                                const upcomingHtml =
                                    upcomingList.length > 0
                                        ? `<div class="upcoming-strip">
                                            <span>Saídas do ponto final:</span>
                                            ${upcomingList
                                                .map((u) => {
                                                    const label = `${u.asterisk || ''}${u.dep_time}`;
                                                    const cls = u.special ? 'upcoming-chip upcoming-chip--special' : 'upcoming-chip';
                                                    const tip = u.variant_desc ? ` title="${escapeHtml(u.variant_desc)}"` : '';
                                                    return `<span class="${cls}"${tip}>${escapeHtml(label)}</span>`;
                                                })
                                                .join('')}
                                           </div>`
                                        : '';

                                const warnHtml = se.variant_warning
                                    ? `<div class="variant-box ${!se.operates_today || se.status_code === 'variant_unavailable_now' ? 'variant-box--off' : ''}">
                                        ${escapeHtml(se.variant_warning)}
                                       </div>`
                                    : '';

                                const legDisplayCode = leg.display_code || getLineDisplayCode(leg.line_code);
                                return `
                                <div class="route-step">
                                    <div class="route-step__line" style="justify-content:space-between;flex-wrap:wrap;">
                                        <div style="display:flex;align-items:center;gap:8px;">
                                            <span class="code-badge">${escapeHtml(legDisplayCode)}</span>
                                            <span>${escapeHtml(formatTitleCase(leg.line_name))}</span>
                                        </div>
                                        ${se.status_badge ? `<span class="op-badge ${badgeClass}">${escapeHtml(se.status_badge)}</span>` : ''}
                                    </div>
                                    <div class="route-step__details">
                                        ${se.status_detail ? `<div style="color:#1f2937;font-weight:500;margin-bottom:3px;">${escapeHtml(se.status_detail)}</div>` : ''}
                                        Sentido: ${escapeHtml(leg.direction_label)}<br>
                                        Embarque: <strong>${escapeHtml(leg.board_stop.address)}</strong> ${leg.walk_before_m > 0 ? `(${leg.walk_before_m} m a pé)` : ''}<br>
                                        Desembarque: <strong>${escapeHtml(leg.alight_stop.address)}</strong> ${leg.walk_after_m > 0 ? `(${leg.walk_after_m} m a pé)` : ''}<br>
                                        Trecho: ${leg.stops_count} paradas · ${(leg.bus_distance_m / 1000).toFixed(1)} km (~${leg.bus_time_min} min no ônibus)
                                    </div>
                                    ${warnHtml}
                                    ${upcomingHtml}
                                </div>`;
                            })
                            .join('');

                        return `
                            <div class="route-card ${isInactive ? 'route-card--inactive' : ''}">
                                <div class="route-card__head">
                                    <span class="tag ${tagClass}">${tagText}</span>
                                    <strong style="font-size:12.5px;color:#1f2937;">Trajeto ~${rec.total_time_min} min</strong>
                                </div>
                                ${legsHtml}
                                <div class="grid-2" style="margin-top:4px;">
                                    <button type="button" class="btn-outline btn-sm btn-apply-route" data-idx="${idx}">
                                        Visualizar no mapa
                                    </button>
                                    <button type="button" class="btn-primary btn-sm btn-guide-route" data-idx="${idx}">
                                        Guiar embarque + descida
                                    </button>
                                </div>
                            </div>
                        `;
                    })
                    .join('');

            const applyRouteOnMap = async (rec, activateGpsGuide = false) => {
                const firstLeg = rec.legs[0];
                await selectLine(firstLeg.line_code, firstLeg.direction, false);

                renderPlannerPinsOnMap();
                const bStop = firstLeg.board_stop;
                const lastLeg = rec.legs[rec.legs.length - 1];
                const aStop = lastLeg.alight_stop;

                L.polyline([[origin.lat, origin.lng], [bStop.lat, bStop.lng]], {
                    color: '#15803d',
                    weight: 3.5,
                    dashArray: '5, 5'
                }).addTo(layerPlanner);

                L.polyline([[aStop.lat, aStop.lng], [dest.lat, dest.lng]], {
                    color: '#b91c1c',
                    weight: 3.5,
                    dashArray: '5, 5'
                }).addTo(layerPlanner);

                window.__selectBoardingStop(bStop.stop_id, firstLeg.direction);

                if (activateGpsGuide) {
                    startWalkingGuideToStop({
                        stop_id: bStop.stop_id,
                        seq: bStop.seq,
                        address: bStop.address,
                        neighborhood: bStop.neighborhood || '',
                        lat: bStop.lat,
                        lng: bStop.lng,
                        direction: firstLeg.direction,
                        line_code: firstLeg.line_code
                    }, origin);

                    activateAutoAlighting({
                        line_code: lastLeg.line_code,
                        display_code: lastLeg.display_code || getLineDisplayCode(lastLeg.line_code),
                        direction: lastLeg.direction,
                        stop_id: aStop.stop_id,
                        seq: aStop.seq,
                        address: aStop.address,
                        lat: aStop.lat,
                        lng: aStop.lng,
                        dist_m: 450
                    }, true);
                }

                const bounds = L.latLngBounds([
                    [origin.lat, origin.lng],
                    [bStop.lat, bStop.lng],
                    [aStop.lat, aStop.lng],
                    [dest.lat, dest.lng]
                ]);
                map.fitBounds(bounds, { padding: [36, 36] });
            };

            container.querySelectorAll('.btn-apply-route').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const rec = json.recommendations[Number(btn.dataset.idx)];
                    applyRouteOnMap(rec, false);
                });
            });

            container.querySelectorAll('.btn-guide-route').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const rec = json.recommendations[Number(btn.dataset.idx)];
                    applyRouteOnMap(rec, true);
                });
            });
        } catch (err) {
            container.innerHTML = `<div style="padding:12px;color:#b91c1c;font-size:12px;">Erro ao calcular rota.</div>`;
        }
    }

    /* =========================================================================
       5B. GPS SECUNDÁRIO — PONTOS MAIS PRÓXIMOS E GUIA A PÉ ATÉ O EMBARQUE
       ========================================================================= */
    function initNearbyEvents() {
        const triggerNearbyLookup = () => {
            const statusEl = document.getElementById('nearbyGpsStatusText');
            if (statusEl) statusEl.textContent = 'Obtendo sua coordenada GPS atual...';
            locateUserOnMap(
                true,
                (coords) => {
                    fetchAndRenderNearbyStops(coords.lat, coords.lng, true);
                },
                true
            );
        };

        const btnFind = document.getElementById('btnFindNearbyStops');
        if (btnFind) btnFind.addEventListener('click', triggerNearbyLookup);

        const btnRefresh = document.getElementById('btnRefreshNearbyGps');
        if (btnRefresh) btnRefresh.addEventListener('click', triggerNearbyLookup);

        const btnStopGuide = document.getElementById('btnStopWalkingGuide');
        if (btnStopGuide) btnStopGuide.addEventListener('click', stopWalkingGuide);

        const btnCloseBar = document.getElementById('btnCloseGpsGuideBar');
        if (btnCloseBar) {
            btnCloseBar.addEventListener('click', () => {
                if (state.walkingGuide) {
                    stopWalkingGuide();
                } else {
                    document.getElementById('gpsGuideFloatingBar').style.display = 'none';
                }
            });
        }
    }

    async function fetchAndRenderNearbyStops(lat, lng, autoGuideNearest = false) {
        const statusEl = document.getElementById('nearbyGpsStatusText');
        const lineCardEl = document.getElementById('nearestLineStopCard');
        const listEl = document.getElementById('nearbyStopsListContainer');
        const dir = state.activeDir === 'volta' ? 'volta' : 'ida';
        const displayCode = getLineDisplayCode(state.activeCode);

        try {
            const qs = new URLSearchParams({
                lat: String(lat),
                lng: String(lng),
                line: state.activeCode,
                dir
            });
            const res = await fetch(`${API_BASE}api/nearby-stops?${qs.toString()}`);
            const json = await res.json();
            if (!json.ok) return;

            state.nearbyStopsCache = json.nearest_stops || [];

            if (statusEl) {
                statusEl.textContent = `Sua posição: (${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}) · Pontos ordenados por proximidade.`;
            }

            if (lineCardEl) {
                if (json.nearest_line_stop) {
                    const ls = json.nearest_line_stop;
                    lineCardEl.style.display = 'block';
                    lineCardEl.innerHTML = `
                        <div class="stop-focus-box" style="margin-top:4px;">
                            <div class="stop-focus-box__content">
                                <span class="stop-focus-box__label">Embarque mais próximo da linha ${escapeHtml(displayCode)}</span>
                                <strong class="stop-focus-box__title">Parada ${ls.seq} — ${escapeHtml(ls.address)}</strong>
                                <span class="stop-focus-box__eta">
                                    A <strong>${ls.distance_m} m</strong> (${ls.walk_min} min a pé · direção ${escapeHtml(ls.compass)})
                                </span>
                            </div>
                            <div class="stop-focus-box__actions">
                                <button type="button" class="btn-primary btn-xs" id="btnGuideNearestActiveLineStop">
                                    Guiar até aqui
                                </button>
                            </div>
                        </div>
                    `;
                    const btnGuideActive = document.getElementById('btnGuideNearestActiveLineStop');
                    if (btnGuideActive) {
                        btnGuideActive.addEventListener('click', () => {
                            startWalkingGuideToStop({
                                ...ls,
                                direction: dir,
                                line_code: state.activeCode
                            });
                        });
                    }
                    if (autoGuideNearest && !state.walkingGuide) {
                        // Destaca no mapa o ponto mais próximo da linha ativa
                        window.__selectBoardingStop(ls.stop_id, dir);
                    }
                } else {
                    lineCardEl.style.display = 'none';
                }
            }

            if (listEl) {
                if (!state.nearbyStopsCache.length) {
                    listEl.innerHTML = `<div style="padding:14px;text-align:center;color:#6b7280;font-size:12px;">Nenhum ponto encontrado nas proximidades.</div>`;
                    return;
                }

                listEl.innerHTML = state.nearbyStopsCache
                    .map((st, idx) => {
                        const linesBadges = (st.lines || []).slice(0, 6).join(', ');
                        return `
                        <div class="stop-row" data-nearby-idx="${idx}" style="justify-content:space-between;">
                            <div style="display:flex;align-items:flex-start;gap:10px;min-width:0;flex:1;">
                                <span class="stop-num">${st.distance_m}m</span>
                                <div style="min-width:0;flex:1;">
                                    <div style="font-weight:600;color:var(--text-main);font-size:12.5px;">
                                        ${escapeHtml(st.address)}
                                    </div>
                                    <div style="font-size:11.5px;color:var(--text-muted);margin-top:2px;">
                                        ${escapeHtml(st.neighborhood)} · <strong>${st.walk_min} min a pé</strong> (${escapeHtml(st.compass)})
                                    </div>
                                    <div style="font-size:11px;color:var(--primary);margin-top:2px;font-weight:500;">
                                        Linhas: ${escapeHtml(linesBadges)}
                                    </div>
                                </div>
                            </div>
                            <button type="button" class="btn-outline btn-xs btn-start-walk" data-nearby-idx="${idx}">
                                Guiar a pé
                            </button>
                        </div>`;
                    })
                    .join('');

                listEl.querySelectorAll('.btn-start-walk').forEach((btn) => {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const st = state.nearbyStopsCache[Number(btn.dataset.nearbyIdx)];
                        if (st) startWalkingGuideToStop(st);
                    });
                });

                listEl.querySelectorAll('.stop-row').forEach((row) => {
                    row.addEventListener('click', () => {
                        const st = state.nearbyStopsCache[Number(row.dataset.nearbyIdx)];
                        if (st) startWalkingGuideToStop(st);
                    });
                });
            }
        } catch (err) {}
    }

    window.__guideToStopById = function (stopId, dirKey) {
        const bundle = state.lineCache[state.activeCode];
        const stops = bundle?.line?.stops?.[dirKey] || [];
        const found = stops.find((s) => String(s.stop_id) === String(stopId));
        if (!found) return;
        startWalkingGuideToStop({
            ...found,
            direction: dirKey,
            line_code: state.activeCode
        });
    };

    async function startWalkingGuideToStop(stopObj, customOrigin = null) {
        if (!stopObj) return;

        const proceedWithCoords = async (userCoords) => {
            state.walkingGuide = {
                stop: stopObj,
                notifiedArrival: false
            };

            if (stopObj.line_code && stopObj.line_code !== state.activeCode) {
                await selectLine(stopObj.line_code, stopObj.direction || 'ida', false);
            }
            if (stopObj.stop_id) {
                window.__selectBoardingStop(stopObj.stop_id, stopObj.direction || (state.activeDir === 'volta' ? 'volta' : 'ida'));
            }

            ensureGpsWatch();
            await drawWalkingRouteToStop(userCoords.lat, userCoords.lng, stopObj);
            updateWalkingGuideProgress();

            const bounds = L.latLngBounds([
                [userCoords.lat, userCoords.lng],
                [stopObj.lat, stopObj.lng]
            ]);
            map.fitBounds(bounds, { padding: [48, 48] });
            showToast(`Guia a pé ativado até ${stopObj.address}.`);
        };

        if (customOrigin && customOrigin.lat && customOrigin.lng) {
            updateUserLocationMarker(customOrigin.lat, customOrigin.lng, false);
            proceedWithCoords(customOrigin);
        } else if (state.userLocation) {
            proceedWithCoords(state.userLocation);
        } else {
            locateUserOnMap(false, (coords) => proceedWithCoords(coords), true);
        }
    }

    async function drawWalkingRouteToStop(uLat, uLng, stopObj) {
        if (!layerWalkingGuide) return;
        layerWalkingGuide.clearLayers();

        let routeCoords = [
            [uLat, uLng],
            [stopObj.lat, stopObj.lng]
        ];

        try {
            const osrmUrl = `https://router.project-osrm.org/route/v1/foot/${uLng},${uLat};${stopObj.lng},${stopObj.lat}?overview=full&geometries=geojson`;
            const res = await fetch(osrmUrl);
            const json = await res.json();
            if (json && json.routes && json.routes[0]?.geometry?.coordinates?.length > 1) {
                routeCoords = json.routes[0].geometry.coordinates.map((c) => [c[1], c[0]]);
            }
        } catch (e) {}

        L.polyline(routeCoords, {
            color: '#16a34a',
            weight: 5,
            opacity: 0.9,
            dashArray: '8, 6'
        }).addTo(layerWalkingGuide);

        const targetIcon = L.divIcon({
            className: '',
            html: `<div style="background:#15803d;color:#fff;padding:3px 8px;border-radius:99px;font-weight:600;font-size:11px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.28);white-space:nowrap;">Embarque aqui</div>`,
            iconSize: [96, 22],
            iconAnchor: [48, 24]
        });
        L.marker([stopObj.lat, stopObj.lng], { icon: targetIcon })
            .addTo(layerWalkingGuide)
            .bindPopup(`<b>Ponto de Embarque</b><br>${escapeHtml(stopObj.address)}`);
    }

    function updateWalkingGuideProgress() {
        const box = document.getElementById('walkingGuideActiveBox');
        const titleEl = document.getElementById('walkingGuideStopTitle');
        const metricsEl = document.getElementById('walkingGuideMetrics');
        const floatBar = document.getElementById('gpsGuideFloatingBar');
        const floatText = document.getElementById('gpsGuideFloatingText');

        if (!state.walkingGuide || !state.walkingGuide.stop) {
            if (box) box.style.display = 'none';
            if (!state.autoAlight?.active && floatBar) {
                floatBar.style.display = 'none';
            }
            return;
        }

        const st = state.walkingGuide.stop;
        if (box) box.style.display = 'flex';
        if (titleEl) titleEl.textContent = st.address;

        if (!state.userLocation) {
            if (metricsEl) metricsEl.textContent = 'Aguardando sinal do GPS...';
            return;
        }

        const distM = Math.round(haversineMeters(state.userLocation.lat, state.userLocation.lng, st.lat, st.lng));
        const walkMin = Math.max(1, Math.ceil(distM / 75));
        const compass = bearingToCompass(state.userLocation.lat, state.userLocation.lng, st.lat, st.lng);

        const msg = distM <= 30
            ? `Você chegou ao ponto de embarque (${distM} m).`
            : `Faltam ${distM} m (~${walkMin} min a pé · siga para ${compass})`;

        if (metricsEl) metricsEl.textContent = msg;
        if (floatBar && floatText) {
            floatBar.style.display = 'flex';
            floatText.textContent = `Guia a pé: ${st.address} — ${msg}`;
        }

        if (distM <= 30 && !state.walkingGuide.notifiedArrival) {
            state.walkingGuide.notifiedArrival = true;
            playAlertSound();
            showToast(`Você chegou ao ponto de embarque: ${st.address}`, true);
            triggerBrowserNotification('Ponto de Embarque alcançado', `Você chegou em ${st.address}.`);
        }
    }

    function stopWalkingGuide() {
        state.walkingGuide = null;
        if (layerWalkingGuide) layerWalkingGuide.clearLayers();
        updateWalkingGuideProgress();
        showToast('Guia a pé encerrado.');
    }

    function haversineMeters(lat1, lon1, lat2, lon2) {
        const R = 6371000;
        const dLat = ((lat2 - lat1) * Math.PI) / 180;
        const dLon = ((lon2 - lon1) * Math.PI) / 180;
        const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos((lat1 * Math.PI) / 180) *
                Math.cos((lat2 * Math.PI) / 180) *
                Math.sin(dLon / 2) *
                Math.sin(dLon / 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function bearingToCompass(lat1, lon1, lat2, lon2) {
        const dLon = ((lon2 - lon1) * Math.PI) / 180;
        const y = Math.sin(dLon) * Math.cos((lat2 * Math.PI) / 180);
        const x =
            Math.cos((lat1 * Math.PI) / 180) * Math.sin((lat2 * Math.PI) / 180) -
            Math.sin((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.cos(dLon);
        const brng = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
        const dirs = ['Norte', 'Nordeste', 'Leste', 'Sudeste', 'Sul', 'Sudoeste', 'Oeste', 'Noroeste'];
        return dirs[Math.round(brng / 45) % 8];
    }

    /* =========================================================================
       6. ALERTAS DE DESEMBARQUE AUTOMÁTICO (GPS) E APROXIMAÇÃO NO EMBARQUE
       ========================================================================= */
    function initAlertEvents() {
        updateNotificationPermissionUI();

        document.getElementById('btnEnableNotifications').addEventListener('click', async () => {
            if (!('Notification' in window)) {
                showToast('Navegador sem suporte a notificações.');
                return;
            }
            const perm = await Notification.requestPermission();
            updateNotificationPermissionUI();
            if (perm === 'granted') {
                showToast('Notificações ativadas com sucesso.');
            }
        });

        document.getElementById('btnTestNotification').addEventListener('click', () => {
            playAlertSound();
            const disp = getLineDisplayCode(state.activeCode);
            showToast(`Teste de alerta: Linha ${disp} se aproximando do ponto (aprox. 2 min).`, true);
            triggerBrowserNotification(
                `Linha ${disp} próxima`,
                'O veículo está a 420 metros na rota (aprox. 2 min).'
            );
        });

        const btnActivateAlight = document.getElementById('btnActivateAutoAlight');
        if (btnActivateAlight) {
            btnActivateAlight.addEventListener('click', () => {
                const stopId = document.getElementById('alightSelectStop').value;
                const distM = Number(document.getElementById('alightDistThreshold').value || 450);
                const bundle = state.lineCache[state.activeCode];
                const dir = state.activeDir === 'volta' ? 'volta' : 'ida';
                const stops = bundle?.line?.stops?.[dir] || [];
                const stopObj = stops.find((s) => String(s.stop_id) === String(stopId));

                if (!stopObj) {
                    showToast('Selecione o ponto de desembarque.');
                    return;
                }

                activateAutoAlighting({
                    line_code: state.activeCode,
                    display_code: getLineDisplayCode(state.activeCode),
                    direction: dir,
                    stop_id: stopObj.stop_id,
                    seq: stopObj.seq,
                    address: stopObj.address,
                    lat: stopObj.lat,
                    lng: stopObj.lng,
                    dist_m: distM
                });
            });
        }

        const btnClearAlight = document.getElementById('btnClearAutoAlight');
        if (btnClearAlight) {
            btnClearAlight.addEventListener('click', clearAutoAlighting);
        }

        document.getElementById('btnSaveAlert').addEventListener('click', () => {
            const stopId = document.getElementById('alertSelectStop').value;
            const distM = Number(document.getElementById('alertDistThreshold').value || 1000);
            const etaMin = Number(document.getElementById('alertEtaThreshold').value || 5);

            const bundle = state.lineCache[state.activeCode];
            const dir = state.activeDir === 'volta' ? 'volta' : 'ida';
            const stops = bundle?.line?.stops?.[dir] || [];
            const stopObj = stops.find((s) => String(s.stop_id) === String(stopId));

            if (!stopObj) {
                showToast('Selecione um ponto de embarque.');
                return;
            }

            const dispCode = getLineDisplayCode(state.activeCode);
            const newAlert = {
                id: 'AL-' + Date.now().toString(36).toUpperCase(),
                line_code: state.activeCode,
                display_code: dispCode,
                direction: dir,
                stop_id: stopObj.stop_id,
                seq: stopObj.seq,
                stop_address: stopObj.address,
                lat: stopObj.lat,
                lng: stopObj.lng,
                dist_m: distM,
                eta_min: etaMin
            };

            state.alerts.unshift(newAlert);
            localStorage.setItem('onibus_mc_alerts', JSON.stringify(state.alerts));
            renderAlertsList();
            window.__selectBoardingStop(stopObj.stop_id, dir);
            showToast(`Alerta de embarque criado para a linha ${dispCode}.`, true);
        });
    }

    window.__setAlightingStop = function (stopId, dirKey) {
        const bundle = state.lineCache[state.activeCode];
        const stops = bundle?.line?.stops?.[dirKey] || [];
        const stopObj = stops.find((s) => String(s.stop_id) === String(stopId));
        if (!stopObj) return;

        const distM = Number(document.getElementById('alightDistThreshold')?.value || 450);
        activateAutoAlighting({
            line_code: state.activeCode,
            display_code: getLineDisplayCode(state.activeCode),
            direction: dirKey,
            stop_id: stopObj.stop_id,
            seq: stopObj.seq,
            address: stopObj.address,
            lat: stopObj.lat,
            lng: stopObj.lng,
            dist_m: distM
        });
    };

    function activateAutoAlighting(cfg, silentToast = false) {
        state.autoAlight = {
            ...cfg,
            active: true,
            triggered: false
        };
        localStorage.setItem('onibus_mc_auto_alight', JSON.stringify(state.autoAlight));

        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission().then(updateNotificationPermissionUI).catch(() => {});
        }

        locateUserOnMap(false, null, true);
        ensureGpsWatch();
        renderStopsOnMap();
        updateAutoAlightUI();
        evaluateAutoAlightingAlert();

        if (!silentToast) {
            showToast(
                `Alerta automático de desembarque ativado: Parada ${cfg.seq} (${cfg.address}).`,
                true
            );
        }
    }

    function clearAutoAlighting() {
        state.autoAlight = null;
        localStorage.removeItem('onibus_mc_auto_alight');
        if (alightTargetMarker) {
            map.removeLayer(alightTargetMarker);
            alightTargetMarker = null;
        }
        renderStopsOnMap();
        updateAutoAlightUI();
        showToast('Alerta automático de desembarque desativado.');
    }

    function updateAutoAlightUI() {
        const badge = document.getElementById('autoAlightBadge');
        const box = document.getElementById('autoAlightStatusBox');
        const text = document.getElementById('autoAlightStatusText');
        const floatBar = document.getElementById('gpsGuideFloatingBar');
        const floatText = document.getElementById('gpsGuideFloatingText');

        if (!state.autoAlight || !state.autoAlight.active) {
            if (badge) {
                badge.className = 'status-pill';
                badge.textContent = 'Inativo';
            }
            if (box) box.style.display = 'none';
            if (alightTargetMarker && map) {
                map.removeLayer(alightTargetMarker);
                alightTargetMarker = null;
            }
            if (!state.walkingGuide && floatBar) {
                floatBar.style.display = 'none';
            }
            return;
        }

        const al = state.autoAlight;
        if (badge) {
            badge.className = 'status-pill status-pill--live';
            badge.textContent = 'Monitorando GPS';
        }
        if (box) box.style.display = 'flex';
        if (text) {
            text.textContent = `Desembarque: Parada ${al.seq} — ${al.address} (aviso a ${al.dist_m} m)`;
        }

        if (map) {
            if (alightTargetMarker) {
                alightTargetMarker.setLatLng([al.lat, al.lng]);
            } else {
                const icon = L.divIcon({
                    className: '',
                    html: `<div style="background:#b91c1c;color:#fff;padding:3px 8px;border-radius:99px;font-weight:600;font-size:11px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.28);white-space:nowrap;">Desembarque</div>`,
                    iconSize: [92, 22],
                    iconAnchor: [46, 24]
                });
                alightTargetMarker = L.marker([al.lat, al.lng], { icon })
                    .addTo(map)
                    .bindPopup(`<b>Seu Ponto de Desembarque</b><br>Parada ${al.seq} — ${escapeHtml(al.address)}`);
            }
        }

        if (!state.walkingGuide && floatBar && floatText) {
            floatBar.style.display = 'flex';
            floatText.textContent = `Monitorando descida: Parada ${al.seq} (${al.address})`;
        }
    }

    function evaluateAutoAlightingAlert() {
        if (!state.autoAlight || !state.autoAlight.active) return;
        const al = state.autoAlight;
        const text = document.getElementById('autoAlightStatusText');
        const floatText = document.getElementById('gpsGuideFloatingText');

        let bestDistM = null;
        let sourceLabel = 'GPS';

        if (state.userLocation) {
            bestDistM = Math.round(haversineMeters(state.userLocation.lat, state.userLocation.lng, al.lat, al.lng));
            sourceLabel = 'seu GPS';
        }

        // Também verifica veículos ativos da linha caso o ônibus esteja se aproximando do ponto de descida
        if (al.line_code === state.activeCode && state.activeVehicles.length > 0) {
            const bundle = state.lineCache[state.activeCode];
            const coords = bundle?.shapes?.[al.direction]?.coordinates || [];
            state.activeVehicles
                .filter((v) => v.direction === al.direction)
                .forEach((v) => {
                    const app = computeBusApproachToStop(v, al, coords);
                    if (app && !app.passed && (bestDistM === null || app.remainingM < bestDistM)) {
                        bestDistM = app.remainingM;
                        sourceLabel = `veículo ${v.label}`;
                    }
                });
        }

        if (bestDistM === null) return;

        const statusLine = `Faltam ${bestDistM} m para seu desembarque na Parada ${al.seq} (${al.address}) via ${sourceLabel}.`;
        if (text) text.textContent = statusLine;
        if (!state.walkingGuide && floatText) {
            floatText.textContent = statusLine;
        }

        if (bestDistM <= al.dist_m && !al.triggered) {
            state.autoAlight.triggered = true;
            localStorage.setItem('onibus_mc_auto_alight', JSON.stringify(state.autoAlight));
            playAlertSound();
            if (navigator.vibrate) {
                try { navigator.vibrate([300, 150, 300]); } catch (e) {}
            }
            const disp = al.display_code || getLineDisplayCode(al.line_code);
            const alertMsg = `Prepare-se para descer! Seu ponto de desembarque (${al.address}) na linha ${disp} está a ${bestDistM} metros.`;
            showToast(alertMsg, true);
            triggerBrowserNotification('Alerta Automático de Desembarque', alertMsg);
        }
    }

    function populateAlertStopsSelect() {
        const select = document.getElementById('alertSelectStop');
        const badge = document.getElementById('alertLineBadge');
        const alightSelect = document.getElementById('alightSelectStop');
        const alightBadge = document.getElementById('alightLineBadge');
        const bundle = state.lineCache[state.activeCode];
        if (!bundle || !select) return;

        const dir = state.activeDir === 'volta' ? 'volta' : 'ida';
        const dispCode = getLineDisplayCode(state.activeCode);
        const labelText = `${dispCode} (${dir === 'volta' ? 'Volta' : 'Ida'})`;

        if (badge) badge.textContent = labelText;
        if (alightBadge) alightBadge.textContent = labelText;

        const stops = bundle.line?.stops?.[dir] || [];
        const optionsHtml = stops
            .map((s) => `<option value="${s.stop_id}">Parada ${s.seq} — ${escapeHtml(s.address)}</option>`)
            .join('');

        select.innerHTML = optionsHtml;
        if (state.selectedStop && state.selectedStop.dir === dir) {
            select.value = state.selectedStop.stop_id;
        }

        if (alightSelect) {
            alightSelect.innerHTML = optionsHtml;
            if (state.autoAlight && state.autoAlight.line_code === state.activeCode && state.autoAlight.direction === dir) {
                alightSelect.value = state.autoAlight.stop_id;
            } else if (stops.length > 0) {
                alightSelect.value = stops[stops.length - 1].stop_id;
            }
        }
    }

    function renderAlertsList() {
        const container = document.getElementById('alertsListContainer');
        const badgeCount = document.getElementById('alertBadgeCount');
        const totalActive = state.alerts.length + (state.autoAlight && state.autoAlight.active ? 1 : 0);

        if (totalActive > 0) {
            badgeCount.style.display = 'inline-block';
            badgeCount.textContent = totalActive;
        } else {
            badgeCount.style.display = 'none';
        }

        if (state.alerts.length === 0) {
            container.innerHTML = `<div style="padding:14px;text-align:center;color:#6b7280;font-size:12px;">Nenhum alerta de embarque ativo.</div>`;
            return;
        }

        container.innerHTML = state.alerts
            .map(
                (al) => `
                <div class="alert-row">
                    <div style="font-size:12px;line-height:1.4;">
                        <div>
                            <span class="code-badge">${escapeHtml(al.display_code || getLineDisplayCode(al.line_code))}</span>
                            <strong style="margin-left:6px;">Parada ${al.seq} (${al.direction === 'volta' ? 'Volta' : 'Ida'})</strong>
                        </div>
                        <div style="color:var(--text-main);margin-top:3px;">${escapeHtml(al.stop_address)}</div>
                        <div style="color:var(--text-muted);font-size:11.5px;">
                            Avisar a ${al.dist_m} m ou ${al.eta_min} min
                        </div>
                    </div>
                    <button type="button" class="btn-ghost btn-xs btn-del-alert" data-id="${al.id}">Remover</button>
                </div>`
            )
            .join('');

        container.querySelectorAll('.btn-del-alert').forEach((btn) => {
            btn.addEventListener('click', () => {
                state.alerts = state.alerts.filter((a) => a.id !== btn.dataset.id);
                localStorage.setItem('onibus_mc_alerts', JSON.stringify(state.alerts));
                renderAlertsList();
            });
        });
    }

    function evaluateActiveAlerts(vehicles) {
        if (state.alerts.length === 0 || vehicles.length === 0) return;
        const bundle = state.lineCache[state.activeCode];
        if (!bundle) return;

        state.alerts.forEach((al) => {
            if (al.line_code !== state.activeCode) return;
            const coords = bundle.shapes?.[al.direction]?.coordinates || [];
            const dispCode = al.display_code || getLineDisplayCode(al.line_code);

            vehicles
                .filter((v) => v.direction === al.direction)
                .forEach((v) => {
                    const dedupeKey = `${al.id}_${v.id}`;
                    if (state.firedAlertKeys[dedupeKey] && Date.now() - state.firedAlertKeys[dedupeKey] < 300000) {
                        return;
                    }

                    const app = computeBusApproachToStop(v, al, coords);
                    if (!app || app.passed) return;

                    if (app.remainingM <= al.dist_m || app.minEta <= al.eta_min) {
                        state.firedAlertKeys[dedupeKey] = Date.now();
                        playAlertSound();
                        const msg = `Linha ${dispCode} (${v.label}) a ${app.remainingM} m (~${app.minEta} a ${app.maxEta} min) do ponto ${al.stop_address}.`;
                        showToast(msg, true);
                        triggerBrowserNotification(`Linha ${dispCode} próxima`, msg);
                    }
                });
        });
    }

    function updateNotificationPermissionUI() {
        const statusText = document.getElementById('pushStatusText');
        const btn = document.getElementById('btnEnableNotifications');
        if (!('Notification' in window)) {
            statusText.textContent = 'Indisponível neste navegador.';
            btn.style.display = 'none';
            return;
        }
        if (Notification.permission === 'granted') {
            statusText.textContent = 'Notificações autorizadas neste aparelho.';
            btn.textContent = 'Ativo';
            btn.disabled = true;
        } else if (Notification.permission === 'denied') {
            statusText.textContent = 'Permissão desativada no navegador.';
        }
    }

    function triggerBrowserNotification(title, body) {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        if (navigator.serviceWorker && navigator.serviceWorker.controller) {
            navigator.serviceWorker.ready.then((reg) => {
                reg.showNotification(title, {
                    body,
                    tag: 'onibus-mc-alert'
                });
            });
        } else {
            new Notification(title, { body });
        }
    }

    function playAlertSound() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(523.25, ctx.currentTime);
            osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.14);
            gain.gain.setValueAtTime(0.14, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 0.45);
        } catch (e) {}
    }

    /* =========================================================================
       7. QUADRO DE HORÁRIOS E PARADAS
       ========================================================================= */
    function initScheduleEvents() {
        const schedSelect = document.getElementById('schedLineSelect');
        if (schedSelect) {
            // Formatar opções em Title Case para leitura confortável
            Array.from(schedSelect.options).forEach((opt) => {
                const parts = opt.textContent.trim().split(' — ');
                if (parts.length === 2) {
                    opt.textContent = `${parts[0]} — ${formatTitleCase(parts[1])}`;
                }
            });

            schedSelect.addEventListener('change', (e) => {
                const newCode = e.target.value;
                selectLine(newCode, state.activeDir === 'volta' ? 'volta' : 'ida', true);
            });
        }

        document.querySelectorAll('.subtab-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.subtab-btn').forEach((b) => b.classList.remove('active'));
                btn.classList.add('active');
                const target = btn.dataset.subtab;
                document.getElementById('subtab-times').style.display = target === 'times' ? 'block' : 'none';
                document.getElementById('subtab-stops').style.display = target === 'stops' ? 'block' : 'none';
            });
        });

        document.querySelectorAll('#subtab-times .day-pill').forEach((btn) => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('#subtab-times .day-pill').forEach((b) => b.classList.remove('active'));
                btn.classList.add('active');
                state.scheduleDay = btn.dataset.day;
                renderScheduleTab();
            });
        });

        document.querySelectorAll('.sched-dir-pill').forEach((btn) => {
            btn.addEventListener('click', () => {
                setDirection(btn.dataset.dir);
            });
        });
    }

    function renderScheduleTab() {
        const bundle = state.lineCache[state.activeCode];
        if (!bundle) return;

        const sched = bundle.line?.schedule || {};
        const timesContainer = document.getElementById('scheduleTimesContainer');
        const stopsContainer = document.getElementById('scheduleStopsContainer');

        const dayKey = state.scheduleDay;
        const isCurrentOperationalDay = state.timeContext && state.timeContext.day_type === dayKey;
        const nowMin = state.timeContext ? Number(state.timeContext.minutes_of_day || 0) : -1;

        timesContainer.innerHTML = ['ida', 'volta']
            .map((dir) => {
                const block = sched[dir] || {};
                const list = block[dayKey] || [];
                const obs = block.obs || [];

                let highlightedNext = false;
                const chipsHtml =
                    list.length > 0
                        ? list
                              .map((t) => {
                                  let isNext = false;
                                  if (isCurrentOperationalDay && !highlightedNext && nowMin >= 0 && t.time) {
                                      const [hh, mm] = t.time.split(':').map(Number);
                                      if (hh * 60 + mm >= nowMin) {
                                          isNext = true;
                                          highlightedNext = true;
                                      }
                                  }
                                  const displayTime = `${t.asterisk || ''}${t.time}`;
                                  const classes = [
                                      'time-tag',
                                      t.special ? 'time-tag--special' : '',
                                      isNext ? 'time-tag--next' : ''
                                  ]
                                      .filter(Boolean)
                                      .join(' ');
                                  const titleParts = [];
                                  if (isNext) titleParts.push('Próxima saída do ponto final hoje');
                                  if (t.special) titleParts.push('Atendimento específico (ver observações abaixo)');
                                  return `<span class="${classes}" title="${escapeHtml(titleParts.join(' · '))}">${escapeHtml(displayTime)}</span>`;
                              })
                              .join('')
                        : `<div style="font-size:12px;color:#6b7280;">Não opera neste período.</div>`;

                const obsHtml =
                    obs.length > 0
                        ? `<div style="margin-top:8px;padding-top:6px;border-top:1px solid #f1f3f5;font-size:11.5px;color:#6b7280;">
                            Obs: ${obs.map(escapeHtml).join(' · ')}
                           </div>`
                        : '';

                return `
                    <div class="schedule-box">
                        <h4>${escapeHtml(formatTitleCase(block.title || (dir === 'ida' ? 'Ida' : 'Volta')))}</h4>
                        <div class="times-grid">${chipsHtml}</div>
                        ${obsHtml}
                    </div>
                `;
            })
            .join('');

        const dirKey = state.activeDir === 'volta' ? 'volta' : 'ida';
        const stops = bundle.line?.stops?.[dirKey] || [];

        stopsContainer.innerHTML = stops
            .map(
                (st) => `
                <div class="stop-row" data-stop-id="${st.stop_id}" data-dir="${dirKey}">
                    <span class="stop-num">${st.seq}</span>
                    <div style="min-width:0;flex:1;">
                        <div style="font-weight:500;color:#1f2937;font-size:12.5px;">${escapeHtml(st.address)}</div>
                        <div style="font-size:11.5px;color:#6b7280;">
                            ${escapeHtml(st.neighborhood)} · ${(st.dist_m / 1000).toFixed(1)} km
                        </div>
                    </div>
                </div>`
            )
            .join('');

        stopsContainer.querySelectorAll('.stop-row').forEach((item) => {
            item.addEventListener('click', () => {
                window.__selectBoardingStop(item.dataset.stopId, item.dataset.dir);
            });
        });
    }

    /* =========================================================================
       8. MODAL CHAVE GOOGLE MAPS & PWA
       ========================================================================= */
    function initApiKeyModal() {
        const modal = document.getElementById('apiKeyModal');
        const input = document.getElementById('inputGoogleApiKey');
        input.value = state.googleApiKey;

        document.getElementById('btnOpenApiKeyModal').addEventListener('click', () => {
            input.value = state.googleApiKey;
            modal.style.display = 'flex';
        });

        document.getElementById('btnCloseApiKeyModal').addEventListener('click', () => {
            modal.style.display = 'none';
        });

        document.getElementById('btnSaveApiKey').addEventListener('click', () => {
            state.googleApiKey = input.value.trim();
            localStorage.setItem('onibus_mc_gkey', state.googleApiKey);
            modal.style.display = 'none';
            showToast(state.googleApiKey ? 'Chave da API do Google salva.' : 'Chave removida (usando busca gratuita padrão).');
        });
    }

    function initServiceWorkerAndPwa() {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register(`${API_BASE}sw.js`).catch(() => {});
        }

        let deferredPrompt = null;
        const btnInstall = document.getElementById('btnInstallPwa');

        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            deferredPrompt = e;
            btnInstall.style.display = 'inline-block';
        });

        btnInstall.addEventListener('click', async () => {
            if (!deferredPrompt) return;
            deferredPrompt.prompt();
            await deferredPrompt.userChoice;
            deferredPrompt = null;
            btnInstall.style.display = 'none';
        });
    }

    /* =========================================================================
       UTILITÁRIOS
       ========================================================================= */
    function formatTitleCase(str) {
        if (!str) return '';
        const lowerWords = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'via', 'para', 'a']);
        return String(str)
            .toLowerCase()
            .split(' ')
            .map((w, i) => {
                if (w === 'ii' || w === 'iii' || w === 'iv' || w === 'xxiii' || w === 'xii') {
                    return w.toUpperCase();
                }
                if (i > 0 && lowerWords.has(w)) return w;
                return w.charAt(0).toUpperCase() + w.slice(1);
            })
            .join(' ');
    }

    function showToast(message, isAlert = false) {
        const container = document.getElementById('toastContainer');
        const el = document.createElement('div');
        el.className = `toast ${isAlert ? 'toast--alert' : ''}`;
        el.textContent = message;
        container.appendChild(el);
        setTimeout(() => {
            el.style.opacity = '0';
            setTimeout(() => el.remove(), 250);
        }, isAlert ? 6000 : 3200);
    }

    function escapeHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
})();
