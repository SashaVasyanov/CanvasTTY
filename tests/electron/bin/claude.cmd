@echo off
rem Fake claude CLI for the Electron tests, found on PATH like the npm shim of the real one.
rem FAKE_CLI_NODE (set by tests/electron/fixtures.mjs) is the Node.js that runs the tests.
setlocal
set "FAKE_NODE=%FAKE_CLI_NODE%"
if not defined FAKE_NODE set "FAKE_NODE=node"
"%FAKE_NODE%" "%~dp0claude" %*
exit /b %ERRORLEVEL%
