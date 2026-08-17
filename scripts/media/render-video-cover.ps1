param(
    [Parameter(Mandatory = $true)]
    [string]$SourcePath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies 'System.Drawing' -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct NativeImageSize { public int Width; public int Height; }

[Flags]
public enum ShellImageFlags {
    ResizeToFit = 0x0,
    BiggerSizeOk = 0x1,
    ThumbnailOnly = 0x8
}

[ComImport]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
[Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b")]
interface IShellItemImageFactory {
    [PreserveSig]
    int GetImage(NativeImageSize size, ShellImageFlags flags, out IntPtr bitmap);
}

public static class VideoCoverRenderer {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string path,
        IntPtr bindContext,
        ref Guid interfaceId,
        [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory item);

    [DllImport("gdi32.dll")]
    static extern bool DeleteObject(IntPtr handle);

    public static byte[] Render(string sourcePath, int width, int height) {
        try {
            return RenderShellThumbnail(sourcePath, width, height);
        } catch {
            return RenderFallback(width, height);
        }
    }

    static byte[] RenderShellThumbnail(string sourcePath, int width, int height) {
        Guid interfaceId = typeof(IShellItemImageFactory).GUID;
        IShellItemImageFactory item;
        SHCreateItemFromParsingName(sourcePath, IntPtr.Zero, ref interfaceId, out item);
        IntPtr handle = IntPtr.Zero;
        try {
            int result = item.GetImage(
                new NativeImageSize { Width = width, Height = height },
                ShellImageFlags.BiggerSizeOk | ShellImageFlags.ThumbnailOnly,
                out handle);
            Marshal.ThrowExceptionForHR(result);
            if (handle == IntPtr.Zero) throw new InvalidOperationException("No video thumbnail was returned");
            using (var image = Image.FromHbitmap(handle)) {
                return EncodePng(image);
            }
        } finally {
            if (handle != IntPtr.Zero) DeleteObject(handle);
            if (item != null && Marshal.IsComObject(item)) Marshal.FinalReleaseComObject(item);
        }
    }

    static byte[] RenderFallback(int width, int height) {
        using (var bitmap = new Bitmap(width, height))
        using (var graphics = Graphics.FromImage(bitmap))
        using (var background = new SolidBrush(Color.FromArgb(31, 36, 46)))
        using (var circle = new SolidBrush(Color.FromArgb(72, 107, 255)))
        using (var play = new SolidBrush(Color.White)) {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.FillRectangle(background, 0, 0, width, height);
            int radius = Math.Min(width, height) / 5;
            int centerX = width / 2;
            int centerY = height / 2;
            graphics.FillEllipse(circle, centerX - radius, centerY - radius, radius * 2, radius * 2);
            Point[] triangle = {
                new Point(centerX - radius / 3, centerY - radius / 2),
                new Point(centerX - radius / 3, centerY + radius / 2),
                new Point(centerX + radius / 2, centerY)
            };
            graphics.FillPolygon(play, triangle);
            return EncodePng(bitmap);
        }
    }

    static byte[] EncodePng(Image image) {
        using (var stream = new MemoryStream()) {
            image.Save(stream, ImageFormat.Png);
            return stream.ToArray();
        }
    }
}
'@

$resolved = (Resolve-Path -LiteralPath $SourcePath).Path
$bytes = [VideoCoverRenderer]::Render($resolved, 640, 360)
if (-not $bytes -or $bytes.Length -le 0) {
    throw 'Video cover renderer returned no PNG data.'
}
$stdout = [Console]::OpenStandardOutput()
$stdout.Write($bytes, 0, $bytes.Length)
$stdout.Flush()
