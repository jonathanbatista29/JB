@echo off
setlocal
rem ============================================================
rem  JB IHM - inicia o servidor de projetos (duplo clique)
rem  Para trocar a porta, mude a linha "set PORT=3000".
rem ============================================================
set PORT=3000
title JB IHM - servidor (porta %PORT%)
cd /d "%~dp0"

echo.
echo  ==========================================
echo    JB IHM - servidor de projetos
echo  ==========================================
echo.

rem --- 1. Node.js instalado? ---
where node >nul 2>nul
if errorlevel 1 (
  echo  [ERRO] Node.js nao encontrado.
  echo         Instale a versao LTS 22 ou mais nova em https://nodejs.org
  echo         e depois rode este arquivo de novo.
  echo.
  start "" https://nodejs.org
  pause
  exit /b 1
)

rem --- 2. Versao 22.13 ou mais nova (o banco SQLite vem embutido no Node) ---
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  for /f %%v in ('node -v') do echo  [ERRO] Node.js %%v e antigo. Instale a versao 22.13 ou mais nova em https://nodejs.org
  echo.
  start "" https://nodejs.org
  pause
  exit /b 1
)
for /f %%v in ('node -v') do echo  Node.js %%v encontrado.

rem --- 3. Dependencias: instala na primeira vez ou quando o programa for atualizado ---
set PRECISA_INSTALAR=0
if not exist "node_modules\" set PRECISA_INSTALAR=1
if exist "node_modules\" (
  node -e "const fs=require('fs');const a=fs.statSync('package-lock.json').mtimeMs;let b=0;try{b=fs.statSync('node_modules/.package-lock.json').mtimeMs}catch{};process.exit(a>b?1:0)"
  if errorlevel 1 set PRECISA_INSTALAR=1
)
if "%PRECISA_INSTALAR%"=="1" (
  echo  Instalando dependencias, aguarde... ^(so na primeira vez ou apos atualizar^)
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo  [ERRO] Falha ao instalar as dependencias. Verifique a internet e tente de novo.
    pause
    exit /b 1
  )
)

rem --- 4. Enderecos para abrir em outros PCs, tablets e celulares da rede ---
echo.
echo  Neste computador:  http://localhost:%PORT%/
echo  Na rede, use um destes enderecos:
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /c:"IPv4"') do (
  for /f "tokens=* delims= " %%j in ("%%i") do echo      http://%%j:%PORT%/
)
echo.
echo  Para PARAR o servidor, feche esta janela ou aperte Ctrl+C.
echo  Na primeira vez o Windows pode pedir para liberar o Node.js no firewall:
echo  marque "Redes privadas" e clique em Permitir para os outros paineis acessarem.
echo.

rem --- 5. Abre o navegador quando o servidor estiver pronto ---
start "" /min cmd /c "timeout /t 3 /nobreak >nul & start "" http://localhost:%PORT%/"

rem --- 6. Inicia o servidor (fica rodando nesta janela) ---
node --disable-warning=ExperimentalWarning server\index.js
echo.
echo  O servidor parou. Se apareceu um erro acima, ele explica o motivo
echo  ^(ex.: a porta %PORT% ja esta em uso por outro programa^).
pause
