<?php
/**
 * Script de Extração, Consolidação, Geocodificação por Polylines e Quadro de Horários
 * Projeto: Ônibus MC (Montes Claros - MG)
 */

error_reporting(E_ALL);
ini_set('memory_limit', '512M');
set_time_limit(300);

$baseDir = dirname(__DIR__);
$dataDir = $baseDir . '/assets/data';
$shapesDir = $dataDir . '/shapes';

if (!is_dir($shapesDir)) {
    mkdir($shapesDir, 0777, true);
}

$linesList = [
    ['code' => '1501',  'name' => 'VILA ATLÂNTIDA / VILA ANÁLIA'],
    ['code' => '1601',  'name' => 'AMAZONAS / RODOVIÁRIA'],
    ['code' => '1701',  'name' => 'CASTELO BRANCO / SÃO GERALDO'],
    ['code' => '1702',  'name' => 'RESIDENCIAL VITÓRIA II / MANGUES - ASILO SÃO VICENTE DE PAULO'],
    ['code' => '2203',  'name' => 'NOVA AMÉRICA / CENTRO (Prefeitura) - VIA NOVO JARAGUÁ'],
    ['code' => '2601',  'name' => 'RECANTO DAS ÁGUAS / MARACANÃ - VIA RENASCENÇA'],
    ['code' => '2603',  'name' => 'JARAGUÁ II / SANTO AMARO'],
    ['code' => '2604',  'name' => 'MONTE SIÃO IV / VILA CAMPOS - VIA GERALDO ATHAYDE - VIA RODOVIÁRIA'],
    ['code' => '3301',  'name' => 'JARDIM PRIMAVERA / CENTRO (Prefeitura) - VIA AEROPORTO'],
    ['code' => '3302',  'name' => 'JARDIM ALEGRE / CENTRO (Prefeitura)'],
    ['code' => '4601',  'name' => 'INDEPENDÊNCIA / NOSSA SENHORA DAS GRAÇAS'],
    ['code' => '4603',  'name' => 'INDEPENDÊNCIA / SANTA RAFAELA - VIA SANTOS DUMONT - VERA CRUZ'],
    ['code' => '4701',  'name' => 'ACÁCIAS / MAJOR PRATES - VIA CARMELO'],
    ['code' => '5101',  'name' => 'JARDIM OLÍMPICO / JARDIM ELDORADO - VIA JARDIM ALVORADA - VIA VILA BRASÍLIA'],
    ['code' => '5601',  'name' => 'VILA ANÁLIA / RODOVIÁRIA - VIA BELVEDERE'],
    ['code' => '5702',  'name' => 'MONTE CARMELO / JARDIM LIBERDADE - VIA RODOVIÁRIA'],
    ['code' => '5801',  'name' => 'VILA SION II / VILA MAURICÉIA - VIA SANTA RITA - VIA IBITURUNA'],
    ['code' => '5802',  'name' => 'VILA SION II / RODOVIÁRIA'],
    ['code' => '5803',  'name' => 'SANTA LÚCIA / SAPUCAIA'],
    ['code' => '5901',  'name' => 'CINTRA / VILA OLIVEIRA - VIA UNIMONTES'],
    ['code' => '5902',  'name' => 'BELVEDERE / VILA OLIVEIRA'],
    ['code' => '6201R', 'name' => 'VILA TELMA / RENASCENÇA'],
    ['code' => '6202',  'name' => 'VILA TELMA / MONTE SIÃO IV - VIA CEMITÉRIO'],
    ['code' => '6404',  'name' => 'VARGEM GRANDE / NOVA SUÍÇA - VIA MONTE CARMELO'],
    ['code' => '6604',  'name' => 'RESIDENCIAL SUL / CENTRO (Praça de Esportes) - VIA MAJOR PRATES'],
    ['code' => '6901',  'name' => 'MARACANÃ / VILA OLIVEIRA - VIA UNIMONTES'],
    ['code' => '7101',  'name' => 'MAJOR PRATES / VILA SÃO FRANCISCO DE ASSIS'],
    ['code' => '7103',  'name' => 'SÃO GERALDO II / JARDIM ELDORADO'],
    ['code' => '8201',  'name' => 'JARDIM LIBERDADE / FLORESTA'],
];

