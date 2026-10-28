param([int]$Port,[string]$Case,[string]$ResultPath,[int]$TimeoutMilliseconds=300,[int]$ObserveMilliseconds=1400)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'agent-network.ps1')
$script:agentNetworkTimeoutMilliseconds=$TimeoutMilliseconds
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'start-agent-ui.ps1'),[ref]$tokens,[ref]$errors)
$wanted=@('Convert-AgentServerToHttp','Assert-SecureTransport','Get-HubApiErrorMessage','Invoke-HubAuthApi','Set-StateText','Complete-AgentStateCheck','Update-AgentStateView','Stop-AgentProcess','Cancel-AgentStart')
foreach($definition in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $wanted -contains $node.Name},$true)) {Invoke-Expression $definition.Extent.Text}
function Get-EawUiText {param([string]$Text,[object[]]$Values) if($Values){$Text -f $Values}else{$Text}}
function Get-EawUiMessage {param([string]$Text) $Text}
function Sync-AgentProcessReference {$script:agentProcess=$null;return $null}
function Get-EawHubCredentialTarget {return 'test-only'}
function Get-EawHubCredential {return @{Secret='test-only-not-a-real-token'}}
function Compare-EawHubDisplayVersion {return 0}
function Start-ClientUpdateCheck {}
$uiNetwork=@{Checking=$false;Account=$null;AccountServer=''}
$clientStatusMetadata=@{Version='0.8.9F1';Protocol=21}
$form=[Windows.Forms.Form]::new();$form.ShowInTaskbar=$false;$form.Opacity=0;$form.WindowState='Minimized'
$serverBox=[Windows.Forms.TextBox]::new();$serverBox.Text="ws://127.0.0.1:$Port"
$serverState=[Windows.Forms.Label]::new();$versionState=[Windows.Forms.Label]::new();$tokenState=[Windows.Forms.Label]::new()
$lastCheckState=[Windows.Forms.Label]::new();$agentState=[Windows.Forms.Label]::new();$status=[Windows.Forms.Label]::new()
$checkStateButton=[Windows.Forms.Button]::new();$reviewButton=[Windows.Forms.Button]::new()
$script:lastPulse=[DateTime]::UtcNow;$script:maxGap=0;$script:pulses=0;$script:localStopMs=0;$script:fixtureError='';$script:failures=@();$script:postComplete=$false;$script:postStatus=''
$pulse=[Windows.Forms.Timer]::new();$pulse.Interval=25
$pulse.Add_Tick({
 try {
  $now=[DateTime]::UtcNow;$script:maxGap=[Math]::Max($script:maxGap,($now-$script:lastPulse).TotalMilliseconds);$script:lastPulse=$now;$script:pulses++
  foreach($entry in @($script:agentRequests.Values)){if($entry.Operation.Task.IsCompleted){$reply=$entry.Operation.Task.GetAwaiter().GetResult();if($reply.Error){$script:failures+= $reply.Error}}}
  if($Case -eq 'body-cancel' -and $script:pulses -eq 10){$watch=[Diagnostics.Stopwatch]::StartNew();Stop-EawAgentRequests;$script:localStopMs=$watch.ElapsedMilliseconds;$watch.Stop()}
  Receive-EawAgentRequests -CurrentServer $serverBox.Text.Trim()
 }catch{$script:fixtureError=$_.Exception.ToString()}
})
$finish=[Windows.Forms.Timer]::new();$finish.Interval=$ObserveMilliseconds
$finish.Add_Tick({
 $finish.Stop()
 $result=@{case=$Case;maxGapMs=[Math]::Round($script:maxGap);pulses=$script:pulses;checking=$uiNetwork.Checking;pending=$script:agentRequests.Count;serverStatus=$serverState.Text;tokenStatus=$tokenState.Text;tokenRed=$tokenState.ForeColor -eq [Drawing.Color]::Firebrick;stopMs=$script:localStopMs;error=$script:fixtureError;failures=$script:failures;postComplete=$script:postComplete;postStatus=$script:postStatus;tokenConfirmed=($null -ne $uiNetwork.ConfirmedAt)}
 [IO.File]::WriteAllText($ResultPath,($result|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
 Stop-EawAgentRequests;$form.Close()
})
$trigger=[Windows.Forms.Timer]::new();$trigger.Interval=150
$trigger.Add_Tick({
 $trigger.Stop()
 try {
  Update-AgentStateView;Update-AgentStateView
  if($Case -in @('post','post-stall')){
   $body=@{password='original-fixture-value'}
   [void](Invoke-HubAuthApi -Route '/fixture-post' -Body $body -Success {$script:postStatus='saved'} -Failure {param($result,$payload) $script:postStatus=Get-HubApiErrorMessage $result $payload} -Complete {$script:postComplete=$true})
   $body.password='cleared-after-start'
  }
  if($Case -eq 'close-path'){$watch=[Diagnostics.Stopwatch]::StartNew();Stop-AgentProcess;$script:localStopMs=$watch.ElapsedMilliseconds;$watch.Stop()}
  if($Case -eq 'stale'){$serverBox.Text='ws://127.0.0.1:1'}
  if($Case -eq 'cancel'){Stop-EawAgentRequests}
 }catch{$script:fixtureError=$_.Exception.ToString()}
 $finish.Start()
})
$pulse.Start();$trigger.Start();[void]$form.ShowDialog()
$pulse.Dispose();$trigger.Dispose();$finish.Dispose();$form.Dispose()
