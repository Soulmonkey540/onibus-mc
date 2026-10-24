<?php
defined('BASEPATH') OR exit('No direct script access allowed');

/*
| -------------------------------------------------------------------------
| json_response()
| -------------------------------------------------------------------------
| Pequeno helper pra não repetir "set_content_type + set_status_header +
| set_output(json_encode(...))" em todo Controller. É o equivalente direto
| de `return { statusCode, headers, body: JSON.stringify(...) }` que cada
| Netlify Function antiga devolvia.
*/
function json_response($data, $status_code = 200)
{
    $ci =& get_instance();
    $ci->output
        ->set_status_header($status_code)
        ->set_content_type('application/json', 'utf-8')
        ->set_output(json_encode($data));
}

/*
| Lê o corpo JSON da requisição (equivalente a JSON.parse(event.body || '{}')).
| Devolve um array associativo vazio se o corpo estiver ausente/malformado.
*/
function json_input()
{
    $raw = file_get_contents('php://input');
    if (!$raw) return array();
    $dados = json_decode($raw, true);
    return is_array($dados) ? $dados : array();
}
