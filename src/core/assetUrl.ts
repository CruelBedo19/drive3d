/**
 * URL of a file under `public/`. Prefixes Vite's base so the game also works when it is served from a
 * sub-path (GitHub Pages: /drive3d-public/). In Node (tests) there is no `import.meta.env`, the base is '/'.
 */
export function assetUrl(path: string): string {
  const base = import.meta.env?.BASE_URL ?? '/';
  return base + path.replace(/^\//, '');
}
