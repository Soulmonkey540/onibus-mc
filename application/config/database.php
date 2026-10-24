<?php
defined('BASEPATH') OR exit('No direct script access allowed');

/*
| -------------------------------------------------------------------------
| Banco de dados — Postgres (mesmo banco Supabase que já existe hoje)
| -------------------------------------------------------------------------
| Continuamos usando Postgres (o mesmo banco Supabase da versão antiga) —
| não é necessário recriar as tabelas, o schema.sql é o mesmo.
|
| PREENCHA com as credenciais reais assim que o novo host for escolhido
| (idealmente via variáveis de ambiente do próprio host, nunca hardcoded
| direto no arquivo se o repositório for público). Veja o README-DEV.md,
| seção "database.php", para o passo a passo.
|
| O host precisa ter a extensão PHP "pgsql" (e "pdo_pgsql" se preferir PDO)
| habilitada — isso é uma restrição a checar na hora de escolher o
| serviço de hospedagem.
*/

$active_group = 'default';
$query_builder = TRUE;

$db['default'] = array(
    'dsn'      => '',
    'hostname' => getenv('DB_HOST') ?: 'localhost',
    'username' => getenv('DB_USER') ?: '',
    'password' => getenv('DB_PASS') ?: '',
    'database' => getenv('DB_NAME') ?: '',
    'dbdriver' => 'postgre',
    'dbprefix' => '',
    'pconnect' => FALSE,
    // Sempre FALSE, mesmo em desenvolvimento — de propósito. Com isso
    // ligado, uma falha de conexão derruba o PHP inteiro com a tela de
    // erro nativa do CI3 (foi o que aconteceu no Laragon sem o banco
    // configurado). Desligado, a falha vira uma exceção comum que o
    // MY_Model (application/core/MY_Model.php) já sabe transformar numa
    // resposta JSON 503 amigável — é o que permite trabalhar no visual
    // do site sem precisar ter um banco por perto.
    'db_debug' => FALSE,
    'cache_on' => FALSE,
    'cachedir' => '',
    'char_set' => 'utf8',
    'dbcollat' => 'utf8_general_ci',
    'swap_pre' => '',
    'encrypt'  => FALSE,
    'compress' => FALSE,
    'stricton' => FALSE,
    'failover' => array(),
    'save_queries' => TRUE,
    // O pooler do Supabase exige SSL. O driver "postgre" do CI3 monta a
    // string de conexão a partir de hostname/port/database/username/password
    // — para forçar SSL, a forma mais confiável é usar a "dsn" completa
    // abaixo (descomente e preencha) em vez dos campos soltos:
    //
    // 'dsn' => 'pgsql:host=SEU_HOST;port=5432;dbname=SEU_BANCO;user=SEU_USUARIO;password=SUA_SENHA;sslmode=require',
    'port' => getenv('DB_PORT') ?: 5432,
);
