# Dot-source only: bounded, loopback-only protocol probe. No inference or thread creation.
function Test-CodexAppServerInitialize {
    param([Parameter(Mandatory)][string]$Url, [int]$TimeoutMilliseconds = 2000)
    $uri = [Uri]$Url
    if ($uri.Scheme -ne 'ws' -or $uri.Host -notin @('127.0.0.1', 'localhost', '::1') -or
        $uri.AbsolutePath -ne '/rpc' -or $uri.Port -le 0) { return $false }
    $socket = [Net.WebSockets.ClientWebSocket]::new()
    $cancel = [Threading.CancellationTokenSource]::new()
    $cancel.CancelAfter($TimeoutMilliseconds)
    try {
        $socket.Options.Proxy = $null
        [void]$socket.ConnectAsync($uri, $cancel.Token).GetAwaiter().GetResult()
        $initialize = '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"feishu_bridge_readiness","version":"1.0.0"}}}'
        $bytes = [Text.Encoding]::UTF8.GetBytes($initialize)
        [void]$socket.SendAsync([ArraySegment[byte]]::new($bytes),
            [Net.WebSockets.WebSocketMessageType]::Text, $true, $cancel.Token).GetAwaiter().GetResult()
        $buffer = [byte[]]::new(4096)
        $message = [IO.MemoryStream]::new()
        try {
            while (-not $cancel.IsCancellationRequested) {
                $part = $socket.ReceiveAsync([ArraySegment[byte]]::new($buffer), $cancel.Token).GetAwaiter().GetResult()
                if ($part.MessageType -ne [Net.WebSockets.WebSocketMessageType]::Text) { return $false }
                $message.Write($buffer, 0, $part.Count)
                if ($message.Length -gt 65536) { return $false }
                if (-not $part.EndOfMessage) { continue }
                $response = [Text.Encoding]::UTF8.GetString($message.ToArray()) | ConvertFrom-Json
                $message.SetLength(0)
                if ($response.id -ne 1) { continue }
                if ($response.error -or -not $response.PSObject.Properties['result']) { return $false }
                $bytes = [Text.Encoding]::UTF8.GetBytes('{"method":"initialized","params":{}}')
                [void]$socket.SendAsync([ArraySegment[byte]]::new($bytes),
                    [Net.WebSockets.WebSocketMessageType]::Text, $true, $cancel.Token).GetAwaiter().GetResult()
                return $true
            }
        } finally { $message.Dispose() }
        return $false
    } catch { return $false }
    finally {
        $socket.Abort()
        $socket.Dispose()
        $cancel.Dispose()
    }
}
