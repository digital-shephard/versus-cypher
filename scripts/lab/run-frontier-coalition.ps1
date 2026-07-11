[CmdletBinding()]
param(
    [string]$Models = ""
)

$ErrorActionPreference = "Stop"
$secureKey = Read-Host "OpenRouter API key" -AsSecureString
$keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)

try {
    $env:OPENROUTER_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
    if ($Models) {
        $env:VERSUS_COALITION_MODELS = $Models
    }
    npm run lab:coalition-models
    if ($LASTEXITCODE -ne 0) {
        throw "Frontier coalition laboratory failed with exit code $LASTEXITCODE"
    }
}
finally {
    Remove-Item Env:OPENROUTER_API_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:VERSUS_COALITION_MODELS -ErrorAction SilentlyContinue
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
}