function fetchMulti(array $urls, int $concurrency = 12): array {
    $results = [];
    $chunks = array_chunk($urls, $concurrency, true);
    foreach ($chunks as $chunk) {
        $mh = curl_multi_init();
        $handles = [];
        foreach ($chunk as $key => $url) {
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_TIMEOUT => 15,
                CURLOPT_CONNECTTIMEOUT => 8,
                CURLOPT_SSL_VERIFYPEER => false,
                CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) OnibusMC-DatasetBuilder/1.0'
            ]);
            curl_multi_add_handle($mh, $ch);
            $handles[$key] = $ch;
        }
        $active = null;
        do {
            $mrc = curl_multi_exec($mh, $active);
        } while ($mrc == CURLM_CALL_MULTI_PERFORM);

        while ($active && $mrc == CURLM_OK) {
            if (curl_multi_select($mh) != -1) {
                do {
                    $mrc = curl_multi_exec($mh, $active);
                } while ($mrc == CURLM_CALL_MULTI_PERFORM);
            }
        }
        foreach ($handles as $key => $ch) {
            $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $body = curl_multi_getcontent($ch);
            $results[$key] = ($code >= 200 && $code < 300) ? $body : null;
            curl_multi_remove_handle($mh, $ch);
            curl_close($ch);
        }
        curl_multi_close($mh);
    }
    return $results;
}

function haversine(float $lat1, float $lon1, float $lat2, float $lon2): float {
    $R = 6371000.0;
    $dLat = deg2rad($lat2 - $lat1);
    $dLon = deg2rad($lon2 - $lon1);
    $a = sin($dLat / 2) * sin($dLat / 2) +
         cos(deg2rad($lat1)) * cos(deg2rad($lat2)) *
         sin($dLon / 2) * sin($dLon / 2);
    return 2 * $R * atan2(sqrt($a), sqrt(1 - $a));
}

