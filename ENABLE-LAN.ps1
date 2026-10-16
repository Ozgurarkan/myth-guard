# Run once as administrator to let players on your Wi-Fi reach Myth Guard.
# It opens TCP port 5173 to the local subnet on PRIVATE networks only, and (optionally) lets your browser receive the
# game's sound (WebRTC, UDP) from the local subnet. It does not turn the firewall off. Safe to run again: it only
# adds a rule that is missing.
#
#   .\ENABLE-LAN.ps1               asks before adding the sound (UDP) rule
#   .\ENABLE-LAN.ps1 -SkipUdp      only the web port
#   .\ENABLE-LAN.ps1 -Yes          add the sound rule without asking
param(
    [int]$Port = 5173,
    [switch]$SkipUdp,
    [switch]$Yes
)
$ErrorActionPreference = 'Stop'

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    Write-Host 'This needs administrator rights. Right-click ENABLE-LAN.ps1 and choose "Run with PowerShell" as administrator.' -ForegroundColor Yellow
    exit 1
}

foreach ($old in 'NightCityGrid-LAN-5173') {
    if (Get-NetFirewallRule -Name $old -ErrorAction SilentlyContinue) { Remove-NetFirewallRule -Name $old }
}

# Web page, state and images: TCP, local subnet, Private networks only.
$tcpName = "RealmForge-LAN-$Port"
$existing = Get-NetFirewallRule -Name $tcpName -ErrorAction SilentlyContinue
if ($existing -and (($existing | Get-NetFirewallPortFilter).LocalPort -eq "$Port") -and ($existing.Profile -eq 'Private')) {
    Write-Host "Web rule already in place ($tcpName)."
} else {
    # An older version of this rule applied to every network profile: replace it.
    if ($existing) { Remove-NetFirewallRule -Name $tcpName }
    New-NetFirewallRule -Name $tcpName `
        -DisplayName 'Myth Guard - players on my network' `
        -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port `
        -RemoteAddress LocalSubnet -Profile Private | Out-Null
    Write-Host "Added the web rule ($tcpName): TCP $Port from the local subnet, Private networks."
}

# Sound (WebRTC over UDP) arrives at the GM's browser. A rule for the browser program, local subnet, Private only.
if (-not $SkipUdp) {
    $browsers = @(
        @{ Name = 'Edge';    Path = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe" },
        @{ Name = 'Edge';    Path = "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe" },
        @{ Name = 'Chrome';  Path = "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe" },
        @{ Name = 'Chrome';  Path = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe" },
        @{ Name = 'Firefox'; Path = "${env:ProgramFiles}\Mozilla Firefox\firefox.exe" }
    ) | Where-Object { $_.Path -and (Test-Path $_.Path) }
    if (-not $browsers) {
        Write-Host 'No known browser found for the sound rule. Sound still works through the fallback path.' -ForegroundColor Yellow
    } else {
        $go = $Yes
        if (-not $go) {
            $answer = Read-Host 'Let your browser receive game sound from players on your network (UDP, local subnet only)? [Y/n]'
            $go = ($answer -eq '' -or $answer -match '^[yY]')
        }
        if ($go) {
            foreach ($browser in $browsers) {
                $hash = [BitConverter]::ToString([Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($browser.Path))).Replace('-', '').Substring(0, 8)
                $udpName = "RealmForge-Sound-$($browser.Name)-$hash"
                if (Get-NetFirewallRule -Name $udpName -ErrorAction SilentlyContinue) {
                    Write-Host "Sound rule already in place ($($browser.Name))."
                } else {
                    New-NetFirewallRule -Name $udpName `
                        -DisplayName "Myth Guard - game sound ($($browser.Name))" `
                        -Direction Inbound -Action Allow -Protocol UDP -Program $browser.Path `
                        -RemoteAddress LocalSubnet -Profile Private | Out-Null
                    Write-Host "Added the sound rule for $($browser.Name)."
                }
            }
        } else {
            Write-Host 'Skipped the sound rule.'
        }
    }
}

# The rules above apply to Private networks only. Say so if this computer is on a Public one.
$public = Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq 'Public' }
if ($public) {
    $names = ($public | ForEach-Object { $_.Name }) -join ', '
    Write-Host ''
    Write-Host "Your current network ($names) is set to Public, so players cannot reach Myth Guard yet." -ForegroundColor Yellow
    Write-Host 'If this is your home network: Settings > Network & internet > Wi-Fi > your network > Network profile type > Private.' -ForegroundColor Yellow
    Write-Host 'Do not do this on a network you do not trust.' -ForegroundColor Yellow
} else {
    Write-Host 'Done. Players on your Wi-Fi can now reach Myth Guard.'
}
