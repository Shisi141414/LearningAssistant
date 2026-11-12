# 创建「学习助手」桌面快捷方式（由 创建桌面快捷方式.bat 调用，也可右键“使用 PowerShell 运行”）
# 编码警告：本文件必须保持 UTF-8 with BOM——Windows PowerShell 5.1 对无 BOM 的 UTF-8
# 按 ANSI 读取，中文路径会乱码导致创建失败。v1 版把中文写进 bat 的命令参数，
# 被 cmd 按错误代码页解析而失败，本文件即为此重写的 v2。
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$target = Join-Path $projectDir '启动学习助手.bat'
if (-not (Test-Path $target)) { Write-Host "[错误] 未找到 $target"; exit 1 }
# GetFolderPath 会正确返回 OneDrive 重定向后的桌面（Windows 11 常见）
$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop) { Write-Host '[错误] 无法定位桌面目录'; exit 1 }
$lnkPath = Join-Path $desktop '学习助手.lnk'
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = $target
$lnk.WorkingDirectory = $projectDir
$icon = Join-Path $projectDir 'node_modules\electron\dist\electron.exe'
if (Test-Path $icon) { $lnk.IconLocation = "$icon,0" }
$lnk.Save()
Write-Host "已创建桌面快捷方式：$lnkPath"
