@echo off
setlocal
rem ============================================================
rem  JB IHM - abre o painel de operacao em TELA CHEIA (modo quiosque)
rem  Sem barra de endereco, sem abas: so a tela da IHM.
rem  Troque o endereco abaixo pelo do seu projeto, ex.:
rem    set URL=http://10.106.233.51:3000/carrossel-l1/
rem  Para FECHAR o painel: Alt+F4.
rem  Para abrir sozinho ao ligar o PC: coloque um atalho deste arquivo em
rem    Win+R  ->  shell:startup
rem ============================================================
set URL=http://localhost:3000/

set NAV=
for %%p in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
) do if not defined NAV if exist %%p set NAV=%%p

if not defined NAV (
  echo  [ERRO] Chrome ou Edge nao encontrado.
  pause
  exit /b 1
)

rem Perfil separado: funciona mesmo com o navegador normal aberto e guarda o login do painel.
start "" %NAV% --kiosk "%URL%" --edge-kiosk-type=fullscreen --no-first-run --disable-pinch --overscroll-history-navigation=0 --disable-session-crashed-bubble --user-data-dir="%LocalAppData%\JBIHM-painel"
