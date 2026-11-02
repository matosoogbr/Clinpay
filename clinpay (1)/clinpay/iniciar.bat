@echo off
cd /d "%~dp0"
title ClinPay - NAO FECHE ESTA JANELA
rem Para liberar o assistente de IA, tire o "rem" da linha abaixo e coloque a sua chave da Anthropic:
rem set ANTHROPIC_API_KEY=sua-chave-aqui
node server.js
pause
