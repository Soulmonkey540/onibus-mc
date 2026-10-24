<?php
defined('BASEPATH') OR exit('No direct script access allowed');

class App extends CI_Controller {

    public function index() {
        $catalogFile = FCPATH . 'assets/data/catalog.json';
        $linesSummary = [];

        if (file_exists($catalogFile)) {
            $raw = json_decode(file_get_contents($catalogFile), true);
            if (!empty($raw['lines'])) {
                foreach ($raw['lines'] as $code => $info) {
                    $linesSummary[] = [
                        'code'            => (string)$info['code'],
                        'name'            => $info['name'],
                        'ida_label'       => $info['ida_label'] ?? 'Sentido Ida',
                        'volta_label'     => $info['volta_label'] ?? 'Sentido Volta',
                        'has_shape_ida'   => !empty($info['has_shape_ida']),
                        'has_shape_volta' => !empty($info['has_shape_volta']),
                        'stops_ida_cnt'   => isset($info['stops']['ida']) ? count($info['stops']['ida']) : 0,
                        'stops_volta_cnt' => isset($info['stops']['volta']) ? count($info['stops']['volta']) : 0,
                        'neighborhoods'   => $info['neighborhoods'] ?? []
                    ];
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
