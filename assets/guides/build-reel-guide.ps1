$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap(1080, 1920)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(235, 255, 255, 255))
$shade = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(105, 8, 11, 18))
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 5)
$safe = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(170, 80, 220, 180), 2)
$safe.DashStyle = [System.Drawing.Drawing2D.DashStyle]::Dash
$title = New-Object System.Drawing.Font('Segoe UI', 48, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$body = New-Object System.Drawing.Font('Segoe UI', 34, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$small = New-Object System.Drawing.Font('Segoe UI', 27, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$heart = New-Object System.Drawing.Drawing2D.GraphicsPath
try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.FillRectangle($shade, 0, 0, 1080, 190)
    $graphics.FillRectangle($shade, 0, 1470, 1080, 450)
    $graphics.FillRectangle($shade, 900, 750, 180, 720)
    $graphics.DrawRectangle($safe, 65, 230, 795, 1180)
    $graphics.DrawString('9:41', $small, $white, 50, 25)
    $graphics.FillRectangle($white, 949, 34, 57, 22)
    $graphics.DrawString('Reels', $title, $white, 48, 98)
    $graphics.DrawRectangle($pen, 950, 113, 65, 45)
    $graphics.DrawEllipse($pen, 970, 120, 28, 28)
    $heart.AddBezier(991, 938, 890, 870, 953, 818, 991, 857)
    $heart.AddBezier(991, 857, 1029, 818, 1092, 870, 991, 938)
    $graphics.DrawPath($pen, $heart)
    $graphics.DrawString('128K', $small, $white, 952, 951)
    $graphics.DrawEllipse($pen, 958, 1063, 68, 58)
    $graphics.DrawLines($pen, [System.Drawing.Point[]]@([System.Drawing.Point]::new(978, 1120), [System.Drawing.Point]::new(966, 1138), [System.Drawing.Point]::new(1005, 1121)))
    $graphics.DrawString('1,420', $small, $white, 951, 1151)
    $graphics.DrawPolygon($pen, [System.Drawing.Point[]]@([System.Drawing.Point]::new(956, 1268), [System.Drawing.Point]::new(1031, 1245), [System.Drawing.Point]::new(1008, 1320), [System.Drawing.Point]::new(991, 1286)))
    $graphics.DrawLine($pen, 991, 1286, 1031, 1245)
    $graphics.DrawString('32.5K', $small, $white, 950, 1339)
    $graphics.DrawString('...', $title, $white, 964, 1410)
    $graphics.DrawEllipse($pen, 52, 1540, 68, 68)
    $graphics.DrawString('@username', $body, $white, 140, 1552)
    $graphics.DrawRectangle($pen, 382, 1545, 130, 54)
    $graphics.DrawString('Follow', $small, $white, 406, 1556)
    $graphics.DrawString('A moment worth sharing.', $body, $white, 52, 1640)
    $graphics.DrawString('Behind the scene... more', $body, $white, 52, 1690)
    $graphics.DrawString('Original audio - username', $small, $white, 52, 1780)
    $graphics.DrawRectangle($pen, 950, 1750, 75, 75)
    $graphics.DrawEllipse($pen, 966, 1766, 43, 43)
    $graphics.DrawLine($pen, 45, 1870, 1035, 1870)
    $graphics.FillRectangle($white, 400, 1900, 280, 7)
    $output = Join-Path $PSScriptRoot 'ig_reel_guide_1080x1920.png'
    $bitmap.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)
    if ($bitmap.GetPixel(500, 500).A -ne 0) { throw 'Guide center must remain transparent' }
    Get-Item $output | Select-Object Name, Length
} finally {
    $heart.Dispose()
    $title.Dispose()
    $body.Dispose()
    $small.Dispose()
    $white.Dispose()
    $shade.Dispose()
    $pen.Dispose()
    $safe.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}