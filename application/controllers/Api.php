<?php
defined('BASEPATH') OR exit('No direct script access allowed');

class Api extends CI_Controller {

    private $dataDir;
    private $cacheDir;

    public function __construct() {
        parent::__construct();
        $this->dataDir = FCPATH . 'assets/data';

        // Na Vercel (Serverless), o sistema de arquivos principal é somente-leitura, exceto /tmp (sys_get_temp_dir)
        $localCache = APPPATH . 'cache/gps';
        if (getenv('VERCEL') || (!is_dir($localCache) && !@mkdir($localCache, 0777, true)) || !is_writable($localCache)) {
            $this->cacheDir = rtrim(sys_get_temp_dir(), '/\\') . '/onibus_mc_cache';
        } else {
            $this->cacheDir = $localCache;
        }
        if (!is_dir($this->cacheDir)) {
            @mkdir($this->cacheDir, 0777, true);
        }
    }

    private function jsonOut($data, int $status = 200) {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store, no-cache, must-revalidate');
        echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }

    private function loadCatalog(): array {
        $file = $this->dataDir . '/catalog.json';
        if (!file_exists($file)) {
            return ['lines' => []];
        }
        return json_decode(file_get_contents($file), true) ?: ['lines' => []];
    }

    private function haversine(float $lat1, float $lon1, float $lat2, float $lon2): float {
        $R = 6371000.0;
        $dLat = deg2rad($lat2 - $lat1);
        $dLon = deg2rad($lon2 - $lon1);
        $a = sin($dLat / 2) * sin($dLat / 2) +
             cos(deg2rad($lat1)) * cos(deg2rad($lat2)) *
             sin($dLon / 2) * sin($dLon / 2);
        return 2 * $R * atan2(sqrt($a), sqrt(1 - $a));
    }

    private function bearing(float $lat1, float $lon1, float $lat2, float $lon2): int {
        $dLon = deg2rad($lon2 - $lon1);
        $lat1 = deg2rad($lat1);
        $lat2 = deg2rad($lat2);
        $y = sin($dLon) * cos($lat2);
        $x = cos($lat1) * sin($lat2) - sin($lat1) * cos($lat2) * cos($dLon);
        $brng = rad2deg(atan2($y, $x));
        return (int)round(fmod(($brng + 360.0), 360.0));
    }

    /**
     * GET /api/lines
     */
    public function lines() {
        $cat = $this->loadCatalog();
        $list = [];
        foreach (($cat['lines'] ?? []) as $code => $info) {
            $schedIda = $info['schedule']['ida'] ?? [];
            $schedVolta = $info['schedule']['volta'] ?? [];
            $list[] = [
                'code'            => (string)$info['code'],
                'name'            => $info['name'],
                'ida_label'       => $info['ida_label'] ?? 'Sentido Ida',
                'volta_label'     => $info['volta_label'] ?? 'Sentido Volta',
                'has_shape_ida'   => !empty($info['has_shape_ida']),
                'has_shape_volta' => !empty($info['has_shape_volta']),
                'neighborhoods'   => $info['neighborhoods'] ?? [],
                'operates_days'   => [
                    'weekdays'  => !empty($schedIda['weekdays']) || !empty($schedVolta['weekdays']),
                    'saturdays' => !empty($schedIda['saturdays']) || !empty($schedVolta['saturdays']),
                    'sundays'   => !empty($schedIda['sundays']) || !empty($schedVolta['sundays'])
                ],
                'stops_count'     => [
                    'ida'   => count($info['stops']['ida'] ?? []),
                    'volta' => count($info['stops']['volta'] ?? [])
                ]
            ];
        }
        $this->jsonOut([
            'ok'           => true,
            'time_context' => $this->getMontesClarosTimeContext(),
            'count'        => count($list),
            'lines'        => $list
        ]);
    }

    /**
     * GET /api/line/{code}
     */
    public function line(string $code = '') {
        $code = strtoupper(trim($code));
        $cat = $this->loadCatalog();
        if (empty($cat['lines'][$code])) {
            $this->jsonOut(['ok' => false, 'error' => 'Linha não encontrada no catálogo.'], 404);
        }

        $lineData = $cat['lines'][$code];
        $shapeIdaFile   = $this->dataDir . "/shapes/{$code}_ida.json";
        $shapeVoltaFile = $this->dataDir . "/shapes/{$code}_volta.json";

        $shapeIda   = file_exists($shapeIdaFile) ? json_decode(file_get_contents($shapeIdaFile), true) : ['coordinates' => [], 'total_distance_m' => 0];
        $shapeVolta = file_exists($shapeVoltaFile) ? json_decode(file_get_contents($shapeVoltaFile), true) : ['coordinates' => [], 'total_distance_m' => 0];

        $this->jsonOut([
            'ok'     => true,
            'line'   => $lineData,
            'shapes' => [
                'ida'   => $shapeIda,
                'volta' => $shapeVolta
            ]
        ]);
    }

    /**
     * GET /api/shape/{code}/{direction}
     */
    public function shape(string $code = '', string $direction = 'ida') {
        $code = strtoupper(trim($code));
        $direction = strtolower(trim($direction)) === 'volta' ? 'volta' : 'ida';
        $file = $this->dataDir . "/shapes/{$code}_{$direction}.json";
        if (!file_exists($file)) {
            $this->jsonOut(['ok' => false, 'error' => 'Traçado não disponível.'], 404);
        }
        $data = json_decode(file_get_contents($file), true);
        $this->jsonOut([
            'ok'               => true,
            'routeCode'        => $code,
            'direction'        => $direction,
            'coordinates'      => $data['coordinates'] ?? [],
            'total_distance_m' => $data['total_distance_m'] ?? 0
        ]);
    }

    /**
     * GET /api/vehicles/{code}/{direction}
     * Proxy + Cache de 10s + Normalização MOCBUS + Simulador Inteligente
     */
    public function vehicles(string $code = '', string $direction = 'ida') {
        $code = strtoupper(trim($code));
        $direction = strtolower(trim($direction)) === 'volta' ? 'volta' : 'ida';
        $simulate = $this->input->get('simulate') === '1';

        $cacheFile = $this->cacheDir . "/gps_{$code}_{$direction}.json";
        $cacheTtl  = 10; // 10 segundos conforme Roadmap Seção 6.1

        $rawVehicles = [];
        $sourceStatus = 'live';
        $fetchedAt = time();

        if (!$simulate) {
            if (file_exists($cacheFile) && (time() - filemtime($cacheFile) < $cacheTtl)) {
                $cached = json_decode(file_get_contents($cacheFile), true);
                if (is_array($cached)) {
                    $rawVehicles = $cached['data'] ?? [];
                    $fetchedAt   = $cached['fetched_at'] ?? time();
                    $sourceStatus = 'cache';
                }
            } else {
                $url = "https://www.mocbus.com.br/index.php/gps/obter_dados/{$code}/{$direction}?t=" . (time() * 1000);
                $ch = curl_init($url);
                curl_setopt_array($ch, [
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_FOLLOWLOCATION => true,
                    CURLOPT_TIMEOUT        => 6,
                    CURLOPT_CONNECTTIMEOUT => 4,
                    CURLOPT_SSL_VERIFYPEER => false,
                    CURLOPT_USERAGENT      => 'Mozilla/5.0 (Compatible; OnibusMC-BFF/1.0)'
                ]);
                $body = curl_exec($ch);
                $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
                curl_close($ch);

                if ($httpCode >= 200 && $httpCode < 300 && $body) {
                    $decoded = json_decode($body, true);
                    if (is_array($decoded)) {
                        $rawVehicles = $decoded;
                        @file_put_contents($cacheFile, json_encode([
                            'fetched_at' => $fetchedAt,
                            'data'       => $rawVehicles
                        ]));
                    } else {
                        $sourceStatus = 'invalid_json';
                    }
                } else {
                    $sourceStatus = 'upstream_error';
                }
            }
        }

        $normalized = [];
        foreach ($rawVehicles as $idx => $v) {
            $lat = isset($v['lat']) ? (float)$v['lat'] : (isset($v['latitude']) ? (float)$v['latitude'] : 0.0);
            $lng = isset($v['lng']) ? (float)$v['lng'] : (isset($v['longitude']) ? (float)$v['longitude'] : 0.0);
            if ($lat < -18.0 || $lat > -15.5 || $lng < -45.0 || $lng > -42.5) {
                continue;
            }
            $rawCode = $v['codigo'] ?? ('VEIC-' . ($idx + 1));
            $opaqueId = 'BUS-' . strtoupper(substr(md5($code . '_' . $rawCode), 0, 6));
            $vel = isset($v['velocidade']) ? max(0, (float)$v['velocidade']) : 0;
            $dirDeg = isset($v['direcao']) ? (int)$v['direcao'] : 0;

            $posTimeMs = isset($v['dataHora']) ? (int)$v['dataHora'] : ($fetchedAt * 1000);
            $posTimeSec = $posTimeMs > 2000000000 ? (int)round($posTimeMs / 1000) : $posTimeMs;
            $ageSeconds = max(0, time() - $posTimeSec);

            $normalized[] = [
                'id'             => $opaqueId,
                'label'          => (string)$rawCode,
                'latitude'       => round($lat, 6),
                'longitude'      => round($lng, 6),
                'speedKmh'       => round($vel, 1),
                'headingDegrees' => $dirDeg,
                'positionTime'   => gmdate('Y-m-d\TH:i:s\Z', $posTimeSec),
                'ageSeconds'     => $ageSeconds,
                'stale'          => ($ageSeconds > 90),
                'tripVariant'    => $v['trajeto'] ?? 'principal',
                'simulated'      => false
            ];
        }

        // Se o modo simulação estiver ativo (para testar alertas e ETA mesmo quando a linha está sem veículo ativo na API)
        if ($simulate) {
            $sourceStatus = 'simulated';
            $normalized = $this->generateSimulatedVehicles($code, $direction);
        }

        $this->jsonOut([
            'ok'        => true,
            'routeCode' => $code,
            'direction' => $direction,
            'source'    => $sourceStatus,
            'fetchedAt' => gmdate('Y-m-d\TH:i:s\Z', $fetchedAt),
            'stale'     => ($sourceStatus === 'upstream_error'),
            'vehicles'  => $normalized
        ]);
    }

