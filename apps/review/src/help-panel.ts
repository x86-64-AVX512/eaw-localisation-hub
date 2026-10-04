import { uiText } from '../../../packages/shared/src/ui-language.mts';
import { requiredElement } from './dom-elements.ts';

interface TutorialSegment { id: string; revision: number; title: string; text: string }
interface HelpState {
  trainingProgress: Record<string, number>;
  trainingProgressConfirmed?: boolean;
  serverVersion?: string;
  version: string;
}
interface HelpPanelOptions {
  state: HelpState;
  token: string;
  showToast: (message: string, isError?: boolean) => void;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

const segment = (id: string, title: string, paragraphs: string[], revision = 1): TutorialSegment =>
  ({ id, revision, title, text: paragraphs.join('\n\n') });
const SEGMENTS = [
  segment('start', uiText("1. Что именно открыто"), [
    uiText("В заголовке всегда проверяйте путь файла, ветку и выбранную версию. «Основная версия» – общий документ команды. Версия с названием тикета – отдельный черновик этого тикета; изменения между ними сами по себе не перетекают."),
    uiText("Состояние подключения находится в нижней строке. Вкладки над текстом переключают документы; панели участников и обсуждений можно скрыть через меню «Вид». Пока документ синхронизируется, меняет ветку или заблокирован новым Git-коммитом, дождитесь понятного статуса либо выполните указанное действие."),
    uiText("Слева показаны люди именно в этом документе, их курсоры и брони. Справа находятся комментарии и предложения. Щелчок по подсвеченному месту в тексте прокручивает правую колонку к связанной карточке."),
  ]),
  segment('editing', uiText("2. Обычное редактирование"), [
    uiText("Режим «Редактирование» меняет вашу авторскую версию документа сразу. Другие участники видят результат в совместной версии, но их изменения не записываются в ваш физический Git-файл."),
    uiText("Отмена убирает вашу последнюю редакторскую операцию, а повтор возвращает отменённую. После новой правки отменённая ветка повторов может исчезнуть – это обычное поведение истории редактора."),
    uiText("Не редактируйте YAML-заголовок и ключ слева от значения без необходимости. Перед коммитом откройте «Локальный файл» и проверьте персональный итог: именно он материализуется в репозитории и попадёт в GitHub Desktop."),
  ]),
  segment('suggestions', uiText("3. Режим «Правки»"), [
    uiText("Режим «Правки» не заменяет исходный текст сразу. Ввод, удаление и замена создают предложение с удалённой и добавленной частями, как в Google Docs. Можно менять одну букву, целое слово или несколько строк."),
    uiText("Пока вы продолжаете печатать внутри своей открытой правки, Hub обновляет одну карточку. Кнопки карточки позволяют ответить, продолжить редактирование, принять, отклонить или удалить её. Принятие переносит текст в документ; отклонение сохраняет решение без применения."),
    uiText("Отмена в этом режиме убирает последнюю созданную или изменённую вами правку, а повтор восстанавливает её. Перенос строки разрешён на границе слова; редактор не должен позволять разрезать защищённое слово посередине."),
  ]),
  segment('discussion', uiText("4. Комментарии, ответы и брони"), [
    uiText("Для комментария выделите текст и нажмите «Комментарий». Ответ автору обсуждения отправляет мгновенное уведомление. Закрытое обсуждение остаётся в истории и может отображаться через фильтр принятых/закрытых элементов."),
    uiText("Бронь создаётся по выделению слева. Выберите исполнителя и при необходимости оставьте примечание. Бронь сообщает намерение команды, но технически не запрещает правку и не заменяет договорённость между людьми."),
    uiText("Не создавайте несколько карточек про один и тот же участок без причины. Используйте ответы в существующей карточке: так автор получит уведомление, а контекст не расползётся по правой колонке."),
  ]),
  segment('personal-file', uiText("5. Совместная версия и локальный файл"), [
    uiText("Сервер хранит общий документ и независимые авторские изменения. По умолчанию рабочий файл строится как «Git HEAD + только мои изменения», поэтому чужие правки не попадают в ваш коммит без выбора."),
    uiText("У каждого ключа, которым совместная версия отличается от Git HEAD, слева от номера строки есть отдельная галочка. Нажатие включает только этот ключ в локальный файл; повторное нажатие возвращает для него Git-вариант. Добавленные и удалённые ключи выбираются так же независимо."),
    uiText("Кнопка «Локальный файл» показывает полный список различий и те же галочки с вариантами до и после. Зелёная плашка над редактором остаётся видна, пока в локальный файл включено хотя бы одно совместное изменение. «Снять все и записать Git HEAD» очищает выбор, а «Вернуть Git + мои» восстанавливает вашу авторскую версию."),
  ], 2),
  segment('git-updates', uiText("6. Git, обновления и смена ветки"), [
    uiText("Hub отслеживает только поддерживаемые `.yml`: `localisation/russian`, `localisation/english`, `localisation/replace/russian` и `localisation/replace/english`. Новый коммит вне этих папок не должен блокировать работу."),
    uiText("Жёлтая плашка сообщает о новом коммите в ветке. Красная плашка появляется только если в пропущенных коммитах изменился именно открытый файл; редактирование разблокируется после Pull в GitHub Desktop и автоматического повторного подключения Agent."),
    uiText("При смене ветки дождитесь завершения переключения в GitHub Desktop. Agent проверяет устойчивое состояние Git и горячо переподключает Review. Если Git сообщает detached/unknown, интерфейс временно становится только для чтения, а не подменяет имя ветки."),
  ]),
  segment('conflicts', uiText("7. Конфликты Git"), [
    uiText("Конфликт возникает, когда одна и та же локализационная сущность разошлась между Git-базой, совместной версией и внешним файлом. Откройте конфликт слева: diff показывает обе стороны с переносом длинных строк."),
    uiText("«Оставить совместный» выбирает вариант Hub, «Принять из Git» – содержимое рабочей Git-стороны. Сначала прочитайте diff, затем применяйте решение; после успешного разрешения карточка должна исчезнуть без перезапуска Agent или Review."),
    uiText("Если конфликт уже разрешён, но карточка осталась, не нажимайте решение многократно. Подождите пересчёт состояния; при реальной ошибке сохраните текст сообщения и путь файла для диагностики."),
  ]),
  segment('tickets', uiText("8. Тикеты от создания до применения"), [
    uiText("Тикет фиксирует базовую ветку, базовый коммит и список файлов. Работа внутри него изолирована от основной версии. Каталог «Все тикеты» нужен для поиска, смены статуса, открытия и архивирования."),
    uiText("Если базовая ветка ушла вперёд, rebase переносит тикет на новый Git-коммит и показывает конфликты отдельно. Применение тикета проверяет ожидаемые ревизии всех файлов и только затем атомарно переносит результат в основные документы."),
    uiText("Автор тикета получает десятиминутные сводки о действиях с состоянием и отдельные сводки редактирования: кто работал и сколько строк, слов и символов было затронуто. Это числа для ориентира, а не замена просмотру diff."),
  ]),
  segment('language-tools', uiText("9. Английский оригинал и ключи"), [
    uiText("«Английский оригинал» берёт ключ под курсором и открывает парный английский файл только для чтения. Для файлов `localisation/replace/russian` пара ищется внутри `localisation/replace/english`."),
    uiText("«Изменить по ключам» принимает строки вида `key:0 \"текст\"` или `key: \"текст\"`. Сначала выберите русский либо английский язык и изучите предпросмотр. Поиск охватывает обычную и `replace`-папку выбранного языка; отсутствующие или неоднозначные ключи блокируют применение."),
    uiText("«Сверка» сравнивает парные русский и английский файлы в двух режимах. «Ключи» показывает пропуски и дубликаты. «Строки и порядок» требует точного совпадения количества физических строк, пустых мест, последовательности ключей и отдельных строк-комментариев. Хвосты после значения ключа, например #Snow #First event, видны в колонках, но различия в них не считаются ошибкой."),
  ]),
  segment('history-diff', uiText("10. История Hub и Git diff"), [
    uiText("«История» показывает совместные серверные версии документа: кто и когда менял текст. Восстановление создаёт новую версию и не уничтожает старую историю, комментарии, брони или правки."),
    uiText("«Git diff» показывает историю коммитов именно этого файла и следует за переименованиями. Выберите независимо левый и правый коммиты – так можно одним сравнением увидеть путь от ранней версии до HEAD."),
    uiText("Версии истории, Git diff, diff тикетов и сверка локализации кэшируются на этом компьютере и повторно открываются быстрее. Кэш ограничен по размеру и не заменяет исходные данные; удалить его можно в «Настройки → Локальный кэш диффов»."),
  ], 2),
  segment('notifications', uiText("11. Уведомления без спама"), [
    uiText("Ответ на ваш комментарий или обсуждение правки приходит сразу. Принятие и отклонение ваших правок объединяются в один пакет через десять минут. Действия с вашим тикетом и собственно редактирование тикета идут отдельными десятиминутными сводками."),
    uiText("Колокольчик «Уведомления» показывает непрочитанное число. Список и настройки хранятся локально на этом компьютере; сервер держит ограниченный журнал доставки, чтобы Review мог забрать пропущенные события после краткого отключения."),
    uiText("В «Настройки» можно независимо выключить все уведомления или только звук. По умолчанию включено и то, и другое. Отключение не влияет на совместную работу и не рассылает настройку другим участникам."),
  ]),
  segment('agent-plugin', uiText("12. Agent, Review и восстановление обучения"), [
    uiText("Desktop Agent должен быть запущен и авторизован: он связывает локальный Git, Review и сервер. По умолчанию закрытие окна завершает Agent. Если сознательно нужен фон, включите настройку работы в области уведомлений."),
    uiText("Плагин Notepad++ удалён из поставки. Открывайте файлы через ярлык EaW Hub Review: он запускает Agent при необходимости и восстанавливает последний документ либо предлагает выбрать файл. Вся совместная работа выполняется в Review."),
    uiText("Прохождение каждого раздела записывается в аккаунт на сервере, поэтому переустановка не заставит проходить его снова. «Настройки → Повторить обучение» запускает добровольный повтор; будущая функция сможет получить новый обязательный раздел или повышенную ревизию существующего."),
  ], 3),
];

function versionParts(value: string): number[] {
  const match = /^(\d+)\.(\d+)\.(\d+)F(\d+)$/iu.exec(String(value));
  return match ? match.slice(1).map(Number) : [0, 0, 0, 0];
}
function newer(left: string, right: string): boolean {
  const a = versionParts(left), b = versionParts(right);
  return a.some((value, index) => value !== b[index] && a.slice(0, index).every((v, i) => v === b[i]) && value > b[index]);
}

export function createHelpPanel({ state, token, showToast }: HelpPanelOptions) {
  const help = requiredElement<HTMLDialogElement>('#help-dialog');
  const tutorial = requiredElement<HTMLDialogElement>('#tutorial-dialog');
  const content = requiredElement<HTMLElement>('#tutorial-content');
  const heading = requiredElement<HTMLElement>('#tutorial-heading');
  const progress = requiredElement<HTMLElement>('#tutorial-progress');
  const enabled = requiredElement<HTMLInputElement>('#notifications-enabled');
  const sound = requiredElement<HTMLInputElement>('#notification-sound');
  const cacheInfo = requiredElement<HTMLElement>('#diff-cache-info');
  const cacheClear = requiredElement<HTMLButtonElement>('#diff-cache-clear');
  const tutorialBack = requiredElement<HTMLButtonElement>('#tutorial-back');
  const tutorialNext = requiredElement<HTMLButtonElement>('#tutorial-next');
  const versionNotice = requiredElement<HTMLElement>('#version-notice');
  let index = 0;
  let mandatory = false;
  let saving = false;
  const completedThisWindow = new Map<string, number>();

  function completedRevision(segmentId: string): number {
    return Math.max(
      Number(state.trainingProgress[segmentId] ?? 0),
      Number(completedThisWindow.get(segmentId) ?? 0),
    );
  }

  async function saveProgress(segment: TutorialSegment): Promise<boolean> {
    try {
      const response = await fetch('/api/training', { method: 'PUT', headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      }, body: JSON.stringify({ segmentId: segment.id, revision: segment.revision }) });
      const payload = asRecord(await response.json().catch(() => ({})));
      if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : uiText("Сервер вернул HTTP {0}.", response.status));
      const progress = asRecord(asRecord(payload.user).trainingProgress);
      const mergedProgress = { ...state.trainingProgress };
      for (const [id, revision] of Object.entries(progress)) {
        const numericRevision = Number(revision);
        if (Number.isFinite(numericRevision)) mergedProgress[id] = numericRevision;
      }
      state.trainingProgress = mergedProgress;
      state.trainingProgress[segment.id] = Math.max(
        Number(state.trainingProgress[segment.id] ?? 0), segment.revision,
      );
      completedThisWindow.set(segment.id, segment.revision);
      return true;
    } catch (error) {
      showToast(uiText("Прогресс обучения не сохранён: {0}", error instanceof Error ? error.message : String(error)), true);
      return false;
    }
  }
  function formatBytes(value: unknown): string {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return uiText("{0} Б", bytes);
    if (bytes < 1024 * 1024) return uiText("{0} КБ", (bytes / 1024).toFixed(1));
    return uiText("{0} МБ", (bytes / (1024 * 1024)).toFixed(1));
  }
  async function cacheRequest(method = 'GET'): Promise<Record<string, unknown>> {
    const response = await fetch('/api/diff-cache', {
      method, headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
    });
    const payload = asRecord(await response.json().catch(() => ({})));
    if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`);
    return payload;
  }
  async function refreshCacheInfo() {
    cacheInfo.textContent = uiText("Подсчёт размера…");
    try {
      const stats = await cacheRequest();
      cacheInfo.textContent = uiText("{0} записей · {1} из {2}", stats.entries, formatBytes(stats.bytes), formatBytes(stats.maximumBytes));
    } catch (error) {
      cacheInfo.textContent = uiText("Не удалось прочитать кэш: {0}", error instanceof Error ? error.message : String(error));
    }
  }
  function render() {
    const segment = SEGMENTS[index];
    heading.textContent = segment.title;
    progress.textContent = `${index + 1} / ${SEGMENTS.length}`;
    content.textContent = segment.text;
    tutorialBack.disabled = index === 0;
    tutorialNext.textContent = index === SEGMENTS.length - 1 ? uiText("Завершить") : uiText("Далее");
  }
  function openTutorial(force = false) {
    mandatory = !force;
    index = force ? 0 : Math.max(0, SEGMENTS.findIndex((item) => completedRevision(item.id) < item.revision));
    render(); tutorial.showModal();
  }
  requiredElement<HTMLButtonElement>('#help-open').addEventListener('click', () => {
    help.showModal();
    void refreshCacheInfo();
  });
  requiredElement<HTMLButtonElement>('#help-close').addEventListener('click', () => help.close());
  cacheClear.addEventListener('click', async () => {
    cacheClear.disabled = true;
    try {
      const result = await cacheRequest('DELETE');
      const cleared = asRecord(result.cleared);
      cacheInfo.textContent = uiText("0 записей · 0 Б из {0}", formatBytes(result.maximumBytes));
      window.dispatchEvent(new Event('eaw-diff-cache-cleared'));
      showToast(uiText("Кэш диффов очищен: удалено {0} записей ({1}).", cleared.entries ?? 0, formatBytes(cleared.bytes)));
    } catch (error) {
      showToast(uiText("Не удалось очистить кэш диффов: {0}", error instanceof Error ? error.message : String(error)), true);
      await refreshCacheInfo();
    } finally { cacheClear.disabled = false; }
  });
  requiredElement<HTMLButtonElement>('#tutorial-repeat').addEventListener('click', () => { help.close(); openTutorial(true); });
  tutorialBack.addEventListener('click', () => { if (index > 0) { index -= 1; render(); } });
  tutorialNext.addEventListener('click', async () => {
    if (saving) return;
    saving = true;
    tutorialNext.disabled = true;
    try {
      if (!await saveProgress(SEGMENTS[index])) return;
      if (index < SEGMENTS.length - 1) { index += 1; render(); } else tutorial.close();
    } finally {
      saving = false;
      tutorialNext.disabled = false;
    }
  });
  tutorial.addEventListener('cancel', (event) => { if (mandatory) event.preventDefault(); });
  function refresh() {
    const isNew = state.serverVersion && newer(state.serverVersion, state.version);
    versionNotice.hidden = !isNew;
    if (isNew) versionNotice.textContent = uiText("Доступна новая версия EaW Localisation Hub {0}. Установлена {1}.", state.serverVersion, state.version);
    // The initial Agent hello can precede its authenticated account refresh.
    // Do not interpret an unconfirmed empty map as a new user's server state.
    const incomplete = state.trainingProgressConfirmed === true
      && SEGMENTS.some((item) => completedRevision(item.id) < item.revision);
    if (incomplete && !tutorial.open) openTutorial(false);
  }
  for (const control of [enabled, sound]) control.addEventListener('change', () => {
    localStorage.setItem('eaw-hub-notifications', JSON.stringify({ enabled: enabled.checked, sound: sound.checked }));
    showToast(uiText("Настройки уведомлений сохранены на этом компьютере."));
  });
  try {
    const settings = JSON.parse(localStorage.getItem('eaw-hub-notifications') || '{}');
    enabled.checked = settings.enabled !== false; sound.checked = settings.sound !== false;
  } catch { /* defaults */ }
  return { refresh, dispose() {} };
}
