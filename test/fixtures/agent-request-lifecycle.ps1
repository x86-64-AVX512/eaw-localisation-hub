param([string]$Root,[string]$Scratch,[int]$Port)
$ErrorActionPreference='Stop'
. (Join-Path $Root 'scripts\agent-network.ps1')
$script:agentNetworkTimeoutMilliseconds=350
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $Root 'scripts\start-agent-ui.ps1'),[ref]$tokens,[ref]$errors)
$wanted=@('Start-AgentProcess','Stop-AgentProcess','Cancel-AgentStart','Invoke-HubAuthApi','Convert-AgentServerToHttp','Assert-SecureTransport','Get-HubApiErrorMessage')
foreach($definition in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $wanted -contains $node.Name},$true)) {Invoke-Expression $definition.Extent.Text}
function Get-EawUiText {param([string]$Text,[object[]]$Values) if($Values){$Text -f $Values}else{$Text}}
function Get-EawUiMessage {param([string]$Text) $Text}
function Sync-AgentProcessReference {}
function Current-Config {return @{Repo=$Scratch;Server=$serverBox.Text;Color='#6aa9ff';User='Fixture'}}
function Get-EawHubCredentialTarget {return 'fixture-only'}
function Get-EawHubCredential {return @{Secret=$script:fixtureToken}}
function Save-AgentConfig {}
function Set-StartupShortcut {}
function Get-NodeExecutable {return 'fixture-only'}
function Quote-AgentArgument {param($Value) return $Value}
function Update-AgentStateView {}
# Process creation and termination are counted; no user Agent or configuration is touched.
function Start-Process {
    $script:launches++
    $process=[pscustomobject]@{Id=99999;HasExited=$false;Handle=1}
    $process|Add-Member ScriptMethod WaitForExit {param($timeout) return $true}
    return $process
}
function Stop-Process {$script:agentProcess.HasExited=$true}
$agentStartCheckTimer=[pscustomobject]@{}
$agentStartCheckTimer|Add-Member ScriptMethod Stop {}
$agentStartCheckTimer|Add-Member ScriptMethod Start {}
$startupCheck=@{Checked=$false}
$projectRoot=$Root;$logDirectory=$Scratch;$stateDirectory=$Scratch
$server="ws://127.0.0.1:$Port"
$results=[Collections.Generic.List[object]]::new()
function Reset-Fixture {
    Stop-EawAgentRequests
    $script:agentProcess=$null;$script:launches=0;$script:fixtureToken='fixture-ok'
    $script:uiNetwork=@{Account=$null;AccountServer='';StartIntent=$null;ConfirmedAt=$null}
    $script:serverBox=@{Text=$server};$script:status=@{Text='initial'}
    $script:successCalls=0;$script:failureCalls=0;$script:completeCalls=0
}
function Drain-Requests {
    $watch=[Diagnostics.Stopwatch]::StartNew()
    while($script:agentRequests.Count -and $watch.ElapsedMilliseconds -lt 5000){
        Receive-EawAgentRequests -CurrentServer $serverBox.Text
        Start-Sleep -Milliseconds 10
    }
    if($script:agentRequests.Count){throw 'Request fixture did not finish'}
}
function Invoke-OldCallbacks($entry) {
    & $entry.Success ([pscustomobject]@{user=[pscustomobject]@{displayName='Old account';temporaryPassword=$false}})
    & $entry.Failure ([pscustomobject]@{NetworkError=$true;Status=0}) $null
    if($entry.Complete){& $entry.Complete}
}

Reset-Fixture
Start-AgentProcess
$old=$script:agentRequests['start-check']
Stop-AgentProcess
Invoke-OldCallbacks $old
$results.Add(@{case='stop-cancels-start';launches=$script:launches;pending=$script:agentRequests.Count;intent=$uiNetwork.StartIntent;status=$status.Text})

Reset-Fixture
Start-AgentProcess;$old=$script:agentRequests['start-check']
Stop-AgentProcess
Start-AgentProcess;$newIntent=$uiNetwork.StartIntent
Invoke-OldCallbacks $old
$preserved=$uiNetwork.StartIntent -ceq $newIntent
Start-AgentProcess
$pending=$script:agentRequests.Count
Drain-Requests
$results.Add(@{case='new-start-survives-old-callback';preserved=$preserved;pendingBeforeDrain=$pending;launches=$script:launches})
Stop-AgentProcess

foreach($token in @('fixture-timeout','fixture-denied','fixture-temporary')){
    Reset-Fixture;$script:fixtureToken=$token
    Start-AgentProcess;Drain-Requests
    $results.Add(@{case=$token;launches=$script:launches;intent=$uiNetwork.StartIntent})
    Stop-AgentProcess
}

foreach($operation in @('password-change','logout')){
    foreach($outcome in @('ok','rejected','timeout')){
        Reset-Fixture
        $route=if($operation -eq 'password-change'){'/api/auth/password/change'}else{'/api/auth/logout'}
        [void](Invoke-HubAuthApi -Key $operation -Route $route -Body @{outcome=$outcome} -Operation $operation -Success {$script:successCalls++} -Failure {$script:failureCalls++} -Complete {$script:completeCalls++})
        $serverBox.Text='ws://127.0.0.1:1'
        Cancel-AgentStart;Stop-EawAgentRequests -Keys @('health-state','account-state')
        $uiNetwork.Account=[pscustomobject]@{displayName='Selected account'};$uiNetwork.AccountServer=$serverBox.Text
        $uiNetwork.ConfirmedAt=[datetime]'2026-01-01'
        Drain-Requests
        $results.Add(@{case="$operation-$outcome";status=$status.Text;successCalls=$script:successCalls;failureCalls=$script:failureCalls;completeCalls=$script:completeCalls;account=$uiNetwork.Account.displayName;accountServer=$uiNetwork.AccountServer;confirmed=$uiNetwork.ConfirmedAt.ToString('yyyy-MM-dd')})
    }
}

foreach($route in @('/api/auth/me','/api/auth/login')){
    Reset-Fixture
    $method=if($route -eq '/api/auth/me'){'GET'}else{'POST'}
    [void](Invoke-HubAuthApi -Route $route -Method $method -Success {$script:successCalls++} -Failure {$script:failureCalls++} -Complete {$script:completeCalls++})
    $serverBox.Text='ws://127.0.0.1:1'
    Drain-Requests
    $results.Add(@{case="stale-$method";successCalls=$script:successCalls;failureCalls=$script:failureCalls;completeCalls=$script:completeCalls;status=$status.Text})
}

Reset-Fixture
[void](Invoke-HubAuthApi -Key 'password-change' -Route '/api/auth/password/change' -Body @{outcome='ok'} -Operation 'password-change' -Success {$script:successCalls++} -Failure {$script:failureCalls++} -Complete {$script:completeCalls++})
Drain-Requests
$results.Add(@{case='same-server';successCalls=$script:successCalls;failureCalls=$script:failureCalls;completeCalls=$script:completeCalls;status=$status.Text})
Stop-EawAgentRequests
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$results.ToArray()|ConvertTo-Json -Depth 6 -Compress
