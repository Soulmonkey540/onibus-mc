<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">
    <meta name="theme-color" content="#ffffff">
    <meta name="description" content="Horários, rotas e localização dos ônibus de Montes Claros.">
    <title>Ônibus Montes Claros</title>

    <link rel="manifest" href="<?= $base_url ?>manifest.webmanifest">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">

    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossorigin="" />
    <link rel="stylesheet" href="<?= $base_url ?>assets/css/app.css?v=2.5.0">
</head>
<body>
    <header class="topbar">
        <div class="topbar__left">
            <span class="brand-mark">MC</span>
            <span class="brand-title">Ônibus Montes Claros</span>
            <span id="mcClockPill" class="clock-pill" title="Horário oficial de Montes Claros (UTC-3) e calendário operacional">--:--</span>
        </div>

        <div class="topbar__right">
            <label class="switch-control" title="Alternar visualização simultânea da rota de Ida e Volta da linha no mapa">
                <input type="checkbox" id="toggleRouteBoth">
                <span class="switch-track"></span>
                <span class="switch-text">Rota Ida e Volta</span>
            </label>

            <button type="button" id="btnMyLocation" class="btn-outline btn-sm">
                Meu GPS
            </button>

            <button type="button" id="btnToggleDarkMode" class="btn-outline btn-sm" title="Alternar modo escuro">
                Modo escuro
            </button>

            <button type="button" id="btnOpenApiKeyModal" class="btn-ghost btn-sm" title="Configurar chave opcional do Google Maps">
                API Google
            </button>

            <button type="button" id="btnInstallPwa" class="btn-primary btn-sm" style="display:none;">
                Instalar
            </button>
        </div>
    </header>

    <div class="layout">
        <aside class="sidebar" id="mainSidebar">
            <nav class="tabs-nav" role="tablist" aria-label="Menu principal">
                <button type="button" class="tab-link active" data-tab="lines" role="tab" aria-selected="true">Linhas</button>
                <button type="button" class="tab-link" data-tab="planner" role="tab" aria-selected="false">Rotas</button>
                <button type="button" class="tab-link" data-tab="nearby" role="tab" aria-selected="false">Próximos</button>
                <button type="button" class="tab-link" data-tab="alerts" role="tab" aria-selected="false">
                    Alertas <span id="alertBadgeCount" class="count-pill" style="display:none;">0</span>
                </button>
                <button type="button" class="tab-link" data-tab="schedule" role="tab" aria-selected="false">Horários</button>
            </nav>

            <!-- ABA 1: LINHAS -->
            <section class="tab-panel active" id="tab-lines" role="tabpanel">
                <div class="panel-body">
                    <div class="search-row">
                        <input type="search" id="lineSearchInput" class="input-text" placeholder="Buscar linha, bairro ou rua..." autocomplete="off">
                        <button type="button" id="btnFilterFavs" class="btn-filter" title="Filtrar favoritas">Favoritas</button>
                    </div>

                    <div class="selected-line-box" id="activeLineCard">
                        <div class="selected-line-box__top">
                            <div class="selected-line-box__id">
                                <span class="code-badge" id="activeLineCode">5801</span>
                                <button type="button" id="btnToggleFavCurrent" class="btn-star" title="Salvar nos favoritos">Favoritar</button>
                            </div>
                            <span id="gpsStatusBadge" class="status-pill">Atualizando...</span>
                        </div>

                        <div id="activeLineName" class="selected-line-box__name">Vila Sion II / Vila Mauricéia</div>

                        <div class="segmented-control" role="group" aria-label="Sentido">
                            <button type="button" class="seg-btn active" data-dir="ida" id="btnDirIda">
                                <span class="dot dot--ida"></span>
                                <span id="labelDirIda">Ida</span>
                            </button>
                            <button type="button" class="seg-btn" data-dir="volta" id="btnDirVolta">
                                <span class="dot dot--volta"></span>
                                <span id="labelDirVolta">Volta</span>
                            </button>
                            <button type="button" class="seg-btn" data-dir="ambos" id="btnDirAmbos">Ambos</button>
                        </div>

                        <div class="meta-strip">
                            <span>Veículos: <strong id="telBusCount">0</strong></span>
                            <span class="meta-sep">·</span>
                            <span>Percurso: <strong id="telRouteDist">-- km</strong></span>
                            <span class="meta-sep">·</span>
                            <span>Leitura: <strong id="telLastUpdate">--</strong></span>
                        </div>

                        <div id="selectedStopBanner" class="stop-focus-box" style="display:none;">
                            <div class="stop-focus-box__content">
                                <span class="stop-focus-box__label">Ponto selecionado</span>
                                <strong id="selectedStopName" class="stop-focus-box__title">--</strong>
                                <span id="selectedStopEtaBox" class="stop-focus-box__eta">Calculando...</span>
                            </div>
                            <div class="stop-focus-box__actions">
                                <button type="button" id="btnQuickCreateAlert" class="btn-primary btn-xs">Criar alerta</button>
                                <button type="button" id="btnClearStop" class="btn-ghost btn-xs">Fechar</button>
                            </div>
                        </div>
                    </div>

                    <div class="section-caption">
                        <span>Todas as linhas (<span id="linesCountLabel"><?= count($lines_summary) ?></span>)</span>
                    </div>

                    <div id="linesListContainer" class="lines-list"></div>
                </div>
            </section>

            <!-- ABA 2: TRAÇAR ROTA (ORIGEM E DESTINO) -->
            <section class="tab-panel" id="tab-planner" role="tabpanel">
                <div class="panel-body">
                    <div class="form-card">
                        <div class="field-block">
                            <div class="field-header">
                                <label for="inputOrigin">Ponto de partida</label>
                                <div class="field-links">
                                    <button type="button" id="btnOriginGps" class="link-btn">Usar meu GPS</button>
                                    <button type="button" id="btnPickOriginMap" class="link-btn">Marcar no mapa</button>
                                </div>
                            </div>
                            <input type="text" id="inputOrigin" class="input-text" placeholder="Escola, comércio, hospital, rua ou link Google Maps..." autocomplete="off">
                            <div id="originSuggestions" class="dropdown-list" style="display:none;"></div>
                            <span id="originCoordsInfo" class="field-hint">Digite um ponto de referência ou escolha no mapa</span>
                        </div>

                        <div class="swap-divider">
                            <button type="button" id="btnSwapOriginDest" class="link-btn">Inverter partida e destino</button>
                        </div>

                        <div class="field-block">
                            <div class="field-header">
                                <label for="inputDest">Destino</label>
                                <div class="field-links">
                                    <button type="button" id="btnPickDestMap" class="link-btn">Marcar no mapa</button>
                                </div>
                            </div>
                            <input type="text" id="inputDest" class="input-text" placeholder="Ex: Colégio Marista, Shopping, Unimontes, Bretas..." autocomplete="off">
                            <div id="destSuggestions" class="dropdown-list" style="display:none;"></div>
                            <span id="destCoordsInfo" class="field-hint">Digite o nome do local ou endereço</span>
                        </div>

                        <div class="field-block">
                            <div class="field-header">
                                <label>Horário e dia da viagem</label>
                                <div class="field-links">
                                    <button type="button" id="btnTimeModeNow" class="link-btn active-mode">Usar agora (MC)</button>
                                    <button type="button" id="btnTimeModeCustom" class="link-btn">Outro dia/hora</button>
                                </div>
                            </div>
                            <div id="plannerTimeNowBar" class="time-context-bar">
                                <span id="plannerTimeNowText">Sincronizando horário oficial de Montes Claros...</span>
                            </div>
                            <div id="plannerTimeCustomRow" class="grid-2" style="display:none;">
                                <div>
                                    <input type="date" id="inputPlanDate" class="input-text" aria-label="Data da viagem">
                                </div>
                                <div>
                                    <input type="time" id="inputPlanTime" class="input-text" aria-label="Horário da viagem">
                                </div>
                            </div>
                            <span id="plannerCalendarInfo" class="field-hint">Considera dias úteis, sábados, domingos, feriados e variações de bairro</span>
                        </div>

                        <div class="presets-row">
                            <span class="presets-label">Sugestões:</span>
                            <button type="button" class="chip-btn preset-chip" data-orig-name="Colégio Marista São José" data-orig-lat="-16.7186" data-orig-lng="-43.8639" data-dest-name="Ibituruna Shopping" data-dest-lat="-16.7168" data-dest-lng="-43.8842">Marista → Ibituruna</button>
                            <button type="button" class="chip-btn preset-chip" data-orig-name="Hospital Aroldo Tourinho" data-orig-lat="-16.7145" data-orig-lng="-43.8648" data-dest-name="Montes Claros Shopping" data-dest-lat="-16.7372" data-dest-lng="-43.8705">Aroldo Tourinho → Shopping</button>
                            <button type="button" class="chip-btn preset-chip" data-orig-name="UFMG (Av. Universitária)" data-orig-lat="-16.6852" data-orig-lng="-43.8398" data-dest-name="Parque Municipal Milton Prates" data-dest-lat="-16.7524" data-dest-lng="-43.8768">UFMG → Parque Municipal</button>
                        </div>

                        <button type="button" id="btnCalculateRoute" class="btn-primary btn-full">
                            Buscar melhor linha
                        </button>
                    </div>

                    <div id="routePlanResults" class="results-stack"></div>
                </div>
            </section>

            <!-- ABA 3: GPS SECUNDÁRIO — PONTOS MAIS PRÓXIMOS E GUIA ATÉ O EMBARQUE -->
            <section class="tab-panel" id="tab-nearby" role="tabpanel">
                <div class="panel-body">
                    <div class="form-card">
                        <div class="field-header">
                            <strong>Guia GPS até o Ponto de Embarque</strong>
                            <button type="button" id="btnRefreshNearbyGps" class="link-btn">Atualizar GPS</button>
                        </div>
                        <span id="nearbyGpsStatusText" class="field-hint">
                            Localiza os pontos de ônibus mais próximos de você e traça o caminho a pé até o embarque.
                        </span>

                        <div id="walkingGuideActiveBox" class="stop-focus-box" style="display:none;">
                            <div class="stop-focus-box__content">
                                <span class="stop-focus-box__label">Guiando a pé até o embarque</span>
                                <strong id="walkingGuideStopTitle" class="stop-focus-box__title">--</strong>
                                <span id="walkingGuideMetrics" class="stop-focus-box__eta">Calculando distância...</span>
                            </div>
                            <div class="stop-focus-box__actions">
                                <button type="button" id="btnStopWalkingGuide" class="btn-ghost btn-xs">Encerrar</button>
                            </div>
                        </div>

                        <div id="nearestLineStopCard" style="display:none;"></div>

                        <button type="button" id="btnFindNearbyStops" class="btn-primary btn-full">
                            Localizar pontos próximos de mim
                        </button>
                    </div>

                    <div class="section-caption">
                        <span>Pontos mais próximos da sua localização</span>
                    </div>
                    <div id="nearbyStopsListContainer" class="stops-list">
                        <div style="padding:14px;text-align:center;color:var(--text-muted);font-size:12px;">
                            Toque em "Localizar pontos próximos de mim" para ativar o GPS secundário.
                        </div>
                    </div>
                </div>
            </section>

            <!-- ABA 4: ALERTAS (DESEMBARQUE AUTOMÁTICO POR GPS + EMBARQUE) -->
            <section class="tab-panel" id="tab-alerts" role="tabpanel">
                <div class="panel-body">
                    <!-- Alerta Automático de Desembarque por GPS -->
                    <div class="form-card">
                        <div class="field-header">
                            <strong>Alerta Automático de Desembarque (GPS)</strong>
                            <span id="autoAlightBadge" class="status-pill">Inativo</span>
                        </div>
                        <span class="field-hint">
                            Detecta o seu GPS em tempo real durante a viagem e envia uma notificação automática quando o ônibus estiver chegando perto do seu ponto de descida.
                        </span>

                        <div class="field-block">
                            <label for="alightSelectStop">Meu ponto de desembarque na linha <strong id="alightLineBadge">5801 (Ida)</strong></label>
                            <select id="alightSelectStop" class="input-select"></select>
                        </div>

                        <div class="field-block">
                            <label for="alightDistThreshold">Avisar antes do desembarque</label>
                            <select id="alightDistThreshold" class="input-select">
                                <option value="300">300 metros antes (~1 parada)</option>
                                <option value="450" selected>450 metros antes (~2 paradas)</option>
                                <option value="700">700 metros antes (~3 paradas)</option>
                            </select>
                        </div>

                        <div id="autoAlightStatusBox" class="time-context-bar" style="display:none;">
                            <span id="autoAlightStatusText">Monitorando GPS até o desembarque...</span>
                        </div>

                        <div class="grid-2">
                            <button type="button" id="btnActivateAutoAlight" class="btn-primary btn-full">
                                Ativar alerta de descida
                            </button>
                            <button type="button" id="btnClearAutoAlight" class="btn-outline btn-full">
                                Desativar
                            </button>
                        </div>
                    </div>

                    <!-- Alerta de Embarque (Ônibus vindo até o ponto) -->
                    <div class="form-card">
                        <div class="field-header">
                            <strong>Alerta de Aproximação no Embarque</strong>
                        </div>
                        <div class="field-block">
                            <label for="alertSelectStop">Ponto de embarque na linha <strong id="alertLineBadge">5801 (Ida)</strong></label>
                            <select id="alertSelectStop" class="input-select"></select>
                        </div>

                        <div class="grid-2">
                            <div class="field-block">
                                <label for="alertDistThreshold">Distância na rota</label>
                                <select id="alertDistThreshold" class="input-select">
                                    <option value="500">500 metros antes</option>
                                    <option value="1000" selected>1,0 km antes</option>
                                    <option value="1500">1,5 km antes</option>
                                    <option value="2500">2,5 km antes</option>
                                </select>
                            </div>
                            <div class="field-block">
                                <label for="alertEtaThreshold">Tempo estimado</label>
                                <select id="alertEtaThreshold" class="input-select">
                                    <option value="3">3 minutos</option>
                                    <option value="5" selected>5 minutos</option>
                                    <option value="10">10 minutos</option>
                                </select>
                            </div>
                        </div>

                        <button type="button" id="btnSaveAlert" class="btn-primary btn-full">
                            Criar alerta de embarque
                        </button>
                    </div>

                    <div class="notify-bar" id="pushPermissionCard">
                        <div class="notify-bar__text">
                            <strong>Notificações do navegador</strong>
                            <span id="pushStatusText">Permite avisar quando o ônibus estiver próximo.</span>
                        </div>
                        <div class="notify-bar__actions">
                            <button type="button" id="btnEnableNotifications" class="btn-outline btn-xs">Ativar</button>
                            <button type="button" id="btnTestNotification" class="btn-ghost btn-xs">Testar</button>
                        </div>
                    </div>

                    <div class="section-caption">
                        <span>Alertas ativos</span>
                    </div>
                    <div id="alertsListContainer" class="alerts-list"></div>
                </div>
            </section>

            <!-- ABA 4: HORÁRIOS E PARADAS -->
            <section class="tab-panel" id="tab-schedule" role="tabpanel">
                <div class="panel-body">
                    <div class="schedule-top">
                        <div class="field-block">
                            <label for="schedLineSelect">Linha selecionada</label>
                            <select id="schedLineSelect" class="input-select">
                                <?php foreach ($lines_summary as $ln): ?>
                                    <option value="<?= htmlspecialchars($ln['code']) ?>">
                                        <?= htmlspecialchars(($ln['display_code'] ?? $ln['code']) . ' — ' . $ln['name']) ?>
                                    </option>
                                <?php endforeach; ?>
                            </select>
                        </div>

                        <div class="segmented-control">
                            <button type="button" class="seg-btn subtab-btn active" data-subtab="times">Quadro de horários</button>
                            <button type="button" class="seg-btn subtab-btn" data-subtab="stops">Pontos de parada</button>
                        </div>
                    </div>

                    <div id="subtab-times">
                        <div class="day-selector">
                            <button type="button" class="day-pill active" data-day="weekdays">Dias úteis</button>
                            <button type="button" class="day-pill" data-day="saturdays">Sábados</button>
                            <button type="button" class="day-pill" data-day="sundays">Domingos</button>
                        </div>
                        <div id="scheduleTimesContainer" class="schedule-list"></div>
                    </div>

                    <div id="subtab-stops" style="display:none;">
                        <div class="day-selector" id="schedStopsDirSelector">
                            <button type="button" class="day-pill sched-dir-pill active" data-dir="ida" id="schedBtnStopsIda">Sentido Ida</button>
                            <button type="button" class="day-pill sched-dir-pill" data-dir="volta" id="schedBtnStopsVolta">Sentido Volta</button>
                        </div>
                        <div id="scheduleStopsContainer" class="stops-list"></div>
                    </div>
                </div>
            </section>
        </aside>

        <main class="map-wrapper">
            <div id="map"></div>

            <!-- Seletor de Camada do Mapa (Google Mapa / Satélite) -->
            <div class="map-style-switcher" role="group" aria-label="Estilo do mapa">
                <button type="button" class="style-btn active" data-style="gmaps">Mapa</button>
                <button type="button" class="style-btn" data-style="gsat">Satélite</button>
            </div>

            <div id="mapModeBanner" class="map-floating-prompt" style="display:none;">
                <span id="mapModeText">Clique no mapa para definir o local</span>
                <button type="button" id="btnCancelMapPick" class="btn-ghost btn-xs">Cancelar</button>
            </div>

            <div id="gpsGuideFloatingBar" class="map-floating-prompt" style="display:none;top:54px;">
                <span id="gpsGuideFloatingText">Guiando até o ponto...</span>
                <button type="button" id="btnCloseGpsGuideBar" class="btn-ghost btn-xs">Fechar</button>
            </div>

            <div class="map-legend">
                <span class="legend-entry"><i class="line-swatch line-swatch--ida"></i> Ida</span>
                <span class="legend-entry"><i class="line-swatch line-swatch--volta"></i> Volta</span>
                <span class="legend-entry"><i class="dot-swatch dot-swatch--stop"></i> Parada</span>
            </div>
        </main>
    </div>

    <!-- Modal simples para Chave Opcional do Google Maps -->
    <div id="apiKeyModal" class="modal-backdrop" style="display:none;">
        <div class="modal-card">
            <div class="modal-header">
                <h3>Integração Google Maps API</h3>
                <button type="button" id="btnCloseApiKeyModal" class="btn-ghost btn-xs">Fechar</button>
            </div>
            <div class="modal-body">
                <p class="modal-text">
                    O mapa e a busca de escolas, comércios e órgãos públicos já funcionam gratuitamente sem precisar de chave.
                    Caso você queira usar sua própria <strong>Google Places / Geocoding API Key</strong> oficial:
                </p>
                <ol class="modal-steps">
                    <li>Acesse <strong>console.cloud.google.com</strong> e crie um projeto.</li>
                    <li>No menu <strong>APIs e Serviços &gt; Biblioteca</strong>, ative <em>Maps JavaScript API</em>, <em>Places API</em> e <em>Geocoding API</em>.</li>
                    <li>Em <strong>Credenciais &gt; Criar Credenciais &gt; Chave de API</strong>, copie a chave gerada e cole abaixo.</li>
                </ol>
                <div class="field-block">
                    <label for="inputGoogleApiKey">Chave de API do Google Maps (Opcional)</label>
                    <input type="text" id="inputGoogleApiKey" class="input-text" placeholder="Ex: AIzaSyB...">
                </div>
            </div>
            <div class="modal-footer">
                <button type="button" id="btnSaveApiKey" class="btn-primary btn-sm">Salvar chave</button>
            </div>
        </div>
    </div>

    <div id="toastContainer" class="toast-stack" aria-live="polite"></div>

    <script>
        window.ONIBUS_MC_CONFIG = {
            baseUrl: <?= json_encode($base_url) ?>,
            initialLines: <?= json_encode($lines_summary, JSON_UNESCAPED_UNICODE) ?>
        };
    </script>
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin=""></script>
    <script src="https://cdn.jsdelivr.net/npm/@turf/turf@6.5.0/turf.min.js"></script>
    <script src="<?= $base_url ?>assets/js/app.js?v=2.5.0"></script>
</body>
</html>
