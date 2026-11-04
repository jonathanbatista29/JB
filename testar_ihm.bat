@echo off
setlocal
rem ============================================================
rem  JB IHM - roda os testes automaticos (duplo clique)
rem  Use depois de atualizar o programa, antes de colocar em producao.
rem ============================================================
title JB IHM - testes
cd /d "%~dp0"
echo.
echo  Rodando os testes automaticos da JB IHM...
echo  (usa uma pasta temporaria: nao mexe nos seus projetos)
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo  [ERRO] Node.js nao encontrado. Instale em https://nodejs.org
  pause
  exit /b 1
)
if not exist "node_modules\" call npm install --no-audit --no-fund
call npm test
if errorlevel 1 (
  echo.
  echo  ****************************************************
  echo   ALGUM TESTE FALHOU - veja acima as linhas "not ok".
  echo   Nao coloque esta versao em producao antes de corrigir.
  echo  ****************************************************
) else (
  echo.
  echo  Todos os testes passaram.
)
echo.
pause
