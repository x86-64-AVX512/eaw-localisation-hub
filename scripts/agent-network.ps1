Add-Type -AssemblyName System.Net.Http
if (-not ('EawAgentHttpOperation' -as [type])) {
    Add-Type -ReferencedAssemblies 'System.dll','System.Core.dll','System.Net.Http.dll' -TypeDefinition @'
using System;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public sealed class EawAgentHttpResult {
    public int Status;
    public string Body = "";
    public string Error = "";
    public bool NetworkError;
}
public sealed class EawAgentHttpOperation : IDisposable {
    private readonly CancellationTokenSource cancel;
    private int disposed;
    public Task<EawAgentHttpResult> Task { get; private set; }
    public EawAgentHttpOperation(string url, string method, string body, string token, int timeoutMs) {
        cancel = new CancellationTokenSource(timeoutMs);
        Task = System.Threading.Tasks.Task.Run(async () => {
            try { return await Run(url, method, body, token).ConfigureAwait(false); }
            catch (Exception error) { return new EawAgentHttpResult { NetworkError = true, Error = error.Message }; }
        });
    }
    private async Task<EawAgentHttpResult> Run(string url, string method, string body, string token) {
        var result = new EawAgentHttpResult();
        var ct = cancel.Token;
        using (var handler = new HttpClientHandler { AllowAutoRedirect = false })
        using (var client = new HttpClient(handler))
        using (var request = new HttpRequestMessage(new HttpMethod(method), url)) {
            client.Timeout = System.Threading.Timeout.InfiniteTimeSpan;
            if (!String.IsNullOrEmpty(token)) request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
            if (!String.IsNullOrEmpty(body)) request.Content = new StringContent(body, Encoding.UTF8, "application/json");
            HttpResponseMessage response = null;
            using (ct.Register(() => { client.CancelPendingRequests(); if (response != null) response.Dispose(); })) {
                try {
                    response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
                    result.Status = (int)response.StatusCode;
                    using (var stream = await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
                    using (var bytes = new MemoryStream()) {
                        var buffer = new byte[8192]; int count;
                        while ((count = await stream.ReadAsync(buffer, 0, buffer.Length, ct).ConfigureAwait(false)) != 0) {
                            ct.ThrowIfCancellationRequested();
                            if (bytes.Length + count > 1024 * 1024) throw new IOException("Server response exceeds the size limit");
                            bytes.Write(buffer, 0, count);
                        }
                        result.Body = Encoding.UTF8.GetString(bytes.ToArray());
                    }
                    ct.ThrowIfCancellationRequested();
                } catch (Exception error) {
                    result.NetworkError = true;
                    result.Error = ct.IsCancellationRequested ? "Request timed out or was cancelled" : error.Message;
                } finally { if (response != null) response.Dispose(); }
            }
        }
        return result;
    }
    public void Dispose() {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        cancel.Cancel();
        Task.ContinueWith(_ => cancel.Dispose(), TaskScheduler.Default);
    }
}
'@
}

$script:agentRequests = @{}
$script:agentNetworkTimeoutMilliseconds = 8000
function Start-EawAgentRequest {
    param([string]$Key,[string]$Server,[string]$Url,[string]$Method='GET',$Body=$null,[string]$Token='',
          [scriptblock]$Success,[scriptblock]$Failure,[scriptblock]$Complete,[scriptblock]$DetachedResult,
          [int]$TimeoutMilliseconds=$script:agentNetworkTimeoutMilliseconds)
    if ($script:agentRequests.ContainsKey($Key)) { return $false }
    $json = if ($null -ne $Body) { $Body | ConvertTo-Json -Depth 12 -Compress } else { $null }
    $operation = [EawAgentHttpOperation]::new($Url,$Method,$json,$Token,$TimeoutMilliseconds)
    $script:agentRequests[$Key] = @{Operation=$operation;Server=$Server;Success=$Success;Failure=$Failure;Complete=$Complete;DetachedResult=$DetachedResult}
    return $true
}

function Receive-EawAgentRequests {
    param([string]$CurrentServer)
    foreach ($key in @($script:agentRequests.Keys)) {
        $entry = $script:agentRequests[$key]
        if (-not $entry) { continue }
        if (-not $entry.Operation.Task.IsCompleted) { continue }
        $script:agentRequests.Remove($key)
        try {
            $result = $entry.Operation.Task.GetAwaiter().GetResult()
            $payload = $null
            if ($result.Body) {
                try { $payload = $result.Body | ConvertFrom-Json -ErrorAction Stop }
                catch { $result.Error = 'Invalid JSON response'; $result.NetworkError = $true }
            }
            if (-not $result.NetworkError -and $result.Status -ne 204 -and ($null -eq $payload -or $payload -is [array] -or $payload -isnot [pscustomobject])) {
                $result.Error = 'Invalid JSON response'; $result.NetworkError = $true
            }
            if ($entry.Server -cne $CurrentServer) {
                # State and credential callbacks belong to the selected server. A
                # sent mutation may still report its outcome without applying them.
                if ($entry.DetachedResult) { & $entry.DetachedResult $result $payload $entry.Server }
                continue
            }
            if (-not $result.NetworkError -and $result.Status -ge 200 -and $result.Status -lt 300) {
                if ($entry.Success) { & $entry.Success $payload }
            } elseif ($entry.Failure) { & $entry.Failure $result $payload }
        } finally {
            $entry.Operation.Dispose()
            if ($entry.Complete) { & $entry.Complete }
        }
    }
}

function Stop-EawAgentRequests {
    param([string[]]$Keys)
    foreach ($key in @($script:agentRequests.Keys)) {
        if ($Keys -and $Keys -notcontains $key) { continue }
        $entry=$script:agentRequests[$key];$script:agentRequests.Remove($key)
        $entry.Operation.Dispose()
        if ($entry.Complete) { & $entry.Complete }
    }
}
