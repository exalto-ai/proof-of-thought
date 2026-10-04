/** Find a required element, failing loudly and early if the markup lacks it. */
export function required<T extends Element>(
  root: ParentNode,
  selector: string,
  surface = "UI",
): T {
  const value = root.querySelector<T>(selector);
  if (!value) throw new Error(`missing ${surface} element: ${selector}`);
  return value;
}
