<?php
defined('BASEPATH') OR exit('No direct script access allowed');

/*
| -------------------------------------------------------------------------
| Autoload do SCORN
| -------------------------------------------------------------------------
| Mesma lógica: carrega automaticamente o que TODA rota da API precisa
| (banco de dados, as bibliotecas próprias do projeto). Junte estas
| chaves com o autoload.php oficial do CI3 (ver README-DEV.md).
*/

$autoload['packages'] = array();

/*
| 'database' NÃO está na lista de propósito: cada Model conecta sozinha,
| só quando é de fato carregada (ver application/core/MY_Model.php) — do
| jeito que estava antes, TODA página tentava conectar no banco, mesmo a
| loja e o admin (que são só HTML).
|
| As libraries também saíram do autoload: cada Controller carrega só o
| que usa ($this->load->library('Superfrete_lib'), etc.). Antes, toda
| página instanciava Auth_lib (que logava "SESSION_SECRET não
| configurado" a cada acesso, inclusive na loja) e a 'session' do CI3,
| que nenhum código do projeto usa.
*/
$autoload['libraries'] = array();

$autoload['drivers'] = array();

$autoload['helper'] = array('url', 'json_response');

$autoload['config'] = array();

$autoload['language'] = array();

/*
| Modelos também NÃO são autoload — cada Controller de API carrega só o(s)
| que precisa, com $this->load->model('Produto_model'), por exemplo. Veja
| o padrão em qualquer Controller dentro de application/controllers/api/.
*/
$autoload['model'] = array();
