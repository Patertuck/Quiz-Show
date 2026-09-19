$ErrorActionPreference = "Stop"
$python = Join-Path $PSScriptRoot "..\.venv\Scripts\python.exe"
& $python -m unittest discover -s tests -p "test_*.py"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node --test tests/*.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node --check js/app.js
node --check js/player.js
node --check js/display.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run test:visual
