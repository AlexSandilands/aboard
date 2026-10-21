/**
 * The full project order after dragging one of the listed projects over another, when the list shows only some of
 * the projects. The listed ones swap among the places they already hold, so the hidden ones stay where they were
 * and the order sent to the server is still every project. Null when either project isn't listed.
 */
export function moveAmongVisible(
  allIds: ReadonlyArray<string>,
  visibleIds: ReadonlyArray<string>,
  activeId: string,
  overId: string,
): string[] | null {
  const from = visibleIds.indexOf(activeId);
  const to = visibleIds.indexOf(overId);
  if (from < 0 || to < 0) return null;
  const moved = [...visibleIds];
  moved.splice(to, 0, ...moved.splice(from, 1));
  const listed = new Set(visibleIds);
  let next = 0;
  return allIds.map((id) => (listed.has(id) ? moved[next++]! : id));
}