    /**
     * Gera 2 veículos simulados movendo-se continuamente ao longo da polyline oficial da linha
     */
    private function generateSimulatedVehicles(string $code, string $direction): array {
        $shapeFile = $this->dataDir . "/shapes/{$code}_{$direction}.json";
        if (!file_exists($shapeFile)) {
            return [];
        }
        $shape = json_decode(file_get_contents($shapeFile), true);
        $coords = $shape['coordinates'] ?? [];
        $n = count($coords);
        if ($n < 3) return [];

        // Velocidade média simulada: ~26 km/h (~7.22 m/s)
        // Usamos o timestamp atual para que o ônibus avance continuamente a cada requisição
        $now = microtime(true);
        $cycleSeconds = 1500.0; // 25 minutos para completar toda a rota na simulação
        $seedOffset = crc32($code . '_' . $direction) % 600;

        $vehicles = [];
        $offsets = [0.0, 0.45]; // Dois veículos espaçados em 45% da rota

        foreach ($offsets as $i => $phaseOffset) {
            $progress = fmod((($now + $seedOffset) / $cycleSeconds) + $phaseOffset, 1.0);
            $exactIdx = $progress * ($n - 1);
            $idxA = (int)floor($exactIdx);
            $idxB = min($n - 1, $idxA + 1);
            $frac = $exactIdx - $idxA;

            $latA = $coords[$idxA][0];
            $lngA = $coords[$idxA][1];
            $latB = $coords[$idxB][0];
            $lngB = $coords[$idxB][1];

            $lat = $latA + ($latB - $latA) * $frac;
            $lng = $lngA + ($lngB - $lngA) * $frac;
            $heading = $this->bearing($latA, $lngA, $latB, $lngB);
            $speed = 24 + (($i * 5 + ((int)$now % 7)) % 10);

            $vehicles[] = [
                'id'             => sprintf('SIM-%s-%d', $code, $i + 1),
                'label'          => sprintf('SIM-%02d', $i + 1),
                'latitude'       => round($lat, 6),
                'longitude'      => round($lng, 6),
                'speedKmh'       => $speed,
                'headingDegrees' => $heading,
                'positionTime'   => gmdate('Y-m-d\TH:i:s\Z'),
                'ageSeconds'     => 2,
                'stale'          => false,
                'tripVariant'    => "Simulação Tempo Real ({$direction})",
                'simulated'      => true
            ];
        }

        return $vehicles;
    }

