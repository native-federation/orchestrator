// Iterative path halving: no stack growth in the browser.
export function unionFind() {
  const parent = new Map<string, string>();
  const find = (node: string): string => {
    for (let up = parent.get(node); up !== undefined; up = parent.get(node)) {
      const grand = parent.get(up);
      if (grand === undefined) return up;
      parent.set(node, grand);
      node = grand;
    }
    return node;
  };
  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };
  return { find, union };
}
