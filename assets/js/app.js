/**
 * Ônibus Montes Claros — Frontend Minimalista
 */
(function () {
    'use strict';

    const CONFIG = window.ONIBUS_MC_CONFIG || { baseUrl: '/', initialLines: [] };
    const API_BASE = CONFIG.baseUrl.replace(/\/?$/, '/');

    const state = {
        lines: CONFIG.initialLines || [],
        favorites: JSON.parse(localStorage.getItem('onibus_mc_favs') || '["5801", "1501", "2601", "5901"]'),
        googleApiKey: localStorage.getItem('onibus_mc_gkey') || '',
        darkMode: localStorage.getItem('onibus_mc_dark') === '1',
        onlyFavs: false,
        searchQuery: '',
        activeCode: '5801',
        activeVariant: 'normal',
        activeDir: 'ida',
        viewMode: 'line', // 'line' (Modo Seleção de Linha) | 'route' (Modo Definição de Rota)
        activeRoutePlan: null,
        schedViewCode: '5801',
        schedViewDir: 'ida',
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
        initSmartInitialLine();

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
        const iconEl = document.getElementById('iconDarkMode');
        const textEl = document.getElementById('textDarkMode');
        const applyDark = (isDark) => {
            document.body.classList.toggle('dark-mode', isDark);
            if (iconEl) {
                iconEl.className = isDark ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
            }
            if (textEl) {
                textEl.textContent = isDark ? 'Modo claro' : 'Modo escuro';
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

    function getLineDisplayCode(code, variantKey = null) {
        if (!code) return '';
        const bundle = state.lineCache[code];
        const vKey = variantKey || (code === state.activeCode ? state.activeVariant : 'normal');
        if (bundle?.line?.variants_data?.[vKey]?.display_code) {
            return bundle.line.variants_data[vKey].display_code;
        }
        if (bundle?.line?.display_code) {
            return bundle.line.display_code;
        }
        const found = state.lines.find((l) => String(l.code) === String(code));
        return found?.display_code || String(code);
    }

    function getActiveLineViewData(code = state.activeCode, variantKey = state.activeVariant) {
        const bundle = state.lineCache[code];
        if (!bundle) return null;
        const line = bundle.line || {};
        const vData = line.variants_data?.[variantKey];
        if (vData) {
            return {
                display_code: vData.display_code || line.display_code || code,
                name: vData.name || line.name || '',
                stops: vData.stops || line.stops || { ida: [], volta: [] },
                shapes: vData.shapes || bundle.shapes || { ida: { coordinates: [] }, volta: { coordinates: [] } },
                schedule: vData.schedule || line.schedule || {},
                fullStops: line.full_stops || line.stops || { ida: [], volta: [] },
                fullShapes: bundle.full_shapes || line.full_shapes || bundle.shapes || { ida: { coordinates: [] }, volta: { coordinates: [] } }
            };
        }
        return {
            display_code: line.display_code || code,
            name: line.name || '',
            stops: line.stops || { ida: [], volta: [] },
            shapes: bundle.shapes || { ida: { coordinates: [] }, volta: { coordinates: [] } },
            schedule: line.schedule || {},
            fullStops: line.full_stops || line.stops || { ida: [], volta: [] },
            fullShapes: bundle.full_shapes || bundle.shapes || { ida: { coordinates: [] }, volta: { coordinates: [] } }
        };
    }

    /**
     * Estado Inicial Inteligente do Mapa (Módulo 3):
     * - Com GPS Desativado: seleciona uma linha tronco popular de alta demanda para o horário e dia da semana atuais (relógio do sistema)
     * - Com GPS Ativo: identifica a localização do usuário, encontra a parada mais próxima e renderiza a linha mais comum/utilizada que passa naquele ponto
     */
    function pickPopularLineForCurrentTime() {
        const now = new Date();
        const day = now.getDay(); // 0 = Dom, 6 = Sáb
        const hour = now.getHours();
        const dayKey = day === 0 ? 'sundays' : (day === 6 ? 'saturdays' : 'weekdays');

        // Linhas tronco de alta demanda por faixa de horário no relógio do sistema
        let rankedTrunk = ['5801', '1501', '2601', '5901', '7101', '5101', '1702'];
        if (hour >= 6 && hour <= 9) {
            rankedTrunk = ['5801', '1501', '5901', '2601', '7101'];
        } else if (hour >= 11 && hour <= 14) {
            rankedTrunk = ['1501', '5801', '2601', '5101', '5901'];
        } else if (hour >= 17 && hour <= 20) {
            rankedTrunk = ['2601', '5801', '1501', '5901', '4701'];
        }

        for (const c of rankedTrunk) {
            const lineMeta = state.lines.find((l) => String(l.code) === c);
            if (!lineMeta) continue;
            if (!lineMeta.operates_days || lineMeta.operates_days[dayKey] !== false) {
                return c;
            }
        }
        return state.lines[0]?.code || '5801';
    }

    function pickBestLineFromStopLines(stopLines) {
        if (!Array.isArray(stopLines) || stopLines.length === 0) {
            return pickPopularLineForCurrentTime();
        }
        const now = new Date();
        const day = now.getDay();
        const dayKey = day === 0 ? 'sundays' : (day === 6 ? 'saturdays' : 'weekdays');
        const popularityWeights = {
            '5801': 100,
            '1501': 96,
            '2601': 94,
            '5901': 92,
            '7101': 90,
            '5101': 88,
            '1702': 86,
            '4701': 84,
            '2201': 82,
            '1102': 80
        };

        let bestCode = stopLines[0];
        let bestScore = -1;
        stopLines.forEach((rawCode) => {
            const code = String(rawCode).split('-')[0];
            const meta = state.lines.find((l) => String(l.code) === code);
            const operates = meta?.operates_days ? meta.operates_days[dayKey] !== false : true;
            const stopsSum = (meta?.stops_count?.ida || 25) + (meta?.stops_count?.volta || 25);
            const popBonus = popularityWeights[code] || 50;
            const score = (operates ? 1000 : 0) + popBonus + stopsSum * 0.4;
            if (score > bestScore) {
                bestScore = score;
                bestCode = code;
            }
        });
        return bestCode;
    }

    async function initSmartInitialLine() {
        const fallbackCode = pickPopularLineForCurrentTime();
        state.activeCode = fallbackCode;
        state.schedViewCode = fallbackCode;

        // Renderiza imediatamente a linha popular de alta demanda para que o mapa nunca inicie vazio
        await selectLine(fallbackCode, 'ida', true, 'normal');

        // Tenta detectar GPS ativo para ajustar automaticamente para a parada mais próxima e linha mais comum daquele ponto
        if (!navigator.geolocation) return;

        navigator.geolocation.getCurrentPosition(
            async (pos) => {
                const lat = Number(pos.coords.latitude.toFixed(6));
                const lng = Number(pos.coords.longitude.toFixed(6));
                updateUserLocationMarker(lat, lng, false);
                ensureGpsWatch();

                try {
                    const res = await fetch(`${API_BASE}api/nearby-stops?lat=${lat}&lng=${lng}`);
                    const json = await res.json();
                    if (json && json.ok && Array.isArray(json.nearest_stops) && json.nearest_stops.length > 0) {
                        const nearestStop = json.nearest_stops[0];
                        const chosenLine = pickBestLineFromStopLines(nearestStop.lines || []);
                        // Só substitui se o usuário ainda não tiver definido uma rota manualmente
                        if (state.viewMode === 'line') {
                            await selectLine(chosenLine, 'ida', true, 'normal');
                            window.__selectBoardingStop(nearestStop.stop_id, 'ida');
                            showToast(
                                `GPS ativo: exibindo linha ${chosenLine} na parada mais próxima (${nearestStop.address}).`
                            );
                        }
                    }
                } catch (e) {}
            },
            () => {
                // Com GPS desativado/negado, mantém a linha popular de alta demanda já renderizada pelo relógio do sistema
            },
            { enableHighAccuracy: true, timeout: 4500, maximumAge: 15000 }
        );
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
        const clockText = document.getElementById('mcClockText');
        if (clockText && !ctx.is_custom) {
            clockText.textContent = `${ctx.time} · ${ctx.day_type_short}`;
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
       1. MAPA E CAMADAS (GOOGLE MAPS STREETS / SATÉLITE)
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
            setMobileMapView(false);
            showToast(`Local de ${mode === 'origin' ? 'partida' : 'destino'} definido no mapa.`);
        });

        document.getElementById('btnMyLocation').addEventListener('click', () => {
            setMobileMapView(true);
            locateUserOnMap(true);
            ensureGpsWatch();
        });

        const mapDirBtn = document.getElementById('mapDirectionIndicator');
        if (mapDirBtn) {
            mapDirBtn.addEventListener('click', () => {
                const nextDir = state.activeDir === 'volta' ? 'ida' : 'volta';
                setDirection(nextDir);
            });
        }
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

        if (state.viewMode === 'route' && state.activeRoutePlan) {
            evaluateDynamicRouteProgressOnGps(lat, lng);
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
       2. NAVEGAÇÃO MOBILE (SIDEBAR RETRÁTIL) E CATÁLOGO DE LINHAS
       ========================================================================= */
    function initTabs() {
        const btnMobileMenu = document.getElementById('btnMobileMenu');
        const backdrop = document.getElementById('mobileDrawerBackdrop');
        const btnMobileToggleMap = document.getElementById('btnMobileToggleMap');
        const btnViewLineOnMapMobile = document.getElementById('btnViewLineOnMapMobile');

        // Abrir/fechar sidebar mobile APENAS pelo botão hambúrguer (fa-bars) ou clicando fora (backdrop)
        if (btnMobileMenu) {
            btnMobileMenu.addEventListener('click', (e) => {
                e.stopPropagation();
                const isOpen = document.body.classList.toggle('mobile-drawer-open');
                btnMobileMenu.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
            });
        }

        if (backdrop) {
            backdrop.addEventListener('click', () => {
                document.body.classList.remove('mobile-drawer-open');
                if (btnMobileMenu) btnMobileMenu.setAttribute('aria-expanded', 'false');
            });
        }

        // Ao clicar em uma opção do menu, o conteúdo assume a tela principal inteira,
        // mas a sidebar NÃO fecha automaticamente
        const sidebarNav = document.getElementById('mobileSidebarNav');
        if (sidebarNav) {
            sidebarNav.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        }

        document.querySelectorAll('.tab-link').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                switchTab(btn.dataset.tab);
            });
        });

        if (btnMobileToggleMap) {
            btnMobileToggleMap.addEventListener('click', () => {
                const showingMap = document.body.classList.contains('mobile-show-map');
                setMobileMapView(!showingMap);
            });
        }

        if (btnViewLineOnMapMobile) {
            btnViewLineOnMapMobile.addEventListener('click', () => {
                setMobileMapView(true);
            });
        }
    }

    function setMobileMapView(showMap) {
        document.body.classList.toggle('mobile-show-map', Boolean(showMap));
        const btnText = document.getElementById('btnMobileToggleMapText');
        if (btnText) {
            btnText.textContent = showMap ? 'Painel' : 'Mapa';
        }
        if (showMap && map) {
            setTimeout(() => {
                map.invalidateSize();
            }, 60);
        }
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
        // No mobile, ao selecionar qualquer opção do menu, a tela principal inteira passa a exibir o conteúdo daquela opção
        setMobileMapView(false);
    }

    function initCatalogEvents() {
        document.getElementById('lineSearchInput').addEventListener('input', (e) => {
            state.searchQuery = e.target.value.trim().toLowerCase();
            renderLinesList();
        });

        const btnFilterFavs = document.getElementById('btnFilterFavs');
        const iconFilterFavs = document.getElementById('iconFilterFavs');
        btnFilterFavs.addEventListener('click', () => {
            state.onlyFavs = !state.onlyFavs;
            btnFilterFavs.classList.toggle('active', state.onlyFavs);
            if (iconFilterFavs) {
                iconFilterFavs.className = state.onlyFavs ? 'fa-solid fa-star' : 'fa-regular fa-star';
            }
            renderLinesList();
        });

        document.getElementById('btnToggleFavCurrent').addEventListener('click', () => {
            toggleFavorite(state.activeCode);
        });

        const selectLineVariant = document.getElementById('selectLineVariant');
        if (selectLineVariant) {
            selectLineVariant.addEventListener('change', (e) => {
                const newVar = e.target.value === 'variant' ? 'variant' : 'normal';
                state.activeVariant = newVar;
                state.viewMode = 'line';
                state.activeRoutePlan = null;
                if (layerPlanner) layerPlanner.clearLayers();

                const viewData = getActiveLineViewData(state.activeCode, state.activeVariant);
                if (viewData) {
                    document.getElementById('activeLineCode').textContent = viewData.display_code;
                    document.getElementById('activeLineName').textContent = formatTitleCase(viewData.name);
                }

                updateDirectionButtonsUI();
                renderRouteShapesOnMap(true);
                renderStopsOnMap();
                populateAlertStopsSelect();
                if (state.schedViewCode === state.activeCode) {
                    renderScheduleTab();
                }
                showToast(
                    newVar === 'variant'
                        ? `Exibindo sub-rota: ${viewData?.display_code || state.activeCode}`
                        : `Exibindo rota principal: ${state.activeCode}`
                );
            });
        }

        ['btnDirIda', 'btnDirVolta'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('click', (e) => {
                    setDirection(e.currentTarget.dataset.dir);
                });
            }
        });

        const toggleDirTopbar = document.getElementById('toggleDirTopbar');
        if (toggleDirTopbar) {
            toggleDirTopbar.addEventListener('change', (e) => {
                const newDir = e.target.checked ? 'volta' : 'ida';
                setDirection(newDir);
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
        if (!btn) return;
        btn.innerHTML = isFav
            ? '<i class="fa-solid fa-bookmark"></i> Salva'
            : '<i class="fa-regular fa-bookmark"></i> Favoritar';
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
            const hay = `${item.code} ${item.display_code || ''} ${item.name} ${item.variant_label || ''} ${(item.neighborhoods || []).join(' ')}`.toLowerCase();
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
                const hasSubBadge = item.has_sub_routes
                    ? `<span style="color:var(--primary);font-weight:600;"><i class="fa-solid fa-code-branch"></i> Sub-rota</span> · `
                    : '';
                return `
                <div class="line-row ${isActive ? 'active' : ''}" data-code="${escapeHtml(item.code)}">
                    <div class="line-row__left">
                        <span class="line-row__code">${escapeHtml(displayCode)}</span>
                        <div style="min-width:0;">
                            <div class="line-row__name">${escapeHtml(formatTitleCase(item.name))}</div>
                            <div class="line-row__sub">
                                ${!operatesToday ? '<span style="color:#b91c1c;font-weight:500;"><i class="fa-solid fa-circle-exclamation"></i> Não opera hoje</span> · ' : ''}
                                ${hasSubBadge}${bairrosPreview ? escapeHtml(bairrosPreview) : 'Ida e volta'}
                            </div>
                        </div>
                    </div>
                    ${isFav ? `<span class="fav-indicator"><i class="fa-solid fa-star"></i> Salva</span>` : ''}
                </div>`;
            })
            .join('');

        container.querySelectorAll('.line-row').forEach((row) => {
            row.addEventListener('click', () => {
                // Padrão Inicial: A opção "Ida" vem selecionada por padrão sempre que uma linha for aberta
                selectLine(row.dataset.code, 'ida', true, 'normal', false);
            });
        });
    }

    /* =========================================================================
       3. LINHA ATIVA, SUB-ROTAS, TRAÇADOS E PARADAS (SÓ IDA / SÓ VOLTA)
       ========================================================================= */
    async function selectLine(code, dir = 'ida', fitBounds = true, variantKey = 'normal', preserveRouteMode = false) {
        const rawCode = String(code).toUpperCase();
        const baseCode = rawCode.includes('-') ? rawCode.split('-')[0] : rawCode;
        state.activeCode = baseCode;
        state.activeVariant = rawCode.includes('-') ? 'variant' : (variantKey === 'variant' ? 'variant' : 'normal');
        // Padrão estrito: apenas 'ida' ou 'volta', sendo 'ida' o padrão inicial
        state.activeDir = dir === 'volta' ? 'volta' : 'ida';

        if (!preserveRouteMode) {
            state.viewMode = 'line';
            state.activeRoutePlan = null;
            if (layerPlanner) layerPlanner.clearLayers();
        }

        state.schedViewCode = state.activeCode;
        state.schedViewDir = state.activeDir;

        document.getElementById('activeLineCode').textContent = getLineDisplayCode(state.activeCode, state.activeVariant);
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
                bundle = {
                    line: json.line,
                    shapes: json.shapes,
                    full_shapes: json.full_shapes || json.shapes
                };
                state.lineCache[state.activeCode] = bundle;
            }

            const line = bundle.line;
            const variantBox = document.getElementById('lineVariantSelectorBox');
            const variantSelect = document.getElementById('selectLineVariant');
            if (variantBox && variantSelect) {
                if (line.has_sub_routes && Array.isArray(line.sub_routes) && line.sub_routes.length > 0) {
                    variantBox.style.display = 'block';
                    variantSelect.innerHTML = line.sub_routes
                        .map((sr) => `<option value="${escapeHtml(sr.key)}">${escapeHtml(sr.label)}</option>`)
                        .join('');
                    variantSelect.value = state.activeVariant;
                } else {
                    variantBox.style.display = 'none';
                    state.activeVariant = 'normal';
                }
            }

            const viewData = getActiveLineViewData(state.activeCode, state.activeVariant);
            document.getElementById('activeLineCode').textContent = viewData?.display_code || getLineDisplayCode(state.activeCode);
            document.getElementById('activeLineName').textContent = formatTitleCase(viewData?.name || line.name);

            const idaShort = (line.ida_label || 'Ida').replace(/^Sentido\s+/i, '');
            const voltaShort = (line.volta_label || 'Volta').replace(/^Sentido\s+/i, '');
            document.getElementById('labelDirIda').textContent = idaShort;
            document.getElementById('labelDirVolta').textContent = voltaShort;

            const btnStopsIda = document.getElementById('schedBtnStopsIda');
            const btnStopsVolta = document.getElementById('schedBtnStopsVolta');
            if (btnStopsIda) btnStopsIda.innerHTML = `<i class="fa-solid fa-arrow-right"></i> Ida (${escapeHtml(idaShort)})`;
            if (btnStopsVolta) btnStopsVolta.innerHTML = `<i class="fa-solid fa-arrow-left"></i> Volta (${escapeHtml(voltaShort)})`;

            updateDirectionButtonsUI();
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
        state.activeDir = dir === 'volta' ? 'volta' : 'ida';
        state.viewMode = 'line';
        state.activeRoutePlan = null;
        if (layerPlanner) layerPlanner.clearLayers();

        updateDirectionButtonsUI();
        renderRouteShapesOnMap(false);
        renderStopsOnMap();
        populateAlertStopsSelect();
        if (state.schedViewCode === state.activeCode) {
            state.schedViewDir = state.activeDir;
            renderScheduleTab();
        }
        if (state.userLocation) {
            fetchAndRenderNearbyStops(state.userLocation.lat, state.userLocation.lng, false);
        }
        fetchVehiclesForActiveLine();
        showToast(
            state.activeDir === 'volta'
                ? 'Visualizando: Trajeto de Volta'
                : 'Visualizando: Trajeto de Ida'
        );
    }

    function updateDirectionButtonsUI() {
        const isVolta = state.activeDir === 'volta';
        const stopDir = isVolta ? 'volta' : 'ida';

        document.querySelectorAll('#activeLineCard .seg-btn').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.dir === stopDir);
        });
        document.querySelectorAll('.sched-dir-pill').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.dir === (state.schedViewDir || stopDir));
        });

        const toggleDirTopbar = document.getElementById('toggleDirTopbar');
        const topbarDirLabel = document.getElementById('topbarDirToggleLabel');
        if (toggleDirTopbar) {
            toggleDirTopbar.checked = isVolta;
        }
        if (topbarDirLabel) {
            topbarDirLabel.textContent = isVolta ? 'Só Volta' : 'Só Ida';
        }

        const bundle = state.lineCache[state.activeCode];
        const line = bundle?.line;
        const viewData = getActiveLineViewData(state.activeCode, state.activeVariant);
        const dispCode = viewData?.display_code || state.activeCode;
        const dirShort = line
            ? ((isVolta ? line.volta_label : line.ida_label) || (isVolta ? 'Volta' : 'Ida')).replace(/^Sentido\s+/i, '')
            : (isVolta ? 'Sentido Volta' : 'Sentido Ida');

        const banner = document.getElementById('directionStatusBanner');
        const bannerIcon = document.getElementById('directionBannerIcon');
        const bannerTitle = document.getElementById('directionBannerTitle');
        const bannerSub = document.getElementById('directionBannerSub');

        if (banner) {
            banner.className = `direction-banner ${isVolta ? 'direction-banner--volta' : 'direction-banner--ida'}`;
        }
        if (bannerIcon) {
            bannerIcon.className = isVolta ? 'fa-solid fa-circle-arrow-left' : 'fa-solid fa-circle-arrow-right';
        }
        if (bannerTitle) {
            bannerTitle.textContent = isVolta
                ? `Visualizando: Trajeto de Volta (${dispCode})`
                : `Visualizando: Trajeto de Ida (${dispCode})`;
        }
        if (bannerSub) {
            bannerSub.textContent = state.viewMode === 'route'
                ? `Modo Rota Ativo · Sentido: ${dirShort}`
                : `Sentido ativo: ${dirShort}`;
        }

        const mapPill = document.getElementById('mapDirectionIndicator');
        const mapPillIcon = document.getElementById('mapDirIndicatorIcon');
        const mapPillText = document.getElementById('mapDirIndicatorText');
        if (mapPill) {
            mapPill.className = `map-direction-pill ${isVolta ? 'direction-banner--volta map-direction-pill--volta' : 'map-direction-pill--ida'}`;
        }
        if (mapPillIcon) {
            mapPillIcon.className = isVolta ? 'fa-solid fa-circle-arrow-left' : 'fa-solid fa-circle-arrow-right';
        }
        if (mapPillText) {
            mapPillText.textContent = state.viewMode === 'route'
                ? `Rota Filtrada (${dispCode}) · ${ isVolta ? 'Volta' : 'Ida' }`
                : (isVolta ? `Trajeto de Volta · ${dirShort}` : `Trajeto de Ida · ${dirShort}`);
        }
    }

    function renderRouteShapesOnMap(fitBounds = true) {
        if (layerPolyIda) { map.removeLayer(layerPolyIda); layerPolyIda = null; }
        if (layerPolyVolta) { map.removeLayer(layerPolyVolta); layerPolyVolta = null; }

        // No Modo "Definição de Rota" (Módulo 4), oculta o restante desnecessário da linha
        // e desenha exclusivamente: (1) Ônibus -> Embarque e (2) Embarque -> Desembarque
        if (state.viewMode === 'route' && state.activeRoutePlan) {
            renderActiveRoutePlanOnMap(fitBounds);
            return;
        }

        const viewData = getActiveLineViewData(state.activeCode, state.activeVariant);
        if (!viewData) return;

        const coordsIda = viewData.shapes?.ida?.coordinates || [];
        const coordsVolta = viewData.shapes?.volta?.coordinates || [];
        let totalDistM = 0;

        if (state.activeDir === 'ida' && coordsIda.length > 1) {
            layerPolyIda = L.polyline(coordsIda, {
                color: '#2563eb',
                weight: 4.5,
                opacity: 0.88
            }).addTo(map);
            totalDistM = Number(viewData.shapes.ida.total_distance_m || 0);
        } else if (state.activeDir === 'volta' && coordsVolta.length > 1) {
            layerPolyVolta = L.polyline(coordsVolta, {
                color: '#d97706',
                weight: 4.5,
                opacity: 0.88
            }).addTo(map);
            totalDistM = Number(viewData.shapes.volta.total_distance_m || 0);
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
        const viewData = getActiveLineViewData(state.activeCode, state.activeVariant);
        if (!viewData) return;

        const dirKey = state.activeDir === 'volta' ? 'volta' : 'ida';
        let stops = viewData.stops?.[dirKey] || [];
        const color = dirKey === 'volta' ? '#d97706' : '#2563eb';

        // No Modo "Definição de Rota", exibe apenas as paradas compreendidas entre o embarque e o desembarque
        if (state.viewMode === 'route' && state.activeRoutePlan && !state.activeRoutePlan.postAlightActive) {
            const allStops = viewData.fullStops?.[dirKey] || stops;
            const bStop = state.activeRoutePlan.currentBoardStop;
            const aStop = state.activeRoutePlan.alightStop;
            if (bStop && aStop) {
                const bIdx = allStops.findIndex((s) => String(s.stop_id) === String(bStop.stop_id));
                const aIdx = allStops.findIndex((s) => String(s.stop_id) === String(aStop.stop_id));
                if (bIdx >= 0 && aIdx >= bIdx) {
                    stops = allStops.slice(bIdx, aIdx + 1);
                }
            }
        } else if (state.viewMode === 'route' && state.activeRoutePlan?.postAlightActive) {
            // Na navegação pós-desembarque (última milha a pé), mantém apenas a parada de desembarque
            stops = state.activeRoutePlan.alightStop ? [state.activeRoutePlan.alightStop] : [];
        }

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
                        <i class="fa-solid fa-location-dot"></i> Parada ${st.seq} · ${dirKey === 'volta' ? 'Volta' : 'Ida'}
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
                            <i class="fa-solid fa-check"></i> Selecionar embarque
                        </button>
                        <button type="button" onclick="window.__guideToStopById('${st.stop_id}', '${dirKey}')"
                            style="width:100%;background:#16a34a;color:#fff;border:none;padding:6px 10px;border-radius:6px;font-weight:500;font-size:11.5px;cursor:pointer;">
                            <i class="fa-solid fa-person-walking"></i> Guiar a pé até aqui (GPS)
                        </button>
                        <button type="button" onclick="window.__setAlightingStop('${st.stop_id}', '${dirKey}')"
                            style="width:100%;background:#f3f4f6;color:#1f2937;border:1px solid #d1d5db;padding:5px 10px;border-radius:6px;font-weight:500;font-size:11.5px;cursor:pointer;">
                            <i class="fa-solid fa-bell"></i> Avisar meu desembarque aqui
                        </button>
                    </div>
                </div>
            `;
            marker.bindPopup(popupHtml);
        });
    }

    window.__selectBoardingStop = function (stopId, dirKey) {
        const viewData = getActiveLineViewData(state.activeCode, state.activeVariant);
        if (!viewData) return;
        const stops = viewData.stops?.[dirKey] || viewData.fullStops?.[dirKey] || [];
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
        const dirToFetch = state.activeDir === 'volta' ? 'volta' : 'ida';

        try {
            const res = await fetch(`${API_BASE}api/vehicles/${encodeURIComponent(code)}/${dirToFetch}`).then((r) => r.json());

            let allVehicles = [];
            let isFallbackSimulated = false;

            if (res && res.ok && Array.isArray(res.vehicles)) {
                if (res.source === 'fallback_simulated' || res.source === 'simulated') {
                    isFallbackSimulated = true;
                }
                res.vehicles.forEach((v) => {
                    allVehicles.push({ ...v, direction: res.direction || dirToFetch });
                });
            }

            state.activeVehicles = allVehicles;
            updateVehiclesOnMap(allVehicles);
            updateTelemetryUI(allVehicles, isFallbackSimulated);
            updateSelectedStopEta();
            if (state.viewMode === 'route' && state.activeRoutePlan && !state.activeRoutePlan.postAlightActive) {
                renderActiveRoutePlanOnMap(false);
            }
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
                    <i class="fa-solid fa-bus"></i>
                    <span>${escapeHtml(v.label)}</span>
                    <span style="opacity:0.85;font-weight:400;">· ${v.speedKmh} km/h</span>
                </div>
            `;

            const popupHtml = `
                <div style="font-family:Inter,sans-serif;min-width:175px;line-height:1.45;">
                    <div style="font-weight:600;font-size:13px;color:#1f2937;">
                        <i class="fa-solid fa-bus"></i> Veículo ${escapeHtml(v.label)} ${v.simulated ? '(GPS estimado)' : ''}
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
            setMobileMapView(true);
            banner.style.display = 'flex';
            text.innerHTML = mode === 'origin'
                ? '<i class="fa-solid fa-crosshairs"></i> Clique no mapa para definir o ponto de partida'
                : '<i class="fa-solid fa-location-dot"></i> Clique no mapa para definir o destino';
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
                html: `<div style="background:#15803d;color:#fff;padding:3px 8px;border-radius:99px;font-weight:600;font-size:11px;border:2px solid #fff;box-shadow:0 2px 5px rgba(0,0,0,0.25);white-space:nowrap;"><i class="fa-solid fa-circle-dot"></i> Partida</div>`,
                iconSize: [70, 22],
                iconAnchor: [35, 11]
            });
            L.marker([origin.lat, origin.lng], { icon: origIcon })
                .addTo(layerPlanner)
                .bindPopup(`<b>Partida:</b><br>${escapeHtml(origin.label)}`);
        }

        if (dest) {
            const destIcon = L.divIcon({
                className: '',
                html: `<div style="background:#b91c1c;color:#fff;padding:3px 8px;border-radius:99px;font-weight:600;font-size:11px;border:2px solid #fff;box-shadow:0 2px 5px rgba(0,0,0,0.25);white-space:nowrap;"><i class="fa-solid fa-location-dot"></i> Destino</div>`,
                iconSize: [70, 22],
                iconAnchor: [35, 11]
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

    /**
     * Recorta o traçado exato da linha entre dois pontos [lat, lng] usando Turf.js (ou fallback por índice mais próximo)
     */
    function sliceShapeBetweenPoints(coords, ptStartLatLng, ptEndLatLng) {
        if (!Array.isArray(coords) || coords.length < 2) {
            return [ptStartLatLng, ptEndLatLng];
        }
        try {
            if (typeof turf !== 'undefined') {
                const lineGeo = turf.lineString(coords.map((c) => [c[1], c[0]]));
                const startPt = turf.point([ptStartLatLng[1], ptStartLatLng[0]]);
                const endPt = turf.point([ptEndLatLng[1], ptEndLatLng[0]]);
                const sliced = turf.lineSlice(startPt, endPt, lineGeo);
                if (sliced?.geometry?.coordinates?.length > 1) {
                    return sliced.geometry.coordinates.map((c) => [c[1], c[0]]);
                }
            }
        } catch (e) {}

        // Fallback geométrico por vértice mais próximo
        let idxA = 0;
        let idxB = coords.length - 1;
        let bestDA = Infinity;
        let bestDB = Infinity;
        coords.forEach((c, i) => {
            const dA = haversineMeters(ptStartLatLng[0], ptStartLatLng[1], c[0], c[1]);
            const dB = haversineMeters(ptEndLatLng[0], ptEndLatLng[1], c[0], c[1]);
            if (dA < bestDA) { bestDA = dA; idxA = i; }
            if (dB < bestDB) { bestDB = dB; idxB = i; }
        });
        const from = Math.min(idxA, idxB);
        const to = Math.max(idxA, idxB);
        const seg = coords.slice(from, to + 1);
        return seg.length > 1 ? seg : [ptStartLatLng, ptEndLatLng];
    }

    /**
     * Renderiza no mapa EXCLUSIVAMENTE:
     * 1) O trajeto exato que o ônibus fará da sua posição atual até o ponto de embarque
     * 2) O trajeto do ponto de embarque até o ponto de desembarque proposto
     */
    function renderActiveRoutePlanOnMap(fitBounds = false) {
        if (!state.activeRoutePlan || !layerPlanner) return;
        const plan = state.activeRoutePlan;

        // Oculta o restante desnecessário da linha principal
        if (layerPolyIda) { map.removeLayer(layerPolyIda); layerPolyIda = null; }
        if (layerPolyVolta) { map.removeLayer(layerPolyVolta); layerPolyVolta = null; }
        layerPlanner.clearLayers();

        // Se já estiver na navegação pós-desembarque (Última Milha a pé), exibe apenas o destino e a parada de descida
        if (plan.postAlightActive) {
            const destIcon = L.divIcon({
                className: '',
                html: `<div style="background:#b91c1c;color:#fff;padding:3px 8px;border-radius:99px;font-weight:600;font-size:11px;border:2px solid #fff;box-shadow:0 2px 5px rgba(0,0,0,0.25);white-space:nowrap;"><i class="fa-solid fa-flag-checkered"></i> Destino Final</div>`,
                iconSize: [96, 22],
                iconAnchor: [48, 11]
            });
            L.marker([plan.dest.lat, plan.dest.lng], { icon: destIcon })
                .addTo(layerPlanner)
                .bindPopup(`<b>Endereço Final:</b><br>${escapeHtml(plan.dest.label)}`);
            return;
        }

        const viewData = getActiveLineViewData(plan.lineCode, plan.variantKey);
        const fullCoords = viewData?.fullShapes?.[plan.direction]?.coordinates
            || viewData?.shapes?.[plan.direction]?.coordinates
            || [];

        const bStop = plan.currentBoardStop;
        const aStop = plan.alightStop;
        if (!bStop || !aStop) return;

        // 1. Trajeto exato que o ônibus fará da sua posição no momento presente até o ponto de embarque
        let approachingBus = null;
        if (state.activeVehicles.length > 0 && fullCoords.length > 1) {
            const candidates = [];
            state.activeVehicles
                .filter((v) => v.direction === plan.direction)
                .forEach((v) => {
                    const app = computeBusApproachToStop(v, bStop, fullCoords);
                    if (app && !app.passed) {
                        candidates.push({ bus: v, remainingM: app.remainingM, minEta: app.minEta });
                    }
                });
            candidates.sort((a, b) => a.remainingM - b.remainingM);
            if (candidates.length > 0) {
                approachingBus = candidates[0].bus;
            } else {
                approachingBus = state.activeVehicles.find((v) => v.direction === plan.direction) || state.activeVehicles[0];
            }
        }

        const boundsPts = [
            [bStop.lat, bStop.lng],
            [aStop.lat, aStop.lng]
        ];

        if (approachingBus) {
            const busToBoardCoords = sliceShapeBetweenPoints(
                fullCoords,
                [approachingBus.latitude, approachingBus.longitude],
                [bStop.lat, bStop.lng]
            );
            L.polyline(busToBoardCoords, {
                color: '#f59e0b',
                weight: 4.5,
                opacity: 0.92,
                dashArray: '8, 6'
            })
                .addTo(layerPlanner)
                .bindPopup(
                    `<b>Trajeto do ônibus (${escapeHtml(approachingBus.label)}) até o embarque</b><br>Parada ${bStop.seq} — ${escapeHtml(bStop.address)}`
                );
            boundsPts.push([approachingBus.latitude, approachingBus.longitude]);
        }

        // 2. Trajeto exato do ponto de embarque até o ponto de desembarque proposto
        const boardToAlightCoords = sliceShapeBetweenPoints(
            fullCoords,
            [bStop.lat, bStop.lng],
            [aStop.lat, aStop.lng]
        );
        L.polyline(boardToAlightCoords, {
            color: '#2563eb',
            weight: 6,
            opacity: 0.95
        })
            .addTo(layerPlanner)
            .bindPopup(
                `<b>Trajeto no ônibus: Embarque <i class="fa-solid fa-arrow-right"></i> Desembarque</b><br>${escapeHtml(bStop.address)} <i class="fa-solid fa-arrow-right"></i> ${escapeHtml(aStop.address)}`
            );

        // Marcadores claros de Embarque e Desembarque
        const boardIcon = L.divIcon({
            className: '',
            html: `<div style="background:#15803d;color:#fff;padding:3px 9px;border-radius:99px;font-weight:600;font-size:11px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.28);white-space:nowrap;"><i class="fa-solid fa-bus"></i> Embarque (P${bStop.seq})</div>`,
            iconSize: [110, 22],
            iconAnchor: [55, 24]
        });
        L.marker([bStop.lat, bStop.lng], { icon: boardIcon })
            .addTo(layerPlanner)
            .bindPopup(`<b>Ponto de Embarque (Parada ${bStop.seq})</b><br>${escapeHtml(bStop.address)}`);

        const alightIcon = L.divIcon({
            className: '',
            html: `<div style="background:#b91c1c;color:#fff;padding:3px 9px;border-radius:99px;font-weight:600;font-size:11px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.28);white-space:nowrap;"><i class="fa-solid fa-flag-checkered"></i> Desembarque (P${aStop.seq})</div>`,
            iconSize: [124, 22],
            iconAnchor: [62, 24]
        });
        L.marker([aStop.lat, aStop.lng], { icon: alightIcon })
            .addTo(layerPlanner)
            .bindPopup(`
                <div style="font-family:Inter,sans-serif;min-width:195px;line-height:1.4;">
                    <b>Ponto de Desembarque (Parada ${aStop.seq})</b><br>
                    ${escapeHtml(aStop.address)}
                    <div style="margin-top:8px;">
                        <button type="button" onclick="window.__confirmAlightingArrival()"
                            style="width:100%;background:#16a34a;color:#fff;border:none;padding:6px 10px;border-radius:6px;font-weight:600;font-size:11.5px;cursor:pointer;">
                            <i class="fa-solid fa-person-walking"></i> Confirmar Desembarque (Última Milha)
                        </button>
                    </div>
                </div>
            `);

        if (fitBounds && boundsPts.length >= 2) {
            map.fitBounds(L.latLngBounds(boundsPts), { padding: [38, 38] });
        }
    }

    /**
     * Atualiza dinamicamente o ponto de embarque se o usuário com GPS ativo caminhar até outra parada da linha,
     * e detecta chegada ao ponto de desembarque para iniciar a Última Milha a pé
     */
    function evaluateDynamicRouteProgressOnGps(uLat, uLng) {
        const plan = state.activeRoutePlan;
        if (!plan || plan.postAlightActive) return;

        // 1. Checar se o usuário chegou ao ponto de desembarque (<= 65m)
        if (plan.alightStop) {
            const distToAlight = haversineMeters(uLat, uLng, plan.alightStop.lat, plan.alightStop.lng);
            if (distToAlight <= 65) {
                triggerPostAlightLastMile();
                return;
            }
        }

        // 2. Se o usuário estiver se movendo antes do embarque, verifica se ele se aproximou de outra parada da linha
        const viewData = getActiveLineViewData(plan.lineCode, plan.variantKey);
        const allStops = viewData?.fullStops?.[plan.direction] || viewData?.stops?.[plan.direction] || [];
        if (allStops.length < 2 || !plan.currentBoardStop || !plan.alightStop) return;

        const alightIdx = allStops.findIndex((s) => String(s.stop_id) === String(plan.alightStop.stop_id));
        const limitIdx = alightIdx > 0 ? alightIdx : allStops.length - 1;
        const currDist = haversineMeters(uLat, uLng, plan.currentBoardStop.lat, plan.currentBoardStop.lng);

        let bestStop = null;
        let bestDist = currDist;
        for (let i = 0; i < limitIdx; i++) {
            const st = allStops[i];
            const d = haversineMeters(uLat, uLng, st.lat, st.lng);
            if (d <= 150 && d + 35 < bestDist) {
                bestDist = d;
                bestStop = st;
            }
        }

        if (bestStop && String(bestStop.stop_id) !== String(plan.currentBoardStop.stop_id)) {
            plan.currentBoardStop = { ...bestStop };
            state.selectedStop = { ...bestStop, dir: plan.direction };
            renderActiveRoutePlanOnMap(false);
            renderStopsOnMap();
            showToast(`Embarque atualizado dinamicamente pelo GPS: Parada ${bestStop.seq} (${bestStop.address}).`);
        }
    }

    /**
     * Navegação Pós-Desembarque (Última Milha — Módulo 4):
     * - Condição estrita: só é ativada se o GPS do usuário estiver ativo (state.userLocation !== null).
     * - Caso o GPS esteja desativado, encerra a rota no desembarque.
     */
    window.__confirmAlightingArrival = function () {
        triggerPostAlightLastMile();
    };

    async function triggerPostAlightLastMile() {
        const plan = state.activeRoutePlan;
        if (!plan) return;

        // Condição estrita: se o GPS do usuário estiver desativado, encerra a rota no desembarque
        if (!state.userLocation) {
            state.viewMode = 'line';
            state.activeRoutePlan = null;
            if (layerPlanner) layerPlanner.clearLayers();
            if (layerWalkingGuide) layerWalkingGuide.clearLayers();
            clearAutoAlighting();
            renderRouteShapesOnMap(true);
            renderStopsOnMap();
            showToast('Desembarque confirmado. Rota encerrada no ponto de desembarque (GPS desativado).');
            return;
        }

        if (plan.postAlightActive) return;
        plan.postAlightActive = true;

        renderActiveRoutePlanOnMap(false);
        renderStopsOnMap();

        const startLat = plan.alightStop.lat;
        const startLng = plan.alightStop.lng;
        const destObj = {
            stop_id: 'DEST-FINAL',
            seq: 'Final',
            address: plan.dest.label || 'Endereço de Destino',
            neighborhood: 'Destino Final',
            lat: plan.dest.lat,
            lng: plan.dest.lng
        };

        state.walkingGuide = {
            stop: destObj,
            notifiedArrival: false
        };

        await drawWalkingRouteToStop(startLat, startLng, destObj);
        updateWalkingGuideProgress();

        const bounds = L.latLngBounds([
            [startLat, startLng],
            [plan.dest.lat, plan.dest.lng]
        ]);
        map.fitBounds(bounds, { padding: [44, 44] });
        showToast(`Desembarque confirmado! Guiando a pé até o destino final: ${destObj.address}`, true);
    }

    async function executeRouteCalculation() {
        const container = document.getElementById('routePlanResults');
        document.getElementById('originSuggestions').style.display = 'none';
        document.getElementById('destSuggestions').style.display = 'none';

        container.innerHTML = `<div style="padding:14px;text-align:center;color:#6b7280;font-size:12.5px;"><i class="fa-solid fa-spinner fa-spin"></i> Localizando endereços e validando horários das linhas...</div>`;

        const origin = await resolvePointIfNeeded('origin', 'inputOrigin');
        const dest = await resolvePointIfNeeded('dest', 'inputDest');

        if (!origin || !dest) {
            container.innerHTML = '';
            showToast('Informe o ponto de partida e o destino.');
            return;
        }

        try {
            // Obtém por padrão o horário atual do dispositivo do usuário
            const nowDevice = new Date();
            const deviceDate = `${nowDevice.getFullYear()}-${String(nowDevice.getMonth() + 1).padStart(2, '0')}-${String(nowDevice.getDate()).padStart(2, '0')}`;
            const deviceTime = `${String(nowDevice.getHours()).padStart(2, '0')}:${String(nowDevice.getMinutes()).padStart(2, '0')}`;

            const params = new URLSearchParams({
                orig_lat: origin.lat,
                orig_lng: origin.lng,
                dest_lat: dest.lat,
                dest_lng: dest.lng,
                orig_label: origin.label || '',
                dest_label: dest.label || '',
                device_date: deviceDate,
                device_time: deviceTime
            });

            // Caso o usuário tenha preenchido o campo de horário específico na interface, usa-o como prioridade
            const inputDateEl = document.getElementById('inputPlanDate');
            const inputTimeEl = document.getElementById('inputPlanTime');
            const customTimeVal = (state.planner.timeMode === 'custom' && inputTimeEl?.value)
                ? inputTimeEl.value.trim()
                : (state.planner.customTime || '');
            const customDateVal = (state.planner.timeMode === 'custom' && inputDateEl?.value)
                ? inputDateEl.value.trim()
                : (state.planner.customDate || '');

            if (customTimeVal) {
                params.set('query_time', customTimeVal);
            }
            if (customDateVal) {
                params.set('query_date', customDateVal);
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
                    <i class="fa-regular fa-clock"></i> Cálculo para <strong>${escapeHtml(tCtx.time)}</strong> (${escapeHtml(tCtx.date_br)}) · ${escapeHtml(tCtx.day_label)}
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

                                const legDisplayCode = leg.display_code || getLineDisplayCode(leg.line_code, leg.variant_key);
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
                                        <i class="fa-solid fa-map"></i> Visualizar no mapa
                                    </button>
                                    <button type="button" class="btn-primary btn-sm btn-guide-route" data-idx="${idx}">
                                        <i class="fa-solid fa-location-arrow"></i> Guiar embarque + descida
                                    </button>
                                </div>
                                <button type="button" class="btn-ghost btn-xs btn-confirm-alight-route" data-idx="${idx}" style="margin-top:4px;width:100%;">
                                    <i class="fa-solid fa-person-walking"></i> Já desembarquei — guiar a pé até o endereço final (GPS)
                                </button>
                            </div>
                        `;
                    })
                    .join('');

            const applyRouteOnMap = async (rec, activateGpsGuide = false, switchMobileView = true) => {
                const firstLeg = rec.legs[0];
                const lastLeg = rec.legs[rec.legs.length - 1];
                const bStop = firstLeg.board_stop;
                const aStop = lastLeg.alight_stop;
                const varKey = firstLeg.variant_key || 'normal';

                state.viewMode = 'route';
                state.activeRoutePlan = {
                    rec,
                    origin,
                    dest,
                    lineCode: firstLeg.line_code,
                    variantKey: varKey,
                    direction: firstLeg.direction,
                    currentBoardStop: { ...bStop },
                    alightStop: { ...aStop },
                    postAlightActive: false
                };

                await selectLine(firstLeg.line_code, firstLeg.direction, false, varKey, true);
                if (switchMobileView) {
                    setMobileMapView(true);
                }

                state.selectedStop = { ...bStop, dir: firstLeg.direction };
                document.getElementById('selectedStopBanner').style.display = 'flex';
                document.getElementById('selectedStopName').textContent = `Parada ${bStop.seq} — ${bStop.address}`;

                renderActiveRoutePlanOnMap(true);
                renderStopsOnMap();
                updateDirectionButtonsUI();

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
                        display_code: lastLeg.display_code || getLineDisplayCode(lastLeg.line_code, varKey),
                        direction: lastLeg.direction,
                        stop_id: aStop.stop_id,
                        seq: aStop.seq,
                        address: aStop.address,
                        lat: aStop.lat,
                        lng: aStop.lng,
                        dist_m: 450
                    }, true);
                }
            };

            // Renderiza automaticamente no mapa a melhor rota calculada (sem forçar troca de tela no mobile)
            await applyRouteOnMap(json.recommendations[0], false, false);

            container.querySelectorAll('.btn-apply-route').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const rec = json.recommendations[Number(btn.dataset.idx)];
                    applyRouteOnMap(rec, false, true);
                });
            });

            container.querySelectorAll('.btn-guide-route').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const rec = json.recommendations[Number(btn.dataset.idx)];
                    applyRouteOnMap(rec, true, true);
                });
            });

            container.querySelectorAll('.btn-confirm-alight-route').forEach((btn) => {
                btn.addEventListener('click', async () => {
                    const rec = json.recommendations[Number(btn.dataset.idx)];
                    await applyRouteOnMap(rec, false, true);
                    triggerPostAlightLastMile();
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
       7. QUADRO DE HORÁRIOS E PARADAS (COM PERSISTÊNCIA DO ESTADO DO MAPA)
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

            // Persistência de Estado (Módulo 3): consultar outra linha na aba "Horários"
            // atualiza apenas o painel de horários/paradas, SEM alterar ou recarregar o mapa
            schedSelect.addEventListener('change', async (e) => {
                const newCode = String(e.target.value).toUpperCase();
                state.schedViewCode = newCode;
                if (!state.lineCache[newCode]) {
                    try {
                        const res = await fetch(`${API_BASE}api/line/${encodeURIComponent(newCode)}`);
                        const json = await res.json();
                        if (json && json.ok) {
                            state.lineCache[newCode] = {
                                line: json.line,
                                shapes: json.shapes,
                                full_shapes: json.full_shapes || json.shapes
                            };
                        }
                    } catch (err) {}
                }
                renderScheduleTab();
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
                state.schedViewDir = btn.dataset.dir === 'volta' ? 'volta' : 'ida';
                document.querySelectorAll('.sched-dir-pill').forEach((b) => {
                    b.classList.toggle('active', b.dataset.dir === state.schedViewDir);
                });
                renderScheduleTab();
            });
        });
    }

    function renderScheduleTab() {
        const targetCode = state.schedViewCode || state.activeCode;
        const targetVariant = targetCode === state.activeCode ? state.activeVariant : 'normal';
        const viewData = getActiveLineViewData(targetCode, targetVariant);
        const bundle = state.lineCache[targetCode];
        if (!bundle || !viewData) return;

        const line = bundle.line || {};
        const idaShort = (line.ida_label || 'Ida').replace(/^Sentido\s+/i, '');
        const voltaShort = (line.volta_label || 'Volta').replace(/^Sentido\s+/i, '');
        const btnStopsIda = document.getElementById('schedBtnStopsIda');
        const btnStopsVolta = document.getElementById('schedBtnStopsVolta');
        if (btnStopsIda) btnStopsIda.innerHTML = `<i class="fa-solid fa-arrow-right"></i> Ida (${escapeHtml(idaShort)})`;
        if (btnStopsVolta) btnStopsVolta.innerHTML = `<i class="fa-solid fa-arrow-left"></i> Volta (${escapeHtml(voltaShort)})`;

        const sched = viewData.schedule || line.schedule || {};
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

        const dirKey = (state.schedViewDir || state.activeDir) === 'volta' ? 'volta' : 'ida';
        const stops = viewData.stops?.[dirKey] || [];

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
                if (targetCode === state.activeCode) {
                    window.__selectBoardingStop(item.dataset.stopId, item.dataset.dir);
                }
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
