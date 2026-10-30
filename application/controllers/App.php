<?php
defined('BASEPATH') OR exit('No direct script access allowed');

class App extends CI_Controller {

    public function index() {
        $catalogFile = FCPATH . 'assets/data/catalog.json';
        $linesSummary = [];

        $dualDefs = [
            '5801' => [
                'variant_key'   => '5801-IBITURUNA',
                'display_code'  => '5801 (-Ibituruna)',
                'base_name'     => 'VILA SION II / VILA MAURICÉIA - VIA SANTA RITA',
                'variant_name'  => 'VILA SION II / VILA MAURICÉIA (-Ibituruna: Serra do Mel, Portal da Serra e Vivendas)',
                'extra_bairros' => ['Ibituruna', 'Serra do Mel', 'Portal da Serra', 'Vivendas do Lago']
            ],
            '2601' => [
                'variant_key'   => '2601-UNIVERSITARIA',
                'display_code'  => '2601 (-Universitária)',
                'base_name'     => 'RECANTO DAS ÁGUAS / MARACANÃ - VIA RENASCENÇA',
                'variant_name'  => 'RECANTO DAS ÁGUAS / MARACANÃ (-Av. Universitária / UFMG / Hosp. Veterinário)',
                'extra_bairros' => ['Universitário', 'Av. Universitária', 'UFMG', 'Hospital Veterinário Funorte']
            ],
            '2603' => [
                'variant_key'   => '2603-BERRANTE',
                'display_code'  => '2603 (-Posto Berrante)',
                'base_name'     => 'JARAGUÁ II / SANTO AMARO',
                'variant_name'  => 'JARAGUÁ II / SANTO AMARO (-Posto Berrante / Jardim Alegre)',
                'extra_bairros' => ['Posto Berrante', 'Posto da Produção', 'Anel Rodoviário Norte', 'Jardim Alegre']
            ],
            '4603' => [
                'variant_key'   => '4603-TROPICAL',
                'display_code'  => '4603 (-Cond. Tropical)',
                'base_name'     => 'INDEPENDÊNCIA / SANTA RAFAELA - VIA SANTOS DUMONT',
                'variant_name'  => 'INDEPENDÊNCIA / SANTA RAFAELA (-Condomínio Tropical / Vera Cruz)',
                'extra_bairros' => ['Condomínio Tropical', 'São Judas Tadeu', 'Vera Cruz']
            ],
            '4701' => [
                'variant_key'   => '4701-TERRAJARDINS',
                'display_code'  => '4701 (-Terra Jardins)',
                'base_name'     => 'ACÁCIAS / MAJOR PRATES - VIA CARMELO',
                'variant_name'  => 'ACÁCIAS / MAJOR PRATES (-Bairro Terra Jardins)',
                'extra_bairros' => ['Terra Jardins']
            ],
            '7101' => [
                'variant_key'   => '7101-RESERVAREAL',
                'display_code'  => '7101 (-Reserva Real)',
                'base_name'     => 'MAJOR PRATES / VILA SÃO FRANCISCO DE ASSIS',
                'variant_name'  => 'MAJOR PRATES / VILA SÃO FRANCISCO (-Reserva Real e Gran Royalle)',
                'extra_bairros' => ['Reserva Real', 'Gran Royalle']
            ]
        ];

        if (file_exists($catalogFile)) {
            $raw = json_decode(file_get_contents($catalogFile), true);
            if (!empty($raw['lines'])) {
                foreach ($raw['lines'] as $code => $info) {
                    $codeStr = (string)$info['code'];
                    $schedIda = $info['schedule']['ida'] ?? [];
                    $schedVolta = $info['schedule']['volta'] ?? [];

                    if (isset($dualDefs[$codeStr])) {
                        $def = $dualDefs[$codeStr];

                        // 1. Linha Base
                        $linesSummary[] = [
                            'code'            => $codeStr,
                            'base_code'       => $codeStr,
                            'display_code'    => $codeStr,
                            'is_variant_line' => false,
                            'name'            => $def['base_name'],
                            'ida_label'       => $info['ida_label'] ?? 'Sentido Ida',
                            'volta_label'     => $info['volta_label'] ?? 'Sentido Volta',
                            'has_shape_ida'   => !empty($info['has_shape_ida']),
                            'has_shape_volta' => !empty($info['has_shape_volta']),
                            'stops_ida_cnt'   => isset($info['stops']['ida']) ? count($info['stops']['ida']) : 0,
                            'stops_volta_cnt' => isset($info['stops']['volta']) ? count($info['stops']['volta']) : 0,
                            'neighborhoods'   => $info['neighborhoods'] ?? [],
                            'operates_days'   => [
                                'weekdays'  => !empty($schedIda['weekdays']) || !empty($schedVolta['weekdays']),
                                'saturdays' => !empty($schedIda['saturdays']) || !empty($schedVolta['saturdays']),
                                'sundays'   => !empty($schedIda['sundays']) || !empty($schedVolta['sundays'])
                            ]
                        ];

                        // 2. Linha Variante (ex: 5801 (-Ibituruna))
                        $hasSpecW = !empty(array_filter($schedIda['weekdays'] ?? [], fn($t) => !empty($t['special']))) || !empty(array_filter($schedVolta['weekdays'] ?? [], fn($t) => !empty($t['special'])));
                        $hasSpecS = !empty(array_filter($schedIda['saturdays'] ?? [], fn($t) => !empty($t['special']))) || !empty(array_filter($schedVolta['saturdays'] ?? [], fn($t) => !empty($t['special'])));
                        $hasSpecU = !empty(array_filter($schedIda['sundays'] ?? [], fn($t) => !empty($t['special']))) || !empty(array_filter($schedVolta['sundays'] ?? [], fn($t) => !empty($t['special'])));

                        $linesSummary[] = [
                            'code'            => $def['variant_key'],
                            'base_code'       => $codeStr,
                            'display_code'    => $def['display_code'],
                            'is_variant_line' => true,
                            'name'            => $def['variant_name'],
                            'ida_label'       => $info['ida_label'] ?? 'Sentido Ida',
                            'volta_label'     => $info['volta_label'] ?? 'Sentido Volta',
                            'has_shape_ida'   => !empty($info['has_shape_ida']),
                            'has_shape_volta' => !empty($info['has_shape_volta']),
                            'stops_ida_cnt'   => isset($info['stops']['ida']) ? count($info['stops']['ida']) : 0,
                            'stops_volta_cnt' => isset($info['stops']['volta']) ? count($info['stops']['volta']) : 0,
                            'neighborhoods'   => array_values(array_unique(array_merge($def['extra_bairros'], $info['neighborhoods'] ?? []))),
                            'operates_days'   => [
                                'weekdays'  => $hasSpecW,
                                'saturdays' => $hasSpecS,
                                'sundays'   => $hasSpecU
                            ]
                        ];
                    } else {
                        $linesSummary[] = [
                            'code'            => $codeStr,
                            'base_code'       => $codeStr,
                            'display_code'    => $codeStr,
                            'is_variant_line' => false,
                            'name'            => $info['name'],
                            'ida_label'       => $info['ida_label'] ?? 'Sentido Ida',
                            'volta_label'     => $info['volta_label'] ?? 'Sentido Volta',
                            'has_shape_ida'   => !empty($info['has_shape_ida']),
                            'has_shape_volta' => !empty($info['has_shape_volta']),
                            'stops_ida_cnt'   => isset($info['stops']['ida']) ? count($info['stops']['ida']) : 0,
                            'stops_volta_cnt' => isset($info['stops']['volta']) ? count($info['stops']['volta']) : 0,
                            'neighborhoods'   => $info['neighborhoods'] ?? [],
                            'operates_days'   => [
                                'weekdays'  => !empty($schedIda['weekdays']) || !empty($schedVolta['weekdays']),
                                'saturdays' => !empty($schedIda['saturdays']) || !empty($schedVolta['saturdays']),
                                'sundays'   => !empty($schedIda['sundays']) || !empty($schedVolta['sundays'])
                            ]
                        ];
                    }
                }
            }
        }

        $data = [
            'page_title'    => 'Ônibus MC — Rastreamento e Rotas em Montes Claros',
            'lines_summary' => $linesSummary,
            'base_url'      => base_url()
        ];

        $this->load->view('app_view', $data);
    }

    public function manifest() {
        header('Content-Type: application/manifest+json; charset=utf-8');
        $manifest = [
            'name' => 'Ônibus MC — Transporte Coletivo de Montes Claros',
            'short_name' => 'Ônibus MC',
            'id' => base_url(),
            'start_url' => base_url(),
            'scope' => base_url(),
            'display' => 'standalone',
            'background_color' => '#0f172a',
            'theme_color' => '#1d4ed8',
            'description' => 'Rastreamento por GPS em tempo real, planejador de rotas com baldeação, horários e alertas de aproximação para as 29 linhas de Montes Claros (MG).',
            'icons' => [
                [
                    'src' => 'https://cdn-icons-png.flaticon.com/512/3448/3448339.png',
                    'sizes' => '512x512',
                    'type' => 'image/png',
                    'purpose' => 'any maskable'
                ]
            ]
        ];
        echo json_encode($manifest, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    }

    public function sw() {
        header('Content-Type: application/javascript; charset=utf-8');
        header('Service-Worker-Allowed: /');
        readfile(FCPATH . 'assets/js/sw.js');
    }
}