function cleanText(string $str): string {
    $str = html_entity_decode(strip_tags($str), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $str = preg_replace('/\s+/u', ' ', $str);
    return trim($str);
}

function parseNeighborhood(string $address): string {
    if (preg_match('/Bairro\s+([^,\-\.]+)/iu', $address, $m)) {
        return trim($m[1]);
    }
    if (preg_match('/-\s*([^,\-\.]+)$/u', $address, $m)) {
        $cand = trim($m[1]);
        if (mb_strlen($cand) > 2 && !preg_match('/^(MG|Montes Claros|\d+)$/iu', $cand)) {
            return $cand;
        }
    }
    return 'Montes Claros';
}

function parseParadasHtml(?string $html): array {
    $result = [
        'ida_label' => 'Sentido Ida',
        'volta_label' => 'Sentido Volta',
        'ida' => [],
        'volta' => []
    ];
    if (!$html) return $result;

    // Match each accordion block
    if (preg_match_all('/<div class="accordion">(.*?)<\/div>\s*<\/div>/si', $html, $accMatches)) {
        foreach ($accMatches[1] as $idx => $block) {
            $label = '';
            if (preg_match('/<a class="accordion__header"[^>]*>(.*?)<\/a>/si', $block, $hm)) {
                $rawLabel = preg_replace('/<small>.*?<\/small>/si', '', $hm[1]);
                $label = cleanText($rawLabel);
            }
            $dir = ($idx === 0) ? 'ida' : 'volta';
            if (stripos($label, '(volta)') !== false && $idx === 0) {
                $dir = 'volta';
            } elseif (stripos($label, '(ida)') !== false) {
                $dir = 'ida';
            }
            if ($label) {
                $result[$dir . '_label'] = $label;
            }

            if (preg_match_all('/<a href="\/linhas\/[^\/]+\/paradas\/(\d+)">\s*(.*?)\s*<\/a>/si', $block, $stopMatches, PREG_SET_ORDER)) {
                $seq = 1;
                foreach ($stopMatches as $sm) {
                    $stopId = $sm[1];
                    $addr = cleanText($sm[2]);
                    $result[$dir][] = [
                        'stop_id' => $stopId,
                        'seq' => $seq++,
                        'address' => $addr,
                        'neighborhood' => parseNeighborhood($addr)
                    ];
                }
            }
        }
    }
    return $result;
}

function parseScheduleHtml(?string $html): array {
    $schedule = [
        'ida' => ['title' => 'Viagem de Ida', 'streets' => [], 'obs' => [], 'weekdays' => [], 'saturdays' => [], 'sundays' => []],
        'volta' => ['title' => 'Viagem de Volta', 'streets' => [], 'obs' => [], 'weekdays' => [], 'saturdays' => [], 'sundays' => []]
    ];
    if (!$html) return $schedule;

    if (!preg_match('/<div class="embed">(.*?)<\/main>/si', $html, $embedMatch)) {
        $content = $html;
    } else {
        $content = $embedMatch[1];
    }

    // Split by VIAGEM DE VOLTA
    $posIda = stripos($content, 'VIAGEM DE IDA');
    $posVolta = stripos($content, 'VIAGEM DE VOLTA');

    $sections = [];
    if ($posIda !== false) {
        $startIda = max(0, $posIda - 250);
        if ($posVolta !== false && $posVolta > $posIda) {
            $beforeVolta = substr($content, 0, $posVolta);
            $hrPos = strripos($beforeVolta, '<hr>');
            $startVolta = ($hrPos !== false && $hrPos > $posIda) ? $hrPos : max($posIda, $posVolta - 140);
            $sections['ida'] = substr($content, $startIda, $startVolta - $startIda);
            $sections['volta'] = substr($content, $startVolta);
        } else {
            $sections['ida'] = substr($content, $startIda);
        }
    }

    foreach ($sections as $dir => $secHtml) {
        if (preg_match('/<b>([^<]{5,120})<\/b>\s*<br>\s*(?:<p>)?\s*VIAGEM DE/si', $secHtml, $tm)) {
            $schedule[$dir]['title'] = rtrim(cleanText($tm[1]), ' :');
        }
        if (preg_match_all('/<b>(\d+)<\/b>:\s*(.*?)<br>/si', $secHtml, $stMatches, PREG_SET_ORDER)) {
            foreach ($stMatches as $stm) {
                $stName = cleanText($stm[2]);
                if ($stName) {
                    $schedule[$dir]['streets'][] = $stName;
                }
            }
        }
        if (preg_match('/obs-wrapper">(.*?)<div class="col-md-(?:12|6)">/si', $secHtml, $obsMatch)) {
            $obsHtml = $obsMatch[1];
            if (preg_match_all('/<li>(.*?)<\/li>/si', $obsHtml, $liMatches) && !empty($liMatches[1])) {
                foreach ($liMatches[1] as $li) {
                    $cleanLi = cleanText($li);
                    if ($cleanLi !== '') {
                        $schedule[$dir]['obs'][] = $cleanLi;
                    }
                }
            } else {
                $fallbackObs = cleanText(preg_replace('/Observa[^:]*:|Obs\.?\s*:/iu', '', $obsHtml));
                if ($fallbackObs !== '') {
                    $schedule[$dir]['obs'][] = $fallbackObs;
                }
            }
        }
        if (preg_match('/<b>\s*<p>\s*(?:<i[^>]*><\/i>\s*)?Hor[^<]*dias[^<]*<\/p>\s*<\/b>\s*<p>(.*?)<\/p>/si', $secHtml, $wdMatch)) {
            $schedule[$dir]['weekdays'] = extractTimesList($wdMatch[1]);
        }
        if (preg_match('/<b>\s*<p>\s*(?:<i[^>]*><\/i>\s*)?Hor[^<]*bados[^<]*<\/p>\s*<\/b>\s*<p>(.*?)<\/p>/si', $secHtml, $satMatch)) {
            $schedule[$dir]['saturdays'] = extractTimesList($satMatch[1]);
        }
        if (preg_match('/<b>\s*<p>\s*(?:<i[^>]*><\/i>\s*)?Hor[^<]*domingos[^<]*<\/p>\s*<\/b>\s*<p>(.*?)<\/p>/si', $secHtml, $sunMatch)) {
            $schedule[$dir]['sundays'] = extractTimesList($sunMatch[1]);
        }
    }

    return $schedule;
}

function extractTimesList(string $rawHtml): array {
    if (stripos($rawHtml, 'NÃO OPERA') !== false || stripos($rawHtml, 'NAO OPERA') !== false) {
        return [];
    }
    $times = [];
    // Alguns quadros separam horários por "|" e outros (ex: 5902 Volta) por "/"
    $parts = preg_split('/[\|\/]+/', $rawHtml);
    foreach ($parts as $p) {
        $isRed = (stripos($p, 'color: red') !== false || stripos($p, 'color:red') !== false);
        $txt = cleanText($p);
        if (preg_match('/(\*{1,2})?\s*(\d{2}:\d{2})\s*(\*{1,2})?(?:\s*\(([^)]+)\))?/u', $txt, $m)) {
            $timeStr = $m[2];
            $ast = '';
            if (!empty($m[1])) {
                $ast = $m[1];
            } elseif (!empty($m[3])) {
                $ast = $m[3];
            }
            $note = isset($m[4]) ? trim($m[4]) : '';
            $isSpecial = $isRed || ($ast !== '') || ($note !== '');
            $entry = [
                'time'    => $timeStr,
                'special' => $isSpecial
            ];
            if ($isRed) {
                $entry['red'] = true;
            }
            if ($ast !== '') {
                $entry['asterisk'] = $ast;
            }
            if ($note !== '') {
                $entry['note'] = $note;
            }
            $times[] = $entry;
        }
    }
    return $times;
}

echo "1. Baixando polylines do MOCBUS e paradas/horarios do OnibusMoc para as 29 linhas...\n";

$urls = [];
if (!file_exists("$dataDir/eixos.json")) {
    $urls['eixos'] = 'https://www.mocbus.com.br/assets/js/gps/eixos.json';
}
foreach ($linesList as $l) {
    $c = $l['code'];
    if (!file_exists("$shapesDir/{$c}_ida.json")) {
        $urls["shape_ida_$c"] = "https://www.mocbus.com.br/assets/js/gps/$c/ida.json";
    }
    if (!file_exists("$shapesDir/{$c}_volta.json")) {
        $urls["shape_volta_$c"] = "https://www.mocbus.com.br/assets/js/gps/$c/volta.json";
    }
    $urls["paradas_$c"]  = "https://www.onibusmoc.com/linhas/$c/paradas";
    $urls["horarios_$c"] = "https://www.onibusmoc.com/linhas/$c";
}

$responses = fetchMulti($urls, 15);

if (!empty($responses['eixos'])) {
    file_put_contents("$dataDir/eixos.json", $responses['eixos']);
    echo "   - eixos.json salvo.\n";
}

$catalog = [];
$globalStops = []; // stop_id => ['stop_id', 'address', 'neighborhood', 'lines' => [], 'occurrences' => []]
$polylines = [];   // "{$code}_{$dir}" => [ ['lat', 'lng', 'cum_dist'], ... ]

foreach ($linesList as $l) {
    $c = $l['code'];
    $hasIda = false;
    $hasVolta = false;

    foreach (['ida', 'volta'] as $dir) {
        $existingShapeFile = "$shapesDir/{$c}_{$dir}.json";
        $rawShape = $responses["shape_{$dir}_{$c}"] ?? (file_exists($existingShapeFile) ? file_get_contents($existingShapeFile) : null);
        if ($rawShape) {
            $decoded = json_decode($rawShape, true);
            if (isset($decoded['coordinates']) && is_array($decoded['coordinates']) && count($decoded['coordinates']) > 2) {
                $cleanCoords = [];
                $cumDist = 0.0;
                $prev = null;
                foreach ($decoded['coordinates'] as $pt) {
                    if (!is_array($pt) || count($pt) < 2) continue;
                    $lat = (float)$pt[0];
                    $lng = (float)$pt[1];
                    if ($lat < -18.0 || $lat > -15.5 || $lng < -45.0 || $lng > -42.5) continue;
                    if ($prev !== null) {
                        $d = haversine($prev[0], $prev[1], $lat, $lng);
                        if ($d < 0.5) continue; // skip duplicate consecutive vertices
                        $cumDist += $d;
                    }
                    $cleanCoords[] = [round($lat, 6), round($lng, 6)];
                    $polylines["{$c}_{$dir}"][] = [
                        'lat' => round($lat, 6),
                        'lng' => round($lng, 6),
                        'dist' => round($cumDist, 1)
                    ];
                    $prev = [$lat, $lng];
                }
                if (count($cleanCoords) > 2) {
                    if (!file_exists($existingShapeFile)) {
                        file_put_contents($existingShapeFile, json_encode([
                            'coordinates' => $cleanCoords,
                            'total_distance_m' => round($cumDist, 1)
                        ]));
                    }
                    if ($dir === 'ida') $hasIda = true;
                    if ($dir === 'volta') $hasVolta = true;
                }
            }
        }
    }

    $paradasData = parseParadasHtml($responses["paradas_$c"] ?? null);
    $scheduleData = parseScheduleHtml($responses["horarios_$c"] ?? null);

    // Register stops in globalStops for cross-referencing and polyline intersection
    foreach (['ida', 'volta'] as $dir) {
        $totalStops = count($paradasData[$dir]);
        foreach ($paradasData[$dir] as $idx => $st) {
            $sid = $st['stop_id'];
            $ratio = ($totalStops > 1) ? ($idx / ($totalStops - 1)) : 0.0;
            if (!isset($globalStops[$sid])) {
                $globalStops[$sid] = [
                    'stop_id' => $sid,
                    'address' => $st['address'],
                    'neighborhood' => $st['neighborhood'],
                    'lines' => [],
                    'occurrences' => []
                ];
            }
            if (!in_array($c, $globalStops[$sid]['lines'], true)) {
                $globalStops[$sid]['lines'][] = $c;
            }
            $globalStops[$sid]['occurrences'][] = [
                'line' => $c,
                'dir' => $dir,
                'seq' => $st['seq'],
                'ratio' => $ratio
            ];
        }
    }

    $catalog[$c] = [
        'code' => $c,
        'name' => $l['name'],
        'has_shape_ida' => $hasIda,
        'has_shape_volta' => $hasVolta,
        'ida_label' => $paradasData['ida_label'],
        'volta_label' => $paradasData['volta_label'],
        'stops' => [
            'ida' => $paradasData['ida'],
            'volta' => $paradasData['volta']
        ],
        'schedule' => $scheduleData
    ];

    echo sprintf(
        "   - Linha %-5s: paradas(%2d/%2d) | util(%2d/%2d) | sab(%2d/%2d) | dom(%2d/%2d)\n",
        $c,
        count($paradasData['ida']),
        count($paradasData['volta']),
        count($scheduleData['ida']['weekdays']),
        count($scheduleData['volta']['weekdays']),
        count($scheduleData['ida']['saturdays']),
        count($scheduleData['volta']['saturdays']),
        count($scheduleData['ida']['sundays']),
        count($scheduleData['volta']['sundays'])
    );
}

echo "2. Calculando coordenadas geograficas dos pontos via intersecao e interpolacao nas polylines oficiais...\n";

// Step 2A: For each line+dir, project stops monotonically along its polyline
// First, compute initial estimate for every stop occurrence along its polyline by arc-length ratio,
// refined by multi-line polyline intersection when a stop is shared by multiple lines!
$stopCoords = []; // stop_id => ['lat' => ..., 'lng' => ...]

foreach ($globalStops as $sid => $sInfo) {
    $validOccs = [];
    foreach ($sInfo['occurrences'] as $occ) {
        $key = $occ['line'] . '_' . $occ['dir'];
        if (!empty($polylines[$key])) {
            $validOccs[] = $occ;
        }
    }
    if (empty($validOccs)) {
        // Default center of Montes Claros (Praça Dr. Carlos)
        $stopCoords[$sid] = ['lat' => -16.7235, 'lng' => -43.8636];
        continue;
    }

    // Primary polyline occurrence
    $primary = $validOccs[0];
    $poly1 = $polylines[$primary['line'] . '_' . $primary['dir']];
    $totalDist1 = end($poly1)['dist'];
    $targetDist1 = $primary['ratio'] * $totalDist1;

    if (count($validOccs) >= 2) {
        // Search within a +/- 18% window of targetDist1 on poly1 for the vertex that minimizes distance to poly2
        $poly2 = $polylines[$validOccs[1]['line'] . '_' . $validOccs[1]['dir']];
        $totalDist2 = end($poly2)['dist'];
        $targetDist2 = $validOccs[1]['ratio'] * $totalDist2;

        $bestPt = null;
        $bestScore = INF;
        foreach ($poly1 as $v1) {
            if (abs($v1['dist'] - $targetDist1) > $totalDist1 * 0.22) continue;
            foreach ($poly2 as $v2) {
                if (abs($v2['dist'] - $targetDist2) > $totalDist2 * 0.22) continue;
                $d = haversine($v1['lat'], $v1['lng'], $v2['lat'], $v2['lng']);
                // Add slight penalty for drifting far from expected ratio
                $ratioPenalty = (abs($v1['dist'] - $targetDist1) / max(1.0, $totalDist1)) * 120.0;
                $score = $d + $ratioPenalty;
                if ($score < $bestScore) {
                    $bestScore = $score;
                    $bestPt = $v1;
                }
            }
        }
        if ($bestPt && $bestScore < 350.0) {
            $stopCoords[$sid] = ['lat' => $bestPt['lat'], 'lng' => $bestPt['lng']];
            continue;
        }
    }

    // Fallback or single-line stop: interpolate at targetDist1 along poly1
    $chosen = $poly1[0];
    foreach ($poly1 as $v1) {
        $chosen = $v1;
        if ($v1['dist'] >= $targetDist1) break;
    }
    $stopCoords[$sid] = ['lat' => $chosen['lat'], 'lng' => $chosen['lng']];
}

// Step 2B: Enrich each line's stops with lat, lng, dist_on_route_m, and shared lines
foreach ($catalog as $c => &$lineItem) {
    foreach (['ida', 'volta'] as $dir) {
        $poly = $polylines["{$c}_{$dir}"] ?? [];
        $totalPolyDist = !empty($poly) ? end($poly)['dist'] : 0.0;
        $countStops = count($lineItem['stops'][$dir]);

        $lastDist = 0.0;
        foreach ($lineItem['stops'][$dir] as $idx => &$st) {
            $sid = $st['stop_id'];
            $ratio = ($countStops > 1) ? ($idx / ($countStops - 1)) : 0.0;
            $expectedDist = $ratio * $totalPolyDist;

            // Project stop onto this line's polyline near expectedDist to get monotonic dist_m
            if (!empty($poly)) {
                $coord = $stopCoords[$sid] ?? ['lat' => $poly[0]['lat'], 'lng' => $poly[0]['lng']];
                $bestV = null;
                $bestD = INF;
                foreach ($poly as $v) {
                    if ($v['dist'] < $lastDist - 150.0) continue;
                    if (abs($v['dist'] - $expectedDist) > max(800.0, $totalPolyDist * 0.25)) continue;
                    $d = haversine($coord['lat'], $coord['lng'], $v['lat'], $v['lng']);
                    if ($d < $bestD) {
                        $bestD = $d;
                        $bestV = $v;
                    }
                }
                if (!$bestV) {
                    foreach ($poly as $v) {
                        $bestV = $v;
                        if ($v['dist'] >= $expectedDist) break;
                    }
                }
                $st['lat'] = $bestV['lat'];
                $st['lng'] = $bestV['lng'];
                $st['dist_m'] = max($lastDist, $bestV['dist']);
                $lastDist = $st['dist_m'];
            } else {
                $coord = $stopCoords[$sid] ?? ['lat' => -16.7235, 'lng' => -43.8636];
                $st['lat'] = $coord['lat'];
                $st['lng'] = $coord['lng'];
                $st['dist_m'] = round($ratio * 12000, 1);
            }
            $st['lines'] = $globalStops[$sid]['lines'] ?? [$c];
        }
        unset($st);
    }
    // Extract unique neighborhoods served
    $bairros = [];
    foreach (['ida', 'volta'] as $dir) {
        foreach ($lineItem['stops'][$dir] as $st) {
            if (!empty($st['neighborhood']) && $st['neighborhood'] !== 'Montes Claros' && !in_array($st['neighborhood'], $bairros, true)) {
                $bairros[] = $st['neighborhood'];
            }
        }
    }
    $lineItem['neighborhoods'] = $bairros;
}
unset($lineItem);

// Save full catalog and stops index
file_put_contents("$dataDir/catalog.json", json_encode([
    'generated_at' => date('c'),
    'city' => 'Montes Claros - MG',
    'total_lines' => count($catalog),
    'total_unique_stops' => count($globalStops),
    'lines' => $catalog
], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));

// Also save a compact stops index for fast geocoding/autocomplete & transfer lookup
$stopsCompact = [];
foreach ($globalStops as $sid => $sInfo) {
    $coord = $stopCoords[$sid] ?? ['lat' => -16.7235, 'lng' => -43.8636];
    $stopsCompact[$sid] = [
        'stop_id' => $sid,
        'address' => $sInfo['address'],
        'neighborhood' => $sInfo['neighborhood'],
        'lat' => $coord['lat'],
        'lng' => $coord['lng'],
        'lines' => $sInfo['lines']
    ];
}
file_put_contents("$dataDir/stops_index.json", json_encode($stopsCompact, JSON_UNESCAPED_UNICODE));

echo "3. Concluido! catalog.json (" . count($catalog) . " linhas) e stops_index.json (" . count($stopsCompact) . " paradas unicas) gerados com sucesso!\n";
