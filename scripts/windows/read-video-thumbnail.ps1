$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$requestBody = [Console]::In.ReadToEnd()
$request = $requestBody | ConvertFrom-Json
$inputPath = [System.IO.Path]::GetFullPath([string]$request.inputPath)
if (-not [System.IO.File]::Exists($inputPath)) {
    throw 'Video thumbnail input is not a regular file.'
}

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct BridgeThumbnailSize
{
    public int Width;
    public int Height;
}

[Flags]
public enum BridgeThumbnailFlags
{
    ResizeToFit = 0,
    ThumbnailOnly = 8
}

[ComImport]
[Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IBridgeShellItemImageFactory
{
    [PreserveSig]
    int GetImage(BridgeThumbnailSize size, BridgeThumbnailFlags flags, out IntPtr bitmapHandle);
}

public static class BridgeVideoThumbnail
{
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int SHCreateItemFromParsingName(
        string path,
        IntPtr bindContext,
        ref Guid interfaceId,
        out IBridgeShellItemImageFactory factory);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr handle);

    public static byte[] Read(string path, int width, int height)
    {
        Guid interfaceId = new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b");
        IBridgeShellItemImageFactory factory;
        int createResult = SHCreateItemFromParsingName(path, IntPtr.Zero, ref interfaceId, out factory);
        if (createResult != 0) Marshal.ThrowExceptionForHR(createResult);

        IntPtr bitmapHandle = IntPtr.Zero;
        try
        {
            int imageResult = factory.GetImage(
                new BridgeThumbnailSize { Width = width, Height = height },
                BridgeThumbnailFlags.ThumbnailOnly,
                out bitmapHandle);
            if (imageResult != 0) Marshal.ThrowExceptionForHR(imageResult);

            using (Image image = Image.FromHbitmap(bitmapHandle))
            using (MemoryStream stream = new MemoryStream())
            {
                image.Save(stream, ImageFormat.Png);
                return stream.ToArray();
            }
        }
        finally
        {
            if (bitmapHandle != IntPtr.Zero) DeleteObject(bitmapHandle);
            if (factory != null) Marshal.ReleaseComObject(factory);
        }
    }
}
'@

$thumbnail = [BridgeVideoThumbnail]::Read($inputPath, 640, 360)
[Console]::Out.Write([Convert]::ToBase64String($thumbnail))
