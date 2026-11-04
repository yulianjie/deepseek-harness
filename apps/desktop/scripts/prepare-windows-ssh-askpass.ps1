<# Build the OpenSSH password helper as an x64 executable with no external CRT dependency. #>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$OutputDirectory)

$ErrorActionPreference = 'Stop'
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $output | Out-Null
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw 'SSH password support requires Visual Studio C++ Build Tools.' }
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $visualStudio) { throw 'Visual Studio C++ Build Tools are missing.' }
$vcvars = Join-Path $visualStudio 'VC/Auxiliary/Build/vcvars64.bat'
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../remote-ssh/host/connection/askpass-windows.c'))
$compileScript = Join-Path $output 'compile-ssh-askpass.cmd'
$object = Join-Path $output 'askpass.obj'
$executable = Join-Path $output 'askpass.exe'
$compile = 'cl /nologo /TC /O2 /W4 /WX /MT "{0}" /Fo"{1}" /Fe"{2}" /link ws2_32.lib' -f $source, $object, $executable
$lines = @('@echo off', ('call "{0}" >nul' -f $vcvars), 'if errorlevel 1 exit /b %errorlevel%', $compile)
[IO.File]::WriteAllLines($compileScript, $lines, [Text.Encoding]::Default)
& $env:ComSpec /d /c $compileScript
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw 'SSH password helper compilation failed.'
}
