#ifndef AppVersion
  #define AppVersion "0.8.8F10"
#endif
#ifndef PayloadDir
  #define PayloadDir "..\dist\EaW-Hub-Client-" + AppVersion
#endif
#ifndef WindowsFileVersion
  #define WindowsFileVersion "0.8.8.10"
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
english.WebViewPrompt=Review requires Microsoft Edge WebView2 Runtime. Open the official Microsoft installer?
russian.WebViewPrompt=Для Review необходим Microsoft Edge WebView2 Runtime. Открыть официальный установщик Microsoft?
english.WebViewRequired=Install WebView2 Runtime and run EaW Hub Setup again.
russian.WebViewRequired=Установите WebView2 Runtime и повторите установку EaW Hub.
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
Filename: "{app}\Launch EaW Hub Agent.cmd"; Description: "{cm:LaunchAgent}"; WorkingDir: "{app}"; Flags: postinstall nowait skipifsilent unchecked

[Code]
const
  WebView2ClientId = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

var
  DeleteUserState: Boolean;

function IsWebView2Installed: Boolean;
var
  Version: string;
begin
  Result :=
    (RegQueryStringValue(HKLM32, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\' + WebView2ClientId, 'pv', Version) and (Version <> '')) or
    (RegQueryStringValue(HKCU32, 'Software\Microsoft\EdgeUpdate\Clients\' + WebView2ClientId, 'pv', Version) and (Version <> '')) or
    (RegQueryStringValue(HKLM64, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\' + WebView2ClientId, 'pv', Version) and (Version <> '')) or
    (RegQueryStringValue(HKCU64, 'Software\Microsoft\EdgeUpdate\Clients\' + WebView2ClientId, 'pv', Version) and (Version <> ''));
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
