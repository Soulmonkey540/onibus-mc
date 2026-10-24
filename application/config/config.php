<?php
defined('BASEPATH') OR exit('No direct script access allowed');

/*
| -------------------------------------------------------------------------
| Configuração básica do CodeIgniter 3 para o SCORN
| -------------------------------------------------------------------------
| Este arquivo NÃO substitui o config.php completo que vem no instalador
| oficial do CI3 (ele tem dezenas de outras chaves com valores padrão que
| raramente precisam mudar). Aqui só estão as chaves que realmente
| importam pra este projeto — veja o README-DEV.md, seção "config.php",
| pra saber exatamente onde colar isto dentro do arquivo oficial.
*/

// Em produção, defina a variável de ambiente BASE_URL com a URL completa
// (ex: 'https://seudominio.com.br/'). Sem ela, montamos a partir do host
// da requisição + subpasta do index.php — funciona no Laragon tanto em
// http://scorn-v2-ci.test/ quanto em http://localhost/scorn-V2-CI/.
//
// Por que não deixar '' (auto-detect do CI3)? O CI3 usa o IP do servidor
// (SERVER_ADDR) em vez do host — a página abriria em scorn-v2-ci.test e
// os fetch() da API iriam pra 127.0.0.1, o que o navegador bloqueia
// (origem diferente). O JS agora usa base_url() pra montar as URLs da
// API (ver window.SCORN em views/partials/head.php), então isso importa.
$config['base_url'] = getenv('BASE_URL') ?: (function () {
    $isHttps = is_https() || (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https');
    $protocolo = $isHttps ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $pasta = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/');
    if ($pasta === '/api') {
        $pasta = '';
    }
    return "{$protocolo}://{$host}{$pasta}/";
})();

$config['index_page'] = ''; // exige mod_rewrite / .htaccess (ver README-DEV.md)
$config['uri_protocol'] = 'REQUEST_URI';

$config['charset'] = 'UTF-8';
$config['enable_hooks'] = FALSE;
$config['subclass_prefix'] = 'MY_';
$config['composer_autoload'] = FALSE; // true se algum dia usarem composer (ex: mercadopago/dx-php)

$config['permitted_uri_chars'] = 'a-z 0-9~%.:_\-';

$config['allow_get_array'] = TRUE;
$config['enable_query_strings'] = FALSE;

$config['log_threshold'] = getenv('VERCEL') ? 0 : 1;
$config['log_path'] = getenv('VERCEL') ? sys_get_temp_dir() . '/' : '';
$config['log_file_extension'] = 'log';

// -- Segurança / CSRF --------------------------------------------------
// A API é chamada via fetch() com JSON (não formulários HTML), então o
// CSRF nativo do CI3 fica desligado para as rotas /api/* (o próprio
// admin já é protegido por sessão/cookie httpOnly do JWT). Se no futuro
// o admin ganhar telas com <form> tradicional, vale ligar isso.
$config['csrf_protection'] = FALSE;

// -- Cookies -------------------------------------------------------------
$config['cookie_prefix'] = '';
$config['cookie_domain'] = '';
$config['cookie_path'] = '/';
// Acompanha o protocolo da requisição: TRUE em produção (HTTPS), FALSE
// no Laragon em http:// — antes era TRUE fixo, e aí o navegador
// descartava o cookie de login do admin em desenvolvimento.
$config['cookie_secure'] = is_https();
$config['cookie_httponly'] = TRUE;
$config['cookie_samesite'] = 'Strict';

// -- Chave de criptografia -------------------------------------------------
// Gere uma string aleatória de 32+ caracteres antes de ir pra produção.
// Pode usar: php -r "echo bin2hex(random_bytes(32));"
$config['encryption_key'] = getenv('CI_ENCRYPTION_KEY') ?: '';

$config['sess_driver'] = 'files';
$config['sess_cookie_name'] = 'ci_session';
$config['sess_expiration'] = 7200;
$config['sess_save_path'] = NULL;
$config['sess_match_ip'] = FALSE;
$config['sess_time_to_update'] = 300;
$config['sess_regenerate_destroy'] = FALSE;

$config['time_reference'] = 'local';
$config['rewrite_short_tags'] = FALSE;

$config['proxy_ips'] = '';

/*
| -------------------------------------------------------------------------
| Segredos/variáveis específicas do SCORN
| -------------------------------------------------------------------------
| Equivalentes às "environment variables" que existiam no painel do
| Netlify (seção 9 do SCORN-DOCUMENTACAO.md). Aqui viram chaves lidas via
| getenv() — configure-as no seu novo host (arquivo .env carregado pelo
| painel, "Environment Variables" do painel de hospedagem, ou variáveis
| do Apache/Nginx). NUNCA coloque os valores reais direto neste arquivo
| se o repositório for público.
*/
$config['scorn'] = array(
    'session_secret'              => getenv('SESSION_SECRET') ?: '',
    'mp_access_token'             => getenv('MP_ACCESS_TOKEN') ?: '',
    'mp_access_token_frosty'      => getenv('MP_ACCESS_TOKEN_FROSTY') ?: '',
    'mp_access_token_sakami'      => getenv('MP_ACCESS_TOKEN_SAKAMI') ?: '',
    'site_url'                    => getenv('SITE_URL') ?: '',
    'callmebot_phone'             => getenv('CALLMEBOT_PHONE') ?: '',
    'callmebot_apikey'            => getenv('CALLMEBOT_APIKEY') ?: '',
    'supabase_url'                => getenv('SUPABASE_URL') ?: '',
    'supabase_service_role_key'   => getenv('SUPABASE_SERVICE_ROLE_KEY') ?: '',
    'superfrete_sandbox'          => getenv('SUPERFRETE_SANDBOX') === 'true',
    'superfrete_token_frosty'     => getenv('SUPERFRETE_TOKEN_FROSTY') ?: '',
    'superfrete_cep_origem_frosty' => getenv('SUPERFRETE_CEP_ORIGEM_FROSTY') ?: '',
    'superfrete_token_sakami'     => getenv('SUPERFRETE_TOKEN_SAKAMI') ?: '',
    'superfrete_cep_origem_sakami' => getenv('SUPERFRETE_CEP_ORIGEM_SAKAMI') ?: '',

    // Modo de teste visual (antes era a constante MODO_TESTE_VISUAL no
    // topo do script.js). Ligado: sem produtos/modelos vindos da API, a
    // loja mostra peças e modelos de demonstração (assets/img/demo/).
    // Padrão: ligado fora de produção, desligado com CI_ENV=production.
    // Pra forçar, defina MODO_TESTE_VISUAL=true/false no ambiente.
    'modo_teste_visual' => getenv('MODO_TESTE_VISUAL') !== false
        ? getenv('MODO_TESTE_VISUAL') === 'true'
        : ENVIRONMENT !== 'production',
);
