<?php
/**
 * Entrypoint Serverless para a Vercel (vercel-php)
 * Redireciona o contexto de execução para o index.php raiz do CodeIgniter 3.
 */
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = dirname(__DIR__) . '/index.php';

chdir(dirname(__DIR__));
require_once dirname(__DIR__) . '/index.php';
