#ifndef AppVersion
  #define AppVersion "0.8.9-beta.5"
#endif
#ifndef PayloadDir
  #define PayloadDir "..\dist\EaW-Hub-Client-" + AppVersion
#endif
#ifndef WindowsFileVersion
  #define WindowsFileVersion "0.8.9.5"
#endif

#define AppGuid "{{B84E4DE8-27A1-4DC2-ACF7-AB7779F76FC8}"
#define WebView2DownloadUrl "https://go.microsoft.com/fwlink/p/?LinkId=2124703"

[Setup]
AppId={#AppGuid}
AppName=EaW Localisation Hub
AppVersion={#AppVersion}
AppVerName=EaW Localisation Hub {#AppVersion}
AppPublisher=EaW Localisation Hub
VersionInfoVersion={#WindowsFileVersion}
VersionInfoProductVersion={#WindowsFileVersion}
DefaultDirName={autopf}\EaW Localisation Hub
DefaultGroupName=EaW Localisation Hub
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist
OutputBaseFilename=EaW-Localisation-Hub-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
CloseApplicationsFilter=EaWReview.exe
RestartApplications=no
UninstallDisplayName=EaW Localisation Hub {#AppVersion}
UninstallDisplayIcon={app}\review\EaWReview.exe
SetupLogging=yes
UsedUserAreasWarning=no
MinVersion=10.0.17763
LanguageDetectionMethod=uilanguage

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

[CustomMessages]
english.Extras=Additional options:
russian.Extras=Дополнительно:
english.Autostart=Start Agent when signing in to Windows
russian.Autostart=Запускать Agent при входе в Windows
english.DesktopIcon=Create a Review shortcut on the desktop
russian.DesktopIcon=Создать ярлык Review на рабочем столе
english.LaunchAgent=Launch EaW Localisation Hub Agent
russian.LaunchAgent=Запустить EaW Localisation Hub Agent
english.InstallCodex=Install Codex CLI for proofreading (requires internet)
russian.InstallCodex=Установить Codex CLI для проверки текста (нужен интернет)
english.WebViewPrompt=Review requires Microsoft Edge WebView2 Runtime version 114.0.1823.32 or later. Open the official Microsoft installer?
russian.WebViewPrompt=Для Review нужен Microsoft Edge WebView2 Runtime версии 114.0.1823.32 или новее. Открыть официальный установщик Microsoft?
english.WebViewRequired=Install or update WebView2 Runtime and run EaW Hub Setup again.
russian.WebViewRequired=Установите или обновите WebView2 Runtime и повторите установку EaW Hub.
english.DeleteSettings=Delete local EaW Hub settings? Saved tokens in Windows Credential Manager will remain; remove them using the Sign out button before uninstalling the application.
russian.DeleteSettings=Удалить локальные настройки EaW Hub? Сохранённые токены в Windows Credential Manager останутся; их следует удалить кнопкой «Выйти» до удаления программы.

[Tasks]
Name: "autostart"; Description: "{cm:Autostart}"; GroupDescription: "{cm:Extras}"; Flags: unchecked
Name: "desktopicon"; Description: "{cm:DesktopIcon}"; GroupDescription: "{cm:Extras}"; Flags: unchecked

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\EaW Localisation Hub Review"; Filename: "{app}\Launch EaW Hub Review.cmd"; WorkingDir: "{app}"
Name: "{group}\EaW Localisation Hub Agent"; Filename: "{app}\Launch EaW Hub Agent.cmd"; WorkingDir: "{app}"
Name: "{group}\EaW Localisation Hub Admin"; Filename: "{app}\Launch EaW Hub Admin.cmd"; WorkingDir: "{app}"
Name: "{group}\EaW Localisation Hub Team Management"; Filename: "{app}\Launch EaW Hub Team Management.cmd"; WorkingDir: "{app}"
Name: "{autodesktop}\EaW Localisation Hub Review"; Filename: "{app}\Launch EaW Hub Review.cmd"; WorkingDir: "{app}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "EaWLocalisationHubAgent"; ValueData: "{app}\Launch EaW Hub Agent.cmd"; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\install-codex.ps1"" -Language {language}"; Description: "{cm:InstallCodex}"; WorkingDir: "{app}"; Flags: postinstall runasoriginaluser skipifsilent unchecked
Filename: "{app}\Launch EaW Hub Agent.cmd"; Description: "{cm:LaunchAgent}"; WorkingDir: "{app}"; Flags: postinstall nowait skipifsilent unchecked

[Code]
const
  WebView2ClientId = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2ClientKey = 'Software\Microsoft\EdgeUpdate\Clients\' + WebView2ClientId;

var
  DeleteUserState: Boolean;

function HasSupportedWebView2(RootKey: Integer): Boolean;
var
  Version, Part: string;
  Components: array[0..3] of Word;
  I, Separator, Number: Integer;
begin
  Result := False;
  if not RegQueryStringValue(RootKey, WebView2ClientKey, 'pv', Version) then Exit;
  for I := 0 to 3 do
  begin
    Separator := Pos('.', Version);
    if I < 3 then
    begin
      if Separator < 2 then Exit;
      Part := Copy(Version, 1, Separator - 1);
      Delete(Version, 1, Separator);
    end
    else
    begin
      if Separator <> 0 then Exit;
      Part := Version;
    end;
    Number := StrToIntDef(Part, -1);
    if (Number < 0) or (Number > 65535) then Exit;
    Components[I] := Number;
  end;
  Result := ComparePackedVersion(
    PackVersionComponents(Components[0], Components[1], Components[2], Components[3]),
    PackVersionComponents(114, 0, 1823, 32)) >= 0;
end;

function IsWebView2Installed: Boolean;
begin
  Result := HasSupportedWebView2(HKLM32) or HasSupportedWebView2(HKCU32) or
    HasSupportedWebView2(HKLM64) or HasSupportedWebView2(HKCU64);
end;

function PrepareToInstall(var NeedsRestart: Boolean): string;
var
  ErrorCode: Integer;
begin
  Result := '';
  if not IsWebView2Installed then
  begin
    if not WizardSilent then
      if MsgBox(ExpandConstant('{cm:WebViewPrompt}'),
        mbConfirmation, MB_YESNO) = IDYES then
        ShellExec('open', '{#WebView2DownloadUrl}', '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode);
    Result := ExpandConstant('{cm:WebViewRequired}');
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    DeleteUserState := MsgBox(
      ExpandConstant('{cm:DeleteSettings}'),
      mbConfirmation, MB_YESNO) = IDYES;

  if (CurUninstallStep = usPostUninstall) and DeleteUserState then
    DelTree(ExpandConstant('{localappdata}\EaWLocalisationHub'), True, True, True);
end;
