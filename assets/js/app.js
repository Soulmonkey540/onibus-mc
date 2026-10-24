/**
 * Ônibus Montes Claros — Frontend Minimalista
 */
(function () {
    'use strict';

    const CONFIG = window.ONIBUS_MC_CONFIG || { baseUrl: '/', initialLines: [] };
    const API_BASE = CONFIG.baseUrl.replace(/\/?$/, '/');

    const state = {
        lines: CONFIG.initialLines || [],
        favorites: JSON.parse(localStorage.getItem('onibus_mc_favs') || '["5801", "1501", "2601"]'),
        googleApiKey: localStorage.getItem('onibus_mc_gkey') || '',
        onlyFavs: false,
        searchQuery: '',
        activeCode: '5801',
        activeDir: 'ida',
        simulateGps: false,
        lineCache: {},
        activeVehicles: [],
        selectedStop: null,
        alerts: JSON.parse(localStorage.getItem('onibus_mc_alerts') || '[]'),
        firedAlertKeys: {},
        scheduleDay: 'weekdays',
        planner: {
            origin: null,
            dest: null,
            mapPickMode: null
        },
        userLocation: null,
        pollTimer: null
    };

    let map = null;
    let baseTileLayer = null;
    let layerPolyIda = null;
    let layerPolyVolta = null;
    let layerStops = null;
    let layerBuses = null;
    let layerPlanner = null;
    let userMarker = null;
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
        initMap();
        initTabs();
        initCatalogEvents();
        initPlannerEvents();
        initAlertEvents();
        initScheduleEvents();
        initApiKeyModal();
        initServiceWorkerAndPwa();

        renderLinesList();
        renderAlertsList();
        selectLine(state.activeCode, 'ida', true);

        state.pollTimer = setInterval(() => {
            if (!document.hidden) {
                fetchVehiclesForActiveLine();
            }
        }, 10000);
    });

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

    function locateUserOnMap(centerMap = true, callback = null) {
        if (!navigator.geolocation) {
            showToast('Geolocalização não suportada pelo navegador.');
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const lat = Number(pos.coords.latitude.toFixed(6));
                const lng = Number(pos.coords.longitude.toFixed(6));
                state.userLocation = { lat, lng };

                if (!userMarker) {
                    const icon = L.divIcon({
                        className: '',
                        html: `<div style="width:14px;height:14px;background:#2563eb;border:2.5px solid #fff;border-radius:50%;box-shadow:0 0 0 5px rgba(37,99,235,0.22);"></div>`,
                        iconSize: [14, 14],
                        iconAnchor: [7, 7]
                    });
                    userMarker = L.marker([lat, lng], { icon }).addTo(map).bindPopup('<b>Sua localização atual</b>');
                } else {
                    userMarker.setLatLng([lat, lng]);
                }

                if (centerMap) {
                    map.setView([lat, lng], 15);
                    userMarker.openPopup();
                }
                if (typeof callback === 'function') {
                    callback({ lat, lng });
                }
            },
            () => {
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

        document.getElementById('toggleSimulate').addEventListener('change', (e) => {
            state.simulateGps = e.target.checked;
            showToast(
                state.simulateGps
                    ? 'Simulação de veículos ativada para testes.'
                    : 'Consultando apenas dados ao vivo.'
            );
            fetchVehiclesForActiveLine();
        });

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
            const hay = `${item.code} ${item.name} ${(item.neighborhoods || []).join(' ')}`.toLowerCase();
            return hay.includes(q);
        });

        document.getElementById('linesCountLabel').textContent = filtered.length;

        if (filtered.length === 0) {
            container.innerHTML = `<div style="padding:16px;text-align:center;color:#6b7280;font-size:12.5px;">Nenhuma linha encontrada.</div>`;
            return;
        }

        container.innerHTML = filtered
            .map((item) => {
                const isFav = state.favorites.includes(item.code);
                const isActive = item.code === state.activeCode;
                const bairrosPreview = (item.neighborhoods || []).slice(0, 4).join(', ');
                return `
                <div class="line-row ${isActive ? 'active' : ''}" data-code="${item.code}">
                    <div class="line-row__left">
                        <span class="line-row__code">${item.code}</span>
                        <div style="min-width:0;">
                            <div class="line-row__name">${escapeHtml(formatTitleCase(item.name))}</div>
                            <div class="line-row__sub">${bairrosPreview ? escapeHtml(bairrosPreview) : 'Ida e volta'}</div>
                        </div>
                    </div>
                    ${isFav ? `<span class="fav-indicator">Salva</span>` : ''}
                </div>`;
            })
            .join('');

        container.querySelectorAll('.line-row').forEach((row) => {
            row.addEventListener('click', () => {
                selectLine(row.dataset.code, state.activeDir === 'volta' ? 'volta' : 'ida', true);
            });
        });
    }

    /* =========================================================================
       3. LINHA ATIVA, TRAÇADOS E PARADAS
       ========================================================================= */
    async function selectLine(code, dir = 'ida', fitBounds = true) {
        state.activeCode = String(code);
        state.activeDir = dir;

        document.getElementById('activeLineCode').textContent = state.activeCode;
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

            await fetchVehiclesForActiveLine();
        } catch (err) {
            showToast('Não foi possível carregar os dados da linha ' + state.activeCode);
        }
    }

    function setDirection(dir) {
        state.activeDir = dir;
        updateDirectionButtonsUI();
        renderRouteShapesOnMap(false);
        renderStopsOnMap();
        populateAlertStopsSelect();
        renderScheduleTab();
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
            const marker = L.circleMarker([st.lat, st.lng], {
                radius: isSelected ? 8 : 5,
                color: isSelected ? '#15803d' : color,
                weight: isSelected ? 2.5 : 2,
                fillColor: isSelected ? '#16a34a' : '#ffffff',
                fillOpacity: 1
            }).addTo(layerStops);

            const otherLines = (st.lines || []).join(', ');
            const popupHtml = `
                <div style="font-family:Inter,sans-serif;min-width:200px;line-height:1.4;">
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
                    <button type="button" onclick="window.__selectBoardingStop('${st.stop_id}', '${dirKey}')"
                        style="width:100%;background:#2563eb;color:#fff;border:none;padding:6px 10px;border-radius:6px;font-weight:500;font-size:12px;cursor:pointer;">
                        Selecionar este ponto
                    </button>
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
        const simFlag = state.simulateGps ? '1' : '0';

        try {
            const requests = dirsToFetch.map((d) =>
                fetch(`${API_BASE}api/vehicles/${encodeURIComponent(code)}/${d}?simulate=${simFlag}`).then((r) => r.json())
            );
            const responses = await Promise.all(requests);

            let allVehicles = [];
            let isSimulated = false;

            responses.forEach((res) => {
                if (res && res.ok && Array.isArray(res.vehicles)) {
                    if (res.source === 'simulated') isSimulated = true;
                    res.vehicles.forEach((v) => {
                        allVehicles.push({ ...v, direction: res.direction });
                    });
                }
            });

            state.activeVehicles = allVehicles;
            updateVehiclesOnMap(allVehicles);
            updateTelemetryUI(allVehicles, isSimulated);
            updateSelectedStopEta();
            evaluateActiveAlerts(allVehicles);
        } catch (err) {}
    }

    function updateVehiclesOnMap(vehicles) {
        const activeIds = new Set();

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
                <div style="font-family:Inter,sans-serif;min-width:170px;line-height:1.45;">
                    <div style="font-weight:600;font-size:13px;color:#1f2937;">
                        Veículo ${escapeHtml(v.label)} ${v.simulated ? '(Simulado)' : ''}
                    </div>
                    <div style="font-size:12px;color:#4b5563;margin-top:4px;">
                        Linha ${state.activeCode} (${v.direction === 'volta' ? 'Volta' : 'Ida'})<br>
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

    function updateTelemetryUI(vehicles, isSimulated) {
        const badge = document.getElementById('gpsStatusBadge');
        document.getElementById('telBusCount').textContent = vehicles.length;
        document.getElementById('telLastUpdate').textContent = new Date().toLocaleTimeString('pt-BR', {
            hour: '2-digit',
            minute: '2-digit'
        });

        if (isSimulated) {
            badge.className = 'status-pill status-pill--sim';
            badge.textContent = `Simulação (${vehicles.length})`;
        } else if (vehicles.length > 0) {
            badge.className = 'status-pill status-pill--live';
            badge.textContent = `${vehicles.length} em operação`;
        } else {
            badge.className = 'status-pill';
            badge.textContent = 'Sem sinal no momento';
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
                ? 'Sem veículos ativos agora (ative "Simular veículos" no topo para testar)'
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
                dest_lng: dest.lng
            });
            const res = await fetch(`${API_BASE}api/route-plan?${params.toString()}`);
            const json = await res.json();

            if (!json.ok || !json.recommendations || json.recommendations.length === 0) {
                container.innerHTML = `<div style="padding:12px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;font-size:12.5px;color:#4b5563;">Nenhuma linha encontrada próxima aos locais informados.</div>`;
                return;
            }

            container.innerHTML = json.recommendations
                .map((rec, idx) => {
                    const isDirect = rec.type === 'direct';
                    const tagClass = isDirect ? 'tag--direct' : 'tag--transfer';
                    const tagText = isDirect ? 'Linha direta' : 'Conexão (1 troca)';

                    const legsHtml = rec.legs
                        .map(
                            (leg) => `
                            <div class="route-step">
                                <div class="route-step__line">
                                    <span class="code-badge">${escapeHtml(leg.line_code)}</span>
                                    <span>${escapeHtml(formatTitleCase(leg.line_name))}</span>
                                </div>
                                <div class="route-step__details">
                                    Sentido: ${escapeHtml(leg.direction_label)}<br>
                                    Embarque: <strong>${escapeHtml(leg.board_stop.address)}</strong> ${leg.walk_before_m > 0 ? `(${leg.walk_before_m} m a pé)` : ''}<br>
                                    Desembarque: <strong>${escapeHtml(leg.alight_stop.address)}</strong> ${leg.walk_after_m > 0 ? `(${leg.walk_after_m} m a pé)` : ''}<br>
                                    Trecho: ${leg.stops_count} paradas · ${(leg.bus_distance_m / 1000).toFixed(1)} km (~${leg.bus_time_min} min)
                                </div>
                            </div>`
                        )
                        .join('');

                    return `
                        <div class="route-card">
                            <div class="route-card__head">
                                <span class="tag ${tagClass}">${tagText}</span>
                                <strong style="font-size:12.5px;color:#1f2937;">Aprox. ${rec.total_time_min} min</strong>
                            </div>
                            ${legsHtml}
                            <button type="button" class="btn-outline btn-sm btn-apply-route" data-idx="${idx}">
                                Visualizar no mapa
                            </button>
                        </div>
                    `;
                })
                .join('');

            container.querySelectorAll('.btn-apply-route').forEach((btn) => {
                btn.addEventListener('click', async () => {
                    const rec = json.recommendations[Number(btn.dataset.idx)];
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
                    const bounds = L.latLngBounds([
                        [origin.lat, origin.lng],
                        [bStop.lat, bStop.lng],
                        [aStop.lat, aStop.lng],
                        [dest.lat, dest.lng]
                    ]);
                    map.fitBounds(bounds, { padding: [36, 36] });
                });
            });
        } catch (err) {
            container.innerHTML = `<div style="padding:12px;color:#b91c1c;font-size:12px;">Erro ao calcular rota.</div>`;
        }
    }

    /* =========================================================================
       6. ALERTAS DE APROXIMAÇÃO
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
            showToast('Teste de alerta: Linha 5801 a 480 metros do ponto (aprox. 2 min).', true);
            triggerBrowserNotification(
                'Linha 5801 se aproximando',
                'O veículo está a 480 metros na rota (aprox. 2 a 3 min).'
            );
        });

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

            const newAlert = {
                id: 'AL-' + Date.now().toString(36).toUpperCase(),
                line_code: state.activeCode,
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
            showToast(`Alerta criado para a linha ${newAlert.line_code}.`, true);
        });
    }

    function populateAlertStopsSelect() {
        const select = document.getElementById('alertSelectStop');
        const badge = document.getElementById('alertLineBadge');
        const bundle = state.lineCache[state.activeCode];
        if (!bundle || !select) return;

        const dir = state.activeDir === 'volta' ? 'volta' : 'ida';
        badge.textContent = `${state.activeCode} (${dir === 'volta' ? 'Volta' : 'Ida'})`;
        const stops = bundle.line?.stops?.[dir] || [];

        select.innerHTML = stops
            .map((s) => `<option value="${s.stop_id}">Parada ${s.seq} — ${escapeHtml(s.address)}</option>`)
            .join('');

        if (state.selectedStop && state.selectedStop.dir === dir) {
            select.value = state.selectedStop.stop_id;
        }
    }

    function renderAlertsList() {
        const container = document.getElementById('alertsListContainer');
        const badgeCount = document.getElementById('alertBadgeCount');

        if (state.alerts.length > 0) {
            badgeCount.style.display = 'inline-block';
            badgeCount.textContent = state.alerts.length;
        } else {
            badgeCount.style.display = 'none';
        }

        if (state.alerts.length === 0) {
            container.innerHTML = `<div style="padding:14px;text-align:center;color:#6b7280;font-size:12px;">Nenhum alerta ativo.</div>`;
            return;
        }

        container.innerHTML = state.alerts
            .map(
                (al) => `
                <div class="alert-row">
                    <div style="font-size:12px;line-height:1.4;">
                        <div>
                            <span class="code-badge">${escapeHtml(al.line_code)}</span>
                            <strong style="margin-left:6px;">Parada ${al.seq} (${al.direction === 'volta' ? 'Volta' : 'Ida'})</strong>
                        </div>
                        <div style="color:#1f2937;margin-top:3px;">${escapeHtml(al.stop_address)}</div>
                        <div style="color:#6b7280;font-size:11.5px;">
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
                        const msg = `Linha ${al.line_code} (${v.label}) a ${app.remainingM} m (~${app.minEta} a ${app.maxEta} min) do ponto ${al.stop_address}.`;
                        showToast(msg, true);
                        triggerBrowserNotification(`Linha ${al.line_code} próxima`, msg);
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
        timesContainer.innerHTML = ['ida', 'volta']
            .map((dir) => {
                const block = sched[dir] || {};
                const list = block[dayKey] || [];
                const obs = block.obs || [];

                const chipsHtml =
                    list.length > 0
                        ? list
                              .map(
                                  (t) =>
                                      `<span class="time-tag ${t.special ? 'time-tag--special' : ''}" title="${t.special ? 'Atendimento específico (ver observações)' : ''}">${escapeHtml(t.time)}</span>`
                              )
                              .join('')
                        : `<div style="font-size:12px;color:#6b7280;">Sem horários cadastrados para este período.</div>`;

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
