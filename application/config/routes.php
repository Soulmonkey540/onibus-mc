<?php
defined('BASEPATH') OR exit('No direct script access allowed');

/*
| -------------------------------------------------------------------------
| Rotas do Ônibus MC (CodeIgniter 3)
| -------------------------------------------------------------------------
*/

$route['default_controller'] = 'app';
$route['index.html']         = 'app';
$route['manifest.webmanifest'] = 'app/manifest';
$route['sw.js']              = 'app/sw';

// --- Endpoints da API BFF / Proxy ---
$route['api/lines']['get']                        = 'api/lines';
$route['api/line/(:any)']['get']                  = 'api/line/$1';
$route['api/shape/(:any)/(:any)']['get']          = 'api/shape/$1/$2';
$route['api/vehicles/(:any)/(:any)']['get']       = 'api/vehicles/$1/$2';
$route['api/route-plan']['get']                   = 'api/route_plan';
$route['api/route-plan']['post']                  = 'api/route_plan';
$route['api/time-context']['get']                 = 'api/time_context';
$route['api/search-stops']['get']                 = 'api/search_stops';
$route['api/geocode']['get']                      = 'api/geocode';
$route['api/alerts']['get']                       = 'api/alerts';
$route['api/alerts']['post']                      = 'api/alerts_create';
$route['api/alerts/(:any)']['delete']             = 'api/alerts_delete/$1';
$route['api/health']['get']                       = 'api/health';

$route['404_override'] = '';
$route['translate_uri_dashes'] = FALSE;
