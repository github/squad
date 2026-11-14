import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { remarkRewriteLinks } from './src/plugins/remark-rewrite-links.mjs';
import { rehypePagefindAttrs } from './src/plugins/rehype-pagefind-attrs.mjs';
import { rehypeA11y } from './src/plugins/rehype-a11y.mjs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export default defineConfig({
  site: 'https://github.github.com',
  base: '/squad/',
  integrations: [sitemap()],
  vite: {
    define: {
      __VERSION__: JSON.stringify(process.env.SQUAD_VERSION || require('../package.json').version),
      __COMMIT_SHA__: JSON.stringify(process.env.GITHUB_SHA || 'local'),
      __BUILD_DATE__: JSON.stringify(new Date().toISOString().split('T')[0]),
    },
  },
  markdown: {
    remarkPlugins: [remarkRewriteLinks],
    rehypePlugins: [rehypePagefindAttrs, rehypeA11y],
    shikiConfig: {
      themes: {
        light: 'github-light-high-contrast',
        dark: 'github-dark-high-contrast',
      },
    },
  },
});
