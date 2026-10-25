import { isAbsolute, relative, sep } from 'node:path';

// Native relative() respects Windows drive/case equivalence and path roots.
export function pathsOverlap(first, second) {
  const contains = (parent, child) => {
    const path = relative(parent, child);
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
  };
  return contains(first, second) || contains(second, first);
}