    /**
     * GET /api/geocode?q=...
     * Motor de Autocomplete em Tempo Real do Google Maps (s?tbm=map) + Busca Completa (search?tbm=map)
     * com filtro de relevância estrito, cache em disco e baixa latência (~200ms).
     */
    public function geocode() {
        $q = trim((string)$this->input->get('q'));
        $apiKey = trim((string)($this->input->get('gkey') ?: getenv('GOOGLE_MAPS_API_KEY') ?: ''));

        if (mb_strlen($q) < 2) {
            $this->jsonOut(['ok' => true, 'results' => []]);
        }

        $qNorm = mb_strtolower($q, 'UTF-8');

        // Cache rápido em arquivo para evitar chamadas repetidas enquanto o usuário digita/apaga
        $cacheKey  = md5($qNorm . '_' . $apiKey);
        $cacheFile = $this->cacheDir . "/geo_{$cacheKey}.json";
        if (file_exists($cacheFile) && (time() - filemtime($cacheFile) < 3600)) {
            $cached = json_decode(file_get_contents($cacheFile), true);
            if (is_array($cached)) {
                $this->jsonOut([
                    'ok'      => true,
                    'query'   => $q,
                    'cached'  => true,
                    'results' => $cached
                ]);
            }
        }

        $results = [];

        // 1. Reconhecimento imediato de coordenadas (ex: "-16.7235, -43.8636") ou links do Google Maps
        if (
            preg_match('/@(-?\d+\.\d+),(-?\d+\.\d+)/', $q, $mCoord) ||
            preg_match('/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/', $q, $mCoord) ||
            preg_match('/^\s*(-?\d+\.\d+)\s*[,;\s]\s*(-?\d+\.\d+)\s*$/', $q, $mCoord)
        ) {
            $lat = round((float)$mCoord[1], 6);
            $lng = round((float)$mCoord[2], 6);
            $placeLabel = "Coordenada ({$lat}, {$lng})";
            if (preg_match('/\/place\/([^\/\@]+)/', $q, $mPlace)) {
                $placeLabel = urldecode(str_replace('+', ' ', $mPlace[1]));
            }
            $results[] = [
                'label' => $placeLabel,
                'sub'   => "Localização exata · {$lat}, {$lng}",
                'lat'   => $lat,
                'lng'   => $lng,
                'kind'  => 'coords'
            ];
        }

        // 2. Endpoint de Autocomplete Instantâneo do Google Maps (s?tbm=map) focado no viewport de Montes Claros
        // IMPORTANTE: Não concatenamos "Montes Claros" no texto $q aqui para que palavras parciais (como "jason cae")
        // não façam o Google retornar pontos genéricos da cidade (como Hospital Clemente de Faria).
        $pbSuggest = '!2i12!4m12!1m3!1d35000!2d-43.8645!3d-16.7245!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!7i20!10b1';
        $suggestUrl = 'https://www.google.com/s?tbm=map&gs_ri=maps&suggest=p&authuser=0&hl=pt-BR&gl=br&ie=UTF-8&oe=UTF-8&pb=' . $pbSuggest . '&q=' . urlencode($q);

        $ch = curl_init($suggestUrl);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT        => 3,
            CURLOPT_CONNECTTIMEOUT => 2,
            CURLOPT_ENCODING       => '', // aceita gzip/deflate para resposta ainda mais rápida
            CURLOPT_SSL_VERIFYPEER => false,
            CURLOPT_USERAGENT      => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        ]);
        $rawSuggest = curl_exec($ch);
        curl_close($ch);

        if ($rawSuggest) {
            $firstBracket = strpos($rawSuggest, '[');
            if ($firstBracket !== false) {
                $jsonStr = substr($rawSuggest, $firstBracket);
                if (!mb_check_encoding($jsonStr, 'UTF-8')) {
                    $jsonStr = mb_convert_encoding($jsonStr, 'UTF-8', 'ISO-8859-1');
                }
                $sData = json_decode($jsonStr, true);
                $items = $sData[0][1] ?? [];
                foreach ($items as $entry) {
                    $info = $entry[22] ?? null;
                    if (!is_array($info)) continue;
                    $title  = trim((string)($info[1][0] ?? ($info[0][0] ?? '')));
                    $sub    = trim((string)($info[2][0] ?? ''));
                    $coords = $info[11] ?? null;
                    if ($title !== '' && is_array($coords) && isset($coords[2], $coords[3]) && is_numeric($coords[2]) && is_numeric($coords[3])) {
                        $lat = (float)$coords[2];
                        $lng = (float)$coords[3];
                        // Verifica se está na região de Montes Claros
                        if ($lat >= -17.15 && $lat <= -16.35 && $lng >= -44.30 && $lng <= -43.45) {
                            $results[] = [
                                'label' => $title,
                                'sub'   => $sub !== '' ? $sub : 'Montes Claros - MG',
                                'lat'   => round($lat, 6),
                                'lng'   => round($lng, 6),
                                'kind'  => 'gmaps_suggest'
                            ];
                        }
                    }
                }
            }
        }

        // 3. Fallback para busca expandida do Google Maps (search?tbm=map) APENAS se o autocomplete trouxe menos de 2 locais
        if (count($results) < 2) {
            $queryWithCity = (mb_stripos($q, 'montes claros') === false) ? ($q . ' Montes Claros MG') : $q;
            $pbSearch = '!4m12!1m3!1d55000!2d-43.8645!3d-16.7245!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!7i20!10b1';
            $searchUrl = 'https://www.google.com/search?tbm=map&authuser=0&hl=pt-BR&gl=br&pb=' . $pbSearch . '&q=' . urlencode($queryWithCity);

            $ch = curl_init($searchUrl);
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_TIMEOUT        => 3,
                CURLOPT_CONNECTTIMEOUT => 2,
                CURLOPT_ENCODING       => '',
                CURLOPT_SSL_VERIFYPEER => false,
                CURLOPT_USERAGENT      => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            ]);
            $rawGmaps = curl_exec($ch);
            curl_close($ch);

            // Extrair tokens relevantes digitados pelo usuário para impedir falso-positivo genérico da cidade
            $tokens = array_values(array_filter(
                preg_split('/\s+/u', $this->stripAccents($qNorm)),
                fn($t) => mb_strlen($t) >= 2 && !in_array($t, ['de', 'da', 'do', 'em', 'na', 'no', 'rua', 'av', 'montes', 'claros', 'mg'], true)
            ));

            if ($rawGmaps) {
                $firstBracket = strpos($rawGmaps, '[');
                if ($firstBracket !== false) {
                    $jsonStr = substr($rawGmaps, $firstBracket);
                    $gData = json_decode($jsonStr, true);
                    if (is_array($gData)) {
                        $gResults = [];
                        $walkGmaps = function ($node) use (&$walkGmaps, &$gResults) {
                            if (!is_array($node)) return;
                            if (
                                isset($node[9]) && is_array($node[9]) && count($node[9]) === 4 &&
                                $node[9][0] === null && $node[9][1] === null &&
                                is_numeric($node[9][2]) && is_numeric($node[9][3]) &&
                                isset($node[11]) && is_string($node[11])
                            ) {
                                $lat = (float)$node[9][2];
                                $lng = (float)$node[9][3];
                                if ($lat >= -17.15 && $lat <= -16.35 && $lng >= -44.30 && $lng <= -43.45) {
                                    $name      = trim($node[11]);
                                    $shortAddr = (isset($node[2]) && is_array($node[2])) ? implode(' · ', array_slice($node[2], 0, 2)) : '';
                                    $fullAddr  = (isset($node[18]) && is_string($node[18])) ? $node[18] : $shortAddr;
                                    $cat       = (isset($node[13]) && is_array($node[13]) && !empty($node[13][0])) ? $node[13][0] : 'Google Maps';
                                    if ($shortAddr === '' && $fullAddr !== '') {
                                        $shortAddr = preg_replace('/^' . preg_quote($name, '/') . '\s*-\s*/iu', '', $fullAddr);
                                    }
                                    $subParts = array_filter([$cat, $shortAddr ?: 'Montes Claros - MG']);
                                    $gResults[] = [
                                        'label' => $name,
                                        'sub'   => implode(' — ', $subParts),
                                        'lat'   => round($lat, 6),
                                        'lng'   => round($lng, 6),
                                        'kind'  => 'gmaps_place'
                                    ];
                                }
                                return;
                            }
                            foreach ($node as $child) {
                                if (is_array($child)) {
                                    $walkGmaps($child);
                                }
                            }
                        };
                        $walkGmaps($gData);

                        foreach ($gResults as $gr) {
                            // Validar se o resultado realmente bate com o que foi digitado (evita "Hospital Clemente de Faria" em buscas parciais)
                            if (!empty($tokens)) {
                                $hay = $this->stripAccents(mb_strtolower($gr['label'] . ' ' . $gr['sub'], 'UTF-8'));
                                $matchedToken = false;
                                foreach ($tokens as $tk) {
                                    if (mb_strpos($hay, $tk) !== false) {
                                        $matchedToken = true;
                                        break;
                                    }
                                }
                                if (!$matchedToken) continue;
                            }
                            $results[] = $gr;
                        }
                    }
                }
            }
        }

        // 4. Complementa com paradas de ônibus oficiais que contenham o termo exato
        $stopsFile = $this->dataDir . '/stops_index.json';
        if (file_exists($stopsFile)) {
            $stops = json_decode(file_get_contents($stopsFile), true) ?: [];
            $stopCount = 0;
            foreach ($stops as $st) {
                $haystack = mb_strtolower($st['address'] . ' ' . $st['neighborhood'], 'UTF-8');
                if (mb_strpos($haystack, $qNorm) !== false) {
                    $results[] = [
                        'label'   => $st['address'],
                        'sub'     => 'Ponto de ônibus · Bairro ' . $st['neighborhood'],
                        'lat'     => (float)$st['lat'],
                        'lng'     => (float)$st['lng'],
                        'stop_id' => $st['stop_id'],
                        'kind'    => 'stop'
                    ];
                    if (++$stopCount >= 3) break;
                }
            }
        }

        // Deduplicar mantendo a ordem de relevância
        $unique = [];
        $seen = [];
        foreach ($results as $r) {
            $key = round($r['lat'], 4) . '_' . round($r['lng'], 4);
            if (isset($seen[$key])) continue;
            $seen[$key] = true;
            $unique[] = $r;
        }

        $finalResults = array_slice($unique, 0, 10);
        if (!empty($finalResults)) {
            @file_put_contents($cacheFile, json_encode($finalResults, JSON_UNESCAPED_UNICODE));
        }

        $this->jsonOut([
            'ok'      => true,
            'query'   => $q,
            'results' => $finalResults
        ]);
    }

    private function stripAccents(string $str): string {
        $normalized = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $str);
        return $normalized !== false ? $normalized : $str;
    }

    /**
     * Calcula o domingo de Páscoa para qualquer ano (Algoritmo de Meeus/Jones/Butcher)
     */
    private function computeEasterSunday(int $year): DateTimeImmutable {
        $a = $year % 19;
        $b = intdiv($year, 100);
        $c = $year % 100;
        $d = intdiv($b, 4);
        $e = $b % 4;
        $f = intdiv($b + 8, 25);
        $g = intdiv($b - $f + 1, 3);
        $h = (19 * $a + $b - $d - $g + 15) % 30;
        $i = intdiv($c, 4);
        $k = $c % 4;
        $l = (32 + 2 * $e + 2 * $i - $h - $k) % 7;
        $m = intdiv($a + 11 * $h + 22 * $l, 451);
        $month = intdiv($h + $l - 7 * $m + 114, 31);
        $day = (($h + $l - 7 * $m + 114) % 31) + 1;

        $tz = new DateTimeZone('America/Sao_Paulo');
        return new DateTimeImmutable(sprintf('%04d-%02d-%02d 00:00:00', $year, $month, $day), $tz);
    }

    /**
     * Retorna o contexto oficial de data, hora, dia da semana e feriados de Montes Claros - MG (America/Sao_Paulo)
     */
    public function getMontesClarosTimeContext(?string $customDate = null, ?string $customTime = null): array {
        $tz = new DateTimeZone('America/Sao_Paulo');
        $now = new DateTimeImmutable('now', $tz);

        $dateStr = ($customDate && preg_match('/^\d{4}-\d{2}-\d{2}$/', trim($customDate)))
            ? trim($customDate)
            : $now->format('Y-m-d');

        $timeStr = ($customTime && preg_match('/^\d{2}:\d{2}$/', trim($customTime)))
            ? trim($customTime)
            : $now->format('H:i');

        $dt = DateTimeImmutable::createFromFormat('Y-m-d H:i', "{$dateStr} {$timeStr}", $tz) ?: $now;
        $year = (int)$dt->format('Y');
        $md   = $dt->format('m-d');

        // Feriados fixos (Nacionais + Estaduais MG + Municipais de Montes Claros)
        $fixedHolidays = [
            '01-01' => 'Confraternização Universal',
            '04-21' => 'Tiradentes',
            '05-01' => 'Dia do Trabalhador',
            '07-03' => 'Aniversário de Montes Claros (Feriado Municipal)',
            '08-15' => 'Nossa Senhora da Assunção / Festas de Agosto (Feriado Municipal)',
            '09-07' => 'Independência do Brasil',
            '10-12' => 'Nossa Senhora Aparecida',
            '11-02' => 'Finados',
            '11-15' => 'Proclamação da República',
            '11-20' => 'Dia da Consciência Negra',
            '12-25' => 'Natal'
        ];

        // Feriados móveis baseados na Páscoa
        $easter = $this->computeEasterSunday($year);
        $movableHolidays = [
            $easter->modify('-48 days')->format('m-d') => 'Segunda-feira de Carnaval',
            $easter->modify('-47 days')->format('m-d') => 'Terça-feira de Carnaval',
            $easter->modify('-2 days')->format('m-d')  => 'Sexta-feira Santa',
            $easter->modify('+60 days')->format('m-d') => 'Corpus Christi (Feriado Municipal)'
        ];

        $holidayName = $fixedHolidays[$md] ?? ($movableHolidays[$md] ?? null);
        $isHoliday   = ($holidayName !== null);

        $weekdayNum = (int)$dt->format('w'); // 0 = Domingo .. 6 = Sábado
        $weekdayNames = [
            0 => 'Domingo',
            1 => 'Segunda-feira',
            2 => 'Terça-feira',
            3 => 'Quarta-feira',
            4 => 'Quinta-feira',
            5 => 'Sexta-feira',
            6 => 'Sábado'
        ];
        $weekdayName = $weekdayNames[$weekdayNum] ?? '';

        if ($isHoliday || $weekdayNum === 0) {
            $dayType = 'sundays';
            $dayTypeShort = $isHoliday ? 'Feriado (Quadro de Domingo)' : 'Domingo';
            $dayLabel = $isHoliday
                ? "Feriado: {$holidayName} · Quadro de Domingo"
                : 'Domingo · Quadro de Domingos e Feriados';
        } elseif ($weekdayNum === 6) {
            $dayType = 'saturdays';
            $dayTypeShort = 'Sábado';
            $dayLabel = 'Sábado · Quadro de Sábados';
        } else {
            $dayType = 'weekdays';
            $dayTypeShort = 'Dia útil';
            $dayLabel = "Dia útil ({$weekdayName})";
        }

        [$hh, $mm] = array_map('intval', explode(':', $dt->format('H:i')));
        $minutesOfDay = ($hh * 60) + $mm;

        return [
            'timezone'        => 'America/Sao_Paulo',
            'city'            => 'Montes Claros - MG',
            'is_custom'       => ($customDate !== null && $customDate !== '') || ($customTime !== null && $customTime !== ''),
            'date'            => $dt->format('Y-m-d'),
            'date_br'         => $dt->format('d/m/Y'),
            'time'            => $dt->format('H:i'),
            'minutes_of_day'  => $minutesOfDay,
            'weekday_num'     => $weekdayNum,
            'weekday_name'    => $weekdayName,
            'is_holiday'      => $isHoliday,
            'holiday_name'    => $holidayName,
            'is_weekend'      => ($weekdayNum === 0 || $weekdayNum === 6),
            'day_type'        => $dayType,
            'day_type_short'  => $dayTypeShort,
            'day_label'       => $dayLabel,
            'official_now'    => $now->format('H:i'),
            'official_date'   => $now->format('Y-m-d')
        ];
    }

    /**
     * GET /api/time-context
     */
    public function time_context() {
        $customDate = $this->input->get('date');
        $customTime = $this->input->get('time');
        $this->jsonOut([
            'ok'           => true,
            'time_context' => $this->getMontesClarosTimeContext($customDate, $customTime)
        ]);
    }

    /**
     * Regras operacionais de variações de bairro por horário (vermelho / asterisco) e substituição em fins de semana/feriados
     */
    private function getLineVariantRules(string $code): array {
        $rules = [
            '2601' => [
                'red_desc'       => 'Atende a Av. Universitária / UFMG (ICA)',
                'red_keywords'   => ['universitaria', 'ufmg', 'ciencias agrarias', 'ica'],
                'ast_desc'       => 'Atende o Hospital Veterinário da Funorte',
                'ast_keywords'   => ['hospital veterinario', 'veterinario'],
                'regular_desc'   => 'Itinerário padrão (sem entrar no Hospital Veterinário / Av. Universitária)'
            ],
            '2603' => [
                'red_desc'       => 'Atende Posto Berrante, Posto da Produção e Anel Rodoviário Norte',
                'red_keywords'   => ['posto berrante', 'berrante', 'posto da producao', 'anel rodoviario'],
                'ast2_desc'      => 'Atende Jardim Primavera e Jardim Alegre (Domingos e Feriados)',
                'ast2_keywords'  => ['jardim alegre'],
                'sunday_desc'    => 'Aos domingos e feriados atende a região do Jardim Primavera',
                'regular_desc'   => 'Itinerário padrão Jaraguá II / Santo Amaro'
            ],
            '3301' => [
                'replace_saturdays' => ['line' => '3302', 'note' => 'Aos sábados a região do Jardim Primavera é atendida pela linha 3302.'],
                'replace_sundays'   => ['line' => '2603', 'note' => 'Aos domingos e feriados a região do Jardim Primavera é atendida pela linha 2603.']
            ],
            '3302' => [
                'replace_sundays'   => ['line' => '2603', 'note' => 'Aos domingos e feriados a região do Jardim Alegre é atendida pela linha 2603 (horários com **).']
            ],
            '4603' => [
                'red_desc'       => 'Atende o Condomínio Tropical (Av. São Judas Tadeu)',
                'red_keywords'   => ['condominio tropical', 'sao judas tadeu'],
                'ast_desc'       => 'Atende o Bairro Vera Cruz no itinerário antigo',
                'ast_keywords'   => ['vera cruz'],
                'regular_desc'   => 'Itinerário padrão (via Av. Cula Mangabeira)'
            ],
            '4701' => [
                'red_desc'       => 'Atende o Bairro Terra Jardins',
                'red_keywords'   => ['terra jardins'],
                'regular_desc'   => 'Itinerário padrão Acácias / Major Prates'
            ],
            '5702' => [
                'red_desc'       => 'Passa pelas Ruas João Mendes Leal, Santarém e Brasilino Durães Vasconcelos',
                'red_keywords'   => ['joao mendes leal', 'santarem', 'brasilino duraes'],
                'regular_desc'   => 'Itinerário padrão Monte Carmelo / Jardim Liberdade'
            ],
            '5801' => [
                'red_desc'       => 'Atende a região alta do Ibituruna (Serra do Mel, Portal da Serra e Vivendas do Lago)',
                'red_keywords'   => ['serra do mel', 'portal da serra', 'vivendas do lago', 'vivendas'],
                'regular_desc'   => 'Itinerário padrão (não entra em Serra do Mel / Portal da Serra / Vivendas)'
            ],
            '6901' => [
                'red_desc'       => 'Viagem inicia a partir da Praça Coronel Ribeiro (Centro)',
                'red_keywords'   => [],
                'regular_desc'   => 'Viagem completa a partir do ponto final'
            ],
            '7101' => [
                'red_desc'       => 'Extensão de itinerário para atendimento ao Reserva Real e Gran Royalle',
                'red_keywords'   => ['reserva real', 'gran royalle', 'royalle'],
                'regular_desc'   => 'Itinerário padrão Major Prates / Vila São Francisco de Assis'
            ]
        ];
        return $rules[$code] ?? [];
    }

    private function formatMinutesToHhMm(int $totalMin): string {
        $norm = (($totalMin % 1440) + 1440) % 1440;
        return sprintf('%02d:%02d', intdiv($norm, 60), $norm % 60);
    }

    /**
     * Avalia o quadro de horários de um trecho (linha + sentido) frente ao dia atual, feriado, horário e variações de bairro
     */
    private function evaluateLegSchedule(
        array $lineInfo,
        string $dir,
        array $boardStop,
        array $alightStop,
        int $walkBeforeM,
        array $timeCtx,
        string $tripSearchNorm
    ): array {
        $code     = (string)$lineInfo['code'];
        $dayType  = $timeCtx['day_type']; // 'weekdays' | 'saturdays' | 'sundays'
        $queryMin = (int)$timeCtx['minutes_of_day'];

        $schedDir = $lineInfo['schedule'][$dir] ?? [];
        $dayTimes = $schedDir[$dayType] ?? [];
        $obsList  = $schedDir['obs'] ?? [];
        $rules    = $this->getLineVariantRules($code);

        // Deslocamento estimado do terminal inicial (PF) até a parada de embarque (a ~21.6 km/h = 360 m/min)
        $boardDistM = (float)($boardStop['dist_m'] ?? 0.0);
        $offsetFromTerminalMin = max(0, (int)round($boardDistM / 360.0));
        $walkBeforeMin = max(1, (int)ceil($walkBeforeM / 75.0));

        // Horário mínimo em que o usuário consegue estar no ponto de embarque (com 2 min de tolerância)
        $earliestBoardMin = $queryMin + max(0, $walkBeforeMin - 2);

        // Verifica se a linha NÃO opera no tipo de dia atual (ex: Domingo/Feriado ou Sábado)
        if (empty($dayTimes)) {
            $replacementKey = 'replace_' . $dayType;
            $replacement = $rules[$replacementKey] ?? null;

            $operatesWeekdays  = !empty($schedDir['weekdays']);
            $operatesSaturdays = !empty($schedDir['saturdays']);

            if ($replacement) {
                $reason = $replacement['note'];
            } elseif ($dayType === 'sundays') {
                $reason = $operatesSaturdays
                    ? 'Não opera aos domingos e feriados (opera apenas de segunda a sábado).'
                    : 'Não opera aos domingos e feriados (opera apenas em dias úteis).';
            } elseif ($dayType === 'saturdays') {
                $reason = 'Não opera aos sábados (opera apenas em dias úteis).';
            } else {
                $reason = 'Sem horários cadastrados para este período.';
            }

            return [
                'operates_today'       => false,
                'service_ended_today'  => false,
                'status_code'          => 'not_operating_today',
                'status_badge'         => 'Não opera hoje',
                'status_detail'        => $reason,
                'replaced_by_line'     => $replacement['line'] ?? null,
                'offset_from_pf_min'   => $offsetFromTerminalMin,
                'next_trip'            => null,
                'next_matching_trip'   => null,
                'upcoming_trips'       => [],
                'requires_variant'     => false,
                'required_variant_desc'=> null,
                'variant_warning'      => null,
                'obs'                  => $obsList,
                'score_penalty'        => 25000.0
            ];
        }

        // Verifica se o trajeto do usuário exige uma variação específica de bairro (vermelho ou asterisco)
        $haystack = $this->stripAccents(mb_strtolower(
            $tripSearchNorm . ' ' . ($boardStop['address'] ?? '') . ' ' . ($boardStop['neighborhood'] ?? '') . ' ' .
            ($alightStop['address'] ?? '') . ' ' . ($alightStop['neighborhood'] ?? ''),
            'UTF-8'
        ));

        $requiresRed  = false;
        $requiresAst  = false;
        $requiresAst2 = false;
        $requiredVariantDesc = null;

        foreach (($rules['red_keywords'] ?? []) as $kw) {
            if ($kw !== '' && mb_strpos($haystack, $kw) !== false) {
                $requiresRed = true;
                $requiredVariantDesc = $rules['red_desc'] ?? 'Horário em destaque (vermelho)';
                break;
            }
        }
        foreach (($rules['ast_keywords'] ?? []) as $kw) {
            if ($kw !== '' && mb_strpos($haystack, $kw) !== false) {
                $requiresAst = true;
                $requiredVariantDesc = $rules['ast_desc'] ?? 'Horário com asterisco (*)';
                break;
            }
        }
        if ($dayType === 'sundays') {
            foreach (($rules['ast2_keywords'] ?? []) as $kw) {
                if ($kw !== '' && mb_strpos($haystack, $kw) !== false) {
                    $requiresAst2 = true;
                    $requiredVariantDesc = $rules['ast2_desc'] ?? 'Horário com duplo asterisco (**)';
                    break;
                }
            }
        }

        $requiresVariant = ($requiresRed || $requiresAst || $requiresAst2);

        // Processar todos os horários do dia para encontrar as próximas viagens que passam no ponto
        $upcomingTrips = [];
        $nextTrip = null;
        $nextMatchingTrip = null;

        foreach ($dayTimes as $entry) {
            $tStr = $entry['time'] ?? '';
            if (!preg_match('/^(\d{2}):(\d{2})$/', $tStr, $tm)) continue;
            $depMin = ((int)$tm[1] * 60) + (int)$tm[2];
            $estPassMin = $depMin + $offsetFromTerminalMin;

            $isRed  = !empty($entry['red']) || (!empty($entry['special']) && empty($entry['asterisk']));
            $ast    = $entry['asterisk'] ?? '';
            $isSpec = !empty($entry['special']);

            // Descrição específica desta viagem
            $tripVariantDesc = null;
            if ($ast === '**' && !empty($rules['ast2_desc'])) {
                $tripVariantDesc = $rules['ast2_desc'];
            } elseif ($ast === '*' && !empty($rules['ast_desc'])) {
                $tripVariantDesc = $rules['ast_desc'];
            } elseif ($isRed && !empty($rules['red_desc'])) {
                $tripVariantDesc = $rules['red_desc'];
            } elseif ($dayType === 'sundays' && !empty($rules['sunday_desc'])) {
                $tripVariantDesc = $rules['sunday_desc'];
            } elseif ($isSpec && !empty($obsList[0])) {
                $tripVariantDesc = $obsList[0];
            }

            $matchesRequiredVariant = true;
            if ($requiresVariant) {
                $matchesRequiredVariant = false;
                if ($requiresRed && $isRed) $matchesRequiredVariant = true;
                if ($requiresAst && ($ast === '*' || $ast === '**')) $matchesRequiredVariant = true;
                if ($requiresAst2 && $ast === '**') $matchesRequiredVariant = true;
            }

            if ($estPassMin >= $earliestBoardMin) {
                $waitMin = max(0, $estPassMin - $queryMin);
                $tripObj = [
                    'dep_time'          => $tStr,
                    'est_board_time'    => $this->formatMinutesToHhMm($estPassMin),
                    'wait_min'          => $waitMin,
                    'special'           => $isSpec,
                    'red'               => $isRed,
                    'asterisk'          => $ast,
                    'variant_desc'      => $tripVariantDesc,
                    'matches_requirement' => $matchesRequiredVariant
                ];

                if ($nextTrip === null) {
                    $nextTrip = $tripObj;
                }
                if ($matchesRequiredVariant && $nextMatchingTrip === null) {
                    $nextMatchingTrip = $tripObj;
                }
                if (count($upcomingTrips) < 4) {
                    $upcomingTrips[] = $tripObj;
                }
            }
        }

        // Se já passou o último ônibus do dia
        if ($nextTrip === null) {
            $firstMorning = $dayTimes[0]['time'] ?? '--:--';
            return [
                'operates_today'       => true,
                'service_ended_today'  => true,
                'status_code'          => 'service_ended',
                'status_badge'         => 'Encerrado neste horário',
                'status_detail'        => "Última viagem já passou para o horário consultado ({$timeCtx['time']}). Primeira saída do terminal às {$firstMorning}.",
                'replaced_by_line'     => null,
                'offset_from_pf_min'   => $offsetFromTerminalMin,
                'next_trip'            => null,
                'next_matching_trip'   => null,
                'upcoming_trips'       => [],
                'requires_variant'     => $requiresVariant,
                'required_variant_desc'=> $requiredVariantDesc,
                'variant_warning'      => null,
                'obs'                  => $obsList,
                'score_penalty'        => 12000.0
            ];
        }

        // Se o usuário precisa de uma variação de bairro específica (ex: UFMG, Serra do Mel, Reserva Real, Cond. Tropical)
        $variantWarning = null;
        if ($requiresVariant) {
            if ($nextMatchingTrip === null) {
                $variantWarning = "Atenção: não há mais horários hoje com atendimento específico para este trecho ({$requiredVariantDesc}).";
                $scorePenalty = 8500.0;
                $statusBadge  = 'Sem horário para esta variação hoje';
                $statusDetail = $variantWarning;
                $statusCode   = 'variant_unavailable_now';
            } elseif ($nextMatchingTrip['dep_time'] !== $nextTrip['dep_time']) {
                $variantWarning = "O horário das {$nextTrip['dep_time']} faz apenas o itinerário padrão. O próximo horário que atende este bairro ({$requiredVariantDesc}) sai às {$nextMatchingTrip['dep_time']} (passa no ponto ~{$nextMatchingTrip['est_board_time']}).";
                $scorePenalty = min(90, $nextMatchingTrip['wait_min']) * 16.0;
                $statusBadge  = "Próximo horário p/ bairro às {$nextMatchingTrip['dep_time']}";
                $statusDetail = "Passa no ponto de embarque ~{$nextMatchingTrip['est_board_time']} (em {$nextMatchingTrip['wait_min']} min)";
                $statusCode   = 'active_wait_variant';
            } else {
                $scorePenalty = min(60, $nextMatchingTrip['wait_min']) * 14.0;
                $statusBadge  = "Ativo · Saída {$nextMatchingTrip['dep_time']} (Atende bairro)";
                $statusDetail = "Passa no ponto ~{$nextMatchingTrip['est_board_time']} (em {$nextMatchingTrip['wait_min']} min) · {$requiredVariantDesc}";
                $statusCode   = 'active_variant_ok';
            }
        } else {
            // Viagem comum, mas se a próxima viagem tiver variação de itinerário (vermelho/asterisco), informa claramente o usuário
            $scorePenalty = min(60, $nextTrip['wait_min']) * 14.0;
            $statusCode   = 'active_normal';
            $statusBadge  = "Operando · Próxima saída {$nextTrip['dep_time']}";
            $statusDetail = "Passa no ponto de embarque ~{$nextTrip['est_board_time']} (em {$nextTrip['wait_min']} min)";
            if (!empty($nextTrip['variant_desc'])) {
                $variantWarning = "Observação do horário das {$nextTrip['dep_time']}: {$nextTrip['variant_desc']}.";
            } elseif (!empty($boardStop['virtual_replacement_note'])) {
                $variantWarning = $boardStop['virtual_replacement_note'];
            }
        }

        return [
            'operates_today'       => true,
            'service_ended_today'  => false,
            'status_code'          => $statusCode,
            'status_badge'         => $statusBadge,
            'status_detail'        => $statusDetail,
            'replaced_by_line'     => null,
            'offset_from_pf_min'   => $offsetFromTerminalMin,
            'next_trip'            => $nextTrip,
            'next_matching_trip'   => $nextMatchingTrip ?: $nextTrip,
            'upcoming_trips'       => $upcomingTrips,
            'requires_variant'     => $requiresVariant,
            'required_variant_desc'=> $requiredVariantDesc,
            'variant_warning'      => $variantWarning,
            'obs'                  => $obsList,
            'score_penalty'        => $scorePenalty
        ];
    }

    /**
     * GET|POST /api/route-plan
     * Calcula a melhor linha e pontos entre Origem e Destino considerando:
     * - Horário oficial de Montes Claros (ou data/hora simulada pelo usuário)
     * - Dia da semana e calendário de feriados (Nacionais, MG e Municipais de Montes Claros)
     * - Substituição de linhas em sábados, domingos e feriados (ex: 3301 -> 3302 no sábado e 2603 no domingo)
     * - Variações de itinerário por bairro e horário (horários em vermelho e com asterisco * / **)
     */
    public function route_plan() {
        $origLat = (float)($this->input->get_post('orig_lat') ?: 0);
        $origLng = (float)($this->input->get_post('orig_lng') ?: 0);
        $destLat = (float)($this->input->get_post('dest_lat') ?: 0);
        $destLng = (float)($this->input->get_post('dest_lng') ?: 0);

        $origLabel = trim((string)($this->input->get_post('orig_label') ?: ''));
        $destLabel = trim((string)($this->input->get_post('dest_label') ?: ''));
        $queryDate = $this->input->get_post('query_date');
        $queryTime = $this->input->get_post('query_time');

        if (!$origLat || !$origLng || !$destLat || !$destLng) {
            $this->jsonOut(['ok' => false, 'error' => 'Informe as coordenadas de origem e destino.'], 400);
        }

        $timeCtx = $this->getMontesClarosTimeContext($queryDate, $queryTime);
        $dayType = $timeCtx['day_type'];
        $tripSearchNorm = $origLabel . ' ' . $destLabel;

        $cat = $this->loadCatalog();
        $lines = $cat['lines'] ?? [];

        // Extensão automática de paradas para linhas substitutas oficiais em Sábados e Domingos/Feriados:
        // - Aos sábados, a linha 3302 atende a região da linha 3301 (Jardim Primavera)
        // - Aos domingos e feriados, a linha 2603 atende a região das linhas 3301 (Jardim Primavera) e 3302 (Jardim Alegre)
        if ($dayType === 'saturdays' && isset($lines['3302'], $lines['3301'])) {
            foreach (['ida', 'volta'] as $d) {
                $existingIds = array_column($lines['3302']['stops'][$d] ?? [], 'stop_id');
                foreach (($lines['3301']['stops'][$d] ?? []) as $st) {
                    if (!in_array($st['stop_id'], $existingIds, true)) {
                        $st['virtual_replacement_note'] = 'Atendimento de Sábado: a linha 3302 cobre a região da linha 3301 (Jardim Primavera).';
                        $lines['3302']['stops'][$d][] = $st;
                    }
                }
            }
        } elseif ($dayType === 'sundays' && isset($lines['2603'])) {
            foreach (['3301', '3302'] as $repCode) {
                if (!isset($lines[$repCode])) continue;
                foreach (['ida', 'volta'] as $d) {
                    $existingIds = array_column($lines['2603']['stops'][$d] ?? [], 'stop_id');
                    foreach (($lines[$repCode]['stops'][$d] ?? []) as $st) {
                        if (!in_array($st['stop_id'], $existingIds, true)) {
                            $st['virtual_replacement_note'] = ($repCode === '3301')
                                ? 'Atendimento de Domingo/Feriado: a linha 2603 atende a região do Jardim Primavera (substituindo a linha 3301).'
                                : 'Atendimento de Domingo/Feriado: a linha 2603 atende o Jardim Alegre nos horários com (**) (substituindo a linha 3302).';
                            $lines['2603']['stops'][$d][] = $st;
                        }
                    }
                }
            }
        }

        $maxWalkRadius = 1500.0; // Até 1.5 km de caminhada máxima se necessário
        $directOptions = [];

        // Mapa auxiliar para buscar linhas que passam próximas à Origem e linhas que chegam próximas ao Destino
        $linesFromOrigin = [];
        $linesToDest     = [];

        foreach ($lines as $code => $lineInfo) {
            foreach (['ida', 'volta'] as $dir) {
                $stops = $lineInfo['stops'][$dir] ?? [];
                if (count($stops) < 2) continue;

                $bestOrigCandidates = [];
                $bestDestCandidates = [];

                foreach ($stops as $idx => $st) {
                    $dOrig = $this->haversine($origLat, $origLng, (float)$st['lat'], (float)$st['lng']);
                    $dDest = $this->haversine($destLat, $destLng, (float)$st['lat'], (float)$st['lng']);

                    if ($dOrig <= $maxWalkRadius) {
                        $bestOrigCandidates[] = ['idx' => $idx, 'stop' => $st, 'walk_m' => $dOrig];
                    }
                    if ($dDest <= $maxWalkRadius) {
                        $bestDestCandidates[] = ['idx' => $idx, 'stop' => $st, 'walk_m' => $dDest];
                    }
                }

                usort($bestOrigCandidates, fn($a, $b) => $a['walk_m'] <=> $b['walk_m']);
                usort($bestDestCandidates, fn($a, $b) => $a['walk_m'] <=> $b['walk_m']);

                if (!empty($bestOrigCandidates)) {
                    $linesFromOrigin[] = [
                        'code'        => (string)$code,
                        'name'        => $lineInfo['name'],
                        'line_info'   => $lineInfo,
                        'dir'         => $dir,
                        'dir_label'   => $lineInfo[$dir . '_label'] ?? strtoupper($dir),
                        'idx_orig'    => $bestOrigCandidates[0]['idx'],
                        'stop_orig'   => $bestOrigCandidates[0]['stop'],
                        'walk_orig_m' => round($bestOrigCandidates[0]['walk_m']),
                        'all_stops'   => $stops
                    ];
                }

                if (!empty($bestDestCandidates)) {
                    $linesToDest[] = [
                        'code'        => (string)$code,
                        'name'        => $lineInfo['name'],
                        'line_info'   => $lineInfo,
                        'dir'         => $dir,
                        'dir_label'   => $lineInfo[$dir . '_label'] ?? strtoupper($dir),
                        'idx_dest'    => $bestDestCandidates[0]['idx'],
                        'stop_dest'   => $bestDestCandidates[0]['stop'],
                        'walk_dest_m' => round($bestDestCandidates[0]['walk_m']),
                        'all_stops'   => $stops
                    ];
                }

                // Testar combinações diretas onde o embarque ocorre ANTES do desembarque (idx_orig < idx_dest)
                $bestPair = null;
                $bestGeoScore = INF;
                foreach (array_slice($bestOrigCandidates, 0, 4) as $oc) {
                    foreach (array_slice($bestDestCandidates, 0, 4) as $dc) {
                        if ($oc['idx'] < $dc['idx']) {
                            $walkTotal = $oc['walk_m'] + $dc['walk_m'];
                            $busDist = max(200.0, abs((float)$dc['stop']['dist_m'] - (float)$oc['stop']['dist_m']));
                            $geoScore = ($walkTotal * 3.5) + ($busDist * 0.25);
                            if ($geoScore < $bestGeoScore) {
                                $bestGeoScore = $geoScore;
                                $bestPair = [$oc, $dc, $busDist];
                            }
                        }
                    }
                }

                if ($bestPair) {
                    [$oc, $dc, $busDist] = $bestPair;
                    $walkOrigM = (int)round($oc['walk_m']);
                    $walkDestM = (int)round($dc['walk_m']);
                    $busDistM  = (int)round($busDist);
                    $stopsBetween = max(1, $dc['idx'] - $oc['idx']);

                    $walkTimeMin = max(1, (int)round(($walkOrigM + $walkDestM) / 75.0));
                    $busTimeMin  = max(2, (int)round(($busDistM / 350.0) + ($stopsBetween * 0.3)));

                    $schedEval = $this->evaluateLegSchedule(
                        $lineInfo,
                        $dir,
                        $oc['stop'],
                        $dc['stop'],
                        $walkOrigM,
                        $timeCtx,
                        $tripSearchNorm
                    );

                    $totalScore = $bestGeoScore + $schedEval['score_penalty'];

                    $directOptions[] = [
                        'type'                => 'direct',
                        'score'               => round($totalScore, 1),
                        'operates_today'      => $schedEval['operates_today'],
                        'service_ended_today' => $schedEval['service_ended_today'],
                        'total_time_min'      => $walkTimeMin + $busTimeMin,
                        'walk_total_m'        => $walkOrigM + $walkDestM,
                        'legs'                => [
                            [
                                'line_code'       => (string)$code,
                                'line_name'       => $lineInfo['name'],
                                'direction'       => $dir,
                                'direction_label' => $lineInfo[$dir . '_label'] ?? strtoupper($dir),
                                'board_stop'      => $oc['stop'],
                                'alight_stop'     => $dc['stop'],
                                'stops_count'     => $stopsBetween,
                                'bus_distance_m'  => $busDistM,
                                'walk_before_m'   => $walkOrigM,
                                'walk_after_m'    => $walkDestM,
                                'bus_time_min'    => $busTimeMin,
                                'schedule_eval'   => $schedEval
                            ]
                        ]
                    ];
                }
            }
        }

        usort($directOptions, fn($a, $b) => $a['score'] <=> $b['score']);

        // Dedup direct options by line code (keep best direction per line)
        $uniqueDirect = [];
        $seenLines = [];
        foreach ($directOptions as $opt) {
            $lc = $opt['legs'][0]['line_code'];
            if (isset($seenLines[$lc])) continue;
            $seenLines[$lc] = true;
            $uniqueDirect[] = $opt;
            if (count($uniqueDirect) >= 5) break;
        }

        // Passo 2: Calcular Baldeações (1 conexão) quando não houver linha direta operando agora ou se a caminhada direta for longa
        $transferOptions = [];
        $activeDirectCount = count(array_filter($uniqueDirect, fn($d) => $d['operates_today'] && !$d['service_ended_today']));
        $bestDirectWalk = !empty($uniqueDirect) ? $uniqueDirect[0]['walk_total_m'] : INF;

        if ($activeDirectCount < 2 || $bestDirectWalk > 500) {
            foreach ($linesFromOrigin as $l1) {
                if ($l1['walk_orig_m'] > 900) continue;
                $l1AfterStops = [];
                for ($i = $l1['idx_orig'] + 1; $i < count($l1['all_stops']); $i++) {
                    $st1 = $l1['all_stops'][$i];
                    $l1AfterStops[$st1['stop_id']] = ['idx' => $i, 'stop' => $st1];
                }
                if (empty($l1AfterStops)) continue;

                foreach ($linesToDest as $l2) {
                    if ($l2['code'] === $l1['code'] || $l2['walk_dest_m'] > 900) continue;

                    $bestTransfer = null;
                    $bestTransGeoScore = INF;

                    for ($j = 0; $j < $l2['idx_dest']; $j++) {
                        $st2 = $l2['all_stops'][$j];
                        $sid2 = $st2['stop_id'];
                        if (isset($l1AfterStops[$sid2])) {
                            $st1Match = $l1AfterStops[$sid2];
                            $dist1 = max(200.0, abs((float)$st1Match['stop']['dist_m'] - (float)$l1['stop_orig']['dist_m']));
                            $dist2 = max(200.0, abs((float)$l2['stop_dest']['dist_m'] - (float)$st2['dist_m']));
                            $walkSum = $l1['walk_orig_m'] + $l2['walk_dest_m'];
                            $tScore = ($walkSum * 3.5) + (($dist1 + $dist2) * 0.25) + 900;
                            if ($tScore < $bestTransGeoScore) {
                                $bestTransGeoScore = $tScore;
                                $bestTransfer = [
                                    'transfer_stop' => $st2,
                                    'stops_leg1'    => max(1, $st1Match['idx'] - $l1['idx_orig']),
                                    'stops_leg2'    => max(1, $l2['idx_dest'] - $j),
                                    'dist1_m'       => (int)round($dist1),
                                    'dist2_m'       => (int)round($dist2)
                                ];
                            }
                        }
                    }

                    if ($bestTransfer) {
                        $walkSum = (int)($l1['walk_orig_m'] + $l2['walk_dest_m']);
                        $walkMin = max(1, (int)round($walkSum / 75.0));
                        $bus1Min = max(2, (int)round(($bestTransfer['dist1_m'] / 350.0) + ($bestTransfer['stops_leg1'] * 0.3)));
                        $bus2Min = max(2, (int)round(($bestTransfer['dist2_m'] / 350.0) + ($bestTransfer['stops_leg2'] * 0.3)));
                        $waitTransferMin = 6;

                        $schedEval1 = $this->evaluateLegSchedule(
                            $l1['line_info'],
                            $l1['dir'],
                            $l1['stop_orig'],
                            $bestTransfer['transfer_stop'],
                            (int)$l1['walk_orig_m'],
                            $timeCtx,
                            $origLabel
                        );

                        // Para a 2ª perna da conexão, avança o relógio estimado pelo tempo da 1ª perna
                        $leg2Min = ($timeCtx['minutes_of_day'] + ($schedEval1['next_trip']['wait_min'] ?? 5) + $bus1Min) % 1440;
                        $timeCtxLeg2 = $timeCtx;
                        $timeCtxLeg2['minutes_of_day'] = $leg2Min;
                        $timeCtxLeg2['time'] = $this->formatMinutesToHhMm($leg2Min);

                        $schedEval2 = $this->evaluateLegSchedule(
                            $l2['line_info'],
                            $l2['dir'],
                            $bestTransfer['transfer_stop'],
                            $l2['stop_dest'],
                            0,
                            $timeCtxLeg2,
                            $destLabel
                        );

                        $bothOperate = $schedEval1['operates_today'] && $schedEval2['operates_today'];
                        $anyEnded    = $schedEval1['service_ended_today'] || $schedEval2['service_ended_today'];
                        $combinedPenalty = $schedEval1['score_penalty'] + ($schedEval2['score_penalty'] * 0.6);

                        $transferOptions[] = [
                            'type'                => 'transfer',
                            'score'               => round($bestTransGeoScore + $combinedPenalty, 1),
                            'operates_today'      => $bothOperate,
                            'service_ended_today' => $anyEnded,
                            'total_time_min'      => $walkMin + $bus1Min + $bus2Min + $waitTransferMin,
                            'walk_total_m'        => $walkSum,
                            'transfer_stop'       => $bestTransfer['transfer_stop'],
                            'legs'                => [
                                [
                                    'line_code'       => $l1['code'],
                                    'line_name'       => $l1['name'],
                                    'direction'       => $l1['dir'],
                                    'direction_label' => $l1['dir_label'],
                                    'board_stop'      => $l1['stop_orig'],
                                    'alight_stop'     => $bestTransfer['transfer_stop'],
                                    'stops_count'     => $bestTransfer['stops_leg1'],
                                    'bus_distance_m'  => $bestTransfer['dist1_m'],
                                    'walk_before_m'   => (int)$l1['walk_orig_m'],
                                    'walk_after_m'    => 0,
                                    'bus_time_min'    => $bus1Min,
                                    'schedule_eval'   => $schedEval1
                                ],
                                [
                                    'line_code'       => $l2['code'],
                                    'line_name'       => $l2['name'],
                                    'direction'       => $l2['dir'],
                                    'direction_label' => $l2['dir_label'],
                                    'board_stop'      => $bestTransfer['transfer_stop'],
                                    'alight_stop'     => $l2['stop_dest'],
                                    'stops_count'     => $bestTransfer['stops_leg2'],
                                    'bus_distance_m'  => $bestTransfer['dist2_m'],
                                    'walk_before_m'   => 0,
                                    'walk_after_m'    => (int)$l2['walk_dest_m'],
                                    'bus_time_min'    => $bus2Min,
                                    'schedule_eval'   => $schedEval2
                                ]
                            ]
                        ];
                    }
                }
            }

            usort($transferOptions, fn($a, $b) => $a['score'] <=> $b['score']);
        }

        // Deduplicar baldeações pelo par de linhas
        $uniqueTransfers = [];
        $seenPairs = [];
        foreach ($transferOptions as $tOpt) {
            $pairKey = $tOpt['legs'][0]['line_code'] . '->' . $tOpt['legs'][1]['line_code'];
            if (isset($seenPairs[$pairKey])) continue;
            $seenPairs[$pairKey] = true;
            $uniqueTransfers[] = $tOpt;
            if (count($uniqueTransfers) >= 3) break;
        }

        // Mesclar e ordenar priorizando linhas em operação no dia/horário consultado
        $allRecommendations = array_merge($uniqueDirect, $uniqueTransfers);
        usort($allRecommendations, fn($a, $b) => $a['score'] <=> $b['score']);

        $this->jsonOut([
            'ok'               => true,
            'time_context'     => $timeCtx,
            'origin'           => ['lat' => $origLat, 'lng' => $origLng, 'label' => $origLabel],
            'destination'      => ['lat' => $destLat, 'lng' => $destLng, 'label' => $destLabel],
            'direct_count'     => count($uniqueDirect),
            'transfer_count'   => count($uniqueTransfers),
            'recommendations'  => $allRecommendations
        ]);
    }

    /**
     * GET /api/alerts
     */
    public function alerts() {
        $token = trim((string)$this->input->get('token'));
        $file = $this->cacheDir . '/alerts_store.json';
        $all = file_exists($file) ? (json_decode(file_get_contents($file), true) ?: []) : [];
        $filtered = array_values(array_filter($all, fn($a) => ($a['token'] ?? '') === $token));
        $this->jsonOut(['ok' => true, 'alerts' => $filtered]);
    }

    /**
     * POST /api/alerts
     */
    public function alerts_create() {
        $raw = json_decode(file_get_contents('php://input'), true) ?: $_POST;
        $file = $this->cacheDir . '/alerts_store.json';
        $all = file_exists($file) ? (json_decode(file_get_contents($file), true) ?: []) : [];

        $alert = [
            'id'           => 'AL-' . strtoupper(bin2hex(random_bytes(4))),
            'token'        => $raw['token'] ?? 'anon',
            'line_code'    => strtoupper(trim($raw['line_code'] ?? '5801')),
            'direction'    => ($raw['direction'] ?? 'ida') === 'volta' ? 'volta' : 'ida',
            'stop_id'      => $raw['stop_id'] ?? '',
            'stop_address' => $raw['stop_address'] ?? 'Ponto selecionado no mapa',
            'lat'          => (float)($raw['lat'] ?? -16.7235),
            'lng'          => (float)($raw['lng'] ?? -43.8636),
            'dist_m'       => (float)($raw['dist_m'] ?? 1000),
            'eta_min'      => (int)($raw['eta_min'] ?? 5),
            'created_at'   => gmdate('Y-m-d\TH:i:s\Z'),
            'status'       => 'active'
        ];

        $all[] = $alert;
        @file_put_contents($file, json_encode($all, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
        $this->jsonOut(['ok' => true, 'alert' => $alert], 201);
    }

    /**
     * DELETE /api/alerts/{id}
     */
    public function alerts_delete(string $id = '') {
        $file = $this->cacheDir . '/alerts_store.json';
        $all = file_exists($file) ? (json_decode(file_get_contents($file), true) ?: []) : [];
        $all = array_values(array_filter($all, fn($a) => ($a['id'] ?? '') !== $id));
        @file_put_contents($file, json_encode($all, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
        $this->jsonOut(['ok' => true]);
    }

    /**
     * GET /api/health
     */
    public function health() {
        $cat = $this->loadCatalog();
        $this->jsonOut([
            'ok'                => true,
            'framework'         => 'CodeIgniter ' . CI_VERSION,
            'lines_cataloged'   => count($cat['lines'] ?? []),
            'unique_stops'      => $cat['total_unique_stops'] ?? 0,
            'timestamp'         => gmdate('Y-m-d\TH:i:s\Z')
        ]);
    }
}
