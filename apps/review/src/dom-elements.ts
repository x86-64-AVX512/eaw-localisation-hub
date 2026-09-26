export function requiredElement<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Не найден элемент ${selector}.`);
  return element;
}

export function requiredInput(selector: string): HTMLInputElement {
  const element = requiredElement<HTMLInputElement>(selector);
  if (typeof HTMLInputElement !== 'undefined' && !(element instanceof HTMLInputElement)) {
    throw new Error(`Ожидалось поле ввода ${selector}.`);
  }
  return element;
}

export function requiredSelect(selector: string): HTMLSelectElement {
  const element = requiredElement<HTMLSelectElement>(selector);
  if (typeof HTMLSelectElement !== 'undefined' && !(element instanceof HTMLSelectElement)) {
    throw new Error(`Ожидался список ${selector}.`);
  }
  return element;
}

export function requiredTextArea(selector: string): HTMLTextAreaElement {
  const element = requiredElement<HTMLTextAreaElement>(selector);
  if (typeof HTMLTextAreaElement !== 'undefined' && !(element instanceof HTMLTextAreaElement)) {
    throw new Error(`Ожидалось текстовое поле ${selector}.`);
  }
  return element;
}

export function requiredButton(selector: string): HTMLButtonElement {
  const element = requiredElement<HTMLButtonElement>(selector);
  if (typeof HTMLButtonElement !== 'undefined' && !(element instanceof HTMLButtonElement)) {
    throw new Error(`Ожидалась кнопка ${selector}.`);
  }
  return element;
}

export function requiredDialog(selector: string): HTMLDialogElement {
  const element = requiredElement<HTMLDialogElement>(selector);
  if (typeof HTMLDialogElement !== 'undefined' && !(element instanceof HTMLDialogElement)) {
    throw new Error(`Ожидалось диалоговое окно ${selector}.`);
  }
  return element;
}
