#ifndef AppVersion
  #define AppVersion "0.8.7F1"
#endif
#ifndef PayloadDir
  #define PayloadDir "..\dist\EaW-Hub-Client-" + AppVersion
#endif
#ifndef WindowsFileVersion
  #define WindowsFileVersion "0.8.7.1"
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
CloseApplicationsFilter=notepad++.exe
RestartApplications=no
UninstallDisplayName=EaW Localisation Hub {#AppVersion}
UninstallDisplayIcon={app}\review\EaWReview.exe
SetupLogging=yes
UsedUserAreasWarning=no
MinVersion=10.0.17763

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "autostart"; Description: "Запускать Agent при входе в Windows"; GroupDescription: "Дополнительно:"; Flags: unchecked
Name: "desktopicon"; Description: "Создать ярлык Review на рабочем столе"; GroupDescription: "Дополнительно:"; Flags: unchecked

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; Плагин является обязательным компонентом и намеренно не находится в секции Tasks/Components.
Source: "{#PayloadDir}\plugin\EawLocalisationHub.dll"; DestDir: "{code:GetNotepadPluginDirectory}"; Flags: ignoreversion restartreplace

[Icons]
Name: "{group}\EaW Localisation Hub Review"; Filename: "{app}\Launch EaW Hub Review.cmd"; WorkingDir: "{app}"
Name: "{group}\EaW Localisation Hub Agent"; Filename: "{app}\Launch EaW Hub Agent.cmd"; WorkingDir: "{app}"
Name: "{group}\EaW Localisation Hub Admin"; Filename: "{app}\Launch EaW Hub Admin.cmd"; WorkingDir: "{app}"
Name: "{group}\EaW Localisation Hub Team Management"; Filename: "{app}\Launch EaW Hub Team Management.cmd"; WorkingDir: "{app}"
Name: "{autodesktop}\EaW Localisation Hub Review"; Filename: "{app}\Launch EaW Hub Review.cmd"; WorkingDir: "{app}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "EaWLocalisationHubAgent"; ValueData: "{app}\Launch EaW Hub Agent.cmd"; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\Launch EaW Hub Agent.cmd"; Description: "Запустить EaW Localisation Hub Agent"; WorkingDir: "{app}"; Flags: postinstall nowait skipifsilent unchecked

[Code]
const
  SCS_64BIT_BINARY = 6;
  WebView2ClientId = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

var
  NotepadPage: TInputDirWizardPage;
  DeleteUserState: Boolean;

function GetBinaryType(lpApplicationName: string; var lpBinaryType: Cardinal): Boolean;
  external 'GetBinaryTypeW@kernel32.dll stdcall';

function FindNotepadDirectory: string;
var
  Candidate: string;
begin
  Result := ExpandConstant('{param:NotepadDir|}');
  if (Result <> '') and FileExists(AddBackslash(Result) + 'notepad++.exe') then
    exit;

  if RegQueryStringValue(HKLM64,
       'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Notepad++',
       'InstallLocation', Candidate) and
       FileExists(AddBackslash(Candidate) + 'notepad++.exe') then
  begin
    Result := Candidate;
    exit;
  end;

  Candidate := ExpandConstant('{autopf}\Notepad++');
  if FileExists(AddBackslash(Candidate) + 'notepad++.exe') then
  begin
    Result := Candidate;
    exit;
  end;

  Result := '';
end;

function IsNotepadX64(const Directory: string): Boolean;
var
  BinaryType: Cardinal;
begin
  Result := GetBinaryType(AddBackslash(Directory) + 'notepad++.exe', BinaryType) and
    (BinaryType = SCS_64BIT_BINARY);
end;

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

function IsNotepadRunning: Boolean;
begin
  Result := FindWindowByClassName('Notepad++') <> 0;
end;

procedure InitializeWizard;
var
  DetectedDirectory: string;
begin
  NotepadPage := CreateInputDirPage(wpSelectDir,
    'Notepad++ x64',
    'Укажите установленный Notepad++ x64',
    'Плагин Legacy входит в обязательную установку. Выберите папку, содержащую notepad++.exe.',
    False, '');
  NotepadPage.Add('Папка Notepad++ x64:');
  DetectedDirectory := FindNotepadDirectory;
  if DetectedDirectory <> '' then
    NotepadPage.Values[0] := DetectedDirectory
  else
    NotepadPage.Values[0] := ExpandConstant('{autopf}\Notepad++');
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  ExecutablePath: string;
  ErrorCode: Integer;
begin
  Result := True;
  if CurPageID <> NotepadPage.ID then
    exit;

  ExecutablePath := AddBackslash(NotepadPage.Values[0]) + 'notepad++.exe';
  if not FileExists(ExecutablePath) then
  begin
    MsgBox('В выбранной папке не найден notepad++.exe. Установите Notepad++ x64 или выберите правильную папку.',
      mbError, MB_OK);
    Result := False;
    exit;
  end;
  if not IsNotepadX64(NotepadPage.Values[0]) then
  begin
    MsgBox('Найдена не 64-битная версия Notepad++. Текущий плагин поддерживает только Notepad++ x64.',
      mbError, MB_OK);
    Result := False;
    exit;
  end;

  if not IsWebView2Installed then
  begin
    if MsgBox('Для Review необходим Microsoft Edge WebView2 Runtime. Он не найден. Открыть официальный установщик Microsoft?',
      mbConfirmation, MB_YESNO) = IDYES then
      ShellExec('open', '{#WebView2DownloadUrl}', '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode);
    MsgBox('Установите WebView2 Runtime и затем снова нажмите «Далее». Закрывать мастер EaW Hub не требуется.',
      mbInformation, MB_OK);
    Result := False;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): string;
begin
  Result := '';
  if IsNotepadRunning then
  begin
    Result := 'Закройте все окна Notepad++ и снова нажмите «Установить»: обязательный плагин нельзя безопасно обновить во время работы редактора.';
  end;
end;

function GetNotepadPluginDirectory(Param: string): string;
begin
  Result := AddBackslash(NotepadPage.Values[0]) + 'plugins\EawLocalisationHub';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    DeleteUserState := MsgBox(
      'Удалить локальные настройки EaW Hub? Сохранённые токены в Windows Credential Manager останутся; их следует удалить кнопкой «Выйти» до удаления программы.',
      mbConfirmation, MB_YESNO) = IDYES;

  if (CurUninstallStep = usPostUninstall) and DeleteUserState then
    DelTree(ExpandConstant('{localappdata}\EaWLocalisationHub'), True, True, True);
end;
