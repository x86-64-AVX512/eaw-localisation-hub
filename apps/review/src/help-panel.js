const segment = (id, title, paragraphs, revision = 1) => ({ id, revision, title, text: paragraphs.join('\n\n') });
const SEGMENTS = [
  segment('start', '1. Что именно открыто', [
    'В заголовке всегда проверяйте путь файла, ветку и выбранную версию. «Основная версия» – общий документ команды. Версия с названием тикета – отдельный черновик этого тикета; изменения между ними сами по себе не перетекают.',
    'Состояние подключения находится справа вверху. Пока документ синхронизируется, меняет ветку или заблокирован новым Git-коммитом, не пытайтесь обходить режим чтения: дождитесь понятного статуса либо выполните указанное действие в GitHub Desktop.',
    'Слева показаны люди именно в этом документе, их курсоры и брони. Справа находятся комментарии и предложения. Щелчок по подсвеченному месту в тексте прокручивает правую колонку к связанной карточке.',
  ]),
  segment('editing', '2. Обычное редактирование', [
    'Режим «Редактирование» меняет вашу авторскую версию документа сразу. Другие участники видят результат в совместной версии, но их изменения не записываются в ваш физический Git-файл.',
    'Ctrl+Z отменяет вашу последнюю редакторскую операцию, Ctrl+Y возвращает отменённую. После новой правки отменённая ветка повторов может исчезнуть – это обычное поведение истории редактора.',
    'Не редактируйте YAML-заголовок и ключ слева от значения без необходимости. Перед коммитом откройте «Локальный файл» и проверьте персональный итог: именно он материализуется в репозитории и попадёт в GitHub Desktop.',
  ]),
  segment('suggestions', '3. Режим «Правки»', [
    'Режим «Правки» не заменяет исходный текст сразу. Ввод, удаление и замена создают предложение с удалённой и добавленной частями, как в Google Docs. Можно менять одну букву, целое слово или несколько строк.',
    'Пока вы продолжаете печатать внутри своей открытой правки, Hub обновляет одну карточку. Кнопки карточки позволяют ответить, продолжить редактирование, принять, отклонить или удалить её. Принятие переносит текст в документ; отклонение сохраняет решение без применения.',
    'Ctrl+Z в этом режиме убирает последнюю созданную или изменённую вами правку, Ctrl+Y восстанавливает её. Перенос строки разрешён на границе слова; редактор не должен позволять разрезать защищённое слово посередине.',
  ]),
  segment('discussion', '4. Комментарии, ответы и брони', [
    'Для комментария выделите текст и нажмите «Комментарий». Ответ автору обсуждения отправляет мгновенное уведомление. Закрытое обсуждение остаётся в истории и может отображаться через фильтр принятых/закрытых элементов.',
    'Бронь создаётся по выделению слева. Выберите исполнителя и при необходимости оставьте примечание. Бронь сообщает намерение команды, но технически не запрещает правку и не заменяет договорённость между людьми.',
    'Не создавайте несколько карточек про один и тот же участок без причины. Используйте ответы в существующей карточке: так автор получит уведомление, а контекст не расползётся по правой колонке.',
  ]),
  segment('personal-file', '5. Совместная версия и локальный файл', [
    'Сервер хранит общий документ и независимые авторские изменения. По умолчанию рабочий файл строится как «Git HEAD + только мои изменения», поэтому чужие правки не попадают в ваш коммит без выбора.',
    'У каждого ключа, которым совместная версия отличается от Git HEAD, слева от номера строки есть отдельная галочка. Нажатие включает только этот ключ в локальный файл; повторное нажатие возвращает для него Git-вариант. Добавленные и удалённые ключи выбираются так же независимо.',
    'Кнопка «Локальный файл» показывает полный список различий и те же галочки с вариантами до и после. Зелёная плашка над редактором остаётся видна, пока в локальный файл включено хотя бы одно совместное изменение. «Снять все и записать Git HEAD» очищает выбор, а «Вернуть Git + мои» восстанавливает вашу авторскую версию.',
  ], 2),
  segment('git-updates', '6. Git, обновления и смена ветки', [
    'Hub отслеживает только поддерживаемые `.yml`: `localisation/russian`, `localisation/english`, `localisation/replace/russian` и `localisation/replace/english`. Новый коммит вне этих папок не должен блокировать работу.',
    'Жёлтая плашка сообщает о новом коммите в ветке. Красная плашка появляется только если в пропущенных коммитах изменился именно открытый файл; редактирование разблокируется после Pull в GitHub Desktop и автоматического повторного подключения Agent.',
    'При смене ветки дождитесь завершения переключения в GitHub Desktop. Agent проверяет устойчивое состояние Git и горячо переподключает Review. Если Git сообщает detached/unknown, интерфейс временно становится только для чтения, а не подменяет имя ветки.',
  ]),
  segment('conflicts', '7. Конфликты Git', [
    'Конфликт возникает, когда одна и та же локализационная сущность разошлась между Git-базой, совместной версией и внешним файлом. Откройте конфликт слева: diff показывает обе стороны с переносом длинных строк.',
    '«Оставить совместный» выбирает вариант Hub, «Принять из Git» – содержимое рабочей Git-стороны. Сначала прочитайте diff, затем применяйте решение; после успешного разрешения карточка должна исчезнуть без перезапуска Agent или Review.',
    'Если конфликт уже разрешён, но карточка осталась, не нажимайте решение многократно. Подождите пересчёт состояния; при реальной ошибке сохраните текст сообщения и путь файла для диагностики.',
  ]),
  segment('tickets', '8. Тикеты от создания до применения', [
    'Тикет фиксирует базовую ветку, базовый коммит и список файлов. Работа внутри него изолирована от основной версии. Каталог «Все тикеты» нужен для поиска, смены статуса, открытия и архивирования.',
    'Если базовая ветка ушла вперёд, rebase переносит тикет на новый Git-коммит и показывает конфликты отдельно. Применение тикета проверяет ожидаемые ревизии всех файлов и только затем атомарно переносит результат в основные документы.',
    'Автор тикета получает десятиминутные сводки о действиях с состоянием и отдельные сводки редактирования: кто работал и сколько строк, слов и символов было затронуто. Это числа для ориентира, а не замена просмотру diff.',
  ]),
  segment('language-tools', '9. Английский оригинал и ключи', [
    '«Английский оригинал» берёт ключ под курсором и открывает парный английский файл только для чтения. Для файлов `localisation/replace/russian` пара ищется внутри `localisation/replace/english`.',
    '«Изменить по ключам» принимает строки вида `key:0 "текст"` или `key: "текст"`. Сначала выберите русский либо английский язык и изучите предпросмотр. Поиск охватывает обычную и `replace`-папку выбранного языка; отсутствующие или неоднозначные ключи блокируют применение.',
    '«Сверка» сравнивает парные русский и английский файлы в двух режимах. «Ключи» показывает пропуски и дубликаты. «Строки и порядок» требует точного совпадения количества физических строк, пустых мест, последовательности ключей и отдельных строк-комментариев. Хвосты после значения ключа, например #Snow #First event, видны в колонках, но различия в них не считаются ошибкой.',
  ]),
  segment('history-diff', '10. История Hub и Git diff', [
    '«История» показывает совместные серверные версии документа: кто и когда менял текст. Восстановление создаёт новую версию и не уничтожает старую историю, комментарии, брони или правки.',
    '«Git diff» показывает историю коммитов именно этого файла и следует за переименованиями. Выберите независимо левый и правый коммиты – так можно одним сравнением увидеть путь от ранней версии до HEAD.',
    'Версии истории, Git diff, diff тикетов и сверка локализации кэшируются на этом компьютере и повторно открываются быстрее. Кэш ограничен по размеру и не заменяет исходные данные; удалить его можно в «Настройки → Локальный кэш диффов».',
  ], 2),
  segment('notifications', '11. Уведомления без спама', [
    'Ответ на ваш комментарий или обсуждение правки приходит сразу. Принятие и отклонение ваших правок объединяются в один пакет через десять минут. Действия с вашим тикетом и собственно редактирование тикета идут отдельными десятиминутными сводками.',
    'Колокольчик «Уведомления» показывает непрочитанное число. Список и настройки хранятся локально на этом компьютере; сервер держит ограниченный журнал доставки, чтобы Review мог забрать пропущенные события после краткого отключения.',
    'В «Настройки» можно независимо выключить все уведомления или только звук. По умолчанию включено и то, и другое. Отключение не влияет на совместную работу и не рассылает настройку другим участникам.',
  ]),
  segment('agent-plugin', '12. Agent, Notepad++ и восстановление обучения', [
    'Desktop Agent должен быть запущен и авторизован: он связывает локальный Git, Review и сервер. По умолчанию закрытие окна завершает Agent. Если сознательно нужен фон, включите настройку работы в области уведомлений.',
    'В Notepad++-плагине оставлена только команда «Открыть текущий файл в Review». Панель совместной работы, синхронизация редактора, брони, комментарии, предложения и совместная история внутри Notepad++ полностью отключены и не могут быть включены настройкой. Вся совместная работа выполняется в Review.',
    'Прохождение каждого раздела записывается в аккаунт на сервере, поэтому переустановка не заставит проходить его снова. «Настройки → Повторить обучение» запускает добровольный повтор; будущая функция сможет получить новый обязательный раздел или повышенную ревизию существующего.',
  ], 2),
];

