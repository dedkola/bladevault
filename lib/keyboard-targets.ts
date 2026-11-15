/** True when a key press belongs to a text field, select or editable region. */
export function isEditableKeyTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

/**
 * Widgets that use the arrow keys themselves (tabs, menus, lists, sliders),
 * so a page-level arrow shortcut must leave their key presses alone.
 */
const ARROW_KEY_WIDGETS =
  '[role="tablist"], [role="menu"], [role="menubar"], [role="listbox"], [role="radiogroup"], [role="slider"], [role="grid"], [role="tree"]'

export function usesArrowKeys(target: EventTarget | null): boolean {
  return (
    isEditableKeyTarget(target) ||
    (target instanceof Element && target.closest(ARROW_KEY_WIDGETS) !== null)
  )
}
