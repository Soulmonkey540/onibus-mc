<?php
/**
 * Router para o servidor embutido do PHP (php -S localhost:8080 router.php)
 * Simula o comportamento do .htaccess do Apache para o CodeIgniter 3.
 */
$uri = urldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH));
$file = __DIR__ . $uri;

if ($uri !== '/' && file_exists($file) && !is_dir($file)) {
    return false;
}

$_SERVER['SCRIPT_NAME'] = '/index.php';
require_once __DIR__ . '/index.php';
