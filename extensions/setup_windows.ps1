# setup_windows.ps1
# OpenClaw Environment Setup for Windows
# Run this script to install all global dependencies for MemPlace, GSD, and MCP tools.

Write-Host "══════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  OpenClaw Windows Environment Bootstrap" -ForegroundColor Cyan
Write-Host "══════════════════════════════════════════" -ForegroundColor Cyan

# 1. Global npm packages
Write-Host "`n[1/4] Installing global npm packages..." -ForegroundColor Yellow
npm install -g mcporter
npm install -g get-shit-done-cc
Write-Host "✅ npm packages installed." -ForegroundColor Green

# 2. Python & MemPlace check
Write-Host "`n[2/4] Checking Python & MemPlace..." -ForegroundColor Yellow
if (Get-Command python -ErrorAction SilentlyContinue) {
    Write-Host "Python found: $(python --version)"
    # Suggest installing mempalace if missing
    Write-Host "Ensure you have installed mempalace: 'pip install mempalace'" -ForegroundColor Gray
} else {
    Write-Host "❌ Python not found! Please install Python 3.10+ from python.org" -ForegroundColor Red
}

# 3. Network Tools (Nmap)
Write-Host "`n[3/4] Checking Network Tools (Nmap)..." -ForegroundColor Yellow
if (Get-Command nmap -ErrorAction SilentlyContinue) {
    Write-Host "✅ Nmap found." -ForegroundColor Green
} else {
    Write-Host "⚠️  Nmap not found. It is recommended for the Network Reconnaissance prompt." -ForegroundColor Cyan
    Write-Host "Run: 'choco install nmap' or download from nmap.org" -ForegroundColor Gray
}

# 4. Plugin builds
Write-Host "`n[4/4] Building local plugins..." -ForegroundColor Yellow
$extDir = "C:\Users\Admin\.openclaw\extensions"

Write-Host "Building memory-memplace..."
Set-Location "$extDir\memory-memplace"
npm install; npm run build

Write-Host "Building gsd-bridge..."
Set-Location "$extDir\gsd-bridge"
npm install; npm run build

Write-Host "`n✅ All plugins built." -ForegroundColor Green

Write-Host "`n══════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Setup Complete! Restart OpenClaw." -ForegroundColor Cyan
Write-Host "══════════════════════════════════════════" -ForegroundColor Cyan