function versionParts(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)F(\d+)$/iu.exec(String(value));
  return match ? match.slice(1).map(Number) : [0, 0, 0, 0];
}
function newer(left, right) {
  const a = versionParts(left), b = versionParts(right);
  return a.some((value, index) => value !== b[index] && a.slice(0, index).every((v, i) => v === b[i]) && value > b[index]);
}

export function createHelpPanel({ state, token, showToast }) {
  const help = document.querySelector('#help-dialog');
  const tutorial = document.querySelector('#tutorial-dialog');
  const content = document.querySelector('#tutorial-content');
  const heading = document.querySelector('#tutorial-heading');
  const progress = document.querySelector('#tutorial-progress');
  const enabled = document.querySelector('#notifications-enabled');
  const sound = document.querySelector('#notification-sound');
  const cacheInfo = document.querySelector('#diff-cache-info');
  const cacheClear = document.querySelector('#diff-cache-clear');
  let index = 0;
  let mandatory = false;
  let saving = false;
  const completedThisWindow = new Map();

  function completedRevision(segmentId) {
    return Math.max(
      Number(state.trainingProgress[segmentId] ?? 0),
      Number(completedThisWindow.get(segmentId) ?? 0),
    );
  }

  async function saveProgress(segment) {
    try {
      const response = await fetch('/api/training', { method: 'PUT', headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      }, body: JSON.stringify({ segmentId: segment.id, revision: segment.revision }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Сервер вернул HTTP ${response.status}.`);
      state.trainingProgress = { ...state.trainingProgress, ...(payload.user?.trainingProgress ?? {}) };
      state.trainingProgress[segment.id] = Math.max(
        Number(state.trainingProgress[segment.id] ?? 0), segment.revision,
      );
      completedThisWindow.set(segment.id, segment.revision);
      return true;
    } catch (error) {
      showToast(`Прогресс обучения не сохранён: ${error.message}`, true);
      return false;
    }
  }
  function formatBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  }
  async function cacheRequest(method = 'GET') {
    const response = await fetch('/api/diff-cache', {
      method, headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }
  async function refreshCacheInfo() {
    cacheInfo.textContent = 'Подсчёт размера…';
    try {
      const stats = await cacheRequest();
      cacheInfo.textContent = `${stats.entries} записей · ${formatBytes(stats.bytes)} из ${formatBytes(stats.maximumBytes)}`;
    } catch (error) {
      cacheInfo.textContent = `Не удалось прочитать кэш: ${error.message}`;
    }
  }
  function render() {
    const segment = SEGMENTS[index];
    heading.textContent = segment.title;
    progress.textContent = `${index + 1} / ${SEGMENTS.length}`;
    content.textContent = segment.text;
    document.querySelector('#tutorial-back').disabled = index === 0;
    document.querySelector('#tutorial-next').textContent = index === SEGMENTS.length - 1 ? 'Завершить' : 'Далее';
  }
  function openTutorial(force = false) {
    mandatory = !force;
    index = force ? 0 : Math.max(0, SEGMENTS.findIndex((item) => completedRevision(item.id) < item.revision));
    render(); tutorial.showModal();
  }
  document.querySelector('#help-open').addEventListener('click', () => {
    help.showModal();
    void refreshCacheInfo();
  });
  document.querySelector('#help-close').addEventListener('click', () => help.close());
  cacheClear.addEventListener('click', async () => {
    cacheClear.disabled = true;
    try {
      const result = await cacheRequest('DELETE');
      const cleared = result.cleared ?? {};
      cacheInfo.textContent = `0 записей · 0 Б из ${formatBytes(result.maximumBytes)}`;
      showToast(`Кэш диффов очищен: удалено ${cleared.entries ?? 0} записей (${formatBytes(cleared.bytes)}).`);
    } catch (error) {
      showToast(`Не удалось очистить кэш диффов: ${error.message}`, true);
      await refreshCacheInfo();
    } finally { cacheClear.disabled = false; }
  });
  document.querySelector('#tutorial-repeat').addEventListener('click', () => { help.close(); openTutorial(true); });
  document.querySelector('#tutorial-back').addEventListener('click', () => { if (index > 0) { index -= 1; render(); } });
  document.querySelector('#tutorial-next').addEventListener('click', async () => {
    if (saving) return;
    saving = true;
    const next = document.querySelector('#tutorial-next');
    next.disabled = true;
    try {
      if (!await saveProgress(SEGMENTS[index])) return;
      if (index < SEGMENTS.length - 1) { index += 1; render(); } else tutorial.close();
    } finally {
      saving = false;
      next.disabled = false;
    }
  });
  tutorial.addEventListener('cancel', (event) => { if (mandatory) event.preventDefault(); });
  function refresh() {
    const notice = document.querySelector('#version-notice');
    const isNew = state.serverVersion && newer(state.serverVersion, state.version);
    notice.hidden = !isNew;
    if (isNew) notice.textContent = `Доступна новая версия EaW Localisation Hub ${state.serverVersion}. Установлена ${state.version}.`;
    // The initial Agent hello can precede its authenticated account refresh.
    // Do not interpret an unconfirmed empty map as a new user's server state.
    const incomplete = state.trainingProgressConfirmed === true
      && SEGMENTS.some((item) => completedRevision(item.id) < item.revision);
    if (incomplete && !tutorial.open) openTutorial(false);
  }
  for (const control of [enabled, sound]) control.addEventListener('change', () => {
    localStorage.setItem('eaw-hub-notifications', JSON.stringify({ enabled: enabled.checked, sound: sound.checked }));
    showToast('Настройки уведомлений сохранены на этом компьютере.');
  });
  try {
    const settings = JSON.parse(localStorage.getItem('eaw-hub-notifications') || '{}');
    enabled.checked = settings.enabled !== false; sound.checked = settings.sound !== false;
  } catch { /* defaults */ }
  return { refresh, dispose() {} };
}
