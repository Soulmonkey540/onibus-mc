# 🚌 Ônibus MC — Sistema de Rastreamento GPS e Planejamento de Rotas (Montes Claros - MG)

Aplicação **CodeIgniter 3 + PWA (Progressive Web App)** desenvolvida para rastreamento em tempo real dos ônibus de transporte público de Montes Claros (MG), planejamento de rotas **Origem → Destino** (com cálculo de linhas diretas e baldeações em 1 conexão), consulta de horários oficiais e alertas de aproximação por distância na rota e faixa de ETA.

---

## 🚀 Como Executar o Projeto

### Opção 1 — Servidor Embutido do PHP (Mais Rápido)
Abra o terminal na pasta `C:\Users\point038\Desktop\projetos\web_bus` e execute:

```powershell
& "C:\laragon\bin\php\php-8.1.10-Win32-vs16-x64\php.exe" -S localhost:8080 router.php
```
Acesse no navegador: **`http://localhost:8080`**

### Opção 2 — Pelo Laragon (Apache / Nginx)
Aponte o DocumentRoot ou crie um link simbólico em `C:\laragon\www\web_bus` para `C:\Users\point038\Desktop\projetos\web_bus` e acesse **`http://web_bus.test`** ou **`http://localhost/web_bus/`**.

---

## 📂 Estrutura de Diretórios (CodeIgniter 3)

- `application/controllers/App.php` — Controller principal da interface PWA, `manifest.webmanifest` e `sw.js`.
- `application/controllers/Api.php` — BFF / Proxy da API MOCBUS (com cache de 10s em `application/cache/gps/`), simulador de veículos ao longo da polyline, geocodificador híbrido e motor de cálculo de rotas Origem → Destino (diretas + baldeação).
- `application/views/app_view.php` — Interface responsiva Mobile-First (4 abas: Linhas, Traçar Rota, Alertas, Horários).
- `assets/data/catalog.json` — Catálogo consolidado das **29 linhas**, com paradas separadas por `ida` e `volta`, coordenadas calculadas sobre o traçado oficial e quadros de horários completos (Dias Úteis, Sábados e Domingos).
- `assets/data/stops_index.json` — Índice das **915 paradas únicas** de Montes Claros com conexões entre linhas.
- `assets/data/shapes/` — Polylines oficiais (`{codigo}_ida.json` e `{codigo}_volta.json`) das 29 linhas.
- `scripts/build_dataset.php` — Script CLI automatizado para atualizar polylines, paradas e horários a partir das fontes autorizadas.
