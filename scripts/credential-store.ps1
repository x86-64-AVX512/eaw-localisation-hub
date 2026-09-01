if (-not ('EawHubCredentialNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class EawHubCredentialNative {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public UInt32 Flags;
        public UInt32 Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public UInt32 CredentialBlobSize;
        public IntPtr CredentialBlob;
        public UInt32 Persist;
        public UInt32 AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);

    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);

    [DllImport("advapi32.dll")]
    public static extern void CredFree(IntPtr credential);
}
'@
}

function Get-EawHubServerOrigin {
    param([Parameter(Mandatory = $true)][string]$Server)
    $uri = $null
    if (-not [Uri]::TryCreate($Server.Trim(), [UriKind]::Absolute, [ref]$uri)) {
        throw 'Server URL is invalid.'
    }
    $scheme = $uri.Scheme.ToLowerInvariant()
    if ($scheme -eq 'http') { $scheme = 'ws' }
    elseif ($scheme -eq 'https') { $scheme = 'wss' }
    elseif ($scheme -notin @('ws', 'wss')) { throw 'Server URL must use ws://, wss://, http://, or https://.' }
    if (-not [string]::IsNullOrEmpty($uri.UserInfo)) {
        throw 'Server URL must not contain a user name or password.'
    }
    $port = if ($uri.IsDefaultPort -or $uri.Port -lt 1) {
        if ($scheme -eq 'wss') { 443 } else { 80 }
    } else { $uri.Port }
    $hostName = $uri.IdnHost.ToLowerInvariant()
    if ($hostName.Contains(':') -and -not $hostName.StartsWith('[')) { $hostName = '[' + $hostName + ']' }
    '{0}://{1}:{2}' -f $scheme, $hostName, $port
}

function Get-EawHubCredentialTarget {
    param(
        [Parameter(Mandatory = $true)][string]$Server,
        [ValidatePattern('^[A-Za-z][A-Za-z0-9.-]{0,63}$')][string]$Kind = 'AgentToken'
    )
    $origin = Get-EawHubServerOrigin -Server $Server
    $bytes = [Text.Encoding]::UTF8.GetBytes($origin)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $digest = ($sha256.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join ''
    } finally { $sha256.Dispose() }
    "EaWLocalisationHub.$Kind.$digest"
}

function Set-EawHubCredential {
    param(
        [Parameter(Mandatory = $true)][string]$Target,
        [Parameter(Mandatory = $true)][string]$UserName,
        [Parameter(Mandatory = $true)][string]$Secret
    )
    $bytes = [System.Text.Encoding]::Unicode.GetBytes($Secret)
    $blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
    try {
        [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
        $credential = [EawHubCredentialNative+CREDENTIAL]::new()
        $credential.Type = 1 # CRED_TYPE_GENERIC
        $credential.TargetName = $Target
        $credential.UserName = $UserName
        $credential.CredentialBlob = $blob
        $credential.CredentialBlobSize = $bytes.Length
        $credential.Persist = 2 # CRED_PERSIST_LOCAL_MACHINE
        if (-not [EawHubCredentialNative]::CredWrite([ref]$credential, 0)) {
            throw "Windows Credential Manager rejected the token (Win32 $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))."
        }
    }
    finally {
        $zeros = [byte[]]::new($bytes.Length)
        [Runtime.InteropServices.Marshal]::Copy($zeros, 0, $blob, $zeros.Length)
        [Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
    }
}

function Get-EawHubCredential {
    param([Parameter(Mandatory = $true)][string]$Target)
    $pointer = [IntPtr]::Zero
    if (-not [EawHubCredentialNative]::CredRead($Target, 1, 0, [ref]$pointer)) {
        $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($errorCode -eq 1168) { return $null } # ERROR_NOT_FOUND
        throw "Could not read Windows Credential Manager (Win32 $errorCode)."
    }
    try {
        $credential = [Runtime.InteropServices.Marshal]::PtrToStructure(
            $pointer,
            [type][EawHubCredentialNative+CREDENTIAL])
        $secret = if ($credential.CredentialBlobSize -gt 0) {
            [Runtime.InteropServices.Marshal]::PtrToStringUni(
                $credential.CredentialBlob,
                [int]($credential.CredentialBlobSize / 2))
        } else { '' }
        [pscustomobject]@{
            UserName = $credential.UserName
            Secret = $secret
        }
    }
    finally {
        [EawHubCredentialNative]::CredFree($pointer)
    }
}

function Remove-EawHubCredential {
    param([Parameter(Mandatory = $true)][string]$Target)
    if (-not [EawHubCredentialNative]::CredDelete($Target, 1, 0)) {
        $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($errorCode -ne 1168) {
            throw "Could not delete Windows credential (Win32 $errorCode)."
        }
    }
}

function Get-OrCreate-EawHubIpcSecret {
    $target = 'EaWLocalisationHub.IpcSecret'
    $credential = Get-EawHubCredential -Target $target
    if ($credential -and $credential.Secret.Length -ge 32) { return [string]$credential.Secret }
    $bytes = [byte[]]::new(32)
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) } finally { $random.Dispose() }
    $secret = [Convert]::ToBase64String($bytes)
    Set-EawHubCredential -Target $target -UserName 'EaW Hub local IPC' -Secret $secret
    $secret
}
