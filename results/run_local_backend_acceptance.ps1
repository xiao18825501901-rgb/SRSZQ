$ErrorActionPreference = 'Stop'
$env:SRSZQ_DATA_DIR = 'E:\SRSZQ\01_CurrentProject\srszq-fourmode-matchchat-20261114-2236\srszq-bilingual-product-20261030\results\fourmode-current-acceptance-20261115\runtime-data-final'
$env:PORT = '8080'
$env:SRSZQ_WS_PORT = '8081'
$env:SRSZQ_ALLOWED_ORIGINS = 'http://127.0.0.1:5173'
$env:DEEPSEEK_API_KEY = $null
npm.cmd run start
